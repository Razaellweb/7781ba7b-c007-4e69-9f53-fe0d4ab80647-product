import { NextResponse } from "next/server";
import { authenticateApiKey, ApiKeyError } from "../../../../../lib/server/api-keys";
import { verifyHolder } from "../../../../../lib/server/holder";
import { AccountingError, reserveCompute, settleReservation } from "../../../../../lib/server/accounting";
import { query } from "../../../../../lib/server/db";
import { rateLimit } from "../../../../../lib/server/redis";
import { getInferenceProvider } from "../../../../../lib/server/provider";
import { getActiveModel, pickAutoModel, syncCuratedModels, type ModelRow } from "../../../../../lib/server/models";
import { computeUserDebit, modelPolicy } from "../../../../../lib/server/pricing";
import { pricingConfig, userRateLimit } from "../../../../../lib/server/config";
import { ensureMigrated } from "../../../../../lib/server/migrate";
import type { InferenceMessage, InferenceUsage } from "../../../../../lib/server/inference";

export const runtime = "nodejs";
const encoder = new TextEncoder();
type PublicMessage = { role: "system" | "user" | "assistant"; content: string };
type CompletionBody = { model?: unknown; messages?: unknown; stream?: unknown; stream_options?: unknown; temperature?: unknown; top_p?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown; n?: unknown; stop?: unknown; tools?: unknown; tool_choice?: unknown; response_format?: unknown; user?: unknown };
type GatewayError = { code: string; message: string; status: number };

function error(code: string, message: string, status: number): GatewayError { return { code, message, status }; }
function jsonError(e: GatewayError, requestId: string) { return NextResponse.json({ error: { message: e.message, type: "invalid_request_error", code: e.code }, request_id: requestId }, { status: e.status, headers: { "X-Request-ID": requestId } }); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parseBody(raw: unknown): { model: string; messages: PublicMessage[]; stream: boolean } | GatewayError {
  if (!isRecord(raw)) return error("invalid_request", "The request body must be a JSON object.", 400);
  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "auto";
  if (!Array.isArray(raw.messages) || raw.messages.length < 1 || raw.messages.length > 100) return error("invalid_messages", "messages must contain between 1 and 100 items.", 400);
  const messages: PublicMessage[] = [];
  for (const item of raw.messages) {
    if (!isRecord(item) || !["system", "user", "assistant"].includes(String(item.role)) || typeof item.content !== "string" || !item.content.trim() || item.content.length > 32000) return error("invalid_messages", "Each message must have a supported role and non-empty text content.", 400);
    messages.push({ role: item.role as PublicMessage["role"], content: item.content });
  }
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") return error("invalid_request", "stream must be a boolean.", 400);
  if (raw.stream_options !== undefined && (!isRecord(raw.stream_options) || raw.stream_options.include_usage !== true || Object.keys(raw.stream_options).some((key) => key !== "include_usage"))) return error("unsupported_capability", "The requested streaming options are not supported.", 400);
  if (raw.n !== undefined && raw.n !== 1) return error("unsupported_capability", "Only one completion per request is supported.", 400);
  for (const key of ["tools", "tool_choice", "response_format", "stop", "user"]) if (raw[key] !== undefined) return error("unsupported_capability", `The ${key} capability is not supported by the public gateway contract.`, 400);
  for (const key of ["temperature", "top_p"]) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]))) return error("invalid_request", `${key} must be a finite number.`, 400);
  for (const key of ["max_tokens", "max_completion_tokens"]) if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || Number(raw[key]) < 1 || Number(raw[key]) > 32768)) return error("invalid_request", `${key} must be an integer between 1 and 32768.`, 400);
  if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined) return error("invalid_request", "Specify only one token limit.", 400);
  return { model, messages, stream: raw.stream === true };
}
function publicModel(model: ModelRow) { return model.slug; }
function completionId() { return `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`; }
function usageShape(usage: InferenceUsage) { return { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) }; }

export async function GET() { return jsonError(error("method_not_allowed", "Only POST is supported.", 405), crypto.randomUUID()); }
export async function PUT() { return jsonError(error("method_not_allowed", "Only POST is supported.", 405), crypto.randomUUID()); }
export async function PATCH() { return jsonError(error("method_not_allowed", "Only POST is supported.", 405), crypto.randomUUID()); }
export async function DELETE() { return jsonError(error("method_not_allowed", "Only POST is supported.", 405), crypto.randomUUID()); }

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return jsonError(error("invalid_content_type", "Content-Type must be application/json.", 415), requestId);
    let raw: unknown; try { raw = await request.json(); } catch { return jsonError(error("invalid_json", "The request body must be valid JSON.", 400), requestId); }
    const parsed = parseBody(raw); if ("code" in parsed && "status" in parsed) return jsonError(parsed, requestId);
    let key: Awaited<ReturnType<typeof authenticateApiKey>>;
    try { key = await authenticateApiKey(request.headers.get("authorization"), "chat:write"); } catch (caught) { const e = caught instanceof ApiKeyError ? caught : new ApiKeyError("MALFORMED_BEARER", "A first-party API key is required", 401); return jsonError(error(e.code.toLowerCase(), e.message, e.status), requestId); }
    if (!(await rateLimit(`inference:user:${key.accountId}`, userRateLimit(), 60))) return jsonError(error("rate_limited", "The account inference rate limit has been reached.", 429), requestId);
    if (!(await rateLimit(`inference:key:${key.apiKeyId}`, key.rateLimitPerMinute, 60))) return jsonError(error("rate_limited", "The API key inference rate limit has been reached.", 429), requestId);
    await syncCuratedModels();
    const model = parsed.model === "auto" ? await pickAutoModel() : await getActiveModel(parsed.model);
    if (!model) return jsonError(error("model_unavailable", "The requested public model is unavailable.", 400), requestId);
    const accountRows = await query<{ privy_user_id: string; address: `0x${string}` }>("SELECT a.privy_user_id, w.address FROM user_accounts a JOIN wallets w ON w.account_id=a.id AND w.is_canonical=true WHERE a.id=$1 LIMIT 1", [key.accountId]);
    if (!accountRows[0]?.address) return jsonError(error("ineligible_account", "Holder eligibility must be confirmed before inference.", 403), requestId);
    const eligibility = await verifyHolder({ accountId: key.accountId, privyUserId: accountRows[0].privy_user_id, walletAddress: accountRows[0].address });
    if (eligibility.state !== "eligible") return jsonError(error("ineligible_account", "Holder eligibility must be confirmed before inference.", 403), requestId);
    const provider = getInferenceProvider();
    if (!(await provider.health()).healthy) return jsonError(error("inference_unavailable", "Inference is temporarily unavailable.", 503), requestId);
    const operationKey = request.headers.get("idempotency-key")?.trim() || requestId;
    const existing = await query<{ status: string }>("SELECT status FROM inference_records WHERE operation_key=$1 LIMIT 1", [operationKey]);
    if (existing[0]) return jsonError(error("duplicate_request", "This inference request has already been accepted.", 409), requestId);
    const cfg = pricingConfig(); const policy = modelPolicy(model);
    const conversation = (await query<{ id: string }>("INSERT INTO conversations (account_id, title) VALUES ($1,$2) RETURNING id", [key.accountId, parsed.messages.find((item) => item.role === "user")?.content.slice(0, 60) ?? "API completion"]))[0];
    const claimed = await query<{ id: string }>("INSERT INTO inference_records (account_id,operation_key,provider,model,provider_model,conversation_id,status,markup_micro,metadata,api_key_id,channel) VALUES ($1,$2,'internal',$3,'internal',$4,'started',$5,$6,$7,'api_key') ON CONFLICT (operation_key) DO NOTHING RETURNING id", [key.accountId, operationKey, model.slug, conversation.id, policy.markupMicro.toString(), JSON.stringify({ requestId, channel: "api_key" }), key.apiKeyId]);
    if (!claimed[0]) return jsonError(error("duplicate_request", "This inference request has already been accepted.", 409), requestId);
    await query("INSERT INTO messages (conversation_id,account_id,role,content) VALUES ($1,$2,'user',$3)", [conversation.id, key.accountId, parsed.messages.filter((item) => item.role === "user").at(-1)?.content ?? "API completion"]);
    try { await reserveCompute(key.accountId, operationKey, cfg.reservationCapMicroUsd, { apiKeyId: key.apiKeyId, channel: "api_key" }); } catch (caught) { if (caught instanceof AccountingError) return jsonError(error(caught.code.toLowerCase(), "Internal compute allowance is unavailable.", caught.code === "INSUFFICIENT_COMPUTE" ? 402 : 403), requestId); throw caught; }
    const inferenceMessages: InferenceMessage[] = parsed.messages;
    const id = completionId(); let output = ""; let finalUsage: InferenceUsage | null = null; let settled = false;
    const finalize = async (uncertain: boolean, eventType: "provider_usage" | "cancelled" | "partial" | "uncertain", providerCost: bigint | null) => { if (settled) return; settled = true; const debit = providerCost !== null && !uncertain ? computeUserDebit(providerCost, policy) : 0n; const capped = debit > cfg.reservationCapMicroUsd ? cfg.reservationCapMicroUsd : debit; await settleReservation(operationKey, capped, providerCost, uncertain, { inputTokens: finalUsage?.inputTokens, outputTokens: finalUsage?.outputTokens, eventType, markupMicro: policy.markupMicro }).catch(() => undefined); if (output) await query("INSERT INTO messages (conversation_id,account_id,role,content,partial,model_slug,provider_model,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd) VALUES ($1,$2,'assistant',$3,$4,$5,'internal',$6,$7,$8,$9)", [conversation.id, key.accountId, output, uncertain, model.slug, finalUsage?.inputTokens ?? null, finalUsage?.outputTokens ?? null, providerCost?.toString() ?? null, capped.toString()]).catch(() => undefined); await query("UPDATE inference_records SET status=$2,input_tokens=$3,output_tokens=$4,provider_cost_micro_usd=$5,user_debit_micro_usd=$6,reconciliation_required=$7,completed_at=now() WHERE operation_key=$1", [operationKey, uncertain ? "uncertain" : "complete", finalUsage?.inputTokens ?? null, finalUsage?.outputTokens ?? null, providerCost?.toString() ?? null, capped.toString(), uncertain]).catch(() => undefined); };
    if (parsed.stream) {
      const stream = new ReadableStream({ async start(controller) { const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); try { for await (const chunk of provider.stream({ operationKey, model: model.provider_model_slug, messages: inferenceMessages, signal: request.signal })) { if (chunk.type === "delta") { output += chunk.text; send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: publicModel(model), choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] }); } else if (chunk.type === "complete") { finalUsage = chunk.usage; await finalize(chunk.usage.uncertain, chunk.usage.uncertain ? "uncertain" : "provider_usage", chunk.usage.providerCostMicroUsd); send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: publicModel(model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: usageShape(chunk.usage) }); } else { await finalize(true, output ? "partial" : "uncertain", null); send({ error: { message: "Inference could not be completed.", type: "server_error", code: "inference_unavailable" } }); } } } catch { await finalize(true, output ? "partial" : "uncertain", null); send({ error: { message: "Inference could not be completed.", type: "server_error", code: "inference_unavailable" } }); } finally { await finalize(true, output ? "partial" : "uncertain", null).catch(() => undefined); send("[DONE]"); controller.close(); } }, }); return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Request-ID": requestId } });
    }
    try { for await (const chunk of provider.stream({ operationKey, model: model.provider_model_slug, messages: inferenceMessages, signal: request.signal })) { if (chunk.type === "delta") output += chunk.text; else if (chunk.type === "complete") finalUsage = chunk.usage; else { await finalize(true, output ? "partial" : "uncertain", null); return jsonError(error("inference_unavailable", "Inference could not be completed.", 503), requestId); } } } catch { await finalize(true, output ? "partial" : "uncertain", null); return jsonError(error("inference_unavailable", "Inference could not be completed.", 503), requestId); }
    if (!finalUsage) { await finalize(true, output ? "partial" : "uncertain", null); return jsonError(error("inference_unavailable", "Inference could not be completed.", 503), requestId); }
    await finalize(finalUsage.uncertain, finalUsage.uncertain ? "uncertain" : "provider_usage", finalUsage.providerCostMicroUsd);
    return NextResponse.json({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: publicModel(model), choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }], usage: usageShape(finalUsage) }, { headers: { "X-Request-ID": requestId } });
  } catch (caught) { console.error("[gateway] request failed", caught instanceof Error ? caught.message : "unknown"); return jsonError(error("gateway_unavailable", "The inference gateway is temporarily unavailable.", 503), requestId); }
}

import { NextResponse } from "next/server";
import { authenticateRequest, AuthenticationError } from "../../../lib/server/auth";
import { verifyHolder } from "../../../lib/server/holder";
import { reserveCompute, settleReservation, reportFinalizationFailure, AccountingError } from "../../../lib/server/accounting";
import { query } from "../../../lib/server/db";
import { rateLimit, cacheGet } from "../../../lib/server/redis";
import { getInferenceProvider } from "../../../lib/server/provider";
import { getActiveModel, pickAutoModel, syncCuratedModels, type ModelRow } from "../../../lib/server/models";
import { computeUserDebit, modelPolicy } from "../../../lib/server/pricing";
import { pricingConfig, userRateLimit } from "../../../lib/server/config";
import { ensureMigrated } from "../../../lib/server/migrate";
import type { InferenceMessage } from "../../../lib/server/inference";

const encoder = new TextEncoder();
const CONTEXT_LIMIT = 20;

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    const account = await authenticateRequest(request.headers.get("authorization"), "chat:write");
    const isApiKey = Boolean(account.apiKeyId);
    if (!(await rateLimit(`inference:user:${account.accountId}`, userRateLimit(), 60))) return NextResponse.json({ error: "Your account inference rate limit has been reached. Try again shortly.", code: "USER_RATE_LIMITED", requestId }, { status: 429 });
    if (isApiKey && !(await rateLimit(`inference:key:${account.apiKeyId}`, account.rateLimitPerMinute ?? 20, 60))) return NextResponse.json({ error: "This API key's inference rate limit has been reached. Use another key or try again shortly.", code: "KEY_RATE_LIMITED", requestId }, { status: 429 });
    const body = await request.json() as { conversationId?: string; message?: string; model?: string; operationKey?: string; clientRequestId?: string };
    const text = body.message?.trim();
    if (!text) return NextResponse.json({ error: "Message cannot be empty", code: "INVALID_REQUEST", requestId }, { status: 400 });
    const clientRequestId = body.clientRequestId?.trim() || null;
    await syncCuratedModels();
    const requestedSlug = body.model?.trim();
    const model: ModelRow | null = !requestedSlug || requestedSlug === "auto" ? await pickAutoModel() : await getActiveModel(requestedSlug);
    if (!model) return NextResponse.json({ error: "That model is not available", code: "UNAVAILABLE_MODEL", requestId }, { status: 400 });
    const eligibility = await verifyHolder(account);
    if (eligibility.state !== "eligible") return NextResponse.json({ error: "Holder eligibility must be confirmed before inference", code: eligibility.state, requestId }, { status: 403 });
    const health = await getInferenceProvider().health();
    if (!health.healthy) return NextResponse.json({ error: "Inference is temporarily degraded. Please try again shortly.", code: "PROVIDER_DEGRADED", requestId }, { status: 503 });
    const derivedTitle = text.slice(0, 60);
    const conversationId = body.conversationId ?? (await query<{ id: string }>(`INSERT INTO conversations (account_id, title) VALUES ($1,$2) RETURNING id`, [account.accountId, derivedTitle]))[0].id;
    const owned = await query(`SELECT id FROM conversations WHERE id=$1 AND account_id=$2`, [conversationId, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Conversation not found", code: "NOT_FOUND", requestId }, { status: 404 });
    if (body.conversationId) await query(`UPDATE conversations SET title=$3 WHERE id=$1 AND account_id=$2 AND (title IS NULL OR title IN ('Untitled conversation','New conversation'))`, [conversationId, account.accountId, derivedTitle]);
    const operationKey = body.operationKey?.trim() || clientRequestId || requestId;
    const duplicate = await query<{ id: string; status: string; conversation_id: string }>(`SELECT id,status,conversation_id FROM inference_records WHERE operation_key=$1 OR ($2::text IS NOT NULL AND account_id=$3 AND client_request_id=$2) LIMIT 1`, [operationKey, clientRequestId, account.accountId]);
    if (duplicate[0]) return NextResponse.json({ error: "This inference request has already been accepted", code: "DUPLICATE_REQUEST", requestId, operationKey, status: duplicate[0].status, conversationId: duplicate[0].conversation_id }, { status: 409 });
    const cfg = pricingConfig();
    const policy = modelPolicy(model);
    const channel = isApiKey ? "api_key" : "app";
    const claimed = await query<{ id: string; status: string; conversation_id: string }>(`INSERT INTO inference_records (account_id, operation_key, provider, model, provider_model, conversation_id, status, markup_micro, metadata, api_key_id, channel, client_request_id) VALUES ($1,$2,$3,$4,$5,$6,'started',$7,$8,$9,$10,$11) ON CONFLICT (operation_key) DO NOTHING RETURNING id,status,conversation_id`, [account.accountId, operationKey, model.provider, model.slug, model.provider_model_slug, conversationId, policy.markupMicro.toString(), JSON.stringify({ requestId, channel, apiKeyId: account.apiKeyId ?? null }), account.apiKeyId ?? null, channel, clientRequestId]);
    if (!claimed[0]) return NextResponse.json({ error: "This inference request has already been accepted", code: "DUPLICATE_REQUEST", requestId, operationKey, conversationId }, { status: 409 });
    const inferenceId = claimed[0].id;
    const priorRows = await query<{ role: "user" | "assistant"; content: string }>(`SELECT role, content FROM messages WHERE conversation_id=$1 AND partial=false ORDER BY created_at ASC LIMIT $2`, [conversationId, CONTEXT_LIMIT]);
    const systemPrompt: InferenceMessage = { role: "system", content: "You are Openweight, a helpful AI assistant. Always respond in the same language the user writes in. If the user's language is unclear, respond in English. Do not default to Chinese." };
    const contextMessages: InferenceMessage[] = [systemPrompt, ...priorRows.map((r) => ({ role: r.role, content: r.content })), { role: "user", content: text }];
    await query(`INSERT INTO messages (conversation_id,account_id,role,content) VALUES ($1,$2,'user',$3)`, [conversationId, account.accountId, text]);
    try { await reserveCompute(account.accountId, operationKey, cfg.reservationCapMicroUsd, { apiKeyId: account.apiKeyId, channel }); } catch (error) { if (error instanceof AccountingError) { const status = error.code === "ALLOWANCE_MISSING" || error.code === "ALLOWANCE_EXPIRED" ? 403 : 402; return NextResponse.json({ error: error.message, code: error.code, requestId }, { status }); } throw error; }
    const provider = getInferenceProvider();
    const stream = new ReadableStream({
      async start(controller) {
        let output = "";
        let settled = false;
        let deltas = 0;
        let stopRequested = false;
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const finalize = async (status: "complete" | "cancelled" | "failed" | "uncertain", providerCost: bigint | null, usage: { inputTokens: number | null; outputTokens: number | null } | null, uncertain: boolean) => {
          if (settled) return;
          const correlationId = `${requestId}:${inferenceId}`;
          const userDebit = providerCost != null && !uncertain ? computeUserDebit(providerCost, policy) : 0n;
          const cappedDebit = userDebit > cfg.reservationCapMicroUsd ? cfg.reservationCapMicroUsd : userDebit;
          const isUncertain = uncertain || (status !== "complete" && providerCost == null && output.length > 0);
          try {
            await settleReservation(operationKey, cappedDebit, providerCost, isUncertain, { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, eventType: status === "complete" ? "provider_usage" : status === "cancelled" ? "cancelled" : status === "failed" ? "provider_failure" : "uncertain", markupMicro: policy.markupMicro });
          } catch (error) {
            await reportFinalizationFailure(operationKey, correlationId, "settlement", error);
            throw error;
          }
          try {
            if (output) await query(`INSERT INTO messages (inference_id,conversation_id,account_id,role,content,partial,model_slug,provider_model,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd) VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (inference_id) WHERE role='assistant' DO NOTHING`, [inferenceId, conversationId, account.accountId, output, status !== "complete", model.slug, model.provider_model_slug, usage?.inputTokens ?? null, usage?.outputTokens ?? null, providerCost?.toString() ?? null, cappedDebit.toString()]);
          } catch (error) { await reportFinalizationFailure(operationKey, correlationId, "assistant_persistence", error); throw error; }
          try {
            await query(`UPDATE inference_records SET status=$2, input_tokens=$3, output_tokens=$4, provider_cost_micro_usd=$5, user_debit_micro_usd=$6, reconciliation_required=$7, completed_at=now() WHERE operation_key=$1`, [operationKey, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, providerCost?.toString() ?? null, cappedDebit.toString(), isUncertain]);
            await query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [conversationId]);
          } catch (error) { await reportFinalizationFailure(operationKey, correlationId, "inference_update", error); throw error; }
          settled = true;
        };
        try {
          for await (const chunk of provider.stream({ operationKey, model: model.provider_model_slug, messages: contextMessages })) {
            if (chunk.type === "delta") { output += chunk.text; deltas += 1; send({ type: "delta", text: chunk.text }); if (deltas % 20 === 0 && await cacheGet<boolean>(`stop:${operationKey}`).catch(() => null)) { stopRequested = true; break; } }
            else if (chunk.type === "complete") { await finalize("complete", chunk.usage.providerCostMicroUsd, { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }, chunk.usage.uncertain); send({ type: "complete", conversationId, requestId }); }
            else if (chunk.type === "error") { await finalize("failed", null, null, false); send({ type: "error", code: `INFERENCE_${chunk.error.code.toUpperCase()}`, error: chunk.error.message, retryable: chunk.error.retryable, requestId }); }
          }
          if (stopRequested) { await finalize("cancelled", null, null, true); send({ type: "cancelled", conversationId, requestId }); }
        } catch (error) { console.error(JSON.stringify({ event: "inference_stream_finalization_failed", operationKey, inferenceId, requestId, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" })); send({ type: "error", code: "INFERENCE_UNAVAILABLE", error: "Inference could not be completed.", retryable: true, requestId }); }
        finally { if (!settled) { try { await finalize("failed", null, null, false); } catch (error) { console.error(JSON.stringify({ event: "inference_finalization_failed", operationKey, inferenceId, requestId, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" })); } } controller.close(); }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Request-ID": requestId } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: error.code === "INSUFFICIENT_SCOPE" ? 403 : 401 });
    console.error("[chat] inference request failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Inference is unavailable. No provider work was started.", code: "INFERENCE_UNAVAILABLE", requestId }, { status: 503 });
  }
}
import { NextResponse } from "next/server";
import { authenticateRequest, AuthenticationError } from "../../../lib/server/auth";
import { reserveCompute, settleReservation, reportFinalizationFailure, ensureDefaultAllowance, AccountingError } from "../../../lib/server/accounting";
import { query } from "../../../lib/server/db";
import { rateLimit, cacheGet } from "../../../lib/server/redis";
import { getInferenceProvider } from "../../../lib/server/provider";
import { getActiveModel, modelSupportsTools, pickAutoModel, syncCuratedModels, type ModelRow } from "../../../lib/server/models";
import { computeUserDebit, modelPolicy } from "../../../lib/server/pricing";
import { pricingConfig, userRateLimit } from "../../../lib/server/config";
import { ensureMigrated } from "../../../lib/server/migrate";
import { requireActiveAccountKey, ApiKeyError, type ActiveAccountKey } from "../../../lib/server/api-keys";
import { parseToolOptions } from "../../../lib/server/chat-request";
import { executeDeclaredToolCalls } from "../../../lib/server/tool-handlers";
import type { InferenceMessage, InferenceToolCall, InferenceToolDefinition, InferenceToolChoice, InferenceUsage, CompletionParameters } from "../../../lib/server/inference";

const encoder = new TextEncoder();
const CONTEXT_LIMIT = 20;
// Tool rounds are bounded by the existing context limit rather than a new setting:
// a request can run at most half as many follow-up rounds as the context window
// holds messages, and when that is reached the request ends on the existing
// complete path with the structured tool calls surfaced.
const MAX_TOOL_ROUNDS = Math.max(1, Math.floor(CONTEXT_LIMIT / 2));
const supported = (model: ModelRow, name: string) => Boolean(model.provider_metadata?.supportedParameters.some((item) => item.toLowerCase() === name.toLowerCase()));
function invalidParameter(message: string, requestId: string) { return NextResponse.json({ error: message, code: "INVALID_PARAMETER", requestId }, { status: 400 }); }
function unsupportedCapability(message: string, requestId: string) { return NextResponse.json({ error: message, code: "UNSUPPORTED_CAPABILITY", requestId }, { status: 400 }); }
function parseParameters(body: Record<string, unknown>, model: ModelRow, requestId: string): CompletionParameters | Response {
  const input = body.parameters;
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalidParameter("parameters must be an object.", requestId);
  const raw = input as Record<string, unknown>; const parameters: CompletionParameters = {};
  const number = (key: string, min: number, max: number, integer = false) => { const value = raw[key]; if (value === undefined) return; if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`); const providerName = key === "topP" ? "top_p" : key === "maxTokens" ? "max_tokens" : key; if (!supported(model, providerName)) throw new Error(`${key} is not supported by the selected model.`); (parameters as Record<string, unknown>)[providerName] = value; };
  try {
    number("temperature", 0, 2); number("topP", 0, 1); number("maxTokens", 1, 32768, true); number("seed", 0, 2147483647, true);
    if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()) { if (raw.systemPrompt.length > 8000) throw new Error("systemPrompt must be 8,000 characters or fewer."); parameters.systemPrompt = raw.systemPrompt.trim(); }
    if (raw.stop !== undefined) { if (!Array.isArray(raw.stop) || raw.stop.length > 4 || raw.stop.some((item) => typeof item !== "string" || !item.trim() || item.length > 128)) throw new Error("stop must contain up to four non-empty sequences of 128 characters or fewer."); if (!supported(model, "stop")) throw new Error("stop is not supported by the selected model."); parameters.stop = raw.stop as string[]; }
    return parameters;
  } catch (error) { return invalidParameter(error instanceof Error ? error.message : "Invalid parameters.", requestId); }
}

/**
 * Per-round settlement bookkeeping. Every upstream round-trip of a request is
 * metered through the existing accounting path: its own hold is reserved before
 * the round and settled immediately after it, so a tool-calling request is charged
 * for each inference round-trip at actual provider cost, exactly like a single-round
 * request is. Rounds never share a reservation, so concurrent requests cannot
 * interfere with each other's holds.
 */
type SettledRound = { providerCost: bigint | null; inputTokens: number | null; outputTokens: number | null; debit: bigint };

function sumRounds(rounds: SettledRound[]): { providerCost: bigint | null; inputTokens: number | null; outputTokens: number | null; debit: bigint } {
  if (!rounds.length) return { providerCost: null, inputTokens: null, outputTokens: null, debit: 0n };
  let providerCost: bigint | null = 0n; let inputTokens: number | null = 0; let outputTokens: number | null = 0; let debit = 0n;
  for (const round of rounds) {
    debit += round.debit;
    if (round.providerCost === null) providerCost = null; else if (providerCost !== null) providerCost += round.providerCost;
    if (round.inputTokens === null) inputTokens = null; else if (inputTokens !== null) inputTokens += round.inputTokens;
    if (round.outputTokens === null) outputTokens = null; else if (outputTokens !== null) outputTokens += round.outputTokens;
  }
  return { providerCost, inputTokens, outputTokens, debit };
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    // Authorization is identity-based: a verified Privy session or a valid
    // first-party API key is sufficient. No token-balance, holder-status, or
    // ownership eligibility gate runs before inference any more.
    const account = await authenticateRequest(request.headers.get("authorization"), "chat:write");
    const isApiKey = Boolean(account.apiKeyId);
    if (!(await rateLimit(`inference:user:${account.accountId}`, userRateLimit(), 60))) return NextResponse.json({ error: "Your account inference rate limit has been reached. Try again shortly.", code: "USER_RATE_LIMITED", requestId }, { status: 429 });
    if (isApiKey && !(await rateLimit(`inference:key:${account.apiKeyId}`, account.rateLimitPerMinute ?? 20, 60))) return NextResponse.json({ error: "This API key's inference rate limit has been reached. Use another key or try again shortly.", code: "KEY_RATE_LIMITED", requestId }, { status: 429 });
    const body = await request.json() as Record<string, unknown>;
    const text = typeof body.message === "string" ? body.message.trim() : "";
    if (!text) return NextResponse.json({ error: "Message cannot be empty", code: "INVALID_REQUEST", requestId }, { status: 400 });
    // The Playground requires an active API key on the signed-in account. When the
    // request is presented as a first-party key, authenticateRequest has already
    // verified hash, ownership and revocation for it. For a Privy session the key
    // is looked up in the database here, so a client-supplied key id that belongs
    // to another account, a revoked key, or a keyless session is rejected before
    // any conversation, inference record, or provider work is created.
    let authorizingKey: ActiveAccountKey | null = null;
    if (!account.apiKeyId) {
      try {
        const requestedKeyId = typeof body.apiKeyId === "string" ? body.apiKeyId : request.headers.get("x-openweight-api-key-id");
        authorizingKey = await requireActiveAccountKey(account.accountId, requestedKeyId);
      } catch (error) {
        if (error instanceof ApiKeyError) return NextResponse.json({ error: error.message, code: error.code, requiresApiKey: true, requestId }, { status: error.status });
        throw error;
      }
    }
    const authorizingApiKeyId = account.apiKeyId ?? authorizingKey?.id ?? null;
    const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() || null : null;
    await syncCuratedModels();
    const requestedSlug = typeof body.model === "string" ? body.model.trim() : "";
    const model: ModelRow | null = !requestedSlug || requestedSlug === "auto" ? await pickAutoModel() : await getActiveModel(requestedSlug);
    if (!model) return NextResponse.json({ error: "That model is not available in the curated registry.", code: "UNAVAILABLE_MODEL", requestId }, { status: 400 });
    const parameters = parseParameters(body, model, requestId); if (parameters instanceof Response) return parameters;
    // Tool declarations are validated structurally here and only forwarded when the
    // model's synced provider metadata confirms the `tools` parameter. A malformed
    // declaration keeps the existing validation-error path; a well-formed one aimed
    // at a model without confirmed support keeps the capability refusal.
    const toolOptions = parseToolOptions(body.tools, body.tool_choice ?? body.toolChoice);
    if (!toolOptions.ok) return invalidParameter(toolOptions.error.message, requestId);
    const declaredTools: InferenceToolDefinition[] = toolOptions.value.tools;
    const toolChoice: InferenceToolChoice | undefined = toolOptions.value.toolChoice;
    const toolsRequested = declaredTools.length > 0 || toolChoice !== undefined;
    if (toolsRequested && !modelSupportsTools(model)) return unsupportedCapability("The tools capability is not supported by the selected model.", requestId);
    const declaredToolNames = new Set(declaredTools.map((tool) => tool.function.name));
    const health = await getInferenceProvider().health();
    if (!health.healthy) return NextResponse.json({ error: "Inference is temporarily degraded. Please try again shortly.", code: "PROVIDER_DEGRADED", requestId }, { status: 503 });
    const derivedTitle = text.slice(0, 60);
    const conversationId = typeof body.conversationId === "string" && body.conversationId ? body.conversationId : (await query<{ id: string }>(`INSERT INTO conversations (account_id, title) VALUES ($1,$2) RETURNING id`, [account.accountId, derivedTitle]))[0].id;
    const owned = await query(`SELECT id FROM conversations WHERE id=$1 AND account_id=$2`, [conversationId, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Conversation not found", code: "NOT_FOUND", requestId }, { status: 404 });
    if (typeof body.conversationId === "string") await query(`UPDATE conversations SET title=$3 WHERE id=$1 AND account_id=$2 AND (title IS NULL OR title IN ('Untitled conversation','New conversation'))`, [conversationId, account.accountId, derivedTitle]);
    const operationKey = typeof body.operationKey === "string" && body.operationKey.trim() ? body.operationKey.trim() : clientRequestId || requestId;
    const duplicate = await query<{ id: string; status: string; conversation_id: string }>(`SELECT id,status,conversation_id FROM inference_records WHERE operation_key=$1 OR ($2::text IS NOT NULL AND account_id=$3 AND client_request_id=$2) LIMIT 1`, [operationKey, clientRequestId, account.accountId]);
    if (duplicate[0]) return NextResponse.json({ error: "This inference request has already been accepted", code: "DUPLICATE_REQUEST", requestId, operationKey, status: duplicate[0].status, conversationId: duplicate[0].conversation_id }, { status: 409 });
    const cfg = pricingConfig(); const policy = modelPolicy(model); const channel = isApiKey ? "api_key" : "app";
    // The hold may be smaller than the configured cap when the account's available
    // balance is below it, so settlement is bounded by what was actually reserved.
    let settlementCeiling = cfg.reservationCapMicroUsd;
    const claimed = await query<{ id: string; status: string; conversation_id: string }>(`INSERT INTO inference_records (account_id, operation_key, provider, model, provider_model, conversation_id, status, markup_micro, metadata, api_key_id, channel, client_request_id) VALUES ($1,$2,$3,$4,$5,$6,'started',$7,$8,$9,$10,$11) ON CONFLICT (operation_key) DO NOTHING RETURNING id,status,conversation_id`, [account.accountId, operationKey, model.provider, model.slug, model.provider_model_slug, conversationId, policy.markupMicro.toString(), JSON.stringify({ requestId, channel, apiKeyId: authorizingApiKeyId, parameters, tools: declaredTools.map((tool) => tool.function.name), toolChoice: toolChoice ?? null }), authorizingApiKeyId, channel, clientRequestId]);
    if (!claimed[0]) return NextResponse.json({ error: "This inference request has already been accepted", code: "DUPLICATE_REQUEST", requestId, operationKey, conversationId }, { status: 409 });
    const inferenceId = claimed[0].id;
    const priorRows = await query<{ role: "user" | "assistant"; content: string }>(`SELECT role, content FROM messages WHERE conversation_id=$1 AND partial=false ORDER BY created_at ASC LIMIT $2`, [conversationId, CONTEXT_LIMIT]);
    const systemPrompt: InferenceMessage = { role: "system", content: typeof parameters.systemPrompt === "string" ? parameters.systemPrompt : "You are Openweight, a helpful AI assistant. Always respond in the same language the user writes in. If the user's language is unclear, respond in English. Do not default to Chinese." };
    const providerParameters = { ...parameters }; delete (providerParameters as Record<string, unknown>).systemPrompt;
    const contextMessages: InferenceMessage[] = [systemPrompt, ...priorRows.map((r) => ({ role: r.role, content: r.content })), { role: "user", content: text }];
    await query(`INSERT INTO messages (conversation_id,account_id,role,content) VALUES ($1,$2,'user',$3)`, [conversationId, account.accountId, text]);
    try {
      // The compute allowance is a separately handled mechanism: the configured
      // default grant is provisioned for any verified identity, and it never
      // depends on token holdings or a legacy holder-status value.
      await ensureDefaultAllowance(account.accountId);
      // reserveCompute holds min(configured cap, available balance) atomically, so
      // any positive balance can run an inference request without reaching the cap.
      const reservation = await reserveCompute(account.accountId, operationKey, cfg.reservationCapMicroUsd, { apiKeyId: authorizingApiKeyId ?? undefined, channel });
      const heldMicroUsd = BigInt(reservation?.reserved_micro_usd ?? cfg.reservationCapMicroUsd.toString());
      if (heldMicroUsd > 0n && heldMicroUsd < settlementCeiling) settlementCeiling = heldMicroUsd;
    } catch (error) { if (error instanceof AccountingError) { const status = error.code === "ALLOWANCE_MISSING" || error.code === "ALLOWANCE_EXPIRED" ? 403 : 402; return NextResponse.json({ error: error.message, code: error.code, requestId }, { status }); } throw error; }
    const provider = getInferenceProvider();
    const stream = new ReadableStream({ async start(controller) {
      let output = ""; let settled = false; let deltas = 0; let stopRequested = false;
      // Round 1 settles against the request's own reservation, so a request without
      // tools produces exactly the same accounting as before. Each additional tool
      // round reserves and settles its own hold under a derived key.
      let roundIndex = 1; let roundKey = operationKey; let roundCeiling = settlementCeiling; let roundSettled = false;
      const rounds: SettledRound[] = []; let roundsUncertain = false;
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const correlationId = () => `${requestId}:${inferenceId}`;
      const settleRound = async (eventType: "provider_usage" | "provider_failure" | "cancelled" | "uncertain", usage: InferenceUsage | null, uncertain: boolean) => {
        if (roundSettled) return;
        const providerCost = usage?.providerCostMicroUsd ?? null;
        const userDebit = providerCost != null && !uncertain ? computeUserDebit(providerCost, policy) : 0n;
        const cappedDebit = userDebit > roundCeiling ? roundCeiling : userDebit;
        try { await settleReservation(roundKey, cappedDebit, providerCost, uncertain, { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, eventType, markupMicro: policy.markupMicro }); }
        catch (error) { await reportFinalizationFailure(operationKey, correlationId(), "settlement", error); throw error; }
        rounds.push({ providerCost, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, debit: cappedDebit });
        if (uncertain) roundsUncertain = true;
        roundSettled = true;
      };
      // Persists the assistant turn and closes the inference record. Runs once per
      // request; totals cover every metered round-trip of this request.
      const persist = async (status: "complete" | "cancelled" | "failed" | "uncertain", isUncertain: boolean) => {
        if (settled) return;
        const totals = sumRounds(rounds);
        try { if (output) await query(`INSERT INTO messages (inference_id,conversation_id,account_id,role,content,partial,model_slug,provider_model,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd) VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (inference_id) WHERE inference_id IS NOT NULL AND role='assistant' DO NOTHING`, [inferenceId, conversationId, account.accountId, output, status !== "complete", model.slug, model.provider_model_slug, totals.inputTokens, totals.outputTokens, totals.providerCost?.toString() ?? null, totals.debit.toString()]); } catch (error) { await reportFinalizationFailure(operationKey, correlationId(), "assistant_persistence", error); throw error; }
        try { await query(`UPDATE inference_records SET status=$2, input_tokens=$3, output_tokens=$4, provider_cost_micro_usd=$5, user_debit_micro_usd=$6, reconciliation_required=$7, completed_at=now() WHERE operation_key=$1`, [operationKey, status, totals.inputTokens, totals.outputTokens, totals.providerCost?.toString() ?? null, totals.debit.toString(), isUncertain]); await query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [conversationId]); } catch (error) { await reportFinalizationFailure(operationKey, correlationId(), "inference_update", error); throw error; }
        settled = true;
      };
      const finalize = async (status: "complete" | "cancelled" | "failed" | "uncertain", usage: InferenceUsage | null, uncertain: boolean) => {
        if (settled) return;
        const isUncertain = uncertain || roundsUncertain || (status !== "complete" && (usage?.providerCostMicroUsd ?? null) == null && output.length > 0);
        await settleRound(status === "complete" ? "provider_usage" : status === "cancelled" ? "cancelled" : status === "failed" ? "provider_failure" : "uncertain", usage, uncertain);
        await persist(status, isUncertain);
      };
      try {
        while (true) {
          let roundText = ""; let pendingToolCalls: InferenceToolCall[] = []; let roundUsage: InferenceUsage | null = null; let roundCompleted = false; let roundFailed = false;
          for await (const chunk of provider.stream({ operationKey: roundKey, model: model.provider_model_slug, messages: contextMessages, parameters: providerParameters, ...(toolsRequested ? { tools: declaredTools, toolChoice } : {}) })) {
            if (chunk.type === "delta") {
              output += chunk.text; roundText += chunk.text; deltas += 1; send({ type: "delta", text: chunk.text });
              if (deltas % 20 === 0 && await cacheGet<boolean>(`stop:${operationKey}`).catch(() => null)) { stopRequested = true; break; }
            } else if (chunk.type === "tool_calls") {
              // Complete calls only; the provider already dropped unfinished fragments.
              pendingToolCalls = chunk.toolCalls;
            } else if (chunk.type === "complete") {
              roundUsage = chunk.usage; roundCompleted = true;
            } else {
              roundFailed = true; await finalize("failed", null, false); send({ type: "error", code: `INFERENCE_${chunk.error.code.toUpperCase()}`, error: chunk.error.message, retryable: chunk.error.retryable, requestId }); break;
            }
          }
          if (roundFailed) break;
          if (stopRequested) { await finalize("cancelled", null, true); send({ type: "cancelled", conversationId, requestId }); break; }
          if (!roundCompleted) { await finalize("failed", null, false); send({ type: "error", code: "INFERENCE_UNAVAILABLE", error: "Inference could not be completed.", retryable: true, requestId }); break; }
          // No tool calls: this is the final assistant response for the request.
          if (!pendingToolCalls.length) { await finalize("complete", roundUsage, Boolean(roundUsage?.uncertain)); send({ type: "complete", conversationId, requestId }); break; }
          // This round is metered before the next one starts, so a multi-round
          // request is charged for each upstream round-trip.
          await settleRound("provider_usage", roundUsage, Boolean(roundUsage?.uncertain));
          const outcome = toolsRequested ? await executeDeclaredToolCalls(pendingToolCalls, declaredToolNames, { accountId: account.accountId, conversationId, operationKey }) : { executable: false as const };
          // No allowed handler for one of the requested tools (or the request is out
          // of usable tool rounds): surface the structured call instead of inventing
          // a result. Nothing is executed and nothing is fabricated.
          if (!outcome.executable || roundIndex >= MAX_TOOL_ROUNDS) {
            await persist("complete", Boolean(roundUsage?.uncertain) || roundsUncertain);
            send({ type: "tool_calls", toolCalls: pendingToolCalls, conversationId, requestId });
            send({ type: "complete", conversationId, requestId });
            break;
          }
          // Continue the same inference with the assistant tool-call message and the
          // tool results appended, in the order and with the ids the model produced.
          // Only the final assistant text is persisted: the messages table stores
          // user/assistant turns, so the intermediate tool exchange lives in this
          // request's inference context rather than in conversation history.
          contextMessages.push({ role: "assistant", content: roundText, tool_calls: pendingToolCalls });
          contextMessages.push(...outcome.results);
          roundIndex += 1;
          const nextKey = `${operationKey}#tool-${roundIndex}`;
          try {
            const reservation = await reserveCompute(account.accountId, nextKey, cfg.reservationCapMicroUsd, { apiKeyId: authorizingApiKeyId ?? undefined, channel });
            const held = BigInt(reservation?.reserved_micro_usd ?? cfg.reservationCapMicroUsd.toString());
            roundKey = nextKey; roundCeiling = held > 0n ? held : cfg.reservationCapMicroUsd; roundSettled = false;
          } catch (error) {
            const message = error instanceof AccountingError ? error.message : "Compute is unavailable for the next tool round.";
            await persist("failed", true);
            send({ type: "error", code: "INSUFFICIENT_COMPUTE", error: message, retryable: false, requestId });
            break;
          }
        }
      } catch (error) {
        console.error(JSON.stringify({ event: "inference_stream_finalization_failed", operationKey, inferenceId, requestId, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
        send({ type: "error", code: "INFERENCE_UNAVAILABLE", error: "Inference could not be completed.", retryable: true, requestId });
      } finally {
        if (!settled) { try { await finalize("failed", null, false); } catch (error) { console.error(JSON.stringify({ event: "inference_finalization_failed", operationKey, inferenceId, requestId, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" })); } }
        controller.close();
      }
    } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Request-ID": requestId } });
  } catch (error) { if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: error.code === "INSUFFICIENT_SCOPE" ? 403 : 401 }); console.error("[chat] inference request failed", error instanceof Error ? error.message : "unknown error"); return NextResponse.json({ error: "Inference is unavailable. No provider work was started.", code: "INFERENCE_UNAVAILABLE", requestId }, { status: 503 }); }
}

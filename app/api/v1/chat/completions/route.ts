import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticateApiKey, ApiKeyError } from "../../../../../lib/server/api-keys";
import { ensureDefaultAllowance, reportFinalizationFailure } from "../../../../../lib/server/accounting";
import { openReservation, normalizedUsageFrom, planTurn, settleTurn, usageForDeliveredText } from "../../../../../lib/server/metering";
import { query, transaction } from "../../../../../lib/server/db";
import { cacheGet, rateLimit } from "../../../../../lib/server/redis";
import { getInferenceProvider, providerIdOf } from "../../../../../lib/server/provider";
import { refreshProviderSettings } from "../../../../../lib/server/provider-settings";
import { getActiveModel, pickAutoModel, syncCuratedModels, type ModelRow } from "../../../../../lib/server/models";
import { userRateLimit } from "../../../../../lib/server/config";
import { ensureMigrated } from "../../../../../lib/server/migrate";
import { normalizedErrorFromThrown, normalizedProviderError, type InferenceMessage, type InferenceUsage, type NormalizedProviderError } from "../../../../../lib/server/inference";
import { parseBody, type PublicMessage, type CompletionParameters } from "../../../../../lib/server/chat-request";

export const runtime = "nodejs";
const encoder = new TextEncoder();
type GatewayError = { code: string; message: string; status: number };
type ExistingInference = { id: string; status: string; conversation_id: string; model: string; input_tokens: number | null; output_tokens: number | null; metadata: Record<string, unknown> | null };
function error(code: string, message: string, status: number): GatewayError { return { code, message, status }; }
function jsonError(e: GatewayError, requestId: string) { return NextResponse.json({ error: { message: e.message, type: "invalid_request_error", code: e.code }, request_id: requestId }, { status: e.status, headers: { "X-Request-ID": requestId } }); }
function publicModel(model: ModelRow) { return model.slug; }
function completionId() { return `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`; }
function usageShape(usage: InferenceUsage | null) { return { prompt_tokens: usage?.inputTokens ?? 0, completion_tokens: usage?.outputTokens ?? 0, total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) }; }
function abortError(errorValue: unknown) { return errorValue instanceof Error && (errorValue.name === "AbortError" || errorValue.message.toLowerCase().includes("aborted")); }
function requestFingerprint(parsed: { model: string; messages: PublicMessage[]; stream: boolean; parameters: CompletionParameters }) { return createHash("sha256").update(JSON.stringify(parsed)).digest("hex"); }

/**
 * Maps a normalized provider failure onto the gateway's HTTP status.
 *
 * The distinction the PRD cares about is retryable vs. terminal, and the gateway
 * conveys it both in the code and the status: a provider outage is a 503 (safe to
 * retry), a request the provider rejected is a 400/409 (retrying will not help), and
 * a cancellation is 499. Clients branch on `code`; the status keeps plain HTTP
 * consumers correct.
 */
function statusForProviderError(failure: NormalizedProviderError): number {
  switch (failure.code) {
    case "authentication":
    case "unavailable":
    case "upstream":
    case "timeout":
    case "malformed_response":
    case "rate_limited":
      return 503;
    case "model_unavailable":
    case "unsupported_model":
      return 409;
    case "cancelled":
      return 499;
    default:
      return 400;
  }
}

/**
 * Why a curated model is unavailable, in the gateway's normalized vocabulary.
 * A paused model and a provider outage are both `model_unavailable`, but the
 * message is honest about which one it is.
 */
function unavailableMessage(model: ModelRow): string {
  if (model.status === "paused") return `The model ${model.slug} has been paused by an administrator.`;
  if (model.status !== "active") return `The model ${model.slug} is not activated.`;
  return `The model ${model.slug} is unavailable on the active provider right now.`;
}

async function replayOrReject(existing: ExistingInference | undefined, fingerprint: string, requestId: string) {
  if (!existing) return jsonError(error("duplicate_request", "This inference request has already been accepted.", 409), requestId);
  if (existing.metadata?.requestFingerprint !== fingerprint) return jsonError(error("idempotency_key_reused", "This Idempotency-Key was already used with a different request.", 409), requestId);
  if (existing.status === "complete") {
    const assistant = (await query<{ content: string }>("SELECT content FROM messages WHERE inference_id=$1 AND role='assistant' ORDER BY created_at DESC LIMIT 1", [existing.id]))[0];
    if (assistant) return NextResponse.json({ id: completionId(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: existing.model, choices: [{ index: 0, message: { role: "assistant", content: assistant.content }, finish_reason: "stop" }], usage: { prompt_tokens: existing.input_tokens ?? 0, completion_tokens: existing.output_tokens ?? 0, total_tokens: (existing.input_tokens ?? 0) + (existing.output_tokens ?? 0) }, request_id: requestId }, { headers: { "X-Request-ID": requestId } });
  }
  return jsonError(error("duplicate_request", "This inference request has already been accepted.", 409), requestId);
}

/**
 * A reservation that never happened is recorded as a failed, zero-cost turn: the
 * request did not reach a provider, so nothing is billable and the usage event
 * states that explicitly.
 */
async function recordReservationFailure(operationKey: string, accountId: string, inferenceId: string, conversationId: string, requestId: string, reason: string) {
  try {
    await transaction(async db => {
      await db.query("UPDATE inference_records SET status='failed', user_debit_micro_usd=0, reconciliation_required=false, metadata=metadata || $2::jsonb, completed_at=now() WHERE id=$1", [inferenceId, JSON.stringify({ reservationFailure: true, requestId, reason })]);
      await db.query("INSERT INTO inference_usage_events (account_id,inference_id,reservation_id,api_key_id,operation_key,channel,event_type,user_debit_micro_usd,usage_status,metadata) SELECT $1,$2,NULL,api_key_id,$3,channel,'provider_failure',0,'known',$4::jsonb FROM inference_records WHERE id=$2 ON CONFLICT (operation_key,event_type) DO NOTHING", [accountId, inferenceId, operationKey, JSON.stringify({ requestId, reason, conversationId, reservation: "not_created" })]);
    });
  } catch (persistenceError) {
    console.error(JSON.stringify({ event: "inference_reservation_failure_persistence_failed", reconciliation_signal: "reservation_failure_requires_reconciliation", operationKey, inferenceId, conversationId, requestId, error: persistenceError instanceof Error ? persistenceError.name : "UNKNOWN_ERROR" }));
    try {
      await query("UPDATE inference_records SET status='failed', user_debit_micro_usd=0, reconciliation_required=true, metadata=metadata || $2::jsonb, completed_at=now() WHERE id=$1", [inferenceId, JSON.stringify({ reservationFailure: true, persistenceFailure: true, requestId, reason })]);
    } catch (fallbackError) {
      console.error(JSON.stringify({ event: "inference_reservation_failure_reconciliation_signal_failed", reconciliation_signal: "manual_reconciliation_required", operationKey, inferenceId, conversationId, requestId, error: fallbackError instanceof Error ? fallbackError.name : "UNKNOWN_ERROR" }));
    }
  }
}

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
    const clientRequestId = request.headers.get("idempotency-key")?.trim() || null;
    if (clientRequestId && (clientRequestId.length > 255 || /[\u0000-\u001f\u007f]/.test(clientRequestId))) return jsonError(error("invalid_idempotency_key", "Idempotency-Key must be a printable value of 255 characters or fewer.", 400), requestId);
    const fingerprint = requestFingerprint(parsed);
    let key: Awaited<ReturnType<typeof authenticateApiKey>>; try { key = await authenticateApiKey(request.headers.get("authorization"), "chat:write"); } catch (caught) { const e = caught instanceof ApiKeyError ? caught : new ApiKeyError("MALFORMED_BEARER", "A first-party API key is required", 401); return jsonError(error(e.code.toLowerCase(), e.message, e.status), requestId); }
    if (!(await rateLimit(`inference:user:${key.accountId}`, userRateLimit(), 60))) return jsonError(error("rate_limited", "The account inference rate limit has been reached.", 429), requestId);
    if (!(await rateLimit(`inference:key:${key.apiKeyId}`, key.rateLimitPerMinute, 60))) return jsonError(error("rate_limited", "The API key inference rate limit has been reached.", 429), requestId);
    if (clientRequestId) { const existing = await query<ExistingInference>("SELECT id,status,conversation_id,model,input_tokens,output_tokens,metadata FROM inference_records WHERE account_id=$1 AND client_request_id=$2 LIMIT 1", [key.accountId, clientRequestId]); if (existing[0]) return replayOrReject(existing[0], fingerprint, requestId); }
    // Availability is refreshed at most once per health interval, so this is one
    // cheap registry read in steady state. `auto` only ever resolves to a model
    // that is both admin-activated and currently served by the active provider.
    await syncCuratedModels();
    const model = parsed.model === "auto" ? await pickAutoModel() : await getActiveModel(parsed.model);
    if (!model) return jsonError(error("model_unavailable", parsed.model === "auto" ? "No curated model is operational right now." : `The model ${parsed.model} is unavailable on the active provider.`, 400), requestId);
    // Pick up any admin control-plane provider override before resolving the
    // provider, so a runtime switch applies on the next request (in-flight
    // streams keep the provider they started on).
    await refreshProviderSettings();
    // Authorization is identity-based. A signed, scoped first-party API key bound
    // to a Privy-verified account is sufficient; no token-balance, holder-status,
    // or ownership eligibility check is performed here any more.
    const provider = getInferenceProvider();
    if (!(await provider.health()).healthy) return jsonError(error("inference_unavailable", "Inference is temporarily unavailable.", 503), requestId);
    const primaryProviderId = providerIdOf(provider);

    const claim = await transaction(async db => {
      if (clientRequestId) { await db.query("SELECT id FROM user_accounts WHERE id=$1 FOR UPDATE", [key.accountId]); const existing = await db.query<ExistingInference>("SELECT id,status,conversation_id,model,input_tokens,output_tokens,metadata FROM inference_records WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE", [key.accountId, clientRequestId]); if (existing.rows[0]) return { existing: existing.rows[0] }; }
      const conversation = (await db.query<{ id: string }>("INSERT INTO conversations (account_id, title) VALUES ($1,$2) RETURNING id", [key.accountId, parsed.messages.find((item) => item.role === "user")?.content.slice(0, 60) ?? "API completion"])).rows[0];
      const operationKey = crypto.randomUUID();
      const claimed = await db.query<{ id: string }>("INSERT INTO inference_records (account_id,operation_key,provider,model,provider_model,conversation_id,status,markup_micro,metadata,api_key_id,channel,client_request_id) VALUES ($1,$2,$3,$4,$5,$6,'started',$7,$8,$9,'api_key',$10) ON CONFLICT (operation_key) DO NOTHING RETURNING id", [key.accountId, operationKey, model.provider, model.slug, model.provider_model_slug, conversation.id, "2000000", JSON.stringify({ requestId, channel: "api_key", requestFingerprint: fingerprint }), key.apiKeyId, clientRequestId]);
      if (!claimed.rows[0]) throw new Error("Inference claim could not be created");
      return { inferenceId: claimed.rows[0].id, operationKey, conversationId: conversation.id };
    });
    if ("existing" in claim) return replayOrReject(claim.existing, fingerprint, requestId);
    const { inferenceId, operationKey, conversationId } = claim;
    await query("INSERT INTO messages (conversation_id,account_id,role,content) VALUES ($1,$2,'user',$3)", [conversationId, key.accountId, parsed.messages.filter((item) => item.role === "user").at(-1)?.content ?? "API completion"]);

    // METERING — the same conservative-estimate hold as the Playground, so an API
    // client and a browser turn are priced and settled by identical rules.
    const inferenceMessages: InferenceMessage[] = parsed.messages;
    const plan = planTurn(model, inferenceMessages, parsed.parameters);
    await query("UPDATE inference_records SET markup_micro=$2, metadata=metadata || $3::jsonb WHERE id=$1", [inferenceId, plan.policy.markupMicro.toString(), JSON.stringify({ estimate: { tokens: plan.tokens, reservedMicroUsd: plan.estimate.amountMicroUsd.toString(), capped: plan.estimate.capped } })]);
    try {
      await ensureDefaultAllowance(key.accountId);
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : "unknown allowance failure";
      await recordReservationFailure(operationKey, key.accountId, inferenceId, conversationId, requestId, reason);
      return jsonError(error("allowance_unavailable", "The account compute allowance is unavailable.", 403), requestId);
    }
    const reservation = await openReservation(key.accountId, operationKey, plan.estimate.amountMicroUsd, {
      apiKeyId: key.apiKeyId,
      channel: "api_key",
      estimate: { inputTokens: plan.tokens.inputTokens, outputTokens: plan.tokens.outputTokens, providerCostMicroUsd: plan.estimate.providerCostMicroUsd.toString(), userDebitMicroUsd: plan.estimate.userDebitMicroUsd.toString(), capped: plan.estimate.capped },
    });
    if (!reservation.ok) {
      // A blocked hold means no provider work happened, so nothing is debited. The
      // documented `insufficient_compute` code is what an API client branches on.
      await recordReservationFailure(operationKey, key.accountId, inferenceId, conversationId, requestId, reservation.message);
      return jsonError(error("insufficient_compute", "Insufficient available compute for this request. No provider work was started and nothing was charged.", 402), requestId);
    }

    const id = completionId();
    let output = "";
    let finalUsage: InferenceUsage | null = null;
    let finalized = false;
    let finalizing: Promise<unknown> | null = null;
    // Which provider actually served this turn (the failover wrapper tags it on the
    // terminal chunk). Recorded so the ledger and the activity log attribute the
    // tokens — and the cost — to the provider that really produced them.
    let servedBy: string = primaryProviderId;
    let failedOver = false;
    const promptText = inferenceMessages.map((message) => message.content).join("\n");

    /**
     * The single terminal path for the gateway: settle exactly once from the usage
     * the provider reported (or the delivered text for an interrupted turn), persist
     * the assistant content, then mirror the money onto the inference row.
     */
    const finalize = (status: "complete" | "cancelled" | "failed" | "uncertain", usage: InferenceUsage | null) => {
      if (finalized) return Promise.resolve(null as Awaited<ReturnType<typeof settleTurn>> | null);
      if (finalizing) return finalizing as Promise<Awaited<ReturnType<typeof settleTurn>> | null>;
      finalizing = (async () => {
        const correlationId = `${requestId}:${inferenceId}`;
        let outcome: Awaited<ReturnType<typeof settleTurn>>;
        try {
          outcome = await settleTurn(operationKey, model, usage, { status, policy: plan.policy, accountId: key.accountId, correlationId });
        } catch (failure) {
          await reportFinalizationFailure(operationKey, correlationId, "settlement", failure);
          throw failure;
        }
        try {
          if (output) await query("INSERT INTO messages (inference_id,conversation_id,account_id,role,content,partial,model_slug,provider_model,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd) VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (inference_id) WHERE role='assistant' DO NOTHING", [inferenceId, conversationId, key.accountId, output, status !== "complete", model.slug, model.provider_model_slug, usage?.inputTokens ?? null, usage?.outputTokens ?? null, outcome.providerCostMicroUsd, outcome.userDebitMicroUsd]);
        } catch (failure) {
          await reportFinalizationFailure(operationKey, correlationId, "assistant_persistence", failure);
          throw failure;
        }
        try {
          await query("UPDATE inference_records SET status=$2,input_tokens=$3,output_tokens=$4,provider_cost_micro_usd=$5,user_debit_micro_usd=$6,margin_micro_usd=$7,reconciliation_required=$8,served_by_provider=$9,failed_over=$10,completed_at=now(),metadata=metadata || $11::jsonb WHERE operation_key=$1 AND status NOT IN ('complete','cancelled','uncertain')", [operationKey, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, outcome.providerCostMicroUsd, outcome.userDebitMicroUsd, outcome.marginMicroUsd, outcome.uncertain, servedBy, failedOver, JSON.stringify({ finalization: outcome.eventType, requestId })]);
        } catch (failure) {
          await reportFinalizationFailure(operationKey, correlationId, "inference_update", failure);
          throw failure;
        }
        finalized = true;
        return outcome;
      })();
      return finalizing as Promise<Awaited<ReturnType<typeof settleTurn>> | null>;
    };

    const deliveredUsage = (): InferenceUsage | null => (output.length > 0 ? usageForDeliveredText(provider, model, promptText, output) : null);

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    let stopTimer: ReturnType<typeof setInterval> | undefined;
    if (parsed.stream) stopTimer = setInterval(() => { void cacheGet<boolean>(`stop:${operationKey}`).then((stopped) => { if (stopped) controller.abort(); }).catch(() => undefined); }, 250);

    // The abort signal is handed to the provider so a stop (or a client
    // disconnect) tears down the upstream request instead of leaving the model
    // generating for a response nobody will read. A cancellation propagates to
    // whichever provider is currently active inside the failover wrapper.
    const providerRequest = { operationKey, model: model.provider_model_slug, messages: inferenceMessages, parameters: parsed.parameters, signal: controller.signal, cost: plan.costSpec };

    if (parsed.stream) {
      const stream = new ReadableStream({
        async start(streamController) {
          const send = (value: unknown) => { try { streamController.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { controller.abort(); } };
          try {
            for await (const chunk of provider.stream(providerRequest)) {
              if (chunk.type === "delta") {
                output += chunk.text;
                send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: publicModel(model), choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] });
                continue;
              }
              if (chunk.servedBy) servedBy = chunk.servedBy;
              if (chunk.failedOver) failedOver = true;
              if (chunk.type === "complete") {
                finalUsage = normalizedUsageFrom(provider, chunk.usage, { promptText, completionText: chunk.output ?? output });
                if (controller.signal.aborted) { await finalize("cancelled", deliveredUsage()); break; }
                await finalize(chunk.usage.uncertain ? "uncertain" : "complete", finalUsage);
                send({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: publicModel(model), provider: servedBy, failed_over: failedOver, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: usageShape(finalUsage) });
                break;
              }
              // Normalized provider failure. Tokens already delivered are charged (the
              // partial turn is persisted); with none the hold is released in full. The
              // failover wrapper has already tried the fallback where that was allowed,
              // so this is the definitive outcome for the turn.
              const usage = deliveredUsage();
              await finalize(usage ? "cancelled" : "failed", usage);
              send({ error: { message: chunk.error.message, type: chunk.error.retryable ? "server_error" : "invalid_request_error", code: chunk.error.code }, provider: servedBy, failed_over: failedOver });
              break;
            }
          } catch (failure) {
            const normalized = normalizedErrorFromThrown(failure);
            try { await finalize(deliveredUsage() ? "cancelled" : "failed", deliveredUsage()); } catch (finalizationFailure) { await reportFinalizationFailure(operationKey, `${requestId}:${inferenceId}`, "inference_update", finalizationFailure); }
            if (!abortError(failure)) console.error(JSON.stringify({ event: "gateway_stream_interrupted", operationKey, inferenceId, requestId, error: failure instanceof Error ? failure.name : "UNKNOWN_ERROR" }));
            send({ error: { message: normalized.message, type: normalized.retryable ? "server_error" : "invalid_request_error", code: normalized.code } });
          } finally {
            clearInterval(stopTimer);
            request.signal.removeEventListener("abort", abort);
            if (!finalized) {
              try { await finalize(deliveredUsage() ? "cancelled" : "failed", deliveredUsage()); } catch (failure) { await reportFinalizationFailure(operationKey, `${requestId}:${inferenceId}`, "inference_update", failure); }
            }
            send("[DONE]");
            try { streamController.close(); } catch { /* client disconnected */ }
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Request-ID": requestId } });
    }

    try {
      for await (const chunk of provider.stream(providerRequest)) {
        if (chunk.type === "delta") { output += chunk.text; continue; }
        if (chunk.servedBy) servedBy = chunk.servedBy;
        if (chunk.failedOver) failedOver = true;
        if (chunk.type === "complete") { finalUsage = normalizedUsageFrom(provider, chunk.usage, { promptText, completionText: chunk.output ?? output }); continue; }
        const usage = deliveredUsage();
        await finalize(usage ? "cancelled" : "failed", usage);
        return jsonError(error(chunk.error.code, chunk.error.message, statusForProviderError(chunk.error)), requestId);
      }
    } catch (failure) {
      const normalized = abortError(failure) && controller.signal.aborted ? normalizedProviderError("cancelled") : normalizedErrorFromThrown(failure);
      const usage = deliveredUsage();
      await finalize(usage ? "cancelled" : "failed", usage);
      return jsonError(error(normalized.code, normalized.message, statusForProviderError(normalized)), requestId);
    } finally {
      clearInterval(stopTimer);
      request.signal.removeEventListener("abort", abort);
    }
    if (!finalUsage || controller.signal.aborted) {
      const usage = deliveredUsage();
      await finalize(usage ? "cancelled" : "failed", usage);
      return jsonError(error("cancelled", "Inference was cancelled before completion.", 499), requestId);
    }
    try {
      await finalize(finalUsage.uncertain ? "uncertain" : "complete", finalUsage);
    } catch (failure) {
      console.error(JSON.stringify({ event: "gateway_completion_persistence_failed", operationKey, inferenceId, requestId, error: failure instanceof Error ? failure.name : "UNKNOWN_ERROR" }));
      return jsonError(error("inference_persistence_failed", "The provider completed, but the response could not be durably recorded.", 503), requestId);
    }
    return NextResponse.json({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: publicModel(model), provider: servedBy, failed_over: failedOver, choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }], usage: usageShape(finalUsage) }, { headers: { "X-Request-ID": requestId } });
  } catch (caught) {
    console.error("[gateway] request failed", caught instanceof Error ? caught.name : "unknown");
    return jsonError(error("gateway_unavailable", "The inference gateway is temporarily unavailable.", 503), requestId);
  }
}

import { NextResponse } from "next/server";
import { authenticateRequest, AuthenticationError } from "../../../lib/server/auth";
import { reportFinalizationFailure, ensureDefaultAllowance } from "../../../lib/server/accounting";
import { planTurn, openReservation, settleTurn, normalizedUsageFrom, usageForDeliveredText } from "../../../lib/server/metering";
import { modelPolicy } from "../../../lib/server/pricing";
import { query } from "../../../lib/server/db";
import { rateLimit } from "../../../lib/server/redis";
import { clearStop, stopRequested } from "../../../lib/server/inference-stop";
import { getInferenceProvider, providerIdOf } from "../../../lib/server/provider";
import { refreshProviderSettings } from "../../../lib/server/provider-settings";
import { getActiveModel, getModelBySlug, modelAvailabilityStatus, modelIsOperational, pickAutoModel, syncCuratedModels, type ModelRow } from "../../../lib/server/models";
import { resolveIdentityAccess } from "../../../lib/server/holder";
import { userRateLimit } from "../../../lib/server/config";
import { ensureMigrated } from "../../../lib/server/migrate";
import type { InferenceMessage, InferenceUsage, CompletionParameters } from "../../../lib/server/inference";

const encoder = new TextEncoder();
const CONTEXT_LIMIT = 20;
const MAX_MESSAGE_LENGTH = 32_000;
// How often the stream checks for a Stop originating outside this connection
// (another tab, another instance). Cheap: an in-memory lookup plus one optional
// cache read per window, not per token.
const STOP_POLL_DELTAS = 10;

const supported = (model: ModelRow, name: string) => Boolean(model.provider_metadata?.supportedParameters.some((item) => item.toLowerCase() === name.toLowerCase()));

function invalidParameter(message: string, requestId: string) {
  return NextResponse.json({ error: message, code: "INVALID_PARAMETER", retryable: false, requestId }, { status: 400 });
}

/**
 * The Playground's per-turn parameter contract. Every value is validated against
 * what the selected model advertises, so a parameter the provider route cannot
 * honour is rejected here (normalized `INVALID_PARAMETER`) instead of being sent
 * upstream and silently ignored.
 */
function parseParameters(body: Record<string, unknown>, model: ModelRow, requestId: string): CompletionParameters | Response {
  const input = body.parameters;
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalidParameter("parameters must be an object.", requestId);
  const raw = input as Record<string, unknown>;
  const parameters: CompletionParameters = {};
  const providerName = (key: string) => (key === "topP" ? "top_p" : key === "maxTokens" ? "max_tokens" : key);
  const number = (key: "temperature" | "topP" | "maxTokens" | "seed", min: number, max: number, integer = false) => {
    const value = raw[key];
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    if (!supported(model, providerName(key))) throw new Error(`${key} is not supported by the selected model.`);
    (parameters as Record<string, unknown>)[providerName(key)] = value;
  };
  try {
    number("temperature", 0, 2);
    number("topP", 0, 1);
    number("maxTokens", 1, 32768, true);
    number("seed", 0, 2147483647, true);
    if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()) {
      if (raw.systemPrompt.length > 8000) throw new Error("systemPrompt must be 8,000 characters or fewer.");
      parameters.systemPrompt = raw.systemPrompt.trim();
    }
    if (raw.stop !== undefined) {
      if (!Array.isArray(raw.stop) || raw.stop.length > 4 || raw.stop.some((item) => typeof item !== "string" || !item.trim() || item.length > 128)) throw new Error("stop must contain up to four non-empty sequences of 128 characters or fewer.");
      if (!supported(model, "stop")) throw new Error("stop is not supported by the selected model.");
      parameters.stop = raw.stop as string[];
    }
    return parameters;
  } catch (error) {
    return invalidParameter(error instanceof Error ? error.message : "Invalid parameters.", requestId);
  }
}

/**
 * The authoritative available balance, read from the same ledger view the
 * allowance endpoint uses. Reported to the client in every terminal stream event
 * so the Playground balance always reflects what the server actually settled
 * (a stopped turn therefore shows only the tokens that were received).
 */
async function availableBalance(accountId: string): Promise<string | null> {
  try {
    const rows = await query<{ available: string }>(
      `SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0),0)::text AS available FROM compute_ledger_entries WHERE account_id=$1`,
      [accountId]
    );
    return rows[0]?.available ?? null;
  } catch {
    return null;
  }
}

/**
 * Why a curated model cannot serve this turn. Distinguishes an administrator's
 * pause from a provider outage, so the UI can offer the right affordance (wait for
 * a provider vs. ask an operator to re-activate).
 */
function unavailableReason(model: ModelRow): string {
  if (model.status === "paused") return `${model.display_name} has been paused by an administrator. Choose another model.`;
  if (model.status !== "active") return `${model.display_name} is not activated. Choose another model.`;
  const status = modelAvailabilityStatus(model);
  return status === "unavailable"
    ? `${model.display_name} is unavailable on the active provider right now. Choose another model or retry.`
    : `${model.display_name} is not available right now. Choose another model or retry.`;
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    // Identity is the authorization boundary: a verified Privy session or a valid
    // first-party API key.
    const account = await authenticateRequest(request.headers.get("authorization"), "chat:write");
    const isApiKey = Boolean(account.apiKeyId);
    if (!(await rateLimit(`inference:user:${account.accountId}`, userRateLimit(), 60))) {
      return NextResponse.json({ error: "Your account inference rate limit has been reached. Try again shortly.", code: "USER_RATE_LIMITED", retryable: true, requestId }, { status: 429 });
    }
    if (isApiKey && !(await rateLimit(`inference:key:${account.apiKeyId}`, account.rateLimitPerMinute ?? 20, 60))) {
      return NextResponse.json({ error: "This API key's inference rate limit has been reached. Use another key or try again shortly.", code: "KEY_RATE_LIMITED", retryable: true, requestId }, { status: 429 });
    }

    const body = await request.json() as Record<string, unknown>;
    const text = typeof body.message === "string" ? body.message.trim() : "";
    // Empty prompts are rejected here as well as in the client, so a direct call
    // cannot reach a billable path with nothing to answer.
    if (!text) return NextResponse.json({ error: "Message cannot be empty", code: "INVALID_REQUEST", retryable: false, requestId }, { status: 400 });
    if (text.length > MAX_MESSAGE_LENGTH) return NextResponse.json({ error: `Messages must be ${MAX_MESSAGE_LENGTH.toLocaleString()} characters or fewer.`, code: "INVALID_REQUEST", retryable: false, requestId }, { status: 400 });

    // Holder gate. The access policy (lib/server/holder.ts) is the single source of
    // truth for whether billable inference may run for this account; this route
    // asserts it before any conversation, reservation or provider work happens, so
    // an unverified caller can never reach a billable path even if it bypassed the
    // Playground's disabled composer.
    const access = await resolveIdentityAccess(account);
    if (!access.authorized) {
      return NextResponse.json({ error: "Holder access has not been confirmed for this account. Verify access before inference.", code: "ACCESS_REQUIRED", retryable: false, requestId }, { status: 403 });
    }

    const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() || null : null;
    // Availability refresh is throttled to the health interval, so this is one
    // registry read in steady state rather than a live GPU probe per turn.
    await syncCuratedModels();

    // Model routing. "auto" (or an omitted model) resolves to the server-selected
    // best operational model; an explicit slug must resolve to an operational row.
    // A curated model that exists but is paused / has no live provider route reports
    // the normalized `MODEL_UNAVAILABLE`, which the Playground turns into a
    // retryable "switch model" affordance rather than a bare error.
    const requestedSlug = typeof body.model === "string" ? body.model.trim() : "";
    const autoSelected = !requestedSlug || requestedSlug === "auto";
    const model: ModelRow | null = autoSelected ? await pickAutoModel() : await getActiveModel(requestedSlug);
    if (!model) {
      const known = autoSelected ? null : await getModelBySlug(requestedSlug);
      const message = autoSelected
        ? "No curated model is operational right now. Try again shortly or pick a model."
        : known
          ? unavailableReason(known)
          : "That model is not in the curated registry. Choose another model.";
      return NextResponse.json({ error: message, code: "MODEL_UNAVAILABLE", retryable: true, modelUnavailable: true, model: requestedSlug || "auto", requestId }, { status: autoSelected ? 503 : 409 });
    }
    // The registry is the gate: an admin-paused model, or one whose provider route
    // is unavailable, is rejected here even if the client still offers it. A
    // request already streaming is unaffected — it keeps the model it started on.
    if (!modelIsOperational(model)) {
      return NextResponse.json({ error: unavailableReason(model), code: "MODEL_UNAVAILABLE", retryable: true, modelUnavailable: true, model: model.slug, requestId }, { status: 409 });
    }

    const parameters = parseParameters(body, model, requestId);
    if (parameters instanceof Response) return parameters;

    // Pick up any admin control-plane provider override before resolving which
    // provider serves this turn. The override is cached briefly, so this is one
    // cheap read per window rather than per request.
    await refreshProviderSettings();
    const provider = getInferenceProvider();
    const health = await provider.health();
    if (!health.healthy) {
      return NextResponse.json({ error: "Inference is temporarily degraded. Please try again shortly.", code: "PROVIDER_DEGRADED", retryable: true, requestId }, { status: 503 });
    }

    const derivedTitle = text.slice(0, 60);
    const conversationId = typeof body.conversationId === "string" && body.conversationId
      ? body.conversationId
      : (await query<{ id: string }>(`INSERT INTO conversations (account_id, title) VALUES ($1,$2) RETURNING id`, [account.accountId, derivedTitle]))[0].id;
    const owned = await query(`SELECT id FROM conversations WHERE id=$1 AND account_id=$2`, [conversationId, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Conversation not found", code: "NOT_FOUND", retryable: false, requestId }, { status: 404 });
    if (typeof body.conversationId === "string") {
      await query(`UPDATE conversations SET title=$3 WHERE id=$1 AND account_id=$2 AND (title IS NULL OR title IN ('Untitled conversation','New conversation'))`, [conversationId, account.accountId, derivedTitle]);
    }

    // Idempotency: a retry that reuses the same operation key is answered with 409
    // instead of debiting twice. A genuine retry after a failure uses a fresh key,
    // so its reservation is independent of the failed attempt's (already released) one.
    const operationKey = typeof body.operationKey === "string" && body.operationKey.trim() ? body.operationKey.trim() : clientRequestId || requestId;
    const duplicate = await query<{ id: string; status: string; conversation_id: string }>(
      `SELECT id,status,conversation_id FROM inference_records WHERE operation_key=$1 OR ($2::text IS NOT NULL AND account_id=$3 AND client_request_id=$2) LIMIT 1`,
      [operationKey, clientRequestId, account.accountId]
    );
    if (duplicate[0]) {
      return NextResponse.json({ error: "This inference request has already been accepted", code: "DUPLICATE_REQUEST", retryable: false, requestId, operationKey, status: duplicate[0].status, conversationId: duplicate[0].conversation_id }, { status: 409 });
    }

    const channel = isApiKey ? "api_key" : "app";
    const markupMicro = modelPolicy(model).markupMicro;
    const claimed = await query<{ id: string; status: string; conversation_id: string }>(
      `INSERT INTO inference_records (account_id, operation_key, provider, model, provider_model, conversation_id, status, markup_micro, metadata, api_key_id, channel, client_request_id) VALUES ($1,$2,$3,$4,$5,$6,'started',$7,$8,$9,$10,$11) ON CONFLICT (operation_key) DO NOTHING RETURNING id,status,conversation_id`,
      [account.accountId, operationKey, model.provider, model.slug, model.provider_model_slug, conversationId, markupMicro.toString(), JSON.stringify({ requestId, channel, apiKeyId: account.apiKeyId ?? null, parameters, autoSelected }), account.apiKeyId ?? null, channel, clientRequestId]
    );
    if (!claimed[0]) {
      return NextResponse.json({ error: "This inference request has already been accepted", code: "DUPLICATE_REQUEST", retryable: false, requestId, operationKey, conversationId }, { status: 409 });
    }
    const inferenceId = claimed[0].id;

    const priorRows = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM messages WHERE conversation_id=$1 AND partial=false ORDER BY created_at ASC LIMIT $2`,
      [conversationId, CONTEXT_LIMIT]
    );
    const systemPrompt: InferenceMessage = { role: "system", content: typeof parameters.systemPrompt === "string" ? parameters.systemPrompt : "You are Openweight, a helpful AI assistant. Always respond in the same language the user writes in. If the user's language is unclear, respond in English. Do not default to Chinese." };
    const providerParameters = { ...parameters };
    delete (providerParameters as Record<string, unknown>).systemPrompt;
    const contextMessages: InferenceMessage[] = [systemPrompt, ...priorRows.map((row) => ({ role: row.role, content: row.content })), { role: "user", content: text }];
    await query(`INSERT INTO messages (conversation_id,account_id,role,content) VALUES ($1,$2,'user',$3)`, [conversationId, account.accountId, text]);

    // METERING — plan the turn, then hold compute BEFORE any provider work.
    //
    // The hold is sized from a conservative estimate (pessimistic prompt count,
    // completion assumed at its ceiling) and is all-or-nothing, so a request that
    // cannot cover it never reaches the provider and is never billable. The
    // registry's published per-token rate travels with the request so cost() charges
    // exactly what the model card advertises.
    const plan = planTurn(model, contextMessages, parameters);
    await query(`UPDATE inference_records SET markup_micro=$2, metadata=metadata || $3::jsonb WHERE id=$1`, [inferenceId, plan.policy.markupMicro.toString(), JSON.stringify({ estimate: { tokens: plan.tokens, reservedMicroUsd: plan.estimate.amountMicroUsd.toString(), capped: plan.estimate.capped } })]);
    try {
      await ensureDefaultAllowance(account.accountId);
    } catch (error) {
      console.error(JSON.stringify({ event: "inference_allowance_unavailable", operationKey, requestId, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
      await query(`UPDATE inference_records SET status='failed', user_debit_micro_usd=0, reconciliation_required=false, completed_at=now(), metadata=metadata || $2::jsonb WHERE id=$1`, [inferenceId, JSON.stringify({ failure: "allowance_unavailable", requestId })]);
      return NextResponse.json({ error: "Your compute allowance is unavailable. No provider work was started.", code: "ALLOWANCE_UNAVAILABLE", retryable: true, requestId }, { status: 403 });
    }
    const reservation = await openReservation(account.accountId, operationKey, plan.estimate.amountMicroUsd, {
      apiKeyId: account.apiKeyId,
      channel,
      estimate: { inputTokens: plan.tokens.inputTokens, outputTokens: plan.tokens.outputTokens, providerCostMicroUsd: plan.estimate.providerCostMicroUsd.toString(), userDebitMicroUsd: plan.estimate.userDebitMicroUsd.toString(), capped: plan.estimate.capped },
    });
    if (!reservation.ok) {
      // Nothing was reserved, so nothing reached a provider: the turn is failed and
      // costs zero. `insufficient_compute` is the documented, non-retryable block.
      await query(`UPDATE inference_records SET status='failed', user_debit_micro_usd=0, reconciliation_required=false, completed_at=now(), metadata=metadata || $2::jsonb WHERE id=$1`, [inferenceId, JSON.stringify({ failure: reservation.code, requestId })]);
      const status = reservation.code === "INSUFFICIENT_COMPUTE" ? 402 : 403;
      return NextResponse.json({
        error: reservation.code === "INSUFFICIENT_COMPUTE" ? "Not enough available compute for this request. Your balance has not been charged." : reservation.message,
        code: reservation.code === "INSUFFICIENT_COMPUTE" ? "insufficient_compute" : reservation.code,
        retryable: false,
        requestId,
        conversationId,
      }, { status });
    }

    // The registry's per-token rate is handed to the provider so cost() charges the
    // price the Overview card advertises, for providers whose own cost model is
    // deployment-wide (a rented vast.ai GPU).
    const costSpec = plan.costSpec;
    // Cancellation: this controller is the single seam the "Stop" button drives.
    // Aborting it tears down the upstream HTTP request inside the provider (so a
    // rented GPU stops generating), and the provider then emits its terminal
    // cancellation event so the partial turn is persisted as cancelled.
    const providerAbort = new AbortController();
    const abortUpstream = () => providerAbort.abort();
    if (request.signal.aborted) providerAbort.abort();
    else request.signal.addEventListener("abort", abortUpstream, { once: true });

    const promptText = contextMessages.map((message) => message.content).join("\n");
    const primaryProviderId = providerIdOf(provider);

    const stream = new ReadableStream({
      async start(controller) {
        let output = "";
        let settled = false;
        let deltas = 0;
        let stopObserved = false;
        // Which provider actually served this turn. The failover wrapper tags every
        // terminal chunk, so a turn that failed over is attributed to the provider
        // that really produced the tokens (and whose cost the ledger recorded).
        let servedBy: string = primaryProviderId;
        let failedOver = false;
        const send = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            providerAbort.abort();
          }
        };

        // One terminal path for every ending: settle exactly once from the usage
        // the provider actually reported (or, for an interrupted turn, from the
        // tokens actually delivered), persist what was delivered, then report the
        // authoritative balance. `settleTurn` caps the debit at the hold and its
        // ledger pair is idempotent, so a reconnect or a retry settles once.
        const finalize = async (status: "complete" | "cancelled" | "failed" | "uncertain", usage: InferenceUsage | null) => {
          if (settled) return null;
          const correlationId = `${requestId}:${inferenceId}`;
          let outcome: Awaited<ReturnType<typeof settleTurn>>;
          try {
            outcome = await settleTurn(operationKey, model, usage, { status, policy: plan.policy, accountId: account.accountId, correlationId });
          } catch (error) {
            await reportFinalizationFailure(operationKey, correlationId, "settlement", error);
            throw error;
          }
          const debit = outcome.userDebitMicroUsd;
          try {
            if (output) {
              await query(
                `INSERT INTO messages (inference_id,conversation_id,account_id,role,content,partial,model_slug,provider_model,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd) VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (inference_id) WHERE role='assistant' DO NOTHING`,
                [inferenceId, conversationId, account.accountId, output, status !== "complete", model.slug, model.provider_model_slug, usage?.inputTokens ?? null, usage?.outputTokens ?? null, outcome.providerCostMicroUsd, debit]
              );
            }
          } catch (error) {
            await reportFinalizationFailure(operationKey, correlationId, "assistant_persistence", error);
            throw error;
          }
          try {
            await query(
              `UPDATE inference_records SET status=$2, input_tokens=$3, output_tokens=$4, provider_cost_micro_usd=$5, user_debit_micro_usd=$6, margin_micro_usd=$7, reconciliation_required=$8, served_by_provider=$9, failed_over=$10, completed_at=now() WHERE operation_key=$1`,
              [operationKey, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, outcome.providerCostMicroUsd, debit, outcome.marginMicroUsd, outcome.uncertain, servedBy, failedOver]
            );
            await query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [conversationId]);
          } catch (error) {
            await reportFinalizationFailure(operationKey, correlationId, "inference_update", error);
            throw error;
          }
          settled = true;
          return { userDebit: debit, available: outcome.availableMicroUsd ?? (await availableBalance(account.accountId)), margin: outcome.marginMicroUsd };
        };

        /** Usage for an interrupted turn: the tokens actually delivered, priced at
         *  the registry rate. A cancelled turn therefore debits only what arrived. */
        const deliveredUsage = (): InferenceUsage | null => (output.length > 0 ? usageForDeliveredText(provider, model, promptText, output) : null);

        const cancelledEvent = (balance: string | null) => ({
          type: "cancelled" as const,
          conversationId,
          requestId,
          model: { id: model.slug, displayName: model.display_name },
          provider: servedBy,
          failedOver,
          balance,
          error: output.length > 0 ? "Generation stopped. The visible response is partial." : "Generation stopped before any content arrived.",
        });

        // Resolve the model up front so the client can render which model (and
        // provider route) is actually serving, including for "Auto".
        send({
          type: "started",
          requestId,
          operationKey,
          conversationId,
          model: { id: model.slug, displayName: model.display_name, provider: model.provider, contextLength: model.context_length ?? model.provider_metadata?.contextLength ?? null },
          autoSelected,
          reservedMicroUsd: reservation.reservedMicroUsd.toString(),
        });

        try {
          for await (const chunk of provider.stream({ operationKey, model: model.provider_model_slug, messages: contextMessages, parameters: providerParameters, signal: providerAbort.signal, cost: costSpec })) {
            // A provider can emit a delta after the caller aborted (the abort races
            // the upstream read); never deliver it.
            if (providerAbort.signal.aborted) break;
            if (chunk.type === "delta") {
              output += chunk.text;
              deltas += 1;
              send({ type: "delta", text: chunk.text });
              // Cross-connection stop: a Stop pressed in another tab or served by
              // another instance is registered out of band, so this turn must
              // observe it even when the browser's abort never arrived here.
              if (deltas % STOP_POLL_DELTAS === 0 && await stopRequested(operationKey)) {
                stopObserved = true;
                providerAbort.abort();
                break;
              }
            } else if (chunk.type === "complete") {
              // The failover wrapper tells us which provider produced this answer.
              if (chunk.servedBy) servedBy = chunk.servedBy;
              if (chunk.failedOver) failedOver = true;
              // The provider's own usage() fills in token counts the upstream omitted
              // (and flags an estimate), which is what the ledger prices.
              const usage = normalizedUsageFrom(provider, chunk.usage, { promptText, completionText: chunk.output ?? output });
              const settledUsage = await finalize(chunk.usage.uncertain ? "uncertain" : "complete", usage);
              send({
                type: "complete",
                conversationId,
                requestId,
                model: { id: model.slug, displayName: model.display_name, provider: model.provider },
                // Provider that actually served the tokens, and whether failover ran.
                provider: servedBy,
                failedOver,
                usage: { inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null },
                userDebitMicroUsd: settledUsage?.userDebit ?? null,
                marginMicroUsd: settledUsage?.margin ?? null,
                balance: settledUsage?.available ?? null,
                uncertain: chunk.usage.uncertain,
              });
            } else if (chunk.error.code === "cancelled") {
              if (chunk.servedBy) servedBy = chunk.servedBy;
              const usage = deliveredUsage();
              const settledUsage = await finalize(output.length > 0 ? "cancelled" : "failed", usage);
              send(cancelledEvent(settledUsage?.available ?? null));
            } else {
              // Normalized provider failure (model_unavailable, timeout, upstream...).
              // Tokens that were already delivered are paid for; when nothing arrived
              // the reservation is released in full and the turn costs nothing, so a
              // retry starts from the same balance.
              if (chunk.servedBy) servedBy = chunk.servedBy;
              if (chunk.failedOver) failedOver = true;
              const usage = deliveredUsage();
              const settledUsage = await finalize(usage ? "cancelled" : "failed", usage);
              send({
                type: "error",
                code: chunk.error.code,
                error: chunk.error.message,
                retryable: chunk.error.retryable,
                modelUnavailable: chunk.error.code === "model_unavailable",
                // Both are required for the UI's Retry affordance to be honest: a
                // retryable outage offers Retry, a terminal one does not.
                provider: servedBy,
                failedOver,
                conversationId,
                requestId,
                balance: settledUsage?.available ?? null,
              });
            }
          }
          if (stopObserved) {
            await provider.cancel(operationKey).catch(() => undefined);
            const settledUsage = await finalize(output.length > 0 ? "cancelled" : "failed", deliveredUsage());
            send(cancelledEvent(settledUsage?.available ?? null));
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "inference_stream_finalization_failed", operationKey, inferenceId, requestId, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
          send({ type: "error", code: "unavailable", error: "Inference could not be completed.", retryable: true, provider: servedBy, failedOver, conversationId, requestId, balance: null });
        } finally {
          request.signal.removeEventListener("abort", abortUpstream);
          clearStop(operationKey);
          if (!settled) {
            try {
              // The client went away (Stop, tab close, network drop) while content
              // had already arrived: charge only what the user actually saw and
              // persist it as a cancelled partial rather than losing it. With no
              // content the hold is released in full.
              const usage = deliveredUsage();
              const settledUsage = await finalize(usage ? "cancelled" : "failed", usage);
              if (usage) send(cancelledEvent(settledUsage?.available ?? null));
            } catch (error) {
              console.error(JSON.stringify({ event: "inference_finalization_failed", operationKey, inferenceId, requestId, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
            }
          }
          try {
            controller.close();
          } catch {
            /* the client already disconnected */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Request-ID": requestId,
      },
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: error.message, code: error.code, retryable: false, requestId }, { status: error.code === "INSUFFICIENT_SCOPE" ? 403 : 401 });
    }
    console.error("[chat] inference request failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Inference is unavailable. No provider work was started.", code: "INFERENCE_UNAVAILABLE", retryable: true, requestId }, { status: 503 });
  }
}

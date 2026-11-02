import { meteringConfig, pricingConfig } from "./config";
import { availableMicroUsd, adjustSettlement, releaseReservation, reserveCompute, settleReservation, AccountingError, type MicroUsd, type SettlementEvent } from "./accounting";
import type { InferenceMessage, InferenceProvider, InferenceUsage, ModelCostSpec, TokenUsage } from "./inference";
import { registryCostSpec, type ModelRow } from "./models";
import { computeUserDebit, grossMargin, modelPolicy, type PricingPolicy } from "./pricing";
import { query } from "./db";

// Compute metering & settlement (PRD: atomic reservation, exact settlement,
// append-only ledger, margin per inference, idempotent retries).
//
// One module owns the money path for an inference turn, so the Playground and
// the public API gateway settle identically:
//
//   estimateTokens()     — a deliberately CONSERVATIVE token estimate, used to
//                          size the hold before any provider work happens.
//   openReservation()    — the atomic hold itself (delegates to accounting).
//   settleTurn()         — settle from the provider's own usage() × registry
//                          pricing × markup, release the unused hold, record
//                          margin, and append to the ledger exactly once.
//   reconcilePending()   — the worker path for holds that never settled and for
//                          settlements that were recorded uncertain.
//
// Everything is integer micro-USD. Nothing here reads or writes a float into a
// balance-affecting column.

const MICRO = 1_000_000n;

/**
 * The provider `usage()` transport, including the optional fallback text a
 * rented-GPU provider uses to estimate counts the upstream omitted.
 *
 * Declared here because the normalized `CompletionProvider` contract only names
 * the documented single-argument form; VastAIProvider additionally accepts the
 * text to estimate from, which is exactly what settlement needs.
 */
type UsageFunction = (response: unknown, fallback?: { promptText?: string; completionText?: string }) => TokenUsage & { estimated: boolean };

function usageFunctionOf(provider: InferenceProvider): UsageFunction | null {
  const candidate = (provider as { usage?: unknown }).usage;
  return typeof candidate === "function" ? (candidate as UsageFunction) : null;
}

/**
 * A conservative estimate of one turn's tokens.
 *
 * The prompt is measured pessimistically (METERING_PROMPT_CHARS_PER_TOKEN, which
 * is fewer characters per token than any real tokenizer) plus per-message framing
 * overhead, and the completion is assumed to run all the way to its requested
 * ceiling. Over-estimating an unclear hold is safe — it is released at
 * settlement — while under-estimating would let a request spend beyond its hold.
 */
export function estimateTokens(messages: InferenceMessage[], parameters: { max_tokens?: number; max_completion_tokens?: number } = {}): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const cfg = meteringConfig();
  let inputTokens = 0;
  for (const message of messages) {
    inputTokens += Math.ceil((message.content?.length ?? 0) / cfg.promptCharsPerToken) + cfg.promptMessageOverheadTokens;
  }
  const ceiling = parameters.max_tokens ?? parameters.max_completion_tokens;
  const outputTokens = typeof ceiling === "number" && ceiling > 0 ? Math.floor(ceiling) : cfg.defaultCompletionTokens;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** The registry's per-token rate for a model, or null when it publishes none. */
export function modelTokenRates(model: ModelRow | null | undefined): { prompt: number; completion: number } | null {
  if (!model) return null;
  const prompt = model.prompt_usd_per_token == null ? null : Number(model.prompt_usd_per_token);
  const completion = model.completion_usd_per_token == null ? null : Number(model.completion_usd_per_token);
  if (prompt === null && completion === null) return null;
  return { prompt: prompt ?? 0, completion: completion ?? 0 };
}

/**
 * The provider cost of a token count at the registry's published rate, in
 * micro-USD. Rounded once, so the ledger never receives a fractional unit.
 */
export function providerCostForTokens(tokens: { inputTokens: number; outputTokens: number }, rates: { prompt: number; completion: number }): MicroUsd {
  const micro = Number(tokens.inputTokens) * rates.prompt * 1_000_000 + Number(tokens.outputTokens) * rates.completion * 1_000_000;
  if (!Number.isFinite(micro) || micro <= 0) return 0n;
  const rounded = BigInt(Math.round(micro));
  return rounded > 0n ? rounded : 1n;
}

/**
 * The conservative hold for one turn: provider cost × markup, padded by the
 * safety factor, floored at the configured minimum, and capped at the per-turn
 * reservation cap so one request can never lock the whole allowance.
 */
export function reservationEstimate(tokens: { inputTokens: number; outputTokens: number }, policy: PricingPolicy, model: ModelRow | null | undefined): { amountMicroUsd: MicroUsd; providerCostMicroUsd: MicroUsd; userDebitMicroUsd: MicroUsd; capped: boolean } {
  const cfg = meteringConfig();
  const pricing = pricingConfig();
  const rates = modelTokenRates(model) ?? { prompt: 0.5 / 1_000_000, completion: 1.5 / 1_000_000 };
  const providerCostMicroUsd = providerCostForTokens(tokens, rates);
  const userDebitMicroUsd = computeUserDebit(providerCostMicroUsd, policy);
  const padded = (userDebitMicroUsd * cfg.safetyMicro) % MICRO === 0n ? (userDebitMicroUsd * cfg.safetyMicro) / MICRO : (userDebitMicroUsd * cfg.safetyMicro) / MICRO + 1n;
  const floored = padded > cfg.minReservationMicroUsd ? padded : cfg.minReservationMicroUsd;
  const capped = floored > pricing.reservationCapMicroUsd ? pricing.reservationCapMicroUsd : floored;
  return { amountMicroUsd: capped, providerCostMicroUsd, userDebitMicroUsd, capped: capped !== floored };
}

export type TurnPlan = {
  policy: PricingPolicy;
  costSpec: ModelCostSpec | null;
  estimate: ReturnType<typeof reservationEstimate>;
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
};

/** Everything the request path needs to price and hold one turn. */
export function planTurn(model: ModelRow, messages: InferenceMessage[], parameters: { max_tokens?: number; max_completion_tokens?: number } = {}): TurnPlan {
  const policy = modelPolicy(model);
  const tokens = estimateTokens(messages, parameters);
  return { policy, costSpec: registryCostSpec(model), estimate: reservationEstimate(tokens, policy, model), tokens };
}

/**
 * Normalizes the usage reported by a provider, preferring the provider's own
 * `usage()` contract.
 *
 * `VastAIProvider.usage()` is the authority for a rented GPU: a vLLM server may
 * omit the usage frame entirely, in which case usage() estimates the counts from
 * the prompt and the delivered text and flags the result `estimated` so the
 * ledger records it for reconciliation. A provider with its own per-response cost
 * (OpenRouter) keeps whatever it reported.
 */
export function normalizedUsageFrom(provider: InferenceProvider, reported: InferenceUsage | null, fallbackText: { promptText?: string; completionText?: string } = {}): InferenceUsage | null {
  const usageFn = usageFunctionOf(provider);
  if (!usageFn) return reported;
  const missing = reported == null || reported.inputTokens == null || reported.outputTokens == null;
  if (!missing) return reported;
  try {
    const usage = usageFn.call(provider, reported, fallbackText);
    return {
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      providerCostMicroUsd: reported?.providerCostMicroUsd ?? null,
      // An estimate is never treated as known usage.
      uncertain: reported?.uncertain === true || usage.estimated,
    };
  } catch {
    return reported;
  }
}

/**
 * Usage for a turn that was interrupted (Stop, disconnect, provider failure) after
 * delivering content: the tokens that were actually received, priced at the
 * registry rate the model card publishes.
 *
 * This is what makes a cancelled turn debit only what arrived. Returns null when
 * nothing was delivered, which settles as zero.
 */
export function usageForDeliveredText(provider: InferenceProvider, model: ModelRow | null | undefined, promptText: string, completionText: string): InferenceUsage | null {
  if (!completionText) return null;
  const rates = modelTokenRates(model) ?? { prompt: 0.5 / 1_000_000, completion: 1.5 / 1_000_000 };
  const usageFn = usageFunctionOf(provider);
  let tokens: { inputTokens: number; outputTokens: number; estimated: boolean };
  if (usageFn) {
    try {
      const usage = usageFn.call(provider, null, { promptText, completionText });
      tokens = { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, estimated: usage.estimated };
    } catch {
      const estimate = estimateTokens([{ role: "user", content: promptText }, { role: "assistant", content: completionText }]);
      tokens = { inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, estimated: true };
    }
  } else {
    const estimate = estimateTokens([{ role: "user", content: promptText }, { role: "assistant", content: completionText }]);
    tokens = { inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens, estimated: true };
  }
  const providerCostMicroUsd = providerCostForTokens(tokens, rates);
  return { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens, providerCostMicroUsd, uncertain: tokens.estimated };
}

export type OpenReservationResult =
  | { ok: true; reservedMicroUsd: MicroUsd; availableMicroUsd: MicroUsd }
  | { ok: false; code: "INSUFFICIENT_COMPUTE" | "ALLOWANCE_MISSING" | "ALLOWANCE_EXPIRED" | "ACCOUNTING_ERROR"; message: string };

/**
 * Opens the atomic hold for a turn.
 *
 * A rejection is returned rather than thrown, so both request paths can map it
 * to the documented `insufficient_compute` response without unwrapping the
 * transaction error. A rejected hold means the request NEVER reached a provider,
 * so nothing is billable.
 */
export async function openReservation(accountId: string, operationKey: string, amountMicroUsd: MicroUsd, options: { apiKeyId?: string; channel?: "app" | "api_key" | "gpu"; estimate?: Record<string, unknown> } = {}): Promise<OpenReservationResult> {
  try {
    await reserveCompute(accountId, operationKey, amountMicroUsd, { apiKeyId: options.apiKeyId, channel: options.channel, metadata: { estimate: options.estimate ?? null } });
    return { ok: true, reservedMicroUsd: amountMicroUsd, availableMicroUsd: await availableMicroUsd(accountId) };
  } catch (error) {
    const cause = accountingErrorOf(error);
    if (cause) return { ok: false, code: cause.code as "INSUFFICIENT_COMPUTE", message: cause.message };
    return { ok: false, code: "ACCOUNTING_ERROR", message: "Compute could not be reserved for this request." };
  }
}

/** Unwraps the AccountingError a reserve/settle call raised (through transaction()). */
export function accountingErrorOf(error: unknown): AccountingError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof AccountingError) return current;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

export type SettlementOutcome = {
  eventType: SettlementEvent;
  providerCostMicroUsd: string | null;
  userDebitMicroUsd: string;
  marginMicroUsd: string | null;
  unbilledMicroUsd: string;
  uncertain: boolean;
  availableMicroUsd: string | null;
};

/**
 * Settles a turn from the usage the provider actually reported.
 *
 *   completed            → debit = usage × registry rate × markup
 *   cancelled / partial  → the same, from the tokens actually received, so the
 *                          balance reflects exactly the partial usage
 *   failed (no tokens)   → debit 0, the whole hold is released
 *   zero-token complete  → debit 0, the whole hold is released
 *
 * A turn whose usage had to be ESTIMATED (the upstream omitted its usage frame,
 * or the stream was interrupted before the final frame arrived) is still charged —
 * refusing to charge would let an interrupted turn be free — but the settlement is
 * flagged so the reconciliation worker can correct it from late usage, appending
 * only the difference.
 *
 * The debit is capped at the hold (an overage becomes recorded `unbilled` margin
 * loss rather than a negative balance), and the ledger entries carry a
 * per-operation idempotency key, so a reconnect or a worker retry settles once.
 */
export async function settleTurn(operationKey: string, model: ModelRow, usage: InferenceUsage | null, options: { status: "complete" | "cancelled" | "failed" | "uncertain"; eventType?: SettlementEvent; policy: PricingPolicy; accountId: string; correlationId?: string }): Promise<SettlementOutcome> {
  const eventType: SettlementEvent = options.eventType ?? (options.status === "complete" ? "provider_usage" : options.status === "cancelled" ? "cancelled" : options.status === "uncertain" ? "uncertain" : "provider_failure");
  const providerCost = usage?.providerCostMicroUsd ?? null;
  const receivedTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

  // Zero tokens (a failed turn, or a completion that produced nothing) is never
  // billable: the reservation is released in full and the turn costs zero.
  if (options.status === "failed" || receivedTokens === 0 || usage == null || providerCost == null) {
    const released = await releaseReservation(operationKey, options.status === "failed" ? "provider_failure" : eventType, { reason: "no_tokens_settled", correlationId: options.correlationId ?? null });
    await mirrorReservationOnInference(operationKey, released);
    return {
      eventType: options.status === "failed" ? "provider_failure" : eventType,
      providerCostMicroUsd: providerCost?.toString() ?? null,
      userDebitMicroUsd: "0",
      marginMicroUsd: null,
      unbilledMicroUsd: String(released?.unbilled_micro_usd ?? "0"),
      uncertain: false,
      availableMicroUsd: (await availableMicroUsd(options.accountId)).toString(),
    };
  }

  // Charge what was actually received. `uncertain` does not suppress the debit:
  // it records that the number may still be corrected by reconciliation.
  const uncertain = options.status === "uncertain" || Boolean(usage.uncertain);
  const debit = computeUserDebit(providerCost, options.policy);
  const settled = await settleReservation(operationKey, debit, providerCost, uncertain, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    eventType,
    markupMicro: options.policy.markupMicro,
    metadata: { correlationId: options.correlationId ?? null, accountId: options.accountId, estimated: Boolean(usage.uncertain) },
  });
  await mirrorReservationOnInference(operationKey, settled);
  return {
    eventType,
    providerCostMicroUsd: providerCost.toString(),
    userDebitMicroUsd: String(settled?.settled_micro_usd ?? "0"),
    marginMicroUsd: settled?.margin_micro_usd == null ? null : String(settled.margin_micro_usd),
    unbilledMicroUsd: String(settled?.unbilled_micro_usd ?? "0"),
    uncertain,
    availableMicroUsd: (await availableMicroUsd(options.accountId)).toString(),
  };
}

/**
 * Copies the settled money onto the inference row, so a single read (the activity
 * list, the operator margin report) shows provider cost, debit and margin together
 * without joining the ledger.
 */
async function mirrorReservationOnInference(operationKey: string, reservation: { status?: string; settled_micro_usd?: string; margin_micro_usd?: string | null } | null | undefined): Promise<void> {
  if (!reservation) return;
  try {
    await query(
      `UPDATE inference_records SET reservation_status=$2, margin_micro_usd=$3 WHERE operation_key=$1`,
      [operationKey, reservation.status ?? null, reservation.margin_micro_usd == null ? null : String(reservation.margin_micro_usd)]
    );
  } catch {
    // The money already moved; a mirror failure must not fail the turn. The
    // reconciliation report reads the settled reservation rows, not this column.
  }
}

/** What the durable record justifies for one operation, used by reconciliation. */
type RecordedUsage = {
  tokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  providerCostMicroUsd: MicroUsd | null;
  debitMicroUsd: MicroUsd;
};

/**
 * One reconciliation pass over unsettled money:
 *
 *   1. holds that are still `reserved` past the reconciliation window (the stream
 *      process died before finalizing) are settled from whatever the inference
 *      record durably captured — zero tokens when it captured nothing, which
 *      releases the hold in full;
 *   2. settlements recorded `uncertain` are re-priced from the stored usage and
 *      corrected with an APPENDED adjustment, never a rewrite.
 *
 * Both paths are idempotent: re-running the worker (a crashed run, an overlapping
 * cron) cannot double settle, because settlement keys are unique and only a
 * `reserved`/`uncertain` row is transitioned.
 */
export async function reconcilePending(limit?: number): Promise<{ released: number; reconciled: number; skipped: number }> {
  const cfg = meteringConfig();
  const batch = limit ?? cfg.reconcileBatch;
  let released = 0;
  let reconciled = 0;
  let skipped = 0;

  // 1. Dangling holds.
  const dangling = await query<{ operation_key: string; account_id: string }>(
    `SELECT r.operation_key, r.account_id
       FROM compute_reservations r
      WHERE r.status='reserved' AND r.created_at < now() - make_interval(secs => $1)
      ORDER BY r.created_at ASC LIMIT $2`,
    [cfg.reconcileAfterSeconds, batch]
  );
  for (const row of dangling) {
    try {
      const usage = await recordedUsage(row.operation_key);
      if (usage.tokens === 0) {
        await releaseReservation(row.operation_key, "uncertain", { reason: "reconciliation_no_usage", reconciled: true });
        released += 1;
      } else {
        await adjustSettlement(row.operation_key, usage.debitMicroUsd, usage.providerCostMicroUsd, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, metadata: { reason: "reconciliation_late_usage" } });
        reconciled += 1;
      }
    } catch (error) {
      skipped += 1;
      console.error(JSON.stringify({ event: "compute_reconciliation_failed", operationKey: row.operation_key, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
    }
  }

  // 2. Uncertain settlements, bounded by the attempt ceiling so an
  //    unreconcilable row cannot spin forever.
  const uncertain = await query<{ operation_key: string; account_id: string }>(
    `SELECT operation_key, account_id
       FROM compute_reservations
      WHERE status='uncertain' AND reconciliation_attempts < $1 AND settled_at < now() - make_interval(secs => $2)
      ORDER BY settled_at ASC LIMIT $3`,
    [cfg.maxReconcileAttempts, cfg.reconcileAfterSeconds, batch]
  );
  for (const row of uncertain) {
    try {
      const usage = await recordedUsage(row.operation_key);
      await adjustSettlement(row.operation_key, usage.debitMicroUsd, usage.providerCostMicroUsd, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, metadata: { reason: "reconciliation_uncertain" } });
      reconciled += 1;
    } catch (error) {
      skipped += 1;
      console.error(JSON.stringify({ event: "compute_reconciliation_failed", operationKey: row.operation_key, error: error instanceof Error ? error.name : "UNKNOWN_ERROR" }));
    }
  }

  return { released, reconciled, skipped };
}

/**
 * The money the durable record justifies for one operation: the token counts and
 * provider cost the inference row captured, re-priced with the markup that was
 * applied when the turn started.
 *
 * This is the ONLY input to a reconciliation decision, which is what makes the
 * worker safe to retry: it never invents usage, and it reads the same markup the
 * original attempt used (stored on the inference row), not today's configuration.
 *
 * A row that recorded no provider cost is re-priced from its token counts and the
 * model's registry rate — that is the "provider returned usage after a timeout"
 * case, where the tokens are known but the upstream price never arrived.
 */
async function recordedUsage(operationKey: string): Promise<RecordedUsage> {
  const rows = await query<{ input_tokens: number | null; output_tokens: number | null; provider_cost_micro_usd: string | null; markup_micro: string | null; model: string }>(
    `SELECT input_tokens, output_tokens, provider_cost_micro_usd::text AS provider_cost_micro_usd, markup_micro::text AS markup_micro, model FROM inference_records WHERE operation_key=$1`,
    [operationKey]
  );
  const row = rows[0];
  if (!row) return { tokens: 0, inputTokens: null, outputTokens: null, providerCostMicroUsd: null, debitMicroUsd: 0n };
  const inputTokens = row.input_tokens ?? 0;
  const outputTokens = row.output_tokens ?? 0;
  if (inputTokens + outputTokens === 0) return { tokens: 0, inputTokens: row.input_tokens, outputTokens: row.output_tokens, providerCostMicroUsd: null, debitMicroUsd: 0n };

  let providerCost: MicroUsd | null = row.provider_cost_micro_usd == null ? null : BigInt(row.provider_cost_micro_usd);
  if (providerCost === null) {
    const model = (await query<{ prompt_usd_per_token: string | null; completion_usd_per_token: string | null }>(
      `SELECT prompt_usd_per_token::text AS prompt_usd_per_token, completion_usd_per_token::text AS completion_usd_per_token FROM models WHERE slug=$1`,
      [row.model]
    ))[0];
    if (model && (model.prompt_usd_per_token != null || model.completion_usd_per_token != null)) {
      providerCost = providerCostForTokens({ inputTokens, outputTokens }, { prompt: Number(model.prompt_usd_per_token ?? 0), completion: Number(model.completion_usd_per_token ?? 0) });
    }
  }
  if (providerCost === null) return { tokens: inputTokens + outputTokens, inputTokens: row.input_tokens, outputTokens: row.output_tokens, providerCostMicroUsd: null, debitMicroUsd: 0n };

  const markupMicro = row.markup_micro == null ? pricingConfig().defaultMarkupMicro : BigInt(row.markup_micro);
  return {
    tokens: inputTokens + outputTokens,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    providerCostMicroUsd: providerCost,
    debitMicroUsd: computeUserDebit(providerCost, { markupMicro, minChargeMicroUsd: 0n }),
  };
}

/**
 * The reconciliation report: provider cost, user debit and margin over a window,
 * for the operator. Read-only, integer micro-USD straight from the settled rows.
 */
export async function meteringReport(): Promise<{
  windowHours: number;
  inferences: { settled: number; released: number; uncertain: number };
  money: { providerCostMicroUsd: string; userDebitMicroUsd: string; marginMicroUsd: string; unbilledMicroUsd: string };
  accounts: Array<{ accountId: string; providerCostMicroUsd: string; userDebitMicroUsd: string; marginMicroUsd: string }>;
}> {
  const cfg = meteringConfig();
  const totals = await query<{ provider_cost: string; user_debit: string; unbilled: string; settled: string; released: string; uncertain: string }>(
    `SELECT
       COALESCE(SUM(provider_cost_micro_usd),0)::text AS provider_cost,
       COALESCE(SUM(settled_micro_usd),0)::text AS user_debit,
       COALESCE(SUM(unbilled_micro_usd),0)::text AS unbilled,
       count(*) FILTER (WHERE status='settled')::text AS settled,
       count(*) FILTER (WHERE status='released')::text AS released,
       count(*) FILTER (WHERE status='uncertain')::text AS uncertain
     FROM compute_reservations
     WHERE channel IN ('app','api_key') AND settled_at > now() - make_interval(hours => $1)`,
    [cfg.reportWindowHours]
  );
  const perAccount = await query<{ account_id: string; provider_cost: string; user_debit: string }>(
    `SELECT account_id,
            COALESCE(SUM(provider_cost_micro_usd),0)::text AS provider_cost,
            COALESCE(SUM(settled_micro_usd),0)::text AS user_debit
       FROM compute_reservations
      WHERE channel IN ('app','api_key') AND settled_at > now() - make_interval(hours => $1)
      GROUP BY account_id ORDER BY SUM(settled_micro_usd) DESC NULLS LAST LIMIT 50`,
    [cfg.reportWindowHours]
  );
  const row = totals[0];
  const providerCost = BigInt(row?.provider_cost ?? "0");
  const userDebit = BigInt(row?.user_debit ?? "0");
  const margin = grossMargin(userDebit, providerCost);
  return {
    windowHours: cfg.reportWindowHours,
    inferences: { settled: Number(row?.settled ?? 0), released: Number(row?.released ?? 0), uncertain: Number(row?.uncertain ?? 0) },
    money: {
      providerCostMicroUsd: providerCost.toString(),
      userDebitMicroUsd: userDebit.toString(),
      marginMicroUsd: (margin ?? 0n).toString(),
      unbilledMicroUsd: BigInt(row?.unbilled ?? "0").toString(),
    },
    accounts: perAccount.map((entry) => ({
      accountId: entry.account_id,
      providerCostMicroUsd: entry.provider_cost,
      userDebitMicroUsd: entry.user_debit,
      marginMicroUsd: (BigInt(entry.user_debit) - BigInt(entry.provider_cost)).toString(),
    })),
  };
}

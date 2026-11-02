import { query, transaction } from "./db";
import { allowanceConfig } from "./config";

export type MicroUsd = bigint;
export type AccountingChannel = "app" | "api_key" | "gpu";
export class AccountingError extends Error { readonly code: string; constructor(message: string, code = "ACCOUNTING_ERROR") { super(message); this.code = code; } }

/**
 * Unwraps the AccountingError a reserve/settle call raised.
 *
 * transaction() wraps every failure in DatabaseError, so an AccountingError
 * thrown inside the transaction arrives as the `cause`. Callers that branch on
 * `insufficient_compute` must look through that wrapper, otherwise a blocked
 * reservation would surface as a generic 503 instead of the documented 402.
 */
export function accountingCause(error: unknown): AccountingError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof AccountingError) return current;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

// Canonical monthly period boundaries in UTC. Grants are idempotent per period
// via recurrence_key, so this can be called from any request path safely.
export function currentAllowancePeriod(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function issueGrant(accountId: string, periodStart: Date, periodEnd: Date) {
  const c = allowanceConfig();
  return transaction(async db => {
    // Grants are issued to any authenticated, Privy-verified account. Ownership
    // is no longer a precondition, so no holder_eligibility lookup happens here.
    const grant = await db.query(`INSERT INTO compute_grants (account_id, amount_micro_usd, period_start, period_end, recurrence_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id, recurrence_key) DO NOTHING RETURNING *`, [accountId, c.amountMicroUsd.toString(), periodStart, periodEnd, `${c.recurrence}:${periodStart.toISOString()}`]);
    if (!grant.rowCount) return (await db.query(`SELECT * FROM compute_grants WHERE account_id=$1 AND recurrence_key=$2`, [accountId, `${c.recurrence}:${periodStart.toISOString()}`])).rows[0];
    await db.query(`INSERT INTO compute_ledger_entries (account_id, grant_id, entry_type, amount_micro_usd, idempotency_key, metadata) VALUES ($1,$2,'grant',$3,$4,$5)`, [accountId, grant.rows[0].id, c.amountMicroUsd.toString(), `grant:${grant.rows[0].id}`, JSON.stringify({ periodStart, periodEnd })]);
    return grant.rows[0];
  });
}

// Ensures the authenticated account holds the configured default allowance for
// the current period. The allowance is a separately handled mechanism: it never
// consults chain state, token balances, or legacy holder-status rows, and it
// never invents a new amount (it reuses allowanceConfig()).
export async function ensureDefaultAllowance(accountId: string) {
  const { start, end } = currentAllowancePeriod();
  return issueGrant(accountId, start, end);
}

/**
 * The account's spendable balance, derived only from the append-only ledger.
 * A hold (reservation) reduces it immediately; settling releases the hold and
 * debits the settled amount, so the balance moves by exactly what was charged.
 */
export async function availableMicroUsd(accountId: string): Promise<bigint> {
  const rows = await query<{ available: string }>(
    `SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0),0)::text AS available FROM compute_ledger_entries WHERE account_id=$1`,
    [accountId]
  );
  return BigInt(rows[0]?.available ?? "0");
}

export type ReservationOptions = { apiKeyId?: string; channel?: AccountingChannel; metadata?: Record<string, unknown> };

/**
 * Atomically holds compute for one operation.
 *
 * Everything happens inside a single transaction that first locks the account
 * row, so two concurrent requests (two browser tabs, an API client and the
 * Playground) cannot both observe the same balance and overdraw it: the second
 * waits for the first to commit, then sees the already-reduced balance and is
 * rejected with `INSUFFICIENT_COMPUTE`. A hold is all-or-nothing, so a request
 * either reserves its full estimate or never reaches the provider.
 */
export async function reserveCompute(accountId: string, operationKey: string, estimate: MicroUsd, options: ReservationOptions = {}) {
  if (estimate <= 0n) throw new AccountingError("Reservation must be positive");
  const channel = options.channel ?? (options.apiKeyId ? "api_key" : "app");
  return transaction(async db => {
    const existing = await db.query(`SELECT * FROM compute_reservations WHERE account_id=$1 AND operation_key=$2`, [accountId, operationKey]);
    if (existing.rowCount) return existing.rows[0];
    await db.query(`SELECT id FROM user_accounts WHERE id=$1 FOR UPDATE`, [accountId]);
    const grantState = await db.query<{ active_count: string; expired_count: string }>(`SELECT count(*) FILTER (WHERE period_end > now())::text active_count, count(*) FILTER (WHERE period_end <= now())::text expired_count FROM compute_grants WHERE account_id=$1`, [accountId]);
    if (grantState.rows[0].active_count === "0") throw new AccountingError(grantState.rows[0].expired_count === "0" ? "No active compute allowance is available" : "Your compute allowance has expired; refresh allowance to renew it", grantState.rows[0].expired_count === "0" ? "ALLOWANCE_MISSING" : "ALLOWANCE_EXPIRED");
    const balance = await db.query<{ available: string }>(`SELECT COALESCE(SUM(CASE WHEN e.entry_type='grant' AND g.period_end > now() THEN e.amount_micro_usd WHEN e.entry_type IN ('release','refund') THEN e.amount_micro_usd WHEN e.entry_type IN ('reservation','user_debit') THEN -e.amount_micro_usd ELSE 0 END),0)::text available FROM compute_ledger_entries e LEFT JOIN compute_grants g ON g.id=e.grant_id WHERE e.account_id=$1`, [accountId]);
    const available = BigInt(balance.rows[0].available);
    if (available < estimate) throw new AccountingError(`Insufficient available compute. This request needs ${(Number(estimate) / 1_000_000).toFixed(6)} USD and ${(Number(available > 0n ? available : 0n) / 1_000_000).toFixed(6)} USD is available.`, "INSUFFICIENT_COMPUTE");
    const reservation = await db.query(`INSERT INTO compute_reservations (account_id, operation_key, reserved_micro_usd, status, api_key_id, channel, metadata) VALUES ($1,$2,$3,'reserved',$4,$5,$6) RETURNING *`, [accountId, operationKey, estimate.toString(), options.apiKeyId ?? null, channel, JSON.stringify({ channel, apiKeyId: options.apiKeyId ?? null, ...(options.metadata ?? {}) })]);
    await db.query(`INSERT INTO compute_ledger_entries (account_id, reservation_id, entry_type, amount_micro_usd, idempotency_key, metadata) VALUES ($1,$2,'reservation',$3,$4,$5)`, [accountId, reservation.rows[0].id, estimate.toString(), `reserve:${operationKey}`, JSON.stringify({ channel, apiKeyId: options.apiKeyId ?? null, ...(options.metadata ?? {}) })]);
    return reservation.rows[0];
  });
}

/** The settlement vocabulary the append-only usage events accept. */
export type SettlementEvent = "provider_usage" | "provider_failure" | "cancelled" | "partial" | "uncertain" | "reconciled";

export type SettlementOptions = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  eventType?: SettlementEvent;
  markupMicro?: bigint;
  /** Overrides the default `settle:<operationKey>` idempotency key. */
  settlementKey?: string;
  /** Debit that exceeded the hold and was therefore not charged. */
  unbilledMicroUsd?: bigint;
  metadata?: Record<string, unknown>;
};

/**
 * Settles one hold exactly once.
 *
 * Idempotency has two layers, because settlement can be attempted by more than
 * one actor (the streaming handler, a reconnect, the reconciliation worker):
 *   1. the reservation row is locked FOR UPDATE and only a `reserved` row is
 *      transitioned, so the second caller observes the settled row and returns
 *      it unchanged;
 *   2. `settlement_key` is unique, so a retried insert can never write a second
 *      ledger pair even under a crash-and-retry.
 *
 * The debit is capped at the hold rather than rejected: a turn that ran longer
 * than estimated still settles, the overage is recorded as `unbilled_micro_usd`
 * for reconciliation, and the balance can never go negative.
 *
 * The ledger stays append-only: a settlement writes one `release` (the unused
 * part of the hold) and one `user_debit` (the settled amount). The account's
 * available balance therefore moves by exactly the amount charged.
 */
export async function settleReservation(operationKey: string, userDebit: MicroUsd, providerCostMicroUsd: MicroUsd | null, uncertain = false, usage: SettlementOptions = {}) {
  if (userDebit < 0n) throw new AccountingError("Debit cannot be negative");
  return transaction(async db => {
    const r = await db.query(`SELECT r.*, i.id AS inference_id, i.api_key_id AS inference_api_key_id, i.channel AS inference_channel, i.account_id AS inference_account_id FROM compute_reservations r LEFT JOIN inference_records i ON i.operation_key=r.operation_key WHERE r.operation_key=$1 FOR UPDATE`, [operationKey]);
    if (!r.rowCount) throw new AccountingError("Reservation not found", "RESERVATION_NOT_FOUND");
    const row = r.rows[0];
    // Already settled (a reconnect, a retried finalize, or the worker got there
    // first): return the stored row instead of writing a second ledger pair.
    if (row.status !== "reserved") return row;
    const reserved = BigInt(row.reserved_micro_usd);
    const charged = userDebit > reserved ? reserved : userDebit;
    const unbilled = (userDebit > reserved ? userDebit - reserved : 0n) + (usage.unbilledMicroUsd ?? 0n);
    const margin = providerCostMicroUsd == null ? null : charged - providerCostMicroUsd;
    const status = uncertain ? "uncertain" : charged > 0n ? "settled" : "released";
    const eventType: SettlementEvent = usage.eventType ?? (uncertain ? "uncertain" : charged > 0n ? "provider_usage" : "provider_failure");
    const settlementKey = usage.settlementKey ?? `settle:${operationKey}`;
    await db.query(
      `UPDATE compute_reservations SET status=$2, settled_micro_usd=$3, provider_cost_micro_usd=$4, uncertain=$5, settled_at=now(), margin_micro_usd=$6, unbilled_micro_usd=$7, settlement_event=$8, settlement_key=COALESCE(settlement_key,$9), metadata=metadata || $10::jsonb WHERE id=$1`,
      [row.id, status, charged.toString(), providerCostMicroUsd?.toString() ?? null, uncertain, margin?.toString() ?? null, unbilled.toString(), eventType, settlementKey, JSON.stringify({ settledBy: "request", ...(usage.metadata ?? {}) })]
    );
    const ledgerMetadata = JSON.stringify({ channel: row.channel, uncertain, event: eventType, marginMicroUsd: margin?.toString() ?? null, ...(usage.metadata ?? {}) });
    if (reserved > 0n) {
      await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'release',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, reserved.toString(), `release:${operationKey}`, ledgerMetadata]);
    }
    if (charged > 0n) {
      await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'user_debit',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, charged.toString(), `debit:${operationKey}`, JSON.stringify({ providerCostMicroUsd: providerCostMicroUsd?.toString() ?? null, marginMicroUsd: margin?.toString() ?? null, uncertain, channel: row.channel, event: eventType })]);
    }
    await db.query(
      `INSERT INTO inference_usage_events (account_id,inference_id,reservation_id,api_key_id,operation_key,channel,event_type,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd,pricing_markup_micro,margin_micro_usd,usage_status,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (operation_key,event_type) DO NOTHING`,
      [row.account_id, row.inference_id ?? null, row.id, row.api_key_id ?? row.inference_api_key_id ?? null, operationKey, row.channel, eventType, usage.inputTokens ?? null, usage.outputTokens ?? null, providerCostMicroUsd?.toString() ?? null, charged.toString(), usage.markupMicro?.toString() ?? null, margin?.toString() ?? null, uncertain ? "pending_reconciliation" : "known", JSON.stringify({ channel: row.channel, unbilledMicroUsd: unbilled > 0n ? unbilled.toString() : null, ...(usage.metadata ?? {}) })]
    );
    return (await db.query(`SELECT * FROM compute_reservations WHERE id=$1`, [row.id])).rows[0];
  });
}

/**
 * Releases a hold without debiting anything.
 *
 * Used when a request failed before any tokens were received (provider
 * unavailable, cold-start failure, reservation followed by an error): the user
 * pays nothing and the balance returns to exactly where it started. Reuses the
 * settlement path so the release is recorded once, with the same idempotency key
 * a later settlement would have used.
 */
export async function releaseReservation(operationKey: string, eventType: SettlementEvent = "provider_failure", metadata: Record<string, unknown> = {}) {
  return settleReservation(operationKey, 0n, null, false, { eventType, metadata, settlementKey: `settle:${operationKey}` });
}

/**
 * Retries a settlement that was recorded `uncertain` (the provider never
 * confirmed usage, or answered after the stream was already closed).
 *
 * The correction is APPENDED rather than rewritten: if the true debit is higher
 * than what was charged, a `user_debit` entry for the difference is added; if it
 * is lower, a `refund` entry is added. Both carry the `adjust:<operationKey>`
 * idempotency key, so a crashed worker retrying the same reconciliation cannot
 * apply it twice, and the ledger remains a complete, replayable history.
 */
export async function adjustSettlement(operationKey: string, actualDebit: MicroUsd, providerCostMicroUsd: MicroUsd | null, usage: SettlementOptions = {}) {
  if (actualDebit < 0n) throw new AccountingError("Debit cannot be negative");
  return transaction(async db => {
    const r = await db.query(`SELECT r.*, i.id AS inference_id, i.api_key_id AS inference_api_key_id FROM compute_reservations r LEFT JOIN inference_records i ON i.operation_key=r.operation_key WHERE r.operation_key=$1 FOR UPDATE`, [operationKey]);
    if (!r.rowCount) throw new AccountingError("Reservation not found", "RESERVATION_NOT_FOUND");
    const row = r.rows[0];
    if (row.status !== "uncertain" && row.status !== "reserved") return row;
    const reserved = BigInt(row.reserved_micro_usd);
    const previous = BigInt(row.settled_micro_usd ?? "0");
    const charged = actualDebit > reserved ? reserved : actualDebit;
    const delta = charged - previous;
    const margin = providerCostMicroUsd == null ? null : charged - providerCostMicroUsd;
    const adjustmentKey = `adjust:${operationKey}`;
    if (delta > 0n) {
      await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'user_debit',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, delta.toString(), adjustmentKey, JSON.stringify({ reason: "reconciled_usage_increase", previous: previous.toString(), providerCostMicroUsd: providerCostMicroUsd?.toString() ?? null, channel: row.channel })]);
    } else if (delta < 0n) {
      await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'refund',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, (-delta).toString(), adjustmentKey, JSON.stringify({ reason: "reconciled_usage_decrease", previous: previous.toString(), providerCostMicroUsd: providerCostMicroUsd?.toString() ?? null, channel: row.channel })]);
    }
    if (row.status === "reserved" && reserved > 0n) {
      await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'release',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, reserved.toString(), `release:${operationKey}`, JSON.stringify({ channel: row.channel, reconciled: true })]);
    }
    await db.query(
      `UPDATE compute_reservations SET status=$2, settled_micro_usd=$3, provider_cost_micro_usd=COALESCE($4, provider_cost_micro_usd), uncertain=false, settled_at=COALESCE(settled_at, now()), reconciled_at=now(), reconciliation_attempts=reconciliation_attempts+1, margin_micro_usd=$5, settlement_event='reconciled', settlement_key=COALESCE(settlement_key,$6), metadata=metadata || $7::jsonb WHERE id=$1`,
      [row.id, charged > 0n ? "settled" : "released", charged.toString(), providerCostMicroUsd?.toString() ?? null, margin?.toString() ?? null, `reconcile:${operationKey}`, JSON.stringify({ reconciledFrom: previous.toString(), ...(usage.metadata ?? {}) })]
    );
    await db.query(
      `INSERT INTO inference_usage_events (account_id,inference_id,reservation_id,api_key_id,operation_key,channel,event_type,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd,pricing_markup_micro,margin_micro_usd,usage_status,reconciled_at,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'reconciled',$7,$8,$9,$10,$11,$12,'reconciled',now(),$13) ON CONFLICT (operation_key,event_type) DO NOTHING`,
      [row.account_id, row.inference_id ?? null, row.id, row.api_key_id ?? row.inference_api_key_id ?? null, operationKey, row.channel, usage.inputTokens ?? null, usage.outputTokens ?? null, providerCostMicroUsd?.toString() ?? null, charged.toString(), usage.markupMicro?.toString() ?? null, margin?.toString() ?? null, JSON.stringify({ previousDebitMicroUsd: previous.toString(), deltaMicroUsd: delta.toString(), ...(usage.metadata ?? {}) })]
    );
    return (await db.query(`SELECT * FROM compute_reservations WHERE id=$1`, [row.id])).rows[0];
  });
}

/**
 * Records that a settlement could not be applied, and flags the inference for
 * operational reconciliation. Never throws out of the caller's finalization path:
 * the stream must be able to end even when the ledger write failed.
 */
export async function reportFinalizationFailure(operationKey: string, correlationId: string, stage: "settlement" | "assistant_persistence" | "inference_update" | "conversation_update", failure: unknown) {
  const failureCode = failure instanceof AccountingError ? failure.code : failure instanceof Error ? failure.name : "UNKNOWN_ERROR";
  try {
    await transaction(async db => {
      const record = await db.query<{ account_id: string; id: string; channel: AccountingChannel; api_key_id: string | null }>(`SELECT id,account_id,channel,api_key_id FROM inference_records WHERE operation_key=$1 FOR UPDATE`, [operationKey]);
      if (!record.rowCount) throw new AccountingError("Inference record not found", "INFERENCE_RECORD_MISSING");
      const row = record.rows[0];
      await db.query(`UPDATE inference_records SET reconciliation_required=true, status=CASE WHEN status='complete' THEN 'uncertain' ELSE status END, metadata=metadata || $2::jsonb WHERE id=$1`, [row.id, JSON.stringify({ finalizationFailure: { stage, correlationId, code: failureCode } })]);
      await db.query(`INSERT INTO inference_usage_events (account_id,inference_id,api_key_id,operation_key,channel,event_type,user_debit_micro_usd,usage_status,metadata) VALUES ($1,$2,$3,$4,$5,'uncertain',0,'pending_reconciliation',$6) ON CONFLICT (operation_key,event_type) DO NOTHING`, [row.account_id, row.id, row.api_key_id, operationKey, row.channel, JSON.stringify({ stage, correlationId, code: failureCode })]);
    });
  } catch (signalError) {
    console.error(JSON.stringify({ event: "inference_finalization_reconciliation_signal_failed", reconciliation_signal: "manual_reconciliation_required", operationKey, correlationId, stage, code: failureCode, error: signalError instanceof Error ? signalError.name : "UNKNOWN_ERROR" }));
  }
}

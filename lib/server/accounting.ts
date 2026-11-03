import { transaction } from "./db";
import { allowanceConfig } from "./config";

export type MicroUsd = bigint;
export type AccountingChannel = "app" | "api_key" | "gpu";
export class AccountingError extends Error { readonly code: string; constructor(message: string, code = "ACCOUNTING_ERROR") { super(message); this.code = code; } }

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

export async function reserveCompute(accountId: string, operationKey: string, estimate: MicroUsd, options: { apiKeyId?: string; channel?: AccountingChannel } = {}) {
  if (estimate <= 0n) throw new AccountingError("Reservation must be positive");
  const channel = options.channel ?? (options.apiKeyId ? "api_key" : "app");
  return transaction(async db => {
    const existing = await db.query(`SELECT * FROM compute_reservations WHERE account_id=$1 AND operation_key=$2`, [accountId, operationKey]);
    if (existing.rowCount) return existing.rows[0];
    await db.query(`SELECT id FROM user_accounts WHERE id=$1 FOR UPDATE`, [accountId]);
    const grantState = await db.query<{ active_count: string; expired_count: string }>(`SELECT count(*) FILTER (WHERE period_end > now())::text active_count, count(*) FILTER (WHERE period_end <= now())::text expired_count FROM compute_grants WHERE account_id=$1`, [accountId]);
    // An account with no grant can still spend funded compute: deposits credited
    // from a funding wallet are ledger entries of their own and do not require a
    // monthly grant to exist. Only reject when the account has neither.
    const fundedBalance = BigInt((await db.query<{ available: string }>(`SELECT GREATEST(COALESCE(SUM(CASE WHEN e.entry_type='grant' AND g.period_end > now() THEN e.amount_micro_usd WHEN e.entry_type IN ('release','refund','deposit','adjustment') THEN e.amount_micro_usd WHEN e.entry_type IN ('reservation','user_debit') THEN -e.amount_micro_usd ELSE 0 END),0),0)::text available FROM compute_ledger_entries e LEFT JOIN compute_grants g ON g.id=e.grant_id WHERE e.account_id=$1`, [accountId])).rows[0]?.available ?? "0");
    if (grantState.rows[0].active_count === "0" && fundedBalance <= 0n) throw new AccountingError(grantState.rows[0].expired_count === "0" ? "No active compute allowance is available" : "Your compute allowance has expired; refresh allowance to renew it", grantState.rows[0].expired_count === "0" ? "ALLOWANCE_MISSING" : "ALLOWANCE_EXPIRED");
    const balance = await db.query<{ available: string }>(`SELECT COALESCE(SUM(CASE WHEN e.entry_type='grant' AND g.period_end > now() THEN e.amount_micro_usd WHEN e.entry_type IN ('release','refund','deposit','adjustment') THEN e.amount_micro_usd WHEN e.entry_type IN ('reservation','user_debit') THEN -e.amount_micro_usd ELSE 0 END),0)::text available FROM compute_ledger_entries e LEFT JOIN compute_grants g ON g.id=e.grant_id WHERE e.account_id=$1`, [accountId]);
    if (BigInt(balance.rows[0].available) < estimate) throw new AccountingError("Insufficient available compute", "INSUFFICIENT_COMPUTE");
    const reservation = await db.query(`INSERT INTO compute_reservations (account_id, operation_key, reserved_micro_usd, status, api_key_id, channel) VALUES ($1,$2,$3,'reserved',$4,$5) RETURNING *`, [accountId, operationKey, estimate.toString(), options.apiKeyId ?? null, channel]);
    await db.query(`INSERT INTO compute_ledger_entries (account_id, reservation_id, entry_type, amount_micro_usd, idempotency_key, metadata) VALUES ($1,$2,'reservation',$3,$4,$5)`, [accountId, reservation.rows[0].id, estimate.toString(), `reserve:${operationKey}`, JSON.stringify({ channel, apiKeyId: options.apiKeyId ?? null })]);
    return reservation.rows[0];
  });
}

// `discountBps` is the open-weight discount that was resolved when the request
// started (not the model's current value), so the recorded usage matches the
// price actually debited even if an operator edits the model mid-request.
export async function settleReservation(operationKey: string, userDebit: MicroUsd, providerCostMicroUsd: MicroUsd | null, uncertain = false, usage: { inputTokens?: number | null; outputTokens?: number | null; eventType?: "provider_usage" | "provider_failure" | "cancelled" | "partial" | "uncertain"; markupMicro?: bigint; discountBps?: number | null } = {}) {
  if (userDebit < 0n) throw new AccountingError("Debit cannot be negative");
  return transaction(async db => {
    const r = await db.query(`SELECT r.*, i.id AS inference_id, i.api_key_id AS inference_api_key_id, i.channel AS inference_channel FROM compute_reservations r LEFT JOIN inference_records i ON i.operation_key=r.operation_key WHERE r.operation_key=$1 FOR UPDATE`, [operationKey]);
    if (!r.rowCount) throw new AccountingError("Reservation not found");
    const row = r.rows[0];
    if (row.status !== "reserved") return row;
    const reserved = BigInt(row.reserved_micro_usd);
    if (userDebit > reserved) throw new AccountingError("Settlement exceeds reservation");
    const status = uncertain ? "uncertain" : "settled";
    await db.query(`UPDATE compute_reservations SET status=$2, settled_micro_usd=$3, provider_cost_micro_usd=$4, uncertain=$5, settled_at=now() WHERE id=$1`, [row.id, status, userDebit.toString(), providerCostMicroUsd?.toString() ?? null, uncertain]);
    if (reserved > 0n) await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'release',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, reserved.toString(), `release:${operationKey}`, JSON.stringify({ channel: row.channel, uncertain })]);
    if (userDebit > 0n) await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'user_debit',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, userDebit.toString(), `debit:${operationKey}`, JSON.stringify({ providerCostMicroUsd: providerCostMicroUsd?.toString() ?? null, uncertain, channel: row.channel, discountBps: usage.discountBps ?? 0 })]);
    await db.query(`INSERT INTO inference_usage_events (account_id,inference_id,reservation_id,api_key_id,operation_key,channel,event_type,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd,pricing_markup_micro,discount_bps,usage_status,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (operation_key,event_type) DO NOTHING`, [row.account_id, row.inference_id ?? null, row.id, row.api_key_id ?? row.inference_api_key_id ?? null, operationKey, row.channel, usage.eventType ?? (uncertain ? "uncertain" : "provider_usage"), usage.inputTokens ?? null, usage.outputTokens ?? null, providerCostMicroUsd?.toString() ?? null, userDebit.toString(), usage.markupMicro?.toString() ?? null, usage.discountBps ?? 0, uncertain ? "pending_reconciliation" : "known", JSON.stringify({ channel: row.channel })]);
    return (await db.query(`SELECT * FROM compute_reservations WHERE id=$1`, [row.id])).rows[0];
  });
}

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

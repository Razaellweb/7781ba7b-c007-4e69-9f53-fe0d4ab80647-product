import { transaction } from "./db";
import { allowanceConfig } from "./config";

export type MicroUsd = bigint;
export class AccountingError extends Error { readonly code = "ACCOUNTING_ERROR"; }

export async function issueGrant(accountId: string, periodStart: Date, periodEnd: Date) {
  const c = allowanceConfig();
  return transaction(async db => {
    const eligible = await db.query(`SELECT 1 FROM holder_eligibility WHERE account_id=$1 AND state='eligible' AND verified_at > now() - interval '1 second' * $2 ORDER BY verified_at DESC LIMIT 1`, [accountId, 900]);
    if (!eligible.rowCount) throw new AccountingError("Fresh holder eligibility is required");
    const grant = await db.query(`INSERT INTO compute_grants (account_id, amount_micro_usd, period_start, period_end, recurrence_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id, recurrence_key) DO NOTHING RETURNING *`, [accountId, c.amountMicroUsd.toString(), periodStart, periodEnd, `${c.recurrence}:${periodStart.toISOString()}`]);
    if (!grant.rowCount) return (await db.query(`SELECT * FROM compute_grants WHERE account_id=$1 AND recurrence_key=$2`, [accountId, `${c.recurrence}:${periodStart.toISOString()}`])).rows[0];
    await db.query(`INSERT INTO compute_ledger_entries (account_id, grant_id, entry_type, amount_micro_usd, idempotency_key, metadata) VALUES ($1,$2,'grant',$3,$4,$5)`, [accountId, grant.rows[0].id, c.amountMicroUsd.toString(), `grant:${grant.rows[0].id}`, JSON.stringify({ periodStart, periodEnd })]);
    return grant.rows[0];
  });
}

export async function reserveCompute(accountId: string, operationKey: string, estimate: MicroUsd) {
  if (estimate <= 0n) throw new AccountingError("Reservation must be positive");
  return transaction(async db => {
    const existing = await db.query(`SELECT * FROM compute_reservations WHERE account_id=$1 AND operation_key=$2`, [accountId, operationKey]);
    if (existing.rowCount) return existing.rows[0];
    await db.query(`SELECT id FROM user_accounts WHERE id=$1 FOR UPDATE`, [accountId]);
    const balance = await db.query<{ available: string }>(`SELECT COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0)::text available FROM compute_ledger_entries WHERE account_id=$1`, [accountId]);
    if (BigInt(balance.rows[0].available) < estimate) throw new AccountingError("Insufficient available compute");
    const reservation = await db.query(`INSERT INTO compute_reservations (account_id, operation_key, reserved_micro_usd, status) VALUES ($1,$2,$3,'reserved') RETURNING *`, [accountId, operationKey, estimate.toString()]);
    await db.query(`INSERT INTO compute_ledger_entries (account_id, reservation_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,$2,'reservation',$3,$4)`, [accountId, reservation.rows[0].id, estimate.toString(), `reserve:${operationKey}`]);
    return reservation.rows[0];
  });
}

export async function settleReservation(operationKey: string, userDebit: MicroUsd, providerCostMicroUsd: MicroUsd | null, uncertain = false) {
  if (userDebit < 0n) throw new AccountingError("Debit cannot be negative");
  return transaction(async db => {
    const r = await db.query(`SELECT * FROM compute_reservations WHERE operation_key=$1 FOR UPDATE`, [operationKey]);
    if (!r.rowCount) throw new AccountingError("Reservation not found");
    if (r.rows[0].status !== "reserved") return r.rows[0];
    const reserved = BigInt(r.rows[0].reserved_micro_usd);
    if (userDebit > reserved) throw new AccountingError("Settlement exceeds reservation");
    const release = reserved - userDebit;
    await db.query(`UPDATE compute_reservations SET status=$2, settled_micro_usd=$3, provider_cost_micro_usd=$4, uncertain=$5, settled_at=now() WHERE id=$1`, [r.rows[0].id, uncertain ? "uncertain" : "settled", userDebit.toString(), providerCostMicroUsd?.toString() ?? null, uncertain]);
    if (userDebit > 0n) await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'user_debit',$3,$4,$5)`, [r.rows[0].account_id, r.rows[0].id, userDebit.toString(), `debit:${operationKey}`, JSON.stringify({ providerCostMicroUsd: providerCostMicroUsd?.toString() ?? null, uncertain })]);
    if (release > 0n) await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key) VALUES ($1,$2,'release',$3,$4)`, [r.rows[0].account_id, r.rows[0].id, release.toString(), `release:${operationKey}`]);
    return (await db.query(`SELECT * FROM compute_reservations WHERE id=$1`, [r.rows[0].id])).rows[0];
  });
}

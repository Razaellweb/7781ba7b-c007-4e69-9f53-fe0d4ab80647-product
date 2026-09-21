import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { AccountingError, issueGrant } from "../../../lib/server/accounting";
import { query } from "../../../lib/server/db";
import { ensureMigrated } from "../../../lib/server/migrate";

// Canonical monthly period boundaries in UTC so the grant is idempotent for the
// whole calendar month regardless of how often this endpoint is called.
function currentPeriod() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function GET(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const eligible = await query(`SELECT 1 FROM holder_eligibility WHERE account_id=$1 AND state='eligible' AND verified_at > now() - interval '15 minutes' LIMIT 1`, [account.accountId]);
    if (!eligible.length) return NextResponse.json({ error: "Fresh holder eligibility is required", code: "NOT_ELIGIBLE" }, { status: 403 });
    const { start, end } = currentPeriod();
    await issueGrant(account.accountId, start, end);
    const balance = await query(`SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0),0)::text available FROM compute_ledger_entries WHERE account_id=$1`, [account.accountId]);
    const grant = await query(`SELECT amount_micro_usd, period_start, period_end FROM compute_grants WHERE account_id=$1 AND period_end > now() ORDER BY period_end DESC LIMIT 1`, [account.accountId]);
    return NextResponse.json({ balance: balance[0] ?? { available: "0" }, allowance: grant[0] ?? null });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    if (error instanceof AccountingError) {
      const status = error.code === "HOLDER_VERIFICATION_REQUIRED" ? 403 : 503;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Allowance is temporarily unavailable", code: "ALLOWANCE_ERROR" }, { status: 503 });
  }
}
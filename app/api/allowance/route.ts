import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { AccountingError, ensureDefaultAllowance } from "../../../lib/server/accounting";
import { query } from "../../../lib/server/db";
import { ensureMigrated } from "../../../lib/server/migrate";

export async function GET(request: Request) {
  try {
    await ensureMigrated();
    // A verified Privy identity is sufficient to read and receive the compute
    // allowance. The allowance is a separately handled mechanism: no token-holding
    // eligibility, holder status, or legacy verification row is consulted, and no
    // new amount is invented (the configured default grant is reused).
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    await ensureDefaultAllowance(account.accountId);
    const balance = await query(`SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0),0)::text available FROM compute_ledger_entries WHERE account_id=$1`, [account.accountId]);
    const grant = await query(`SELECT amount_micro_usd, period_start, period_end FROM compute_grants WHERE account_id=$1 AND period_end > now() ORDER BY period_end DESC LIMIT 1`, [account.accountId]);
    return NextResponse.json({ balance: balance[0] ?? { available: "0" }, allowance: grant[0] ?? null, access: { authorized: true, method: "privy_identity" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    if (error instanceof AccountingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
    }
    return NextResponse.json({ error: "Allowance is temporarily unavailable", code: "ALLOWANCE_ERROR" }, { status: 503 });
  }
}

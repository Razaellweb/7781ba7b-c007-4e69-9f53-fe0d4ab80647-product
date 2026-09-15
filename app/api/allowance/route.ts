import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { issueGrant } from "../../../lib/server/accounting";
import { query } from "../../../lib/server/db";

export async function GET(request: Request) {
  try {
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const eligible = await query(`SELECT 1 FROM holder_eligibility WHERE account_id=$1 AND state='eligible' AND verified_at > now() - interval '15 minutes' LIMIT 1`, [account.accountId]);
    if (!eligible.length) return NextResponse.json({ error: "Fresh holder eligibility is required", code: "NOT_ELIGIBLE" }, { status: 403 });
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await issueGrant(account.accountId, now, end);
    const balance = await query(`SELECT COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0)::text available FROM compute_ledger_entries WHERE account_id=$1`, [account.accountId]);
    const grant = await query(`SELECT amount_micro_usd, period_start, period_end FROM compute_grants WHERE account_id=$1 AND period_end > now() ORDER BY period_end DESC LIMIT 1`, [account.accountId]);
    return NextResponse.json({ balance: balance[0] ?? { available: "0" }, allowance: grant[0] ?? null });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Allowance is temporarily unavailable", code: "ALLOWANCE_ERROR" }, { status: 503 });
  }
}

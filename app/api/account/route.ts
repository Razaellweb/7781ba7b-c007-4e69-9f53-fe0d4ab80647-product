import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { query } from "../../../lib/server/db";

export async function GET(request: Request) {
  try {
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const eligibility = await query(`SELECT state, chain_id, wallet_address, verified_at FROM holder_eligibility WHERE account_id=$1 ORDER BY verified_at DESC LIMIT 1`, [account.accountId]);
    const balance = await query<{ available: string; reserved: string }>(`SELECT COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0)::text available, COALESCE((SELECT SUM(reserved_micro_usd-settled_micro_usd) FROM compute_reservations WHERE account_id=$1 AND status='reserved'),0)::text reserved FROM compute_ledger_entries WHERE account_id=$1`, [account.accountId]);
    return NextResponse.json({ account, eligibility: eligibility[0] ?? null, compute: balance[0] ?? { available: "0", reserved: "0" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to load account state", code: "ACCOUNT_UNAVAILABLE" }, { status: 503 });
  }
}

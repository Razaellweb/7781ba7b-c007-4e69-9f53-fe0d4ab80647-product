import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { query } from "../../../lib/server/db";
import { ensureMigrated } from "../../../lib/server/migrate";

// Account state (PRD §28.1): identity, holder status with balance/threshold,
// and available compute. Never exposes provider credentials.
export async function GET(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const eligibility = await query<{ state: string; chain_id: number | null; wallet_address: string; balance_raw: string | null; threshold_raw: string | null; token_decimals: number | null; verified_at: string }>(
      `SELECT state, chain_id, wallet_address, balance_raw, threshold_raw, token_decimals, verified_at FROM holder_eligibility WHERE account_id=$1 ORDER BY verified_at DESC LIMIT 1`,
      [account.accountId]
    );
    const balance = await query<{ available: string; reserved: string }>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0)::text available,
              COALESCE((SELECT SUM(reserved_micro_usd-settled_micro_usd) FROM compute_reservations WHERE account_id=$1 AND status='reserved'),0)::text reserved
         FROM compute_ledger_entries WHERE account_id=$1`,
      [account.accountId]
    );
    const holder = eligibility[0]
      ? { state: eligibility[0].state, eligible: eligibility[0].state === "eligible", chainId: eligibility[0].chain_id, balanceRaw: eligibility[0].balance_raw, thresholdRaw: eligibility[0].threshold_raw, tokenDecimals: eligibility[0].token_decimals, verifiedAt: eligibility[0].verified_at }
      : null;
    return NextResponse.json({ account, holder, eligibility: eligibility[0] ?? null, compute: balance[0] ?? { available: "0", reserved: "0" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to load account state", code: "ACCOUNT_UNAVAILABLE" }, { status: 503 });
  }
}

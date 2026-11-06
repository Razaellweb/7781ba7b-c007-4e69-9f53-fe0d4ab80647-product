import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { FundingError, fundingState } from "../../../../lib/server/funding";
import { fundingSchedulerStatus, publicAlchemyConfig, recheckFunding, type FundingRecheckResult } from "../../../../lib/server/funding-recheck";

// Signed-in recheck for ONE account, used by the Fund dialog's "Check again".
//
// This is the interactive counterpart of the scheduled sweep. It runs the SAME
// reconciliation code (retryPendingWatches -> reconcileWallet -> processDeposit)
// but scoped to the authenticated account's own deposit address, and it never reads
// or returns CRON_SECRET. The cron endpoint keeps its own constant-time bearer
// check; nothing here weakens or duplicates that protection.

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 401, headers: NO_STORE });
  }
  if (error instanceof FundingError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
  }
  console.error(JSON.stringify({ event: "funding_recheck_failed", error: error instanceof Error ? error.name : "unknown" }));
  return NextResponse.json({ error: "Funding is temporarily unavailable", code: "FUNDING_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
}

/** The result shape a caller can always rely on, even when the step itself failed. */
function failedRecheck(error: unknown): FundingRecheckResult {
  return {
    watches: { attempted: 0, watched: 0 },
    reconciliation: null,
    reconcileError: error instanceof Error ? error.message.slice(0, 200) : "recheck_failed",
    skipped: false,
    reason: "recheck_failed",
    pendingChecked: 0,
    credited: 0,
  };
}

export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));

    // A recheck never CREATES a wallet: provisioning is the Fund button's job, and the
    // dialog shows "Deposits not ready" until it has succeeded.
    const recheck = await recheckFunding(account.accountId, { maxChunks: 3 }).catch((error) => {
      console.error(JSON.stringify({ event: "funding_recheck_step_failed", error: error instanceof Error ? error.name : "unknown" }));
      return failedRecheck(error);
    });

    // The refreshed state is still returned on a failed recheck: it is the last known
    // truth from the database, and the caller keeps showing it.
    const state = await fundingState(account.accountId, { createWallet: false });
    return NextResponse.json(
      { ...state, alchemy: publicAlchemyConfig(), scheduler: fundingSchedulerStatus(), recheck },
      { headers: NO_STORE },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

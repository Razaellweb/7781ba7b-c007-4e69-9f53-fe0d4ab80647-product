import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { ensureMigrated } from "../../../lib/server/migrate";
import { FundingError, fundingState, retryPendingWatches } from "../../../lib/server/funding";

// Funding state for the signed-in account: the configured Robinhood Chain network,
// the USDG asset, the account's deposit address together with its Alchemy
// monitoring state, and each deposit's confirmation progress.
//
// Deposits remain `pending` to the user until the transfer has been verified on
// chain AND reached the configured confirmation count, so the status shown here is
// never optimistic.
//
// GET returns existing state; POST additionally provisions the deposit address on
// first use (creating the Privy wallet and registering it for monitoring).

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 401, headers: NO_STORE });
  }
  if (error instanceof FundingError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
  }
  console.error(JSON.stringify({ event: "funding_state_failed", error: error instanceof Error ? error.name : "unknown" }));
  return NextResponse.json({ error: "Funding is temporarily unavailable", code: "FUNDING_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
}

async function load(request: Request, createWallet: boolean) {
  await ensureMigrated();
  const account = await authenticatePrivyRequest(request.headers.get("authorization"));
  // Addresses left unwatched by an Alchemy outage are retried on each visit, so
  // monitoring self-heals without waiting for the cron.
  await retryPendingWatches(5).catch(() => undefined);
  const state = await fundingState(account.accountId, { createWallet });
  return NextResponse.json(state, { headers: NO_STORE });
}

export async function GET(request: Request) {
  try {
    return await load(request, false);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    return await load(request, true);
  } catch (error) {
    return errorResponse(error);
  }
}

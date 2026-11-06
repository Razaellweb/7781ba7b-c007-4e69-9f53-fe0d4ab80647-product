import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { ensureMigrated } from "../../../lib/server/migrate";
import { FundingError, fundingState, registerUnwatchedWallets, retryPendingWatches } from "../../../lib/server/funding";
import { fundingSchedulerStatus, publicAlchemyConfig } from "../../../lib/server/funding-recheck";

// Funding state for the signed-in account: the configured Robinhood Chain network,
// the USDG asset, the account's deposit address together with its Alchemy
// monitoring state, and each deposit's confirmation progress.
//
// Deposits remain `pending` to the user until the transfer has been verified on
// chain AND reached the configured confirmation count (FUNDING_CONFIRMATIONS, 3), so
// the status shown here is never optimistic.
//
// `alchemy` reports the monitoring configuration itself: whether an RPC endpoint was
// resolved (from a bare key + network or a full ALCHEMY_RPC_URL), which environment
// variable NAMES are still missing, and — when it is unusable — the DISTINCT reason
// (`alchemy_not_configured`, `alchemy_network_not_configured`,
// `alchemy_network_invalid`, `alchemy_rpc_url_invalid`) with a human-readable
// message. `scheduler` reports whether the scheduled sweep can run at all (that is,
// whether CRON_SECRET is set) without ever exposing the secret.
//
// Watch registration is part of this lifecycle rather than a manual step: every
// visit retries addresses whose registration failed and is past its backoff
// (`retryPendingWatches(5)`), and then runs the population-wide pass
// (`registerUnwatchedWallets`) that submits every server-side wallet which is not yet
// confirmed watched — including pre-existing rows — to Alchemy's watch list. Both
// write back only what Alchemy actually accepted, so a configuration-gated miss
// stays `failed` with its reason and becomes `watched` on the first run after the
// missing variable is supplied.
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
  // monitoring self-heals without waiting for the cron. This also means a watch that
  // failed purely because the Alchemy configuration was missing transitions to
  // `watched` on the first visit after that configuration is fixed.
  await retryPendingWatches(5).catch(() => undefined);
  // Then the population pass: every server-side wallet still not confirmed watched
  // is submitted to the watch list, batched, whether or not its backoff has elapsed.
  // No wallet needs its owner to open this dialog for that to happen — the boot and
  // scheduled-sweep paths run the same pass — and this is a no-op (one SELECT, no
  // HTTP) when nothing is pending.
  await registerUnwatchedWallets(50).catch(() => undefined);
  const state = await fundingState(account.accountId, { createWallet });
  return NextResponse.json(
    { ...state, alchemy: publicAlchemyConfig(), scheduler: fundingSchedulerStatus() },
    { headers: NO_STORE },
  );
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

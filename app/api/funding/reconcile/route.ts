import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { fundingReconcileConfig } from "../../../../lib/server/config";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { recoverFunding } from "../../../../lib/server/funding";
import { alchemyMonitoringStatus } from "../../../../lib/server/alchemy";

// Scheduled reconciliation for funding (vercel.json cron).
//
// Authentication contract: `Authorization: Bearer $CRON_SECRET`, which is what
// Vercel's cron invokes with. An `x-cron-secret` header carrying the same value is
// also accepted so an operator can trigger a sweep manually. The secret is compared
// in constant time, and NOTHING is read or written until it matches.
//
// Responses are structured and actionable rather than opaque:
//   * 503 reconcile_unconfigured — CRON_SECRET is not set, so the endpoint is
//     closed. The body names the variable explicitly.
//   * 401 reconcile_unauthorized / 403 reconcile_forbidden — credentials missing or
//     wrong; NO work is performed.
//   * 503 alchemy_unconfigured  — authenticated, but no usable Alchemy RPC
//     endpoint (ALCHEMY_API_KEY + ALCHEMY_NETWORK, or ALCHEMY_RPC_URL) exists, so
//     no chain data can be read. Distinct from a generic 500.
//   * 200 (status "ok")         — the sweep completed.
//   * 200 (status "partial")    — a rate limit or timeout cut the sweep short; the
//     summary says what was processed, which wallets were skipped and why, and the
//     remaining work resumes next run.
//   * 503                       — a genuine, non-retryable failure.
//
// One run retries failed Alchemy address registrations, replays notifications that
// failed to process, re-checks pending deposits for their confirmation depth, polls
// the configured USDG contract for transfers a missed webhook would have carried,
// and flags any credited deposit that has been reorged out. Every path uses the
// same validation and idempotent credit logic as the webhook, so the sweep can never
// double-credit and can never bypass a chain/token/recipient check.

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Constant-time comparison that does not leak length through an early return. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Perform one comparison anyway so the timing does not reveal the length check.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Reads the presented credential from the bearer header or the x-cron-secret header. */
function presentedSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
    // A bare Authorization value is accepted too, but never silently ignored.
    const bare = authorization.trim();
    if (bare.length > 0) return bare;
  }
  const header = request.headers.get("x-cron-secret");
  return header === null ? null : header.trim();
}

async function runSweep(request: Request) {
  const secret = fundingReconcileConfig().cronSecret;

  // No secret configured: the endpoint stays closed. Say exactly what is missing so
  // an operator can fix it without reading the source.
  if (!secret) {
    console.error(JSON.stringify({ event: "funding_reconcile_unconfigured", missing: ["CRON_SECRET"] }));
    return NextResponse.json(
      {
        error: "Funding reconciliation is not configured: CRON_SECRET is not set on this deployment.",
        code: "reconcile_unconfigured",
        missing: ["CRON_SECRET"],
        detail: "Set CRON_SECRET, then call this endpoint with `Authorization: Bearer <CRON_SECRET>` (Vercel cron does this automatically).",
        retryable: false,
      },
      { status: 503, headers: NO_STORE }
    );
  }

  const provided = presentedSecret(request);
  if (!provided) {
    console.warn(JSON.stringify({ event: "funding_reconcile_auth_missing" }));
    return NextResponse.json(
      { error: "Unauthorized", code: "reconcile_unauthorized", detail: "Missing CRON_SECRET credential.", retryable: false },
      { status: 401, headers: NO_STORE }
    );
  }
  if (!secretMatches(provided, secret)) {
    console.warn(JSON.stringify({ event: "funding_reconcile_auth_rejected" }));
    return NextResponse.json(
      { error: "Forbidden", code: "reconcile_forbidden", detail: "The supplied CRON_SECRET credential is not valid.", retryable: false },
      { status: 403, headers: NO_STORE }
    );
  }

  // Authenticated. A missing Alchemy endpoint is its own configuration state, not a
  // generic server error: report it distinctly with the reason from the config.
  const alchemy = alchemyMonitoringStatus();
  if (!alchemy.enabled) {
    console.error(JSON.stringify({ event: "funding_reconcile_alchemy_unconfigured", reason: alchemy.reason }));
    return NextResponse.json(
      {
        error: "Funding reconciliation cannot run: no usable Alchemy RPC endpoint is configured.",
        code: "alchemy_unconfigured",
        reason: alchemy.reason,
        detail: alchemy.message,
        missing: ["ALCHEMY_API_KEY", "ALCHEMY_NETWORK", "ALCHEMY_RPC_URL"],
        detail_variables: {
          ALCHEMY_RPC_URL: "Complete endpoint from dashboard.alchemy.com (shape: https://<network>.g.alchemy.com/v2/<key>). Used exactly as given.",
          ALCHEMY_API_KEY: "Alchemy app API key, combined with ALCHEMY_NETWORK to build the endpoint.",
          ALCHEMY_NETWORK: "Network name in RPC-hostname or webhook form (e.g. robinhood-mainnet or ROBINHOOD_MAINNET).",
        },
        retryable: false,
      },
      { status: 503, headers: NO_STORE }
    );
  }

  try {
    await ensureMigrated();
  } catch (error) {
    console.error(JSON.stringify({ event: "funding_reconcile_migration_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json(
      { error: "Funding reconciliation is temporarily unavailable: the database schema could not be prepared.", code: "reconcile_unavailable", retryable: true },
      { status: 503, headers: NO_STORE }
    );
  }

  try {
    const summary = await recoverFunding(50);
    // A partial run is a SUCCESS with work remaining: it is reported as 200 so a
    // scheduler does not treat a rate limit as a failure, and the summary carries
    // everything processed, the skipped wallets with reasons, and the reason the
    // rest was deferred to the next run.
    if (summary.partial) {
      console.warn(JSON.stringify({ event: "funding_reconcile_partial", reason: summary.reason, wallets: summary.wallets, reconciled: summary.reconciled, credited: summary.credited }));
      return NextResponse.json({ reconciled: summary, partial: true }, { status: 200, headers: NO_STORE });
    }
    return NextResponse.json({ reconciled: summary, partial: false }, { headers: NO_STORE });
  } catch (error) {
    console.error(JSON.stringify({ event: "funding_reconcile_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json(
      { error: "Reconciliation failed", code: "reconcile_failed", retryable: false },
      { status: 503, headers: NO_STORE }
    );
  }
}

// Vercel cron issues GET; POST is supported so an operator can trigger the same
// sweep manually with the same credential.
export async function GET(request: Request) {
  return runSweep(request);
}

export async function POST(request: Request) {
  return runSweep(request);
}

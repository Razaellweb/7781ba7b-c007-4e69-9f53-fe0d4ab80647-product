import { NextResponse } from "next/server";
import { fundingReconcileConfig } from "../../../../lib/server/config";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { recoverFunding } from "../../../../lib/server/funding";

// Scheduled reconciliation for funding (vercel.json cron). Vercel sends
// `Authorization: Bearer $CRON_SECRET`; without a configured secret the endpoint
// stays closed.
//
// One run retries failed Alchemy address registrations, replays notifications that
// failed to process, re-checks pending deposits for their confirmation depth, polls
// the configured USDG contract for transfers a missed webhook would have carried,
// and flags any credited deposit that has been reorged out. Every path uses the
// same validation and idempotent credit logic as the webhook, so the sweep can never
// double-credit and can never bypass a chain/token/recipient check.

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const secret = fundingReconcileConfig().cronSecret;
  if (!secret) return NextResponse.json({ error: "Reconciliation is not configured" }, { status: 503, headers: NO_STORE });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  try {
    await ensureMigrated();
    const result = await recoverFunding(50);
    return NextResponse.json({ reconciled: result }, { headers: NO_STORE });
  } catch (error) {
    console.error(JSON.stringify({ event: "funding_reconcile_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Reconciliation failed" }, { status: 503, headers: NO_STORE });
  }
}

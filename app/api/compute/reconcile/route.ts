import { NextResponse } from "next/server";
import { gpuRentalConfig } from "../../../../lib/server/config";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { reconcilePending, meteringReport } from "../../../../lib/server/metering";

// Scheduled settlement reconciliation (vercel.json cron).
//
// Three kinds of money need a backstop, and this endpoint is it:
//
//   1. a hold whose stream process died before it could finalize — settled from
//      whatever the inference record durably captured, or released in full when it
//      captured nothing;
//   2. a settlement recorded `uncertain` because the provider answered usage late
//      or not at all — corrected with an APPENDED ledger adjustment;
//   3. an operator-visible reconciliation report (provider cost, user debit and
//      margin per inference and per account) for the reconciliation window.
//
// Every path is idempotent: settlement keys are unique and only a
// `reserved`/`uncertain` row is transitioned, so overlapping cron runs and a
// crashed prior run can never double debit.
//
// Vercel sends `Authorization: Bearer $CRON_SECRET`; without a configured secret
// the endpoint stays closed.
export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = gpuRentalConfig().cronSecret;
  if (!secret) return NextResponse.json({ error: "Reconciliation is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    await ensureMigrated();
    const result = await reconcilePending();
    const report = await meteringReport();
    console.log(JSON.stringify({ event: "compute_reconciliation_cycle", ...result, money: report.money }));
    return NextResponse.json({ ...result, report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(JSON.stringify({ event: "compute_reconciliation_cycle_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Reconciliation failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

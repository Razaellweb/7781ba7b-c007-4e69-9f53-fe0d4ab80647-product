import { NextResponse } from "next/server";
import { gpuRentalConfig } from "../../../../lib/server/config";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { NO_STORE } from "../../../../lib/server/gpu-http";
import { runHealthCycle } from "../../../../lib/server/provider-health-worker";

// Scheduled provider-health worker (vercel.json cron).
//
// One cycle does three things, in this order:
//   1. refreshes the normalized health of every configured inference provider and
//      persists it to provider_health (recording status transitions as metrics);
//   2. terminates lifecycle-managed machines that have been idle past
//      VASTAI_IDLE_SHUTDOWN_MINUTES (warm-pool models are exempt), and retires any
//      machine whose container crashed;
//   3. tops the warm pool back up, so a model listed in VASTAI_WARM_POOL is already
//      serving before the first request arrives.
//
// Vercel sends `Authorization: Bearer $CRON_SECRET`; without a configured secret
// the endpoint stays closed so it cannot be used to force instance churn.
export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = gpuRentalConfig().cronSecret;
  if (!secret) return NextResponse.json({ error: "Health cycle is not configured" }, { status: 503, headers: NO_STORE });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    await ensureMigrated();
    const cycle = await runHealthCycle();
    return NextResponse.json({
      providers: cycle.health.map((entry) => ({ provider: entry.provider, status: entry.status, latencyMs: entry.latencyMs })),
      instances: cycle.instances,
      shutdown: cycle.shutdown,
      crashed: cycle.crashed,
      warmed: cycle.warmed,
    }, { headers: NO_STORE });
  } catch (error) {
    console.error(JSON.stringify({ event: "provider_health_cycle_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Health cycle failed" }, { status: 503, headers: NO_STORE });
  }
}

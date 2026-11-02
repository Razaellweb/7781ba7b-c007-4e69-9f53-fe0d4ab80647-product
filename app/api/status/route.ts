import { NextResponse } from "next/server";
import { ensureMigrated } from "../../../lib/server/migrate";
import { NO_STORE } from "../../../lib/server/gpu-http";
import { providerHealthSnapshot } from "../../../lib/server/provider-health-worker";
import { listManagedInstances } from "../../../lib/server/vast-lifecycle";

// Provider status for the workspace surfaces (Overview badge, admin health).
//
// Public and unauthenticated on purpose: it returns only the coarse normalized
// status of each provider plus warm/pending instance counts. No credential, base
// URL, model mapping, or upstream error text is included, so it can be read by the
// Overview page before a session exists.
//
// The snapshot is served from provider_health and refreshed inline only when it is
// older than VASTAI_HEALTH_INTERVAL_SECONDS, so a page render never fans out live
// probes onto a rented GPU.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureMigrated();
    const snapshot = await providerHealthSnapshot();
    const instances = await listManagedInstances();
    return NextResponse.json(
      {
        active: snapshot.active,
        fallback: snapshot.fallback,
        // The badge reads this: every configured provider's coarse state.
        providers: snapshot.providers.map((entry) => ({
          provider: entry.provider,
          status: entry.status,
          healthy: entry.healthy,
          latencyMs: entry.latencyMs,
          checkedAt: entry.checkedAt,
          stale: entry.stale,
          warmInstances: typeof entry.detail.warmInstances === "number" ? entry.detail.warmInstances : null,
          pendingInstances: typeof entry.detail.pendingInstances === "number" ? entry.detail.pendingInstances : null,
        })),
        lifecycle: {
          enabled: snapshot.lifecycle.enabled,
          warmPool: snapshot.lifecycle.warmPool,
          maxInstances: snapshot.lifecycle.maxInstances,
          idleShutdownMinutes: snapshot.lifecycle.idleShutdownMinutes,
          coldStartBudgetMs: snapshot.lifecycle.coldStartBudgetMs,
          healthIntervalSeconds: snapshot.lifecycle.healthIntervalSeconds,
        },
        instances: instances.map((entry) => ({
          modelId: entry.modelId,
          state: entry.state,
          ready: entry.ready,
          coldStartMs: entry.coldStartMs,
          idleMinutes: entry.idleMinutes,
          warmPool: entry.warmPool,
        })),
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "provider_status_read_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Status is temporarily unavailable.", code: "STATUS_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
  }
}

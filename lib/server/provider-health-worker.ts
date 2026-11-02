import { query } from "./db";
import { vastLifecycleConfig, type InferenceProviderId } from "./config";
import type { InferenceHealth, InferenceStatus } from "./inference";
import { syncCuratedModels } from "./models";
import { listProviderHealth } from "./provider";
import { describeVastLifecycle, listManagedInstances, shutdownIdle, warmPool } from "./vast-lifecycle";

// Provider health worker (PRD: health is refreshed on a schedule and surfaced on
// Overview and the admin health screen).
//
// One module owns the whole cadence:
//   refreshProviderHealth()  — probes every configured provider through the same
//                              normalized health() contract requests use, and
//                              persists the result to provider_health.
//   runHealthCycle()          — refresh + idle shutdown + warm-pool top-up + the
//                              per-model availability refresh. This is what the
//                              cron endpoint calls.
//   providerHealthSnapshot()  — the cheap read the Overview badge and the admin
//                              screen use. It refreshes inline when the stored
//                              snapshot is older than VASTAI_HEALTH_INTERVAL_SECONDS,
//                              so the badge is real even before a cron has run.
//
// Status transitions are recorded as structured metrics (provider_health_transition)
// so an operator can see when a provider went degraded and came back, without
// reading server logs. Nothing credential-shaped is stored or returned.

/** One persisted health row, as the UI consumes it. */
export type ProviderHealthSnapshot = {
  provider: InferenceProviderId;
  status: InferenceStatus;
  healthy: boolean;
  latencyMs: number | null;
  modelIds: string[];
  detail: Record<string, unknown>;
  checkedAt: string;
  /** True when the row is older than the configured refresh interval. */
  stale: boolean;
};

function normalizedStatus(health: InferenceHealth): InferenceStatus {
  if (health.status) return health.status;
  return health.healthy ? "operational" : "unavailable";
}

async function lastStatus(provider: string): Promise<string | null> {
  try {
    const rows = await query<{ status: string }>(`SELECT status FROM provider_health WHERE provider=$1`, [provider]);
    return rows[0]?.status ?? null;
  } catch {
    return null;
  }
}

async function persist(provider: string, health: InferenceHealth, detail: Record<string, unknown>): Promise<void> {
  const status = normalizedStatus(health);
  const previous = await lastStatus(provider);
  try {
    await query(
      `INSERT INTO provider_health (provider, status, healthy, latency_ms, model_ids, detail, checked_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,now())
       ON CONFLICT (provider) DO UPDATE SET status=EXCLUDED.status, healthy=EXCLUDED.healthy, latency_ms=EXCLUDED.latency_ms,
         model_ids=EXCLUDED.model_ids, detail=EXCLUDED.detail, checked_at=now()`,
      [provider, status, health.healthy, health.latencyMs ?? null, JSON.stringify(health.modelIds ?? []), JSON.stringify(detail)]
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "provider_health_persist_failed", provider, error: error instanceof Error ? error.name : "unknown" }));
  }
  if (previous !== status) {
    // A transition is the interesting health event, not a steady state. Written to
    // the same structured metric table as instance lifecycle.
    try {
      await query(
        `INSERT INTO provider_instance_events (instance_id, model_id, provider, event, detail) VALUES (NULL,NULL,$1,'provider_health_transition',$2::jsonb)`,
        [provider, JSON.stringify({ from: previous, to: status, latencyMs: health.latencyMs ?? null })]
      );
    } catch {
      // A metric that cannot be stored must not fail the refresh.
    }
    console.log(JSON.stringify({ event: "provider_health_transition", provider, from: previous, to: status, latencyMs: health.latencyMs ?? null }));
  }
}

/**
 * Probes every provider once and persists the result. Never throws: a provider
 * outage is data, not a worker failure.
 */
export async function refreshProviderHealth(): Promise<ProviderHealthSnapshot[]> {
  let report: Awaited<ReturnType<typeof listProviderHealth>>;
  try {
    report = await listProviderHealth();
  } catch (error) {
    console.error(JSON.stringify({ event: "provider_health_refresh_failed", error: error instanceof Error ? error.name : "unknown" }));
    return [];
  }

  const snapshots: ProviderHealthSnapshot[] = [];
  for (const provider of report.providers) {
    const detail: Record<string, unknown> = {
      active: provider.active,
      fallback: provider.fallback,
      configured: provider.configured,
      warmInstances: provider.health.warmInstances ?? null,
      pendingInstances: provider.health.pendingInstances ?? null,
    };
    await persist(provider.id, provider.health, detail);
    snapshots.push({
      provider: provider.id,
      status: normalizedStatus(provider.health),
      healthy: provider.health.healthy,
      latencyMs: provider.health.latencyMs ?? null,
      modelIds: provider.health.modelIds ?? [],
      detail,
      checkedAt: new Date().toISOString(),
      stale: false,
    });
  }
  return snapshots;
}

function staleAfterMs(): number {
  try {
    return vastLifecycleConfig().healthIntervalSeconds * 1000;
  } catch {
    return 60_000;
  }
}

/**
 * The stored health snapshot, refreshed inline when it is older than the
 * configured interval. The Overview badge and the admin screen both read this, so
 * neither pays for a live probe on every render.
 */
export async function providerHealthSnapshot(options: { refreshIfStale?: boolean } = {}): Promise<{
  providers: ProviderHealthSnapshot[];
  active: InferenceProviderId;
  fallback: InferenceProviderId | null;
  lifecycle: ReturnType<typeof describeVastLifecycle>;
}> {
  const lifecycle = describeVastLifecycle();

  let rows: Array<{ provider: string; status: string; healthy: boolean; latency_ms: number | null; model_ids: unknown; detail: unknown; checked_at: string }> = [];
  try {
    rows = await query(
      `SELECT provider, status, healthy, latency_ms, COALESCE(model_ids,'[]'::jsonb) AS model_ids, COALESCE(detail,'{}'::jsonb) AS detail, checked_at::text AS checked_at
         FROM provider_health ORDER BY provider ASC`
    );
  } catch {
    rows = [];
  }

  const interval = staleAfterMs();
  const isStale = (checkedAt: string) => Date.now() - new Date(checkedAt).getTime() > interval;
  const stale = rows.length === 0 || rows.every((row) => isStale(row.checked_at));

  if (stale && options.refreshIfStale !== false) {
    const refreshed = await refreshProviderHealth();
    if (refreshed.length > 0) {
      let report: Awaited<ReturnType<typeof listProviderHealth>> | null = null;
      try {
        report = await listProviderHealth();
      } catch {
        report = null;
      }
      return {
        providers: refreshed,
        active: report?.active ?? "openrouter",
        fallback: report?.fallback ?? null,
        lifecycle,
      };
    }
  }

  const providers: ProviderHealthSnapshot[] = rows.map((row) => ({
    provider: row.provider as InferenceProviderId,
    status: (row.status === "operational" || row.status === "degraded" ? row.status : "unavailable") as InferenceStatus,
    healthy: row.healthy,
    latencyMs: row.latency_ms,
    modelIds: Array.isArray(row.model_ids) ? (row.model_ids as string[]) : [],
    detail: (row.detail ?? {}) as Record<string, unknown>,
    checkedAt: row.checked_at,
    stale: isStale(row.checked_at),
  }));

  const activeRow = providers.find((entry) => entry.detail.active === true) ?? providers[0];
  return {
    providers,
    active: activeRow?.provider ?? "openrouter",
    fallback: (providers.find((entry) => entry.detail.fallback === true)?.provider ?? null),
    lifecycle,
  };
}

/**
 * One full worker cycle: refresh health, terminate idle instances, keep the warm
 * pool rented, then recompute per-model availability so the Overview cards and the
 * Playground selector converge on the same truth. Called by the cron endpoint and
 * safe to run concurrently — every transition takes a single-flight path.
 */
export async function runHealthCycle(): Promise<{
  health: ProviderHealthSnapshot[];
  instances: number;
  shutdown: number;
  crashed: number;
  retried: number;
  warmed: string[];
  models: { synced: number; unavailable: number; provider: string };
}> {
  const health = await refreshProviderHealth();
  const sweep = await shutdownIdle();
  const pool = await warmPool();
  const instances = (await listManagedInstances()).length;
  // Per-model availability is forced here: the cron is the backstop that makes an
  // admin activate/pause and a provider transition reach the UI within one
  // interval even when no workspace happens to be open.
  let models: { synced: number; unavailable: number; provider: string } = { synced: 0, unavailable: 0, provider: "openrouter" };
  try {
    const synced = await syncCuratedModels({ force: true });
    models = { synced: synced.synced, unavailable: synced.unavailable, provider: synced.provider };
  } catch (error) {
    console.error(JSON.stringify({ event: "model_availability_cycle_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
  console.log(JSON.stringify({
    event: "provider_health_cycle",
    providers: health.map((entry) => ({ provider: entry.provider, status: entry.status })),
    instances,
    shutdown: sweep.shutdown,
    crashed: sweep.crashed,
    warmed: pool.warmed.length,
    models,
  }));
  return { health, instances, shutdown: sweep.shutdown, crashed: sweep.crashed, retried: sweep.retried, warmed: pool.warmed, models };
}

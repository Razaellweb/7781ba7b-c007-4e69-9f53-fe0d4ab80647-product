import { modelHealthConfig, type InferenceProviderId } from "./config";
import { query } from "./db";
import type { InferenceHealth, InferenceStatus } from "./inference";
import { OpenRouterProvider } from "./openrouter";
import { VastAIProvider } from "./vast-inference";
import { listManagedInstances } from "./vast-lifecycle";

// Per-model provider health (PRD: the registry's availability computation
// consults the provider's normalized health contract, so the Overview cards show
// real `Operational` / `Degraded` / `Unavailable` states).
//
// Three responsibilities live here, and nowhere else:
//
//   probeModels()        — one cheap, read-only observation of every curated
//                          model against the ACTIVE provider. It never rents a GPU
//                          and never blocks on one: `VastAIProvider.health()` plus
//                          the per-instance catalogue is the whole input.
//   recordModelProbes()  — persists that observation with DEBOUNCE. A flapping
//                          endpoint must not thrash the Overview cards or the
//                          Playground selector, so a transition is only adopted
//                          after `MODEL_HEALTH_DEBOUNCE_RUNS` consecutive
//                          observations agree. The stored `status` is what the
//                          product shows; `candidate_status`/`candidate_count` are
//                          the pending observation.
//   modelHealthStatuses()— the cheap read the registry projection and the models
//                          API use. No probe on a render path.
//
// The registry remains the source of truth: a provider that reports a model id
// the registry does not contain is IGNORED (and logged), never surfaced.

/** One persisted per-model health row. */
export type ModelHealthRow = {
  model_slug: string;
  provider: InferenceProviderId;
  status: InferenceStatus;
  candidate_status: InferenceStatus | null;
  candidate_count: number;
  latency_ms: number | null;
  detail: Record<string, unknown>;
  checked_at: string;
  changed_at: string;
};

/** One model's probed state. */
export type ModelProbe = {
  status: InferenceStatus;
  latencyMs: number | null;
  detail: Record<string, unknown>;
};

/**
 * A probe run. `unknownModelIds` are provider identifiers the registry does not
 * contain; they are logged as a configuration drift signal and never displayed.
 */
export type ModelProbeReport = { probes: Map<string, ModelProbe>; unknownModelIds: string[] };

/** The curated model a probe needs to know about. */
export type CuratedModelTarget = { slug: string; vastModelId: string | null };

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function unavailableDetail(reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { reason, ...extra };
}

// ---------------------------------------------------------------------------
// vast.ai: provider health + per-model health.
// ---------------------------------------------------------------------------

/**
 * Observes every curated model against vast.ai.
 *
 * The provider-level probe (`/models` on a static endpoint, or the rented fleet in
 * managed mode) answers "can this deployment serve at all?". Per-model health then
 * narrows that to "does THIS model's route exist and answer?", which is what the
 * cards must show:
 *
 *   STATIC endpoint
 *     operational — the endpoint answered and (when it publishes a catalogue) it
 *                   serves this model's mapped identifier;
 *     degraded    — the endpoint answered but rejects/throttles us;
 *     unavailable — the mapped identifier is missing from the served catalogue,
 *                   the model has no vast.ai mapping, or the endpoint is down.
 *
 *   MANAGED (rented) fleet
 *     operational — this model has a warm machine answering;
 *     degraded    — no warm machine, but one can be rented on demand (the first
 *                   turn pays the cold-start budget);
 *     unavailable — the provider cannot serve this model at all.
 *
 * A model with no vast.ai mapping is unavailable FOR THIS PROVIDER and is logged as
 * a configuration error, exactly as the brief requires.
 */
export async function probeVastModels(models: CuratedModelTarget[]): Promise<ModelProbeReport> {
  const probes = new Map<string, ModelProbe>();
  const unknownModelIds: string[] = [];
  const provider = new VastAIProvider();

  let health: InferenceHealth;
  try {
    health = await provider.health();
  } catch {
    health = { healthy: false, message: "unavailable", status: "unavailable", latencyMs: null, modelIds: [] };
  }
  const providerStatus: InferenceStatus = health.status ?? (health.healthy ? "operational" : "unavailable");
  const servedIds = Array.isArray(health.modelIds) ? health.modelIds : [];

  // Managed mode reports per-model state from the instance rows: that is the
  // authoritative answer to "is THIS model warm?".
  const managed = Boolean(health.warmInstances !== undefined || health.pendingInstances !== undefined);
  let instances: Awaited<ReturnType<typeof listManagedInstances>> = [];
  if (managed) {
    try {
      instances = await listManagedInstances();
    } catch {
      instances = [];
    }
  }

  for (const model of models) {
    const mapped = model.vastModelId;
    if (!mapped) {
      // No mapping: a configuration error, not an outage. Logged, and the model is
      // unavailable for this provider only — another provider may still serve it.
      console.error(JSON.stringify({ event: "model_registry_config_error", provider: "vast", model: model.slug, reason: "no_vast_mapping" }));
      probes.set(model.slug, { status: "unavailable", latencyMs: health.latencyMs ?? null, detail: unavailableDetail("no_vast_mapping", { mapped: null }) });
      continue;
    }

    if (providerStatus === "unavailable") {
      probes.set(model.slug, { status: "unavailable", latencyMs: health.latencyMs ?? null, detail: unavailableDetail("provider_unavailable", { mapped }) });
      continue;
    }

    if (managed) {
      const instance = instances.find((entry) => entry.modelId.toLowerCase() === model.slug.toLowerCase());
      if (instance && instance.ready) {
        probes.set(model.slug, { status: "operational", latencyMs: health.latencyMs ?? null, detail: { mapped, state: instance.state, coldStartMs: instance.coldStartMs } });
      } else if (instance) {
        probes.set(model.slug, { status: "degraded", latencyMs: health.latencyMs ?? null, detail: { mapped, state: instance.state, warming: true } });
      } else {
        // No machine, but the lifecycle manager can rent one on the next request.
        probes.set(model.slug, { status: providerStatus === "degraded" ? "degraded" : "degraded", latencyMs: health.latencyMs ?? null, detail: { mapped, state: "cold", rentable: true } });
      }
      continue;
    }

    // Static endpoint. A healthy answer without a catalogue still proves the server
    // is up, which is all a single-model deployment can report.
    if (providerStatus === "degraded") {
      probes.set(model.slug, { status: "degraded", latencyMs: health.latencyMs ?? null, detail: { mapped, served: servedIds.length } });
      continue;
    }
    if (servedIds.length === 0 || servedIds.includes(mapped)) {
      probes.set(model.slug, { status: "operational", latencyMs: health.latencyMs ?? null, detail: { mapped, served: servedIds.length } });
      continue;
    }
    probes.set(model.slug, { status: "unavailable", latencyMs: health.latencyMs ?? null, detail: unavailableDetail("model_not_served", { mapped, served: servedIds.slice(0, 20) }) });
  }

  // Registry is the source of truth: provider ids we do not curate are ignored.
  if (servedIds.length > 0) {
    const curatedIds = new Set(models.map((model) => model.vastModelId).filter((id): id is string => Boolean(id)));
    for (const id of servedIds) {
      if (!curatedIds.has(id)) unknownModelIds.push(id);
    }
    if (unknownModelIds.length > 0) {
      console.error(JSON.stringify({ event: "model_registry_ignored_provider_model", provider: "vast", count: unknownModelIds.length, ids: unknownModelIds.slice(0, 20) }));
    }
  }

  return { probes, unknownModelIds };
}

// ---------------------------------------------------------------------------
// OpenRouter: catalogue membership is the per-model signal.
// ---------------------------------------------------------------------------

/**
 * Observes every curated model against OpenRouter. Membership in the live
 * catalogue is the per-model signal; the catalogue being unreachable degrades every
 * OpenRouter model rather than reporting a per-model outage.
 */
export async function probeOpenRouterModels(models: Array<{ slug: string; providerModelSlug: string }>): Promise<ModelProbeReport> {
  const probes = new Map<string, ModelProbe>();
  let catalog: Awaited<ReturnType<OpenRouterProvider["catalog"]>>;
  try {
    catalog = await new OpenRouterProvider().catalog();
  } catch {
    for (const model of models) {
      probes.set(model.slug, { status: "degraded", latencyMs: null, detail: unavailableDetail("catalog_unavailable") });
    }
    return { probes, unknownModelIds: [] };
  }

  const byId = new Map(catalog.map((model) => [model.providerModelId, model]));
  for (const model of models) {
    const providerModel = model.providerModelSlug ? byId.get(model.providerModelSlug) : undefined;
    probes.set(
      model.slug,
      providerModel
        ? { status: "operational", latencyMs: null, detail: { persisted: true, contextLength: providerModel.contextLength } }
        : { status: "unavailable", latencyMs: null, detail: unavailableDetail("model_not_in_catalog", { providerModelSlug: model.providerModelSlug || null }) }
    );
  }

  const curatedIds = new Set(models.map((model) => model.providerModelSlug).filter(Boolean));
  const unknownModelIds = catalog.map((model) => model.providerModelId).filter((id) => !curatedIds.has(id));
  if (unknownModelIds.length > 0) {
    console.error(JSON.stringify({ event: "model_registry_ignored_provider_model", provider: "openrouter", count: unknownModelIds.length }));
  }
  return { probes, unknownModelIds };
}

// ---------------------------------------------------------------------------
// Debounced persistence.
// ---------------------------------------------------------------------------

function transitionIsConfirmed(probeStatus: InferenceStatus, row: ModelHealthRow | undefined, debounceRuns: number): { status: InferenceStatus; candidate: InferenceStatus | null; count: number } {
  // A brand-new row adopts its first observation: there is nothing to debounce
  // against, and showing no state at all would be worse than showing the truth.
  if (!row) return { status: probeStatus, candidate: null, count: 0 };
  if (probeStatus === row.status) return { status: row.status, candidate: null, count: 0 };
  if (row.candidate_status === probeStatus) {
    const count = row.candidate_count + 1;
    if (count >= debounceRuns) return { status: probeStatus, candidate: null, count: 0 };
    return { status: row.status, candidate: probeStatus, count };
  }
  const count = 1;
  if (count >= debounceRuns) return { status: probeStatus, candidate: null, count: 0 };
  return { status: row.status, candidate: probeStatus, count };
}

/**
 * Persists one probe run, debouncing transitions, and resolves to the status the
 * product should now show for each model.
 *
 * A write failure is reported but never fatal: the caller then projects the last
 * stored value, so a database hiccup cannot fabricate availability.
 */
export async function recordModelProbes(provider: InferenceProviderId, report: ModelProbeReport): Promise<Map<string, InferenceStatus>> {
  const statuses = new Map<string, InferenceStatus>();
  if (report.probes.size === 0) return statuses;

  const debounceRuns = modelHealthConfig().debounceRuns;
  let existing: ModelHealthRow[] = [];
  try {
    existing = await query<ModelHealthRow>(
      `SELECT model_slug, provider, status, candidate_status, candidate_count, latency_ms, COALESCE(detail,'{}'::jsonb) AS detail,
              checked_at::text AS checked_at, changed_at::text AS changed_at
         FROM model_health WHERE provider=$1`,
      [provider]
    );
  } catch {
    existing = [];
  }
  const bySlug = new Map(existing.map((row) => [row.model_slug, row]));

  for (const [slug, probe] of report.probes) {
    const row = bySlug.get(slug);
    const next = transitionIsConfirmed(probe.status, row, debounceRuns);
    statuses.set(slug, next.status);
    const changed = !row || row.status !== next.status;
    try {
      await query(
        `INSERT INTO model_health (model_slug, provider, status, candidate_status, candidate_count, latency_ms, detail, checked_at, changed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
         ON CONFLICT (model_slug, provider) DO UPDATE SET
           status=EXCLUDED.status,
           candidate_status=EXCLUDED.candidate_status,
           candidate_count=EXCLUDED.candidate_count,
           latency_ms=EXCLUDED.latency_ms,
           detail=EXCLUDED.detail,
           checked_at=now(),
           changed_at=CASE WHEN model_health.status <> EXCLUDED.status THEN now() ELSE model_health.changed_at END`,
        [slug, provider, next.status, next.candidate, next.count, probe.latencyMs, JSON.stringify(probe.detail)]
      );
    } catch (error) {
      console.error(JSON.stringify({ event: "model_health_persist_failed", provider, model: slug, error: error instanceof Error ? error.name : "unknown" }));
    }
    if (changed && row) {
      // A transition is the interesting event, not a steady state.
      console.log(JSON.stringify({ event: "model_health_transition", provider, model: slug, from: row.status, to: next.status }));
    }
  }

  return statuses;
}

/** The stored (already debounced) per-model status for one provider. */
export async function modelHealthStatuses(provider: InferenceProviderId): Promise<Map<string, ModelHealthRow>> {
  try {
    const rows = await query<ModelHealthRow>(
      `SELECT model_slug, provider, status, candidate_status, candidate_count, latency_ms, COALESCE(detail,'{}'::jsonb) AS detail,
              checked_at::text AS checked_at, changed_at::text AS changed_at
         FROM model_health WHERE provider=$1`,
      [provider]
    );
    return new Map(rows.map((row) => [row.model_slug, { ...row, detail: objectValue(row.detail) }]));
  } catch {
    return new Map();
  }
}

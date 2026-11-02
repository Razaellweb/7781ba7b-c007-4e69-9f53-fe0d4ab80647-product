import { randomBytes, randomUUID } from "node:crypto";
import { query } from "./db";
import { vastInferenceConfig, vastLifecycleConfig, type VastLifecycleConfig } from "./config";
import { RedisError, withLock } from "./redis";
import {
  createInstance,
  destroyInstance,
  getInstance,
  searchGpuOffers,
  VastUnavailableError,
  type GpuOffer,
  type InstanceSpec,
  type VastInstance,
} from "./vast";

// vast.ai instance lifecycle (PRD: normalized stream/usage/cost/health/error
// contracts, with provider replacement support).
//
// Two deployment shapes are supported by the same provider abstraction:
//
//   1. PRE-PROVISIONED (static): VASTAI_BASE_URL points at a machine that is
//      already running. Nothing is rented; only the health half of this feature
//      is active.
//   2. MANAGED (rented on demand): VASTAI_LIFECYCLE_ENABLED=true. A curated
//      model that has no warm machine is started on the marketplace by
//      ensureInstance(), kept warm while it is used, and terminated by
//      shutdownIdle() once it has been unused past the configured window.
//
// Concurrency is the interesting part. Three mechanisms cooperate so a burst of
// requests for a cold model rents exactly one machine:
//
//   - `inference_instances` has a partial unique index over the ACTIVE states, so
//     the database itself refuses a second live row for the same curated model.
//     That is the authoritative lock; it works with or without Redis.
//   - Redis (when configured) adds a distributed lock around the rent call so
//     other processes wait instead of racing to the unique index.
//   - `claim_token` / `claim_expires_at` make the slow steps (polling the
//     marketplace, probing the endpoint, terminating) single-flight per row.
//
// Every transition is written to provider_instance_events as a structured metric
// (instance_start_requested / instance_ready / instance_warm /
// instance_start_failed / instance_stopped / instance_idle_shutdown) so warm and
// cold latency is inspectable without server logs. No credential, marketplace
// payload, or upstream error text is ever recorded.

/** Why a machine could not be made available. */
export type InstanceUnavailableReason =
  | "disabled"
  | "unconfigured"
  | "cold_start_timeout"
  | "capacity"
  | "start_failed"
  | "lost";

/** Normalized failure raised when a model cannot be started right now. */
export class InstanceUnavailableError extends Error {
  /** The PRD's normalized code for "this model cannot serve right now". */
  readonly code = "model_unavailable";
  readonly retryable = true;
  readonly reason: InstanceUnavailableReason;
  constructor(reason: InstanceUnavailableReason) {
    super("The model could not be started right now. Nothing was charged.");
    this.name = "InstanceUnavailableError";
    this.reason = reason;
  }
}

export type InstanceState = "provisioning" | "warming" | "ready" | "idle" | "terminating" | "terminated" | "failed";

export type InstanceRow = {
  id: string;
  model_id: string;
  provider: string;
  provider_instance_id: string | null;
  provider_model: string | null;
  base_url: string | null;
  service_api_key: string | null;
  offer_id: string | null;
  state: InstanceState;
  claim_token: string | null;
  claim_expires_at: Date | null;
  failure_reason: string | null;
  provider_hourly_micro_usd: string | null;
  cold_start_ms: number | null;
  last_used_at: Date | null;
  last_health_at: Date | null;
  health_status: string | null;
  ready_at: Date | null;
  terminated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/** What the provider needs to reach a usable machine. */
export type InstanceRoute = { baseUrl: string; apiKey: string | null; warm: boolean; modelId: string; instanceId: string };

const USABLE_STATES: InstanceState[] = ["ready", "idle"];
// A claim is a single-flight lease on one row. Long enough to cover a rent call
// plus a cold-start poll, short enough that a crashed process recovers quickly.
const CLAIM_SECONDS = 90;
const REDIS_LOCK_SECONDS = 180;

const now = () => Date.now();

function log(event: string, detail: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...detail }));
}

function warn(event: string, detail: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ event, ...detail }));
}

/** Structured lifecycle metric. Failures never break the request path. */
async function recordEvent(instance: { id: string | null; model_id: string | null }, event: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await query(
      `INSERT INTO provider_instance_events (instance_id, model_id, provider, event, detail) VALUES ($1,$2,'vast',$3,$4::jsonb)`,
      [instance.id, instance.model_id, event, JSON.stringify(detail)]
    );
  } catch {
    // The lifecycle must never fail because a metric row could not be written.
  }
  log(event, { instanceId: instance.id, modelId: instance.model_id, ...detail });
}

function normalizedModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

// The marketplace identifier a curated model maps to. Falls back to the id the
// caller supplied, which is what a single-model deployment expects.
function providerModelFor(modelId: string): string {
  const config = vastInferenceConfig();
  const key = normalizedModelId(modelId);
  const target = config.modelMap ? config.modelMap[key] : undefined;
  return target?.modelId ?? modelId;
}

/** Public URL of an OpenAI-compatible server on a running instance. */
function baseUrlFor(instance: VastInstance): string | null {
  const port = instance.ports["8000/tcp"];
  if (!instance.publicIp || !port) return null;
  return `http://${instance.publicIp}:${port}/v1`;
}

async function loadInstance(instanceId: string): Promise<InstanceRow | null> {
  const rows = await query<InstanceRow>(`SELECT * FROM inference_instances WHERE id=$1`, [instanceId]);
  return rows[0] ?? null;
}

async function loadActive(modelId: string): Promise<InstanceRow | null> {
  const rows = await query<InstanceRow>(
    `SELECT * FROM inference_instances WHERE model_id=$1 AND state IN ('provisioning','warming','ready','idle') ORDER BY created_at DESC LIMIT 1`,
    [modelId]
  );
  return rows[0] ?? null;
}

async function updateInstance(instanceId: string, fields: Partial<InstanceRow>): Promise<InstanceRow | null> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return loadInstance(instanceId);
  const sets = entries.map(([column], index) => `${column}=$${index + 2}`).join(", ");
  const values = entries.map(([, value]) => value);
  const rows = await query<InstanceRow>(`UPDATE inference_instances SET ${sets}, updated_at=now() WHERE id=$1 RETURNING *`, [instanceId, ...values]);
  return rows[0] ?? null;
}

/** Takes a short single-flight lease on one instance row. */
async function claim(instanceId: string): Promise<string | null> {
  const token = randomUUID();
  const rows = await query<{ id: string }>(
    `UPDATE inference_instances SET claim_token=$2, claim_expires_at=now() + make_interval(secs => $3), updated_at=now()
      WHERE id=$1 AND (claim_expires_at IS NULL OR claim_expires_at < now()) RETURNING id`,
    [instanceId, token, CLAIM_SECONDS]
  );
  return rows[0] ? token : null;
}

async function releaseClaim(instanceId: string, token: string): Promise<void> {
  await query(`UPDATE inference_instances SET claim_token=NULL, claim_expires_at=NULL, updated_at=now() WHERE id=$1 AND claim_token=$2`, [instanceId, token]).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Retiring a machine.
// ---------------------------------------------------------------------------

/**
 * Terminates one instance at the provider and moves the row out of the active
 * states. A row that is already terminating is not terminated twice, which is
 * what makes an idle-shutdown racing a request harmless: the request sees no
 * usable endpoint and warms a fresh machine instead of being served by the
 * machine that is going away.
 */
export async function terminateInstance(instanceId: string, reason: string): Promise<boolean> {
  // Move the row out of the active states first, so no new request can be routed
  // to it while the provider teardown is in flight.
  const claimed = await query<InstanceRow>(
    `UPDATE inference_instances SET state='terminating', claim_token=NULL, claim_expires_at=NULL, failure_reason=$2, updated_at=now()
      WHERE id=$1 AND state IN ('provisioning','warming','ready','idle','failed') RETURNING *`,
    [instanceId, reason]
  );
  const instance = claimed[0];
  if (!instance) return false;

  let destroyed = true;
  if (instance.provider_instance_id) {
    try {
      await destroyInstance(Number(instance.provider_instance_id));
    } catch (error) {
      destroyed = false;
      warn("vast_instance_terminate_failed", { instanceId, kind: error instanceof VastUnavailableError ? error.kind : "unknown", reason });
    }
  }

  await updateInstance(instanceId, {
    // A teardown that could not reach the marketplace stays "terminating" so the
    // next sweep retries it; the row is already unreachable by request paths.
    state: destroyed ? "terminated" : "terminating",
    terminated_at: destroyed ? new Date() : instance.terminated_at,
  });
  if (destroyed) await recordEvent(instance, "instance_stopped", { reason, providerInstanceId: instance.provider_instance_id });
  return destroyed;
}

// Retries terminations that could not reach the marketplace.
async function retryTerminations(limit = 5): Promise<number> {
  try {
    const stale = await query<{ id: string; provider_instance_id: string | null; failure_reason: string | null }>(
      `SELECT id, provider_instance_id, failure_reason FROM inference_instances
        WHERE state='terminating' AND updated_at < now() - interval '2 minutes' ORDER BY updated_at ASC LIMIT $1`,
      [limit]
    );
    let done = 0;
    for (const row of stale) {
      if (!row.provider_instance_id) {
        await query(`UPDATE inference_instances SET state='terminated', terminated_at=now(), updated_at=now() WHERE id=$1`, [row.id]);
        done += 1;
        continue;
      }
      try {
        await destroyInstance(Number(row.provider_instance_id));
        await query(`UPDATE inference_instances SET state='terminated', terminated_at=now(), updated_at=now() WHERE id=$1`, [row.id]);
        await recordEvent({ id: row.id, model_id: null }, "instance_stopped", { reason: row.failure_reason ?? "retry" });
        done += 1;
      } catch {
        // Retried on the next sweep.
      }
    }
    return done;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Renting a machine.
// ---------------------------------------------------------------------------

async function pickOffer(config: VastLifecycleConfig): Promise<GpuOffer | null> {
  const result = await searchGpuOffers({
    gpuName: config.gpuName,
    minGpuRamGb: config.minGpuRamGb > 0 ? config.minGpuRamGb : null,
    maxPricePerHour: config.maxHourlyUsd,
    minReliability: 0.9,
    limit: 20,
  });
  return result.offers.find((offer) => offer.hourlyPriceUsd !== null) ?? null;
}

/**
 * The onstart script of a lifecycle-managed inference machine: start a vLLM
 * OpenAI-compatible server on port 8000, protected by a per-instance key.
 *
 * Deliberately carries no lease script: these machines belong to the platform
 * (not to a user rental) and are stopped by shutdownIdle().
 */
function inferenceStartScript(options: { model: string; apiKey: string; maxModelLen: number }): string {
  return [
    "mkdir -p /root/.openweight",
    `nohup python3 -m vllm.entrypoints.openai.api_server --host 0.0.0.0 --port 8000 --model "${options.model}" --api-key "${options.apiKey}" --max-model-len ${options.maxModelLen} > /root/.openweight/server.log 2>&1 &`,
  ].join("\n");
}

function instanceSpec(config: VastLifecycleConfig, options: { label: string; model: string; apiKey: string }): InstanceSpec {
  return {
    image: config.image,
    env: { "-p 8000:8000": "1" },
    onstart: inferenceStartScript({ model: options.model, apiKey: options.apiKey, maxModelLen: config.maxModelLen }),
    runtype: "ssh_direc ssh_proxy",
    diskGb: config.diskGb,
    label: options.label,
    useJupyterLab: false,
  };
}

type RentOutcome = { instance: InstanceRow };

/**
 * Rents one machine for `modelId` and persists the provisioning row. Callers hold
 * the model's distributed lock, so this is the only rent in flight for that model.
 * Returns null when the pool is at capacity or no offer matches.
 */
async function rent(modelId: string, config: VastLifecycleConfig): Promise<RentOutcome | null> {
  const live = await query<{ count: string }>(`SELECT count(*)::text count FROM inference_instances WHERE state IN ('provisioning','warming','ready','idle','terminating')`);
  if (Number(live[0]?.count ?? 0) >= config.maxInstances) {
    warn("vast_instance_capacity_reached", { modelId, maxInstances: config.maxInstances });
    return null;
  }

  const providerModel = providerModelFor(modelId);
  const serviceKey = `ow_inf_${randomBytes(24).toString("base64url")}`;
  const startedAt = now();

  const offer = await pickOffer(config).catch((error) => {
    warn("vast_instance_offer_search_failed", { modelId, kind: error instanceof VastUnavailableError ? error.kind : "unknown" });
    return null;
  });
  if (!offer || offer.id === null) {
    warn("vast_instance_no_offer", { modelId, maxHourlyUsd: config.maxHourlyUsd, minGpuRamGb: config.minGpuRamGb });
    return null;
  }

  const hourlyMicro = offer.hourlyPriceUsd === null ? null : BigInt(Math.ceil(offer.hourlyPriceUsd * 1_000_000)).toString();
  const label = `ow-inf-${normalizedModelId(modelId)}-${randomBytes(4).toString("hex")}`;

  let providerInstanceId: number;
  try {
    providerInstanceId = await createInstance(Number(offer.id), instanceSpec(config, { label, model: providerModel, apiKey: serviceKey }));
  } catch (error) {
    warn("vast_instance_rent_failed", { modelId, kind: error instanceof VastUnavailableError ? error.kind : "unknown" });
    return null;
  }

  const rows = await query<InstanceRow>(
    `INSERT INTO inference_instances (model_id, provider, provider_instance_id, provider_model, service_api_key, offer_id, state, provider_hourly_micro_usd, last_used_at, created_at)
     VALUES ($1,'vast',$2,$3,$4,$5,'provisioning',$6,now(),now()) RETURNING *`,
    [modelId, String(providerInstanceId), providerModel, serviceKey, String(offer.id), hourlyMicro]
  );
  const instance = rows[0];
  if (!instance) return null;
  await recordEvent(instance, "instance_start_requested", { providerInstanceId, offerId: offer.id, hourlyMicroUsd: hourlyMicro, gpuName: offer.gpuName });
  log("vast_instance_cold_start", { modelId, instanceId: instance.id, ms: now() - startedAt });
  return { instance };
}

/**
 * Polls one provisioning instance until its endpoint answers, the budget runs
 * out, or the marketplace reports it failed. Returns the usable route, or null
 * when the machine is gone or failed to start.
 */
async function awaitReady(instanceId: string, deadline: number, config: VastLifecycleConfig): Promise<InstanceRoute | null> {
  for (;;) {
    const instance = await loadInstance(instanceId);
    if (!instance) return null;

    // Someone else may have made it ready already.
    if (USABLE_STATES.includes(instance.state) && instance.base_url) {
      return { baseUrl: instance.base_url, apiKey: instance.service_api_key, warm: true, modelId: instance.model_id, instanceId: instance.id };
    }
    if (instance.state === "terminating" || instance.state === "terminated" || instance.state === "failed") return null;

    if (instance.provider_instance_id) {
      let remote: VastInstance | null = null;
      try {
        remote = await getInstance(Number(instance.provider_instance_id));
      } catch (error) {
        warn("vast_instance_lookup_failed", { instanceId, kind: error instanceof VastUnavailableError ? error.kind : "unknown" });
      }
      if (remote === null) {
        // The marketplace no longer knows this machine: it never started or was
        // removed. Fail the row so the next request rents a fresh one.
        await updateInstance(instanceId, { state: "failed", failure_reason: "gone" });
        await recordEvent(instance, "instance_start_failed", { reason: "gone" });
        return null;
      }
      if (remote.actualStatus === "running" && instance.state === "provisioning") {
        const url = baseUrlFor(remote);
        if (url) {
          const coldStartMs = now() - new Date(instance.created_at).getTime();
          await updateInstance(instanceId, { state: "warming", base_url: url, cold_start_ms: coldStartMs });
          await recordEvent(instance, "instance_container_running", { coldStartMs, providerInstanceId: instance.provider_instance_id });
        }
      }
      if (remote.actualStatus === "exited" || remote.intendedStatus === "stopped") {
        await updateInstance(instanceId, { state: "failed", failure_reason: "exited" });
        await recordEvent(instance, "instance_start_failed", { reason: "exited" });
        return null;
      }
    }

    // The container reports running; the model server also has to answer before
    // the instance counts as warm (a large checkpoint takes minutes to load).
    const current = await loadInstance(instanceId);
    if (current?.base_url && current.state === "warming") {
      if (await probeEndpoint(current.base_url, current.service_api_key)) {
        const coldStartMs = now() - new Date(current.created_at).getTime();
        const ready = await updateInstance(instanceId, {
          state: "ready",
          health_status: "operational",
          last_health_at: new Date(),
          last_used_at: new Date(),
          ready_at: new Date(),
          cold_start_ms: coldStartMs,
        });
        if (ready) {
          await recordEvent(ready, "instance_warm", { coldStartMs, endpointAnswered: true });
          return { baseUrl: ready.base_url ?? current.base_url, apiKey: ready.service_api_key, warm: true, modelId: ready.model_id, instanceId: ready.id };
        }
      }
    }

    if (now() >= deadline) {
      await updateInstance(instanceId, { state: "failed", failure_reason: "cold_start_timeout" });
      await recordEvent(instance, "instance_start_failed", { reason: "cold_start_timeout", budgetMs: config.coldStartBudgetMs });
      // A machine that never answered is still costing money: tear it down.
      await terminateInstance(instanceId, "cold_start_timeout");
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

/** Whether the instance's OpenAI-compatible endpoint answers. */
async function probeEndpoint(baseUrl: string, apiKey: string | null): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      cache: "no-store",
      signal: controller.signal,
    });
    // Drain without reading: no upstream body is needed or surfaced.
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public lifecycle API.
// ---------------------------------------------------------------------------

/**
 * Resolves a ready endpoint for one curated model, renting/starting a machine
 * when none is warm.
 *
 * Contract:
 *   - a warm machine is reused immediately and its idle clock is reset;
 *   - a cold model rents exactly one machine even under concurrency (distributed
 *     lock + partial unique index), and concurrent callers wait for that machine;
 *   - a start that exceeds VASTAI_COLD_START_BUDGET_MS fails with the normalized
 *     `model_unavailable` error, and the caller debits no compute;
 *   - returns null when the deployment is not lifecycle-managed, so the provider
 *     falls back to its configured static endpoint.
 */
export async function ensureInstance(modelId: string): Promise<InstanceRoute | null> {
  const config = vastLifecycleConfig();
  if (!config.enabled) return null;
  const key = normalizedModelId(modelId);
  if (!key) throw new InstanceUnavailableError("unconfigured");

  const deadline = now() + config.coldStartBudgetMs;

  for (;;) {
    const existing = await loadActive(key);
    if (existing) {
      if (USABLE_STATES.includes(existing.state) && existing.base_url) {
        await query(`UPDATE inference_instances SET last_used_at=now(), state='ready', updated_at=now() WHERE id=$1`, [existing.id]);
        return { baseUrl: existing.base_url, apiKey: existing.service_api_key, warm: true, modelId: existing.model_id, instanceId: existing.id };
      }
      // Provisioning/warming: another request already started this machine, so
      // wait for it instead of renting a second one.
      const route = await awaitReady(existing.id, deadline, config);
      if (route) return route;
      const current = await loadInstance(existing.id);
      if (current && (current.state === "provisioning" || current.state === "warming")) {
        // The budget expired while the start was still in progress: report a
        // retryable failure rather than piling on a duplicate rental.
        throw new InstanceUnavailableError("cold_start_timeout");
      }
      // The machine failed or was retired; loop to rent a fresh one.
    }

    if (now() >= deadline) throw new InstanceUnavailableError("cold_start_timeout");

    let rented: RentOutcome | null = null;
    const work = async (): Promise<void> => {
      // Double-check under the lock: another process may have just filled it.
      const active = await loadActive(key);
      if (active) return;
      rented = await rent(key, config);
    };

    try {
      await withLock(`vast:ensure:${key}`, REDIS_LOCK_SECONDS, work);
    } catch (error) {
      if (error instanceof RedisError) {
        // Coordination is unavailable; proceed without the distributed lock. The
        // partial unique index still prevents a duplicate rental.
        warn("vast_instance_lock_unavailable", { modelId: key });
        await work().catch(() => undefined);
      } else {
        throw error;
      }
    }

    const outcome = rented as RentOutcome | null;
    if (outcome) {
      const route = await awaitReady(outcome.instance.id, deadline, config);
      if (route) return route;
      const failed = await loadInstance(outcome.instance.id);
      if (failed?.failure_reason === "cold_start_timeout") throw new InstanceUnavailableError("cold_start_timeout");
      throw new InstanceUnavailableError("start_failed");
    }

    // Nothing was rented: either the pool is at capacity or no offer matched.
    const active = await loadActive(key);
    if (active && USABLE_STATES.includes(active.state) && active.base_url) {
      await query(`UPDATE inference_instances SET last_used_at=now() WHERE id=$1`, [active.id]);
      return { baseUrl: active.base_url, apiKey: active.service_api_key, warm: true, modelId: active.model_id, instanceId: active.id };
    }
    throw new InstanceUnavailableError("capacity");
  }
}

/**
 * Stops every managed machine that has been unused past the idle window, and
 * every machine that crashed. Warm-pool models are exempt from the idle rule.
 *
 * Safe to run concurrently: each termination takes the same single-flight path
 * as a request, and a terminated row is immediately unavailable to request paths,
 * so an idle-shutdown racing a new request just makes that request re-warm.
 */
export async function shutdownIdle(config: VastLifecycleConfig = vastLifecycleConfig()): Promise<{ shutdown: number; crashed: number; retried: number }> {
  if (!config.enabled) return { shutdown: 0, crashed: 0, retried: 0 };
  const result = { shutdown: 0, crashed: 0, retried: 0 };

  try {
    const stale = await query<{ id: string; model_id: string; last_used_at: Date | null }>(
      `SELECT id, model_id, last_used_at FROM inference_instances
        WHERE state IN ('ready','idle')
          AND last_used_at IS NOT NULL
          AND last_used_at < now() - make_interval(secs => $1)
        ORDER BY last_used_at ASC LIMIT 10`,
      [Math.max(60, Math.round(config.idleShutdownMinutes * 60))]
    );
    for (const row of stale) {
      if (config.warmPool.includes(row.model_id)) continue;
      const idledMs = row.last_used_at ? now() - new Date(row.last_used_at).getTime() : null;
      if (await terminateInstance(row.id, "idle")) {
        result.shutdown += 1;
        await recordEvent({ id: row.id, model_id: row.model_id }, "instance_idle_shutdown", { idledMs, windowMinutes: config.idleShutdownMinutes });
      }
    }
  } catch (error) {
    warn("vast_instance_idle_sweep_failed", { error: error instanceof Error ? error.name : "unknown" });
  }

  // Machines whose container exited on its own (host crash, OOM) are retired so a
  // fresh one can be rented on the next request.
  try {
    const active = await query<{ id: string; provider_instance_id: string | null }>(
      `SELECT id, provider_instance_id FROM inference_instances WHERE state IN ('ready','idle','warming') AND provider_instance_id IS NOT NULL LIMIT 10`
    );
    for (const row of active) {
      let remote: VastInstance | null = null;
      try {
        remote = await getInstance(Number(row.provider_instance_id));
      } catch {
        continue; // Marketplace unreachable: leave every instance as it is.
      }
      const dead = remote === null || remote.actualStatus === "exited" || remote.intendedStatus === "stopped";
      if (!dead) continue;
      if (await terminateInstance(row.id, "crashed")) {
        result.crashed += 1;
        await recordEvent({ id: row.id, model_id: null }, "instance_crashed", { providerInstanceId: row.provider_instance_id });
      }
    }
  } catch (error) {
    warn("vast_instance_health_sweep_failed", { error: error instanceof Error ? error.name : "unknown" });
  }

  result.retried = await retryTerminations();

  if (result.shutdown || result.crashed || result.retried) {
    log("vast_instance_sweep", result);
  }
  return result;
}

/**
 * Rents machines for the configured warm pool. Called by the scheduled worker
 * only: nothing on a request path rents warm-pool capacity.
 */
export async function warmPool(config: VastLifecycleConfig = vastLifecycleConfig()): Promise<{ warmed: string[]; skipped: string[] }> {
  const warmed: string[] = [];
  const skipped: string[] = [];
  if (!config.enabled) return { warmed, skipped };

  for (const modelId of config.warmPool) {
    const active = await loadActive(modelId);
    if (active) {
      skipped.push(modelId);
      continue;
    }
    try {
      const route = await ensureInstance(modelId);
      if (route) warmed.push(modelId);
      else skipped.push(modelId);
    } catch (error) {
      warn("vast_warm_pool_failed", {
        modelId,
        reason: error instanceof InstanceUnavailableError ? error.reason : "unknown",
      });
      skipped.push(modelId);
    }
  }
  return { warmed, skipped };
}

/** Marks an instance as used, so its idle clock restarts. */
export async function touchInstance(instanceId: string): Promise<void> {
  await query(`UPDATE inference_instances SET last_used_at=now(), updated_at=now() WHERE id=$1 AND state IN ('ready','idle')`, [instanceId]).catch(() => undefined);
}

/**
 * Every managed model, for the Overview and admin surfaces. Non-secret: no
 * service key, no provider payload, no credentials.
 */
export async function listManagedInstances(): Promise<Array<{
  modelId: string;
  state: InstanceState;
  ready: boolean;
  coldStartMs: number | null;
  idleMinutes: number | null;
  lastUsedAt: string | null;
  warmPool: boolean;
}>> {
  const config = vastLifecycleConfig();
  try {
    const rows = await query<{ model_id: string; state: InstanceState; cold_start_ms: number | null; last_used_at: Date | null }>(
      `SELECT model_id, state, cold_start_ms, last_used_at FROM inference_instances WHERE state IN ('provisioning','warming','ready','idle') ORDER BY model_id ASC`
    );
    return rows.map((row) => ({
      modelId: row.model_id,
      state: row.state,
      ready: row.state === "ready" || row.state === "idle",
      coldStartMs: row.cold_start_ms,
      idleMinutes: row.last_used_at ? Math.max(0, Math.round((now() - new Date(row.last_used_at).getTime()) / 60_000)) : null,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      warmPool: config.warmPool.includes(row.model_id),
    }));
  } catch {
    return [];
  }
}

/**
 * Recent lifecycle metrics, for the admin health screen: instance starts, warm /
 * cold latency, and health transitions.
 */
export async function listInstanceEvents(limit = 20): Promise<Array<{ event: string; modelId: string | null; detail: Record<string, unknown>; createdAt: string }>> {
  try {
    const rows = await query<{ event: string; model_id: string | null; detail: Record<string, unknown>; created_at: string }>(
      `SELECT event, model_id, COALESCE(detail,'{}'::jsonb) AS detail, created_at::text AS created_at
         FROM provider_instance_events ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(50, limit))]
    );
    return rows.map((row) => ({ event: row.event, modelId: row.model_id, detail: row.detail ?? {}, createdAt: row.created_at }));
  } catch {
    return [];
  }
}

/** Operator view of the lifecycle policy. No credentials. */
export function describeVastLifecycle(config: VastLifecycleConfig = vastLifecycleConfig()) {
  return {
    enabled: config.enabled,
    warmPool: config.warmPool,
    maxInstances: config.maxInstances,
    idleShutdownMinutes: config.idleShutdownMinutes,
    coldStartBudgetMs: config.coldStartBudgetMs,
    maxHourlyUsd: config.maxHourlyUsd,
    gpuName: config.gpuName,
    minGpuRamGb: config.minGpuRamGb,
    image: config.image,
    maxModelLen: config.maxModelLen,
    healthIntervalSeconds: config.healthIntervalSeconds,
  };
}

import { query } from "./db";

// Health of the lifecycle-managed vast.ai fleet.
//
// A managed deployment has no single static endpoint: each curated model may be
// served by its own rented machine. Provider health therefore aggregates the
// instances that are currently usable, probing each one's OpenAI-compatible
// /models route in parallel with a short timeout.
//
// Deliberately read-only and cheap: it never rents, never warms, and never blocks
// a request path on a slow GPU. It only answers "is anything warm and answering?".
// No credential or upstream body is returned or logged.

/** Normalized status vocabulary, shared with InferenceHealth. */
export type InstanceHealthStatus = "operational" | "degraded" | "unavailable";

export type InstanceFleetHealth = {
  status: InstanceHealthStatus;
  /** Lowest observed probe latency, when any endpoint answered. */
  latencyMs: number | null;
  /** Provider model identifiers the answering instances actually serve. */
  modelIds: string[];
  /** Instances currently in a usable state. */
  warm: number;
  /** Instances still provisioning/warming. */
  pending: number;
  /** Instances the probe could not reach. */
  unreachable: number;
};

const PROBE_TIMEOUT_MS = 4_000;
const MAX_PROBES = 6;

type WarmRow = { model_id: string; base_url: string; service_api_key: string | null };

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Probes one instance's /models route. Returns null when it does not answer. */
async function probe(row: WarmRow): Promise<{ modelIds: string[]; latencyMs: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${row.base_url}/models`, {
      method: "GET",
      headers: { Accept: "application/json", ...(row.service_api_key ? { Authorization: `Bearer ${row.service_api_key}` } : {}) },
      cache: "no-store",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = objectValue(await response.json().catch(() => ({})));
    const data = Array.isArray(body.data) ? body.data : [];
    const modelIds = data
      .map((entry) => objectValue(entry).id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .slice(0, 50);
    // An answer without a catalogue still proves the endpoint is serving.
    return { modelIds: modelIds.length > 0 ? modelIds : [row.model_id], latencyMs };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Aggregates the health of every usable managed instance.
 *
 *   operational — at least one warm endpoint answered;
 *   degraded    — usable instances exist but none answered, or machines are still
 *                 warming;
 *   unavailable — nothing is warm and nothing is starting.
 *
 * A deployment with no warm machine is NOT reported as unavailable here: the
 * caller (VastAIProvider.health) knows whether a cold machine can still be rented,
 * which is a deployment-configuration question rather than a fleet question.
 */
export async function instanceFleetHealth(): Promise<InstanceFleetHealth> {
  let rows: WarmRow[] = [];
  let pending = 0;
  try {
    rows = await query<WarmRow>(`SELECT model_id, base_url, service_api_key FROM inference_instances WHERE state IN ('ready','idle') AND base_url IS NOT NULL LIMIT $1`, [MAX_PROBES]);
    const counted = await query<{ count: string }>(`SELECT count(*)::text count FROM inference_instances WHERE state IN ('provisioning','warming')`);
    pending = Number(counted[0]?.count ?? 0);
  } catch {
    // A missing table (before the migration applied) is not an outage: report the
    // fleet as empty so the caller can fall back to the static endpoint.
    return { status: "unavailable", latencyMs: null, modelIds: [], warm: 0, pending: 0, unreachable: 0 };
  }

  if (rows.length === 0) {
    return { status: pending > 0 ? "degraded" : "unavailable", latencyMs: null, modelIds: [], warm: 0, pending, unreachable: 0 };
  }

  const probes = await Promise.all(rows.map(probe));
  const answered = probes.filter((result): result is { modelIds: string[]; latencyMs: number } => result !== null);
  const modelIds = Array.from(new Set(answered.flatMap((result) => result.modelIds))).slice(0, 100);
  const latencyMs = answered.length > 0 ? Math.min(...answered.map((result) => result.latencyMs)) : null;

  if (answered.length > 0) {
    return { status: "operational", latencyMs, modelIds, warm: rows.length, pending, unreachable: rows.length - answered.length };
  }
  return { status: "degraded", latencyMs: null, modelIds: [], warm: rows.length, pending, unreachable: rows.length };
}

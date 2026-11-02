import {
  INFERENCE_PROVIDER_ALIASES,
  INFERENCE_PROVIDER_VALUES,
  inferenceProviderConfig,
  type InferenceProviderId,
  type InferenceProviderSelection,
} from "./config";
import { query } from "./db";

// Runtime provider selection (PRD: configurable without code changes).
//
// Two layers, in precedence order:
//   1. the admin control plane's persisted override (inference_provider_settings,
//      one row), written through app/api/admin/providers with an audit record;
//   2. the deployment environment (INFERENCE_PROVIDER / INFERENCE_FALLBACK_ENABLED /
//      INFERENCE_FALLBACK_PROVIDER).
//
// Failover is opt-in and separately switchable from the provider choice: a row can
// name a fallback provider while `fallback_enabled` is false, which means "configured,
// currently disabled" — the primary alone serves and its errors surface verbatim.
// That is the documented default: the product never silently switches providers.
//
// The override is cached for a few seconds per process so a request path never
// pays a database round trip to learn which provider is active. That TTL is what
// makes a control-plane change apply "on the next request without a restart"
// while staying within one cheap read per window. A request that has already
// resolved a provider keeps using it to completion, so in-flight streams finish
// on the provider that started them.

export const PROVIDER_OVERRIDE_TTL_MS = 5_000;

/** Canonical provider ids accepted by the control plane. */
export const PROVIDER_IDS: readonly InferenceProviderId[] = ["openrouter", "vast"];

/** Human-readable labels, shared by the API and the admin screen. */
export const PROVIDER_LABELS: Record<InferenceProviderId, string> = {
  openrouter: "OpenRouter",
  vast: "vast.ai",
};

/** One persisted override row. */
export type ProviderSettingsRow = {
  provider: string;
  fallback_provider: string | null;
  fallback_enabled: boolean;
  model_map: Record<string, unknown>;
  source: string;
  updated_at: string;
  updated_by_privy_user_id: string | null;
};

let cached: { selection: InferenceProviderSelection; expiresAt: number } | null = null;
let loading: Promise<void> | null = null;

/** Canonicalizes any accepted spelling of a provider name, or null. */
export function normalizeProviderId(value: unknown): InferenceProviderId | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? INFERENCE_PROVIDER_ALIASES[normalized] ?? null : null;
}

/**
 * The selection the request path should use right now.
 *
 * Synchronous by design: the inference routes resolve a provider while building a
 * response, and must never fail because the settings read is slow. Falls back to
 * the environment selection until the first refresh populated the cache.
 */
export function activeProviderSelection(): InferenceProviderSelection {
  if (cached && cached.expiresAt > Date.now()) return cached.selection;
  return inferenceProviderConfig();
}

/**
 * Folds a persisted override onto the environment selection.
 *
 * `fallbackEnabled` is the persisted switch; `fallback` (the provider actually used
 * for failover) is only set when that switch is on. The candidate stays visible so a
 * disabled-but-configured fallback is inspectable rather than invisible.
 */
function withOverride(env: InferenceProviderSelection, row: ProviderSettingsRow | null): InferenceProviderSelection {
  if (!row) return env;
  const provider = normalizeProviderId(row.provider) ?? env.provider;
  const rawCandidate = row.fallback_provider ? normalizeProviderId(row.fallback_provider) : env.fallbackCandidate;
  const fallbackCandidate = rawCandidate && rawCandidate !== provider ? rawCandidate : null;
  const fallbackEnabled = row.fallback_enabled === true;
  const fallback = fallbackEnabled ? fallbackCandidate : null;
  return { ...env, provider, fallback, fallbackEnabled, fallbackCandidate };
}

async function readOverride(): Promise<ProviderSettingsRow | null> {
  try {
    const rows = await query<ProviderSettingsRow>(
      `SELECT provider, fallback_provider, COALESCE(fallback_enabled,false) AS fallback_enabled,
              COALESCE(model_map,'{}'::jsonb) AS model_map, source, updated_at::text AS updated_at, updated_by_privy_user_id
         FROM inference_provider_settings WHERE id='active' LIMIT 1`
    );
    return rows[0] ?? null;
  } catch {
    // A missing table (before the migration ran) or an unreachable database must
    // not take inference down: the environment selection stays in force.
    return null;
  }
}

/**
 * Refreshes the cached selection from the database (at most once per TTL, unless
 * `force`). Resolves to the selection in force after the refresh.
 */
export async function refreshProviderSettings(force = false): Promise<InferenceProviderSelection> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.selection;
  if (!loading) {
    loading = (async () => {
      const row = await readOverride();
      cached = { selection: withOverride(inferenceProviderConfig(), row), expiresAt: Date.now() + PROVIDER_OVERRIDE_TTL_MS };
    })().finally(() => { loading = null; });
  }
  await loading.catch(() => undefined);
  return activeProviderSelection();
}

/** Test/ops helper: drops the cached selection so the next read re-queries. */
export function invalidateProviderSettings(): void {
  cached = null;
}

/** The persisted override, for the control plane's display. */
export async function readProviderOverride(): Promise<ProviderSettingsRow | null> {
  return readOverride();
}

export class ProviderSettingsError extends Error {
  readonly code: "INVALID_PROVIDER" | "PERSISTENCE_FAILED";
  constructor(message: string, code: "INVALID_PROVIDER" | "PERSISTENCE_FAILED") {
    super(message);
    this.name = "ProviderSettingsError";
    this.code = code;
  }
}

export type ProviderSwitch = {
  provider: InferenceProviderId;
  /**
   * The provider failover may retry on. null/undefined keeps the currently
   * configured candidate, so switching the primary never silently drops it.
   */
  fallbackProvider?: InferenceProviderId | null;
  /**
   * Whether failover is enabled. Omitted keeps the current value; this is the
   * documented "off by default" switch. Enabling it without any candidate provider
   * is rejected, because there would be nothing to fail over to.
   */
  fallbackEnabled?: boolean;
  /** Audit identity: the verified account that made the change. */
  accountId: string;
  privyUserId: string;
  requestId?: string;
};

/**
 * Persists a provider switch and writes the audit record in the same transaction
 * shape (two statements, ordered so the audit exists even if the upsert is
 * replayed). Returns the previous and new state for the API response.
 */
export async function setActiveProvider(change: ProviderSwitch): Promise<{
  previous: { provider: string; fallback: string | null; fallbackEnabled: boolean } | null;
  current: { provider: InferenceProviderId; fallback: InferenceProviderId | null; fallbackEnabled: boolean; fallbackCandidate: InferenceProviderId | null };
}> {
  const existing = await readOverride();
  // An explicit null clears the candidate; omitting the field keeps the current one.
  const rawCandidate = change.fallbackProvider === undefined
    ? (existing?.fallback_provider ? normalizeProviderId(existing.fallback_provider) : activeProviderSelection().fallbackCandidate)
    : change.fallbackProvider;
  const fallbackCandidate = rawCandidate && rawCandidate !== change.provider ? rawCandidate : null;
  const fallbackEnabled = change.fallbackEnabled === undefined
    ? Boolean(existing?.fallback_enabled)
    : change.fallbackEnabled === true;

  if (fallbackEnabled && !fallbackCandidate) {
    throw new ProviderSettingsError(
      "Failover cannot be enabled without a fallback provider. Choose a different provider to fall back to, or leave failover off.",
      "INVALID_PROVIDER"
    );
  }

  try {
    await query(
      `INSERT INTO inference_provider_settings (id, provider, fallback_provider, fallback_enabled, source, updated_by_privy_user_id, updated_at)
       VALUES ('active', $1, $2, $3, 'admin', $4, now())
       ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, fallback_provider=EXCLUDED.fallback_provider, fallback_enabled=EXCLUDED.fallback_enabled, source='admin', updated_by_privy_user_id=EXCLUDED.updated_by_privy_user_id, updated_at=now()`,
      [change.provider, fallbackCandidate, fallbackEnabled, change.privyUserId]
    );
  } catch {
    throw new ProviderSettingsError("The provider selection could not be persisted.", "PERSISTENCE_FAILED");
  }
  try {
    await query(
      `INSERT INTO admin_audit_log (admin_account_id, action, target_type, target_id, previous_state, new_state, request_id)
       VALUES ($1, 'inference_provider.switched', 'inference_provider', 'active', $2::jsonb, $3::jsonb, $4)`,
      [
        change.accountId,
        JSON.stringify({ provider: existing?.provider ?? null, fallback: existing?.fallback_provider ?? null, fallbackEnabled: Boolean(existing?.fallback_enabled) }),
        JSON.stringify({ provider: change.provider, fallback: fallbackCandidate, fallbackEnabled }),
        change.requestId ?? null,
      ]
    );
  } catch {
    // The switch is already persisted; an unwritable audit trail is reported so
    // operators can see the gap rather than believing the change is audited.
    console.error(JSON.stringify({ event: "admin_provider_audit_failed", provider: change.provider }));
  }
  invalidateProviderSettings();
  await refreshProviderSettings(true);
  return {
    previous: existing
      ? { provider: existing.provider, fallback: existing.fallback_provider, fallbackEnabled: Boolean(existing.fallback_enabled) }
      : null,
    current: { provider: change.provider, fallback: fallbackEnabled ? fallbackCandidate : null, fallbackEnabled, fallbackCandidate },
  };
}

/** Recent provider switches, newest first, for the control-plane screen. */
export async function listProviderAudit(limit = 10): Promise<Array<{ action: string; previous: unknown; next: unknown; createdAt: string }>> {
  try {
    const rows = await query<{ action: string; previous_state: unknown; new_state: unknown; created_at: string }>(
      `SELECT action, previous_state, new_state, created_at::text AS created_at
         FROM admin_audit_log
        WHERE target_type = 'inference_provider' OR action LIKE 'inference_provider.%'
        ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(50, limit))]
    );
    return rows.map((row) => ({ action: row.action, previous: row.previous_state, next: row.new_state, createdAt: row.created_at }));
  } catch {
    return [];
  }
}

/** Valid provider values, for error messages that must list what is accepted. */
export function acceptedProviderValues(): string[] {
  return [...INFERENCE_PROVIDER_VALUES];
}

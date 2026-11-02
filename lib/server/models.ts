import { modelHealthConfig, type InferenceProviderId } from "./config";
import { query, transaction } from "./db";
import type { InferenceStatus, ModelCostSpec } from "./inference";
import { modelHealthStatuses, probeOpenRouterModels, probeVastModels, recordModelProbes, type ModelHealthRow } from "./model-health";
import { OpenRouterProvider } from "./openrouter";
import { refreshProviderSettings } from "./provider-settings";
import { vastModelTargets, type VastModelMapLike } from "./vast-inference";

// The curated model registry (PRD §12: Openweight curates its own catalogue and
// never renders the raw provider list).
//
// What lives here, and why:
//
//   1. IDENTITY + ROUTING. Each curated row carries the identifier the serving
//      provider expects: `provider_model_slug` (OpenRouter) and `vast_model_id` /
//      `vast_base_url` (a rented vast.ai GPU running vLLM or any other
//      OpenAI-compatible server). Routing is a registry fact, not a provider fact.
//   2. METADATA + PRICING. Context length and per-token USD pricing are stored on
//      the row (`context_length`, `prompt_usd_per_token`,
//      `completion_usd_per_token`) and are NEVER overwritten from a provider
//      response. Provider metadata contributes capabilities (modalities,
//      supported parameters) only, so pricing stays under Openweight control and a
//      card can never advertise a price the ledger does not charge.
//   3. AVAILABILITY. Computed by probing the ACTIVE provider through the same
//      normalized health contract requests use (see model-health.ts), debounced so
//      a flapping GPU endpoint cannot thrash the Overview cards or the Playground
//      selector, then projected onto `provider_metadata.availability` +
//      `provider_sync_status` so every existing reader keeps one vocabulary:
//         operational  -> availability "available",  sync "current"
//         degraded     -> availability "degraded",   sync "current"   (servable,
//                         e.g. a warm-on-demand vast.ai machine that must cold start)
//         unavailable  -> availability "unavailable", sync "unavailable"
//   4. ADMIN CONTROL. `setModelStatus()` activates or pauses a curated model. A
//      paused model stops being selectable immediately (the request path re-reads
//      the row), while a request already streaming keeps the model it started on.

/** How a curated model's provider metadata is stored. Provider-owned capabilities,
 *  registry-owned availability. `pricing` mirrors the registry columns so older
 *  readers keep working; the API always reports the columns. */
export type ProviderMetadata = {
  contextLength: number | null;
  pricing: Record<string, string>;
  architecture: { inputModalities: string[]; outputModalities: string[] };
  supportedParameters: string[];
  availability: "available" | "degraded" | "unavailable" | "stale";
  syncedAt: string | null;
};

export type ModelRow = {
  slug: string;
  display_name: string;
  family: string | null;
  provider: string;
  provider_model_slug: string;
  /** vast.ai / vLLM identifier. NULL means unmapped for the vast.ai provider. */
  vast_model_id: string | null;
  /** Optional per-model vast.ai endpoint (a second rented machine). */
  vast_base_url: string | null;
  source_url: string | null;
  status: string;
  visibility: string;
  featured: boolean;
  sort_order: number;
  context_length: number | null;
  /** Registry-owned input price, USD per token (exact decimal string). */
  prompt_usd_per_token: string | null;
  /** Registry-owned output price, USD per token (exact decimal string). */
  completion_usd_per_token: string | null;
  /** Provider the current availability value was computed against. */
  availability_provider: string | null;
  markup_micro: string;
  min_charge_micro_usd: string;
  license_status: string;
  provider_terms_status: string;
  provider_metadata: ProviderMetadata | null;
  provider_sync_status: "never" | "current" | "stale" | "unavailable";
  provider_synced_at: string | null;
  provider_sync_error: string | null;
};

/** The statuses an administrator may set. */
export type ModelActivation = "active" | "paused";

const DEFAULT_AVAILABILITY_ARCHITECTURE = { inputModalities: ["text"], outputModalities: ["text"] };
const DEFAULT_AVAILABILITY_PARAMETERS = ["temperature", "top_p", "max_tokens", "stop", "seed"];

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseMetadata(value: unknown): ProviderMetadata | null {
  const raw = objectValue(value);
  if (!raw || typeof raw.contextLength !== "number" && raw.contextLength !== null) return null;
  const architecture = objectValue(raw.architecture);
  const strings = (candidate: unknown) => Array.isArray(candidate) ? candidate.filter((item): item is string => typeof item === "string") : [];
  return {
    contextLength: raw.contextLength as number | null,
    pricing: objectValue(raw.pricing) as Record<string, string> ?? {},
    architecture: { inputModalities: strings(architecture?.inputModalities), outputModalities: strings(architecture?.outputModalities) },
    supportedParameters: strings(raw.supportedParameters),
    availability: raw.availability === "available" || raw.availability === "stale" || raw.availability === "degraded" ? raw.availability : "unavailable",
    syncedAt: typeof raw.syncedAt === "string" ? raw.syncedAt : null,
  };
}

function modelSelect(): string {
  return `SELECT slug, display_name, family, provider, provider_model_slug, vast_model_id, vast_base_url, source_url,
    status, visibility, featured, sort_order, context_length,
    prompt_usd_per_token::text AS prompt_usd_per_token, completion_usd_per_token::text AS completion_usd_per_token,
    availability_provider,
    markup_micro::text AS markup_micro, min_charge_micro_usd::text AS min_charge_micro_usd,
    license_status, provider_terms_status, provider_metadata, provider_sync_status, provider_synced_at, provider_sync_error
    FROM models`;
}

async function selectModels(where: string, values: unknown[] = [], order = "sort_order ASC, display_name ASC", limit?: number): Promise<ModelRow[]> {
  const suffix = limit == null ? "" : ` LIMIT ${limit}`;
  const rows = await query<ModelRow>(`${modelSelect()} WHERE ${where} ORDER BY ${order}${suffix}`, values);
  return rows.map((row) => ({ ...row, provider_metadata: parseMetadata(row.provider_metadata) }));
}

// ---------------------------------------------------------------------------
// Pricing — registry-owned, shared by cost() and the model cards.
// ---------------------------------------------------------------------------

/**
 * The registry's per-token pricing, in the USD-per-token string form cost() reads.
 *
 * One source for three consumers: the Overview card, the model-details panel, and
 * the provider's cost() call. A card therefore cannot advertise a price different
 * from the one the ledger charges on the same model.
 */
export function registryPricing(model: ModelRow): { prompt: string; completion: string } | null {
  const prompt = model.prompt_usd_per_token;
  const completion = model.completion_usd_per_token;
  if (prompt == null && completion == null) return null;
  return { prompt: prompt ?? "0", completion: completion ?? "0" };
}

/**
 * The cost specification handed to the provider for one request, so a provider that
 * derives cost itself (a rented GPU, priced from GPU time) charges exactly the
 * registry rate instead of its deployment-wide default.
 */
export function registryCostSpec(model: ModelRow | null | undefined): ModelCostSpec | null {
  if (!model) return null;
  const pricing = registryPricing(model);
  return pricing ? { pricing } : null;
}

// ---------------------------------------------------------------------------
// vast.ai mapping.
// ---------------------------------------------------------------------------

/**
 * The vast.ai identifier for a curated row.
 *
 * Precedence: the registry column (the durable, admin-editable source of truth),
 * then the deployment's VASTAI_MODEL_MAP (still supported so an existing
 * environment keeps working unchanged). NULL means genuinely unmapped, which the
 * availability probe reports as unavailable-for-vast.ai and logs as a
 * configuration error — never a silent fallback to some other identifier.
 */
function vastMappingFor(model: { slug: string; provider_model_slug: string; vast_model_id: string | null }, env: VastModelMapLike): string | null {
  if (model.vast_model_id && model.vast_model_id.trim()) return model.vast_model_id.trim();
  const slug = model.slug.toLowerCase();
  const providerSlug = (model.provider_model_slug ?? "").toLowerCase();
  return env[slug]?.modelId ?? (providerSlug ? env[providerSlug]?.modelId : undefined) ?? null;
}

/** Every curated row, including paused ones (so the registry can show their state). */
async function loadCuratedRows(): Promise<ModelRow[]> {
  return selectModels("visibility = 'public' AND status IN ('active','paused','review')");
}

// ---------------------------------------------------------------------------
// Availability.
// ---------------------------------------------------------------------------

function availabilityValue(status: InferenceStatus): ProviderMetadata["availability"] {
  return status === "operational" ? "available" : status === "degraded" ? "degraded" : "unavailable";
}

/** The normalized three-state status a curated row currently reports. */
export function modelAvailabilityStatus(model: ModelRow | null | undefined): InferenceStatus {
  const availability = model?.provider_metadata?.availability;
  if (availability === "available") return "operational";
  if (availability === "degraded") return "degraded";
  return "unavailable";
}

/**
 * Probes one provider for every curated row and persists the debounced result.
 *
 * Failures are contained: a provider probe that throws degrades only that
 * provider's models (they keep their last stored value), so the registry never
 * disappears because an upstream endpoint is unreachable.
 */
async function probeProvider(provider: InferenceProviderId, rows: ModelRow[]): Promise<Map<string, InferenceStatus>> {
  const statuses = new Map<string, InferenceStatus>();
  try {
    if (provider === "vast") {
      const env = vastModelTargets();
      const targets = rows.map((row) => ({ slug: row.slug, vastModelId: vastMappingFor(row, env) }));
      const report = await probeVastModels(targets);
      return await recordModelProbes("vast", report);
    }
    const targets = rows.map((row) => ({ slug: row.slug, providerModelSlug: row.provider_model_slug }));
    const report = await probeOpenRouterModels(targets);
    return await recordModelProbes("openrouter", report);
  } catch (error) {
    console.error(JSON.stringify({ event: "model_availability_probe_failed", provider, error: error instanceof Error ? error.name : "unknown" }));
    return statuses;
  }
}

/**
 * The statuses to project onto the registry.
 *
 * Probing is skipped when the stored snapshot is younger than
 * MODEL_HEALTH_REFRESH_INTERVAL_SECONDS, so a page render costs one query in
 * steady state and a live GPU probe only once per refresh interval. `force`
 * bypasses the throttle (the health cron and the admin control plane use it).
 */
async function availabilityFor(rows: ModelRow[], options: { force?: boolean } = {}): Promise<{ provider: InferenceProviderId; statuses: Map<string, ModelHealthRow>; probed: boolean; error?: string }> {
  let provider: InferenceProviderId = "openrouter";
  let fallback: InferenceProviderId | null = null;
  try {
    const selection = await refreshProviderSettings();
    provider = selection.provider;
    fallback = selection.fallback;
  } catch {
    provider = "openrouter";
    fallback = null;
  }

  const interval = modelHealthConfig().refreshIntervalSeconds * 1000;
  const stored = await modelHealthStatuses(provider);
  const newest = [...stored.values()].reduce((max, row) => Math.max(max, new Date(row.checked_at).getTime()), 0);
  if (!options.force && stored.size > 0 && Date.now() - newest < interval) {
    return { provider, statuses: stored, probed: false };
  }

  const probed = rows.length > 0 ? await probeProvider(provider, rows) : new Map<string, InferenceStatus>();
  const statuses = await modelHealthStatuses(provider);

  // Fallback pass: a model the active provider cannot serve may still be servable
  // through an explicitly configured fallback. Only the models that came back
  // unavailable are re-probed, so the extra catalogue request is the exception
  // rather than the norm.
  if (fallback && fallback !== provider) {
    const missing = rows.filter((row) => (probed.get(row.slug) ?? stored.get(row.slug)?.status ?? "unavailable") === "unavailable");
    if (missing.length > 0) {
      const fallbackStatuses = await probeProvider(fallback, missing);
      const now = new Date().toISOString();
      for (const row of missing) {
        const status = fallbackStatuses.get(row.slug);
        if (!status || status === "unavailable") continue;
        statuses.set(row.slug, {
          model_slug: row.slug,
          provider: fallback,
          status,
          candidate_status: null,
          candidate_count: 0,
          latency_ms: null,
          detail: { viaFallback: fallback },
          checked_at: now,
          changed_at: now,
        });
        probed.set(row.slug, status);
      }
    }
  }

  const error = probed.size === 0 && rows.length > 0 ? "availability_unavailable" : undefined;
  return { provider, statuses, probed: true, ...(error ? { error } : {}) };
}

/**
 * Refreshes every curated row's availability in one transaction.
 *
 * The write is deliberately narrow: availability, the sync status derived from it,
 * which provider produced it, and the registry's own pricing mirrored into
 * `provider_metadata` for older readers. Capability metadata already on the row is
 * preserved.
 */
async function projectAvailability(rows: ModelRow[], provider: InferenceProviderId, statuses: Map<string, ModelHealthRow>): Promise<{ synced: number; unavailable: number }> {
  const syncedAt = new Date().toISOString();
  let synced = 0;
  let unavailable = 0;

  await transaction(async (client) => {
    for (const row of rows) {
      const health = statuses.get(row.slug);
      // A row with no probe result is NOT silently declared available: its last
      // stored value stands, which is what the debounce is for.
      if (!health) continue;
      const availability = availabilityValue(health.status);
      const syncStatus = health.status === "unavailable" ? "unavailable" : "current";
      const pricing = registryPricing(row) ?? {};
      const metadata: ProviderMetadata = {
        contextLength: row.context_length,
        pricing,
        architecture: row.provider_metadata?.architecture?.inputModalities?.length ? row.provider_metadata.architecture : DEFAULT_AVAILABILITY_ARCHITECTURE,
        supportedParameters: row.provider_metadata?.supportedParameters?.length ? row.provider_metadata.supportedParameters : DEFAULT_AVAILABILITY_PARAMETERS,
        availability,
        syncedAt,
      };
      const error = health.status === "unavailable"
        ? (typeof health.detail.reason === "string" ? health.detail.reason : "Provider route unavailable")
        : null;
      await client.query(
        `UPDATE models SET provider_metadata=$2::jsonb, provider_sync_status=$3, provider_synced_at=$4,
           provider_sync_error=$5, availability_provider=$6, updated_at=now() WHERE slug=$1`,
        [row.slug, JSON.stringify(metadata), syncStatus, syncedAt, error, health.provider ?? provider]
      );
      if (health.status === "unavailable") unavailable += 1;
      else synced += 1;
    }
  });

  return { synced, unavailable };
}

/**
 * Backfills provider-owned CAPABILITIES (modalities, supported parameters) for rows
 * that have none yet. Never touches pricing or context length: those are registry
 * facts. Runs only when a row is actually missing capability metadata, so the steady
 * state costs no upstream request.
 */
async function backfillCapabilities(rows: ModelRow[]): Promise<void> {
  const needing = rows.filter((row) => row.provider === "openrouter" && (!row.provider_metadata || !row.provider_metadata.architecture.inputModalities.length));
  if (needing.length === 0) return;
  let catalog: Awaited<ReturnType<OpenRouterProvider["catalog"]>>;
  try {
    catalog = await new OpenRouterProvider().catalog();
  } catch {
    return;
  }
  const byId = new Map(catalog.map((model) => [model.providerModelId, model]));
  try {
    await transaction(async (client) => {
      for (const row of needing) {
        const providerModel = byId.get(row.provider_model_slug);
        if (!providerModel) continue;
        const metadata: ProviderMetadata = {
          contextLength: row.context_length ?? providerModel.contextLength,
          pricing: registryPricing(row) ?? {},
          architecture: providerModel.architecture,
          supportedParameters: providerModel.supportedParameters,
          availability: row.provider_metadata?.availability ?? "unavailable",
          syncedAt: new Date().toISOString(),
        };
        await client.query(
          `UPDATE models SET provider_metadata=$2::jsonb, context_length=COALESCE(context_length,$3), updated_at=now() WHERE slug=$1`,
          [row.slug, JSON.stringify(metadata), providerModel.contextLength]
        );
      }
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "model_capability_backfill_failed", error: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Refreshes the curated registry's capability metadata and live availability.
 *
 * Called by the models API and the health cron. Throttled to
 * MODEL_HEALTH_REFRESH_INTERVAL_SECONDS, so an admin's activate/pause change and a
 * provider transition both reach the Overview cards and the Playground selector
 * within one refresh interval without a probe on every render.
 */
export async function syncCuratedModels(options: { force?: boolean } = {}): Promise<{ synced: number; unavailable: number; error?: string; provider: InferenceProviderId }> {
  let rows: ModelRow[];
  try {
    rows = await loadCuratedRows();
  } catch {
    return { synced: 0, unavailable: 0, error: "registry_unavailable", provider: "openrouter" };
  }
  if (rows.length === 0) return { synced: 0, unavailable: 0, provider: "openrouter" };

  // Capabilities first: availability is projected onto rows that may need their
  // architecture preserved.
  await backfillCapabilities(rows);

  let availability: Awaited<ReturnType<typeof availabilityFor>>;
  try {
    availability = await availabilityFor(rows, options);
  } catch {
    return { synced: 0, unavailable: 0, error: "availability_unavailable", provider: "openrouter" };
  }
  if (availability.probed) {
    try {
      const projected = await projectAvailability(rows, availability.provider, availability.statuses);
      return { ...projected, provider: availability.provider, ...(availability.error ? { error: availability.error } : {}) };
    } catch (error) {
      console.error(JSON.stringify({ event: "model_availability_project_failed", error: error instanceof Error ? error.name : "unknown" }));
      return { synced: 0, unavailable: 0, error: "availability_unavailable", provider: availability.provider };
    }
  }

  // Throttled path: the stored values are already projected onto the rows by the
  // previous refresh, so only the counts are recomputed.
  const unavailable = rows.filter((row) => modelAvailabilityStatus(row) === "unavailable").length;
  return { synced: rows.length - unavailable, unavailable, provider: availability.provider };
}

// ---------------------------------------------------------------------------
// Reads used by the Playground selector and the request path.
// ---------------------------------------------------------------------------

export async function listActiveModels(): Promise<ModelRow[]> {
  return selectModels("status = 'active' AND visibility = 'public'");
}

/** Everything the UI may display: activated models plus paused ones (shown gated). */
export async function listDiscoverableModels(): Promise<ModelRow[]> {
  return selectModels("status IN ('active','paused') AND visibility = 'public'");
}

/**
 * Only models an administrator has ACTIVATED and the active provider currently
 * serves. This is the Playground dropdown's source of truth.
 */
export async function listSelectableModels(): Promise<ModelRow[]> {
  return (await listDiscoverableModels()).filter(modelIsOperational);
}

export async function getActiveModel(slug: string): Promise<ModelRow | null> {
  return (await selectModels("slug = $1 AND status = 'active' AND visibility = 'public' AND provider_sync_status = 'current'", [slug], "sort_order ASC, display_name ASC", 1))[0] ?? null;
}

export async function pickAutoModel(): Promise<ModelRow | null> {
  const candidates = await selectModels("status = 'active' AND visibility = 'public' AND provider_sync_status = 'current'", [], "featured DESC, sort_order ASC, display_name ASC");
  // Auto never routes to a model the provider cannot serve. `degraded` is allowed:
  // the request pays the cold-start budget instead of failing outright.
  return candidates.find((model) => modelIsOperational(model)) ?? null;
}

/**
 * Any public curated row for a slug, regardless of its registry/sync state.
 *
 * The request path uses this only after the operational lookup failed, so it can
 * tell "this model exists but an administrator paused it / its provider route is
 * gone" (the normalized, switch-models `model_unavailable`) apart from "this slug
 * is not in the curated registry at all".
 */
export async function getModelBySlug(slug: string): Promise<ModelRow | null> {
  return (await selectModels("slug = $1 AND visibility = 'public'", [slug], "sort_order ASC, display_name ASC", 1))[0] ?? null;
}

/**
 * The single definition of "this curated model can serve a billable request".
 * Shared by the auto-selection filter, the Playground selector and the request-path
 * guard, so the Overview badge, the dropdown and the server can never disagree.
 *
 * `degraded` counts as operational: the provider can still serve (a cold vast.ai
 * machine warms on demand), and the request path is what pays for that. Only
 * `unavailable` — a model whose endpoint is down, whose mapping is missing, or that
 * an administrator paused — is excluded.
 */
export function modelIsOperational(model: ModelRow | null | undefined): boolean {
  if (!model) return false;
  if (model.status !== "active" || model.visibility !== "public") return false;
  if (model.provider_sync_status !== "current") return false;
  const availability = model.provider_metadata?.availability;
  return availability === "available" || availability === "degraded";
}

// ---------------------------------------------------------------------------
// Admin control plane.
// ---------------------------------------------------------------------------

export class ModelStatusError extends Error {
  readonly code: "UNKNOWN_MODEL" | "INVALID_STATUS" | "PERSISTENCE_FAILED";
  constructor(message: string, code: "UNKNOWN_MODEL" | "INVALID_STATUS" | "PERSISTENCE_FAILED") {
    super(message);
    this.name = "ModelStatusError";
    this.code = code;
  }
}

/**
 * Activates or pauses one curated model.
 *
 * A paused row stops being selectable on the next registry read — the Playground
 * dropdown and the Overview card both reflect it within the health-refresh
 * interval, and the request path rejects it immediately. A request already
 * streaming keeps the model it started on and settles normally.
 */
export async function setModelStatus(
  slug: string,
  status: ModelActivation,
  actor: { accountId: string; privyUserId: string; requestId?: string }
): Promise<{ previous: string; current: ModelActivation }> {
  if (status !== "active" && status !== "paused") throw new ModelStatusError(`Unsupported model status "${String(status)}".`, "INVALID_STATUS");
  const existing = await getModelBySlug(slug);
  if (!existing) throw new ModelStatusError(`The curated model "${slug}" was not found.`, "UNKNOWN_MODEL");

  try {
    await query(`UPDATE models SET status=$2, updated_at=now() WHERE slug=$1`, [slug, status]);
  } catch {
    throw new ModelStatusError("The model status could not be persisted.", "PERSISTENCE_FAILED");
  }
  try {
    await query(
      `INSERT INTO admin_audit_log (admin_account_id, action, target_type, target_id, previous_state, new_state, request_id)
       VALUES ($1,'model.status_changed','model',$2,$3::jsonb,$4::jsonb,$5)`,
      [actor.accountId, slug, JSON.stringify({ status: existing.status }), JSON.stringify({ status }), actor.requestId ?? null]
    );
  } catch {
    // The change is already persisted; report the audit gap rather than hiding it.
    console.error(JSON.stringify({ event: "admin_model_audit_failed", model: slug }));
  }
  console.log(JSON.stringify({ event: "model_status_changed", model: slug, from: existing.status, to: status }));
  return { previous: existing.status, current: status };
}

import { query, transaction } from "./db";
import { openRouterConfig } from "./config";

export type ProviderPricing = {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  request?: string;
  image?: string;
  [key: string]: unknown;
};

export type ProviderMetadata = {
  canonicalId: string;
  pricing: ProviderPricing;
  contextLength: number | null;
  architecture: Record<string, unknown> | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  availability: "available" | "unavailable" | "stale";
  syncedAt: string | null;
  providerFields: Record<string, unknown>;
};

export type ModelRow = {
  slug: string;
  display_name: string;
  family: string | null;
  provider: string;
  provider_model_slug: string;
  status: string;
  featured: boolean;
  sort_order: number;
  context_length: number | null;
  markup_micro: string;
  min_charge_micro_usd: string;
  provider_metadata: ProviderMetadata | null;
  provider_sync_status: "never" | "current" | "stale" | "unavailable";
  provider_synced_at: string | null;
  provider_sync_error: string | null;
};

type OpenRouterModel = {
  id: string;
  context_length?: unknown;
  architecture?: unknown;
  pricing?: unknown;
  supported_parameters?: unknown;
  [key: string]: unknown;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validatedPricing(value: unknown): ProviderPricing {
  const raw = objectValue(value);
  if (!raw) return {};
  const pricing: ProviderPricing = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === "string" && /^-?\d+(\.\d+)?$/.test(item)) pricing[key] = item;
  }
  return pricing;
}

function normalizeProviderModel(model: OpenRouterModel, syncedAt: string): ProviderMetadata | null {
  if (typeof model.id !== "string" || !model.id.trim()) return null;
  const architecture = objectValue(model.architecture);
  const contextLength = typeof model.context_length === "number" && Number.isSafeInteger(model.context_length) && model.context_length > 0 ? model.context_length : null;
  return {
    canonicalId: model.id,
    pricing: validatedPricing(model.pricing),
    contextLength,
    architecture,
    inputModalities: stringArray(architecture?.input_modalities),
    outputModalities: stringArray(architecture?.output_modalities),
    supportedParameters: stringArray(model.supported_parameters),
    availability: "available",
    syncedAt,
    providerFields: Object.fromEntries(Object.entries(model).filter(([key]) => !["id", "pricing", "context_length", "architecture", "supported_parameters"].includes(key))),
  };
}

// Read-only server-side integration point. It returns validated provider data
// but never writes to the registry or exposes the OpenRouter credential.
export async function fetchOpenRouterCatalog(): Promise<OpenRouterModel[]> {
  const config = openRouterConfig();
  if (!config.enabled) throw new Error("OpenRouter synchronization is not enabled");
  const response = await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`OpenRouter models request failed (${response.status})`);
  const payload: unknown = await response.json();
  const root = objectValue(payload);
  if (!root || !Array.isArray(root.data)) throw new Error("OpenRouter models response was malformed");
  return root.data.filter((item): item is OpenRouterModel => objectValue(item) !== null && typeof (item as Record<string, unknown>).id === "string");
}

function modelSelect(): string {
  return `SELECT slug, display_name, family, provider, provider_model_slug, status, featured, sort_order, context_length,
    markup_micro::text AS markup_micro, min_charge_micro_usd::text AS min_charge_micro_usd,
    provider_metadata, provider_sync_status, provider_synced_at, provider_sync_error
    FROM models`;
}

function parseMetadata(value: unknown): ProviderMetadata | null {
  const raw = objectValue(value);
  if (!raw || typeof raw.canonicalId !== "string") return null;
  return raw as unknown as ProviderMetadata;
}

// Synchronizes only already-approved curated rows. The curated registry remains
// the allow-list; provider data cannot create or activate a model.
export async function syncCuratedModels(): Promise<{ synced: number; unavailable: number; error?: string }> {
  const syncedAt = new Date().toISOString();
  try {
    const providerModels = await fetchOpenRouterCatalog();
    const byId = new Map(providerModels.map((model) => [model.id, model]));
    const curated = await query<{ slug: string; provider_model_slug: string }>("SELECT slug, provider_model_slug FROM models WHERE provider = 'openrouter' AND status IN ('active','paused','review')");
    let synced = 0;
    let unavailable = 0;
    await transaction(async (client) => {
      for (const model of curated) {
        const providerModel = byId.get(model.provider_model_slug);
        if (!providerModel) {
          unavailable += 1;
          await client.query(`UPDATE models SET provider_sync_status='unavailable', provider_synced_at=$2, provider_sync_error=$3,
            provider_metadata = CASE WHEN provider_metadata IS NULL THEN NULL ELSE jsonb_set(provider_metadata, '{availability}', '"unavailable"'::jsonb) END,
            updated_at=now() WHERE slug=$1`, [model.slug, syncedAt, "Model was not present in the latest OpenRouter catalog"]);
          continue;
        }
        const metadata = normalizeProviderModel(providerModel, syncedAt);
        if (!metadata) { unavailable += 1; continue; }
        await client.query(`UPDATE models SET provider_model_slug=$2, context_length=$3, provider_metadata=$4::jsonb,
          provider_sync_status='current', provider_synced_at=$5, provider_sync_error=NULL, updated_at=now() WHERE slug=$1`,
          [model.slug, metadata.canonicalId, metadata.contextLength, JSON.stringify(metadata), syncedAt]);
        synced += 1;
      }
    });
    return { synced, unavailable };
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenRouter synchronization failed";
    await query(`UPDATE models SET provider_sync_status = CASE WHEN provider_metadata IS NULL THEN 'unavailable' ELSE 'stale' END,
      provider_sync_error=$1, provider_metadata = CASE WHEN provider_metadata IS NULL THEN NULL ELSE jsonb_set(provider_metadata, '{availability}', '"stale"'::jsonb) END,
      updated_at=now() WHERE provider='openrouter' AND status IN ('active','paused','review')`, [message]);
    return { synced: 0, unavailable: 0, error: message };
  }
}

async function selectModels(where: string, values: unknown[] = []): Promise<ModelRow[]> {
  const rows = await query<ModelRow>(`${modelSelect()} WHERE ${where}`, values);
  return rows.map((row) => ({ ...row, provider_metadata: parseMetadata(row.provider_metadata) }));
}

// The curated registry is the allow-list. Provider availability is returned to
// the UI so unavailable rows can be explained. Inference callers use the two
// helpers below, which require current provider metadata before billable work.
export async function listActiveModels(): Promise<ModelRow[]> {
  return selectModels("status = 'active' AND visibility = 'public' ORDER BY sort_order ASC, display_name ASC");
}

export async function getActiveModel(slug: string): Promise<ModelRow | null> {
  const rows = await selectModels("slug = $1 AND status = 'active' AND visibility = 'public' AND provider_sync_status = 'current' LIMIT 1", [slug]);
  return rows[0] ?? null;
}

export async function pickAutoModel(): Promise<ModelRow | null> {
  return (await selectModels("status = 'active' AND visibility = 'public' AND provider_sync_status = 'current' ORDER BY featured DESC, sort_order ASC LIMIT 1"))[0] ?? null;
}
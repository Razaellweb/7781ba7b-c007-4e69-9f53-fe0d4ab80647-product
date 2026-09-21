import { query, transaction } from "./db";
import { OpenRouterProvider } from "./openrouter";

type ProviderMetadata = {
  contextLength: number | null;
  pricing: Record<string, string>;
  architecture: { inputModalities: string[]; outputModalities: string[] };
  supportedParameters: string[];
  availability: "available" | "unavailable" | "stale";
  syncedAt: string | null;
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
    availability: raw.availability === "available" || raw.availability === "stale" ? raw.availability : "unavailable",
    syncedAt: typeof raw.syncedAt === "string" ? raw.syncedAt : null,
  };
}

function modelSelect(): string {
  return `SELECT slug, display_name, family, provider, provider_model_slug, status, featured, sort_order, context_length,
    markup_micro::text AS markup_micro, min_charge_micro_usd::text AS min_charge_micro_usd,
    provider_metadata, provider_sync_status, provider_synced_at, provider_sync_error
    FROM models`;
}

async function selectModels(where: string, values: unknown[] = []): Promise<ModelRow[]> {
  const rows = await query<ModelRow>(`${modelSelect()} WHERE ${where}`, values);
  return rows.map((row) => ({ ...row, provider_metadata: parseMetadata(row.provider_metadata) }));
}

// The database registry is the first-party public-ID to internal provider-ID
// mapping. Provider catalog data is used only to validate approved rows.
export async function syncCuratedModels(): Promise<{ synced: number; unavailable: number; error?: string }> {
  const syncedAt = new Date().toISOString();
  try {
    const catalog = await new OpenRouterProvider().catalog();
    const byId = new Map(catalog.map((model) => [model.providerModelId, model]));
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
            updated_at=now() WHERE slug=$1`, [model.slug, syncedAt, "The approved model is temporarily unavailable"]);
          continue;
        }
        const metadata = {
          contextLength: providerModel.contextLength,
          pricing: providerModel.pricing,
          architecture: providerModel.architecture,
          supportedParameters: providerModel.supportedParameters,
          availability: "available",
          syncedAt,
        };
        await client.query(`UPDATE models SET context_length=$2, provider_metadata=$3::jsonb,
          provider_sync_status='current', provider_synced_at=$4, provider_sync_error=NULL, updated_at=now() WHERE slug=$1`,
          [model.slug, metadata.contextLength, JSON.stringify(metadata), syncedAt]);
        synced += 1;
      }
    });
    return { synced, unavailable };
  } catch {
    await query(`UPDATE models SET provider_sync_status = CASE WHEN provider_metadata IS NULL THEN 'unavailable' ELSE 'stale' END,
      provider_sync_error=$1, provider_metadata = CASE WHEN provider_metadata IS NULL THEN NULL ELSE jsonb_set(provider_metadata, '{availability}', '"stale"'::jsonb) END,
      updated_at=now() WHERE provider='openrouter' AND status IN ('active','paused','review')`, ["The model catalog is temporarily unavailable"]);
    return { synced: 0, unavailable: 0, error: "catalog_unavailable" };
  }
}

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

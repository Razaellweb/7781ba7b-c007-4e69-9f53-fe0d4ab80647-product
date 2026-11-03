import { query, transaction } from "./db";
import { OpenRouterProvider } from "./openrouter";
import { MAX_DISCOUNT_BPS, normalizeDiscountBps } from "./pricing";

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
  source_url: string | null;
  status: string;
  visibility: string;
  featured: boolean;
  sort_order: number;
  context_length: number | null;
  description: string | null;
  display_provider: string | null;
  markup_micro: string;
  min_charge_micro_usd: string;
  /** Open-weight models are the only models a percentage discount applies to. */
  open_weight: boolean;
  /** Per-model discount in basis points (0-10000). 0 means standard price. */
  discount_bps: number;
  license_status: string;
  provider_terms_status: string;
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
  return `SELECT slug, display_name, family, provider, provider_model_slug, source_url,
    status, visibility, featured, sort_order, context_length, description, display_provider,
    markup_micro::text AS markup_micro, min_charge_micro_usd::text AS min_charge_micro_usd,
    open_weight, discount_bps,
    license_status, provider_terms_status, provider_metadata, provider_sync_status, provider_synced_at, provider_sync_error
    FROM models`;
}

async function selectModels(where: string, values: unknown[] = [], order = "sort_order ASC, display_name ASC", limit?: number): Promise<ModelRow[]> {
  const suffix = limit == null ? "" : ` LIMIT ${limit}`;
  const rows = await query<ModelRow>(`${modelSelect()} WHERE ${where} ORDER BY ${order}${suffix}`, values);
  return rows.map((row) => ({ ...row, provider_metadata: parseMetadata(row.provider_metadata) }));
}

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
            updated_at=now() WHERE slug=$1`, [model.slug, syncedAt, "Verified provider metadata is unavailable"]);
          continue;
        }
        const metadata = { contextLength: providerModel.contextLength, pricing: providerModel.pricing, architecture: providerModel.architecture, supportedParameters: providerModel.supportedParameters, availability: "available", syncedAt };
        await client.query(`UPDATE models SET context_length=$2, provider_metadata=$3::jsonb, provider_sync_status='current', provider_synced_at=$4, provider_sync_error=NULL, updated_at=now() WHERE slug=$1`, [model.slug, metadata.contextLength, JSON.stringify(metadata), syncedAt]);
        synced += 1;
      }
    });
    return { synced, unavailable };
  } catch {
    await query(`UPDATE models SET provider_sync_status = CASE WHEN provider_metadata IS NULL THEN 'unavailable' ELSE 'stale' END, provider_sync_error=$1, provider_metadata = CASE WHEN provider_metadata IS NULL THEN NULL ELSE jsonb_set(provider_metadata, '{availability}', '"stale"'::jsonb) END, updated_at=now() WHERE provider='openrouter' AND status IN ('active','paused','review')`, ["Verified provider metadata is unavailable"]);
    return { synced: 0, unavailable: 0, error: "catalog_unavailable" };
  }
}

export async function listActiveModels(): Promise<ModelRow[]> {
  return selectModels("status = 'active' AND visibility = 'public'");
}

// One card per model identifier. A duplicate row (same slug rendered twice) is
// collapsed to the first row in registry order so the dashboard never shows the
// same model twice.
export function dedupeBySlug(models: ModelRow[]): ModelRow[] {
  const seen = new Set<string>();
  const unique: ModelRow[] = [];
  for (const model of models) {
    const key = model.slug.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(model);
  }
  return unique;
}

export async function listDiscoverableModels(): Promise<ModelRow[]> {
  return dedupeBySlug(await selectModels("status IN ('active','paused') AND visibility = 'public'"));
}

export async function getActiveModel(slug: string): Promise<ModelRow | null> {
  return (await selectModels("slug = $1 AND status = 'active' AND visibility = 'public' AND provider_sync_status = 'current'", [slug], "sort_order ASC, display_name ASC", 1))[0] ?? null;
}

export async function pickAutoModel(): Promise<ModelRow | null> {
  return (await selectModels("status = 'active' AND visibility = 'public' AND provider_sync_status = 'current'", [], "featured DESC, sort_order ASC, display_name ASC", 1))[0] ?? null;
}

/* ==========================================================================
   Admin control plane: per-model open-weight discount

   `discount_bps` is the only column an operator writes here. It is clamped into
   the 0..10000 basis-point range before it ever reaches SQL (negative is refused,
   anything above 100% becomes 100%), and the write is restricted to open-weight
   models so every other model keeps its existing standard price.
   ========================================================================== */

export class ModelDiscountError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ModelDiscountError";
  }
}

/** Every model the discount editor is allowed to show: open-weight models only. */
export async function listOpenWeightModels(): Promise<ModelRow[]> {
  return selectModels("open_weight = true", [], "sort_order ASC, display_name ASC");
}

export async function getModelBySlug(slug: string): Promise<ModelRow | null> {
  return (await selectModels("slug = $1", [slug], "sort_order ASC, display_name ASC", 1))[0] ?? null;
}

/**
 * Persists a single model's open-weight discount. The caller passes an already
 * normalised basis-point value; this layer re-validates it so a bad value can
 * never be written even if a future caller forgets to.
 */
export async function updateModelDiscount(slug: string, discountBps: number): Promise<ModelRow> {
  if (!Number.isFinite(discountBps) || discountBps < 0) {
    throw new ModelDiscountError("INVALID_DISCOUNT", "Discount must be zero or greater", 400);
  }
  const clamped = Math.min(MAX_DISCOUNT_BPS, Math.round(discountBps));
  const rows = await query<{ slug: string; discount_bps: number; open_weight: boolean }>(
    `UPDATE models SET discount_bps = $2, updated_at = now()
      WHERE slug = $1 AND open_weight = true
      RETURNING slug, discount_bps, open_weight`,
    [slug, clamped],
  );
  if (!rows.length) {
    const existing = await getModelBySlug(slug);
    if (!existing) throw new ModelDiscountError("MODEL_NOT_FOUND", "That model is not in the registry", 404);
    throw new ModelDiscountError("NOT_OPEN_WEIGHT", "Discounts apply to open-weight models only", 400);
  }
  const updated = await getModelBySlug(slug);
  if (!updated) throw new ModelDiscountError("MODEL_NOT_FOUND", "That model is not in the registry", 404);
  return { ...updated, discount_bps: normalizeDiscountBps(updated.discount_bps) };
}

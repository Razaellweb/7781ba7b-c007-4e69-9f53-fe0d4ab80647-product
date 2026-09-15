import { query } from "./db";

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
};

// Only active, publicly-visible models are ever exposed (PRD §12.2, §28.2).
export async function listActiveModels(): Promise<ModelRow[]> {
  return query<ModelRow>(
    `SELECT slug, display_name, family, provider, provider_model_slug, status, featured, sort_order, context_length,
            markup_micro::text AS markup_micro, min_charge_micro_usd::text AS min_charge_micro_usd
       FROM models WHERE status = 'active' AND visibility = 'public' ORDER BY sort_order ASC, display_name ASC`
  );
}

// Resolve a user-facing slug to an approved model. Returns null when the model
// is unknown or not active so the caller can reject unauthorized selections.
export async function getActiveModel(slug: string): Promise<ModelRow | null> {
  const rows = await query<ModelRow>(
    `SELECT slug, display_name, family, provider, provider_model_slug, status, featured, sort_order, context_length,
            markup_micro::text AS markup_micro, min_charge_micro_usd::text AS min_charge_micro_usd
       FROM models WHERE slug = $1 AND status = 'active' AND visibility = 'public' LIMIT 1`,
    [slug]
  );
  return rows[0] ?? null;
}

// Auto mode picks the featured model with the lowest sort_order among approved
// models (PRD §13). It can never select outside the active registry.
export async function pickAutoModel(): Promise<ModelRow | null> {
  const rows = await query<ModelRow>(
    `SELECT slug, display_name, family, provider, provider_model_slug, status, featured, sort_order, context_length,
            markup_micro::text AS markup_micro, min_charge_micro_usd::text AS min_charge_micro_usd
       FROM models WHERE status = 'active' AND visibility = 'public'
       ORDER BY featured DESC, sort_order ASC LIMIT 1`
  );
  return rows[0] ?? null;
}

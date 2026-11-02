-- Model registry & availability (PRD: curated registry is the source of truth,
-- provider-agnostic with replacement support).
--
-- Mirrors supabase/migrations/20250219000000_model_registry_availability.sql so the
-- runtime migrator (lib/server/migrate.ts) and the deploy pipeline converge.
--
--   1. vast_model_id / vast_base_url: each curated model's vast.ai (vLLM /
--      OpenAI-compatible) identifier and, optionally, the endpoint serving it.
--   2. prompt_usd_per_token / completion_usd_per_token: registry-owned per-token
--      USD pricing, used by cost() and rendered on the model cards.
--   3. model_health: debounced per-model provider health.
--
-- All statements are idempotent so re-running the migration is safe.

ALTER TABLE models ADD COLUMN IF NOT EXISTS vast_model_id text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS vast_base_url text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS prompt_usd_per_token numeric(24, 12);
ALTER TABLE models ADD COLUMN IF NOT EXISTS completion_usd_per_token numeric(24, 12);
ALTER TABLE models ADD COLUMN IF NOT EXISTS availability_provider text;

CREATE TABLE IF NOT EXISTS model_health (
  model_slug text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openrouter', 'vast')),
  status text NOT NULL CHECK (status IN ('operational', 'degraded', 'unavailable')),
  candidate_status text CHECK (candidate_status IN ('operational', 'degraded', 'unavailable')),
  candidate_count integer NOT NULL DEFAULT 0,
  latency_ms integer,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_slug, provider)
);

CREATE INDEX IF NOT EXISTS model_health_provider_status_idx ON model_health (provider, status);
CREATE INDEX IF NOT EXISTS model_health_checked_idx ON model_health (checked_at DESC);

ALTER TABLE model_health ENABLE ROW LEVEL SECURITY;

UPDATE models SET
  prompt_usd_per_token = COALESCE(
    prompt_usd_per_token,
    NULLIF(provider_metadata -> 'pricing' ->> 'prompt', '')::numeric,
    NULLIF(provider_metadata -> 'pricing' ->> 'input', '')::numeric
  ),
  completion_usd_per_token = COALESCE(
    completion_usd_per_token,
    NULLIF(provider_metadata -> 'pricing' ->> 'completion', '')::numeric,
    NULLIF(provider_metadata -> 'pricing' ->> 'output', '')::numeric
  )
WHERE provider_metadata IS NOT NULL;

UPDATE models SET
  prompt_usd_per_token = COALESCE(prompt_usd_per_token, 0.15 / 1000000),
  completion_usd_per_token = COALESCE(completion_usd_per_token, 0.50 / 1000000)
WHERE visibility = 'public';

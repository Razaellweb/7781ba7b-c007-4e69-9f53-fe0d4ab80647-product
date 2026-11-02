-- Model registry & availability (PRD: curated registry is the source of truth,
-- provider-agnostic with replacement support).
--
-- Three things move into the registry here, so Openweight — not the upstream
-- provider — decides what a model costs and how it is routed:
--
--   1. vast_model_id / vast_base_url: each curated model's vast.ai (vLLM /
--      OpenAI-compatible) identifier and, optionally, the endpoint that serves it.
--      A model with no vast.ai mapping is unavailable FOR THE VAST.AI PROVIDER
--      ONLY (it can still be served by another provider) and is logged as a
--      configuration error by the registry sync.
--   2. prompt_usd_per_token / completion_usd_per_token: the per-token USD price
--      the ledger's cost() uses and the Overview cards display. Provider metadata
--      is now capability data (modalities, parameters), never pricing authority.
--   3. model_health: the latest per-model probe plus its debounce state, so a
--      flapping GPU endpoint cannot thrash the Overview cards or the Playground
--      selector between states.
--
-- All statements are idempotent so re-running the migration is safe.

ALTER TABLE models ADD COLUMN IF NOT EXISTS vast_model_id text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS vast_base_url text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS prompt_usd_per_token numeric(24, 12);
ALTER TABLE models ADD COLUMN IF NOT EXISTS completion_usd_per_token numeric(24, 12);
ALTER TABLE models ADD COLUMN IF NOT EXISTS availability_provider text;

COMMENT ON COLUMN models.vast_model_id IS
  'vast.ai / vLLM model identifier the curated model is served as. NULL means unmapped for the vast.ai provider (logged as a config error).';
COMMENT ON COLUMN models.prompt_usd_per_token IS
  'Registry-owned input price in USD per token. Used by cost() and rendered on the model cards; never read from the provider.';
COMMENT ON COLUMN models.availability_provider IS
  'The provider the current availability value was computed against.';

-- One row per (curated model, provider): the last probed status, plus the
-- candidate transition being debounced. `status` is what the product shows;
-- `candidate_status`/`candidate_count` are the pending observation that has not
-- yet been confirmed often enough to replace it.
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

COMMENT ON TABLE model_health IS
  'Per-model provider health with debounce state. Written by the registry availability refresh, read by the Overview cards, the Playground selector, and the request-path guard. No credential or upstream body is ever stored.';

CREATE INDEX IF NOT EXISTS model_health_provider_status_idx ON model_health (provider, status);
CREATE INDEX IF NOT EXISTS model_health_checked_idx ON model_health (checked_at DESC);

ALTER TABLE model_health ENABLE ROW LEVEL SECURITY;

-- Backfill: adopt the last known provider pricing into the registry so pricing is
-- Openweight-owned from here on. OpenRouter publishes USD-per-token strings, which
-- is exactly the unit cost() consumes.
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

-- Anything still unpriced falls back to the documented GPU-hour-derived rates
-- (VASTAI_PROMPT_USD_PER_TOKEN / VASTAI_COMPLETION_USD_PER_TOKEN defaults), so a
-- card can never advertise a price the ledger does not charge.
UPDATE models SET
  prompt_usd_per_token = COALESCE(prompt_usd_per_token, 0.15 / 1000000),
  completion_usd_per_token = COALESCE(completion_usd_per_token, 0.50 / 1000000)
WHERE visibility = 'public';

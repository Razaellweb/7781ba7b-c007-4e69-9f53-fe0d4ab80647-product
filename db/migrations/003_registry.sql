-- Model registry (PRD §12, §26.7). Openweight curates its own catalogue and
-- never renders the raw provider list. Pricing policy is per-model with an
-- integer micro-multiplier (2_000_000 == 2.0x) so all accounting stays integer.
CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  family text,
  provider text NOT NULL DEFAULT 'openrouter',
  provider_model_slug text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','review','active','paused','deprecated','removed')),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','hidden')),
  featured boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  context_length integer,
  markup_micro bigint NOT NULL DEFAULT 2000000 CHECK (markup_micro > 0),
  min_charge_micro_usd bigint NOT NULL DEFAULT 0 CHECK (min_charge_micro_usd >= 0),
  license_status text NOT NULL DEFAULT 'reviewed',
  provider_terms_status text NOT NULL DEFAULT 'reviewed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS models_active_order ON models(status, sort_order) WHERE status = 'active';

-- Per-message metering (PRD §26.10). Historical model identity and cost are
-- retained on the row that used them.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_slug text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_model text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS output_tokens integer;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_cost_micro_usd bigint;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_debit_micro_usd bigint;

-- Inference record enrichment (PRD §26.11).
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS provider_model text;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS estimated_user_debit_micro_usd bigint;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS markup_micro bigint;

-- Admin audit log (PRD §26.14).
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_account_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  previous_state jsonb,
  new_state jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the approved open-weight catalogue with correct OpenRouter slugs.
INSERT INTO models (slug, display_name, family, provider_model_slug, status, featured, sort_order, context_length) VALUES
  ('glm-4.5',          'GLM-4.5',            'Zhipu',      'z-ai/glm-4.5',                    'active', true,  10, 131072),
  ('qwen3-235b-a22b',  'Qwen3 235B A22B',    'Qwen',       'qwen/qwen3-235b-a22b',            'active', true,  20, 131072),
  ('deepseek-v3.1',    'DeepSeek V3.1',      'DeepSeek',   'deepseek/deepseek-chat-v3.1',     'active', false, 30, 163840),
  ('kimi-k2',          'Kimi K2',            'Moonshot',   'moonshotai/kimi-k2',              'active', false, 40, 131072),
  ('llama-4-maverick', 'Llama 4 Maverick',   'Meta',       'meta-llama/llama-4-maverick',     'active', false, 50, 1048576)
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  family = EXCLUDED.family,
  provider_model_slug = EXCLUDED.provider_model_slug,
  status = EXCLUDED.status,
  featured = EXCLUDED.featured,
  sort_order = EXCLUDED.sort_order,
  context_length = EXCLUDED.context_length,
  updated_at = now();

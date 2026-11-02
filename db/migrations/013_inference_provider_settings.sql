-- Runtime inference-provider selection (PRD: provider-agnostic transport with
-- replacement support, configurable without code changes).
--
-- The deployment environment (INFERENCE_PROVIDER / INFERENCE_FALLBACK_PROVIDER)
-- remains the default. This table lets the admin control plane override it at
-- runtime: a single 'active' row holds the selected provider and, when failover
-- was explicitly enabled, the fallback. A switch is recorded in the existing
-- admin_audit_log table by the API route that performs it.
--
-- `model_map` mirrors VASTAI_MODEL_MAP so per-model vast.ai routes can be
-- inspected from the control plane without redeploying. It is non-secret: it
-- holds provider model identifiers and endpoint addresses, never credentials.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS inference_provider_settings (
  id text PRIMARY KEY CHECK (id = 'active'),
  provider text NOT NULL CHECK (provider IN ('openrouter', 'vast')),
  fallback_provider text CHECK (fallback_provider IN ('openrouter', 'vast')),
  model_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'env', 'default')),
  updated_by_privy_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE inference_provider_settings IS
  'Admin override for the active inference provider. Absent or unreadable, the deployment environment (INFERENCE_PROVIDER) decides. Switching writes an admin_audit_log row.';

COMMENT ON COLUMN inference_provider_settings.model_map IS
  'Curated model id -> vast.ai model identifier / endpoint. Non-secret: mirrors VASTAI_MODEL_MAP for control-plane inspection.';

ALTER TABLE inference_provider_settings DROP CONSTRAINT IF EXISTS inference_provider_settings_fallback_distinct;
ALTER TABLE inference_provider_settings ADD CONSTRAINT inference_provider_settings_fallback_distinct CHECK (fallback_provider IS NULL OR fallback_provider <> provider);

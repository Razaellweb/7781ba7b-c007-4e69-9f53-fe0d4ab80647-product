-- OpenRouter is the provider metadata source of truth for approved models.
-- Metadata is retained as provider JSON so new OpenRouter fields do not require
-- a per-model schema or UI change. Selection still requires status = active.
ALTER TABLE models ADD COLUMN IF NOT EXISTS provider_metadata jsonb;
ALTER TABLE models ADD COLUMN IF NOT EXISTS provider_sync_status text NOT NULL DEFAULT 'never'
  CHECK (provider_sync_status IN ('never', 'current', 'stale', 'unavailable'));
ALTER TABLE models ADD COLUMN IF NOT EXISTS provider_synced_at timestamptz;
ALTER TABLE models ADD COLUMN IF NOT EXISTS provider_sync_error text;

CREATE INDEX IF NOT EXISTS models_provider_sync_status ON models(provider_sync_status);

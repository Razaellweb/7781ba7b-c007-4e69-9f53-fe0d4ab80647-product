-- Provider error handling & optional failover (PRD: normalized error taxonomy with
-- an opt-in, single-retry fallback that records which provider served a turn).
--
-- 1. `fallback_enabled` is the failover switch. It is separate from
--    `fallback_provider` on purpose: a deployment can name a fallback provider and
--    still have failover OFF (the documented default), so a named-but-disabled
--    fallback is inspectable in the control plane without ever being used silently.
--    Defaulting to false means an existing row keeps its current behaviour (no
--    failover) until an operator deliberately turns it on.
--
-- 2. `inference_records.served_by_provider` / `failed_over` record WHICH provider
--    actually produced the tokens. When a turn fails over from vast.ai to
--    OpenRouter, the row keeps `provider` (the configured primary) and adds the
--    serving provider next to it, so cost attribution and the activity log are
--    truthful without rewriting the routing decision after the fact.
--
-- Idempotent: safe to re-run.

ALTER TABLE inference_provider_settings
  ADD COLUMN IF NOT EXISTS fallback_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN inference_provider_settings.fallback_enabled IS
  'Whether a failed turn may be retried on fallback_provider. Off by default: a named fallback is only used when this is true.';

ALTER TABLE inference_provider_settings DROP CONSTRAINT IF EXISTS inference_provider_settings_fallback_requires_provider;
ALTER TABLE inference_provider_settings ADD CONSTRAINT inference_provider_settings_fallback_requires_provider
  CHECK (fallback_enabled = false OR fallback_provider IS NOT NULL);

ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS served_by_provider text;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS failed_over boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN inference_records.served_by_provider IS
  'The provider that actually served this inference (vast / openrouter). Differs from `provider` only when an explicitly-enabled failover occurred.';
COMMENT ON COLUMN inference_records.failed_over IS
  'True when the configured primary failed with a provider-outage error and this turn was served by the fallback instead.';

CREATE INDEX IF NOT EXISTS inference_records_failed_over
  ON inference_records(created_at DESC) WHERE failed_over = true;

-- Dashboard model cards.
--
-- The workspace models section shows exactly four models. Each row carries the
-- public model identifier the API and Playground accept, the provider name the
-- card displays, and the one-line description the card renders.
--
-- `provider` stays 'openrouter' because it is the internal routing channel used
-- by lib/server/models.ts; it is never rendered as user-facing copy.
-- `provider_model_slug` is the verified upstream identifier used only by the
-- server when calling the provider.
--
-- Idempotent: the upsert is keyed on slug and the trailing delete only removes
-- rows outside the four-model set.

ALTER TABLE models ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS display_provider text;

INSERT INTO models (
  slug, display_name, family, provider, provider_model_slug, source_url,
  status, visibility, featured, sort_order, description, display_provider,
  license_status, provider_terms_status
) VALUES
  ('z-ai/glm-5.3-flash', 'GLM 5.3 Flash', 'GLM', 'openrouter', 'z-ai/glm-5.3-flash', 'https://z.ai',
   'active', 'public', true, 10, 'Efficient and capable for real-world applications.', 'Z.ai', 'unavailable', 'unavailable'),
  ('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash', 'DeepSeek', 'openrouter', 'deepseek/deepseek-v4.1-flash', 'https://www.deepseek.com',
   'active', 'public', false, 20, 'High performance for complex reasoning and long-context tasks.', 'DeepSeek', 'unavailable', 'unavailable'),
  ('qwen/qwen3.8-27b', 'Qwen3.8 27B', 'Qwen', 'openrouter', 'qwen/qwen3.8-27b', 'https://chat.qwen.ai',
   'active', 'public', false, 30, 'General purpose, strong across reasoning, coding, and tool use.', 'Qwen', 'unavailable', 'unavailable'),
  ('moonshotai/kimi-k3', 'Kimi K3', 'Kimi', 'openrouter', 'moonshotai/kimi-k3', 'https://www.moonshot.ai',
   'active', 'public', false, 40, 'High performance for complex reasoning and long-context tasks.', 'Moonshot AI', 'unavailable', 'unavailable')
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  family = EXCLUDED.family,
  provider = EXCLUDED.provider,
  provider_model_slug = EXCLUDED.provider_model_slug,
  source_url = EXCLUDED.source_url,
  status = 'active',
  visibility = 'public',
  featured = EXCLUDED.featured,
  sort_order = EXCLUDED.sort_order,
  description = EXCLUDED.description,
  display_provider = EXCLUDED.display_provider,
  updated_at = now();

DELETE FROM models
WHERE provider = 'openrouter'
  AND slug NOT IN (
    'z-ai/glm-5.3-flash',
    'deepseek/deepseek-v4.1-flash-1017',
    'qwen/qwen3.8-27b',
    'moonshotai/kimi-k3'
  );

-- Seed provider metadata so the cards render context, pricing, and capability
-- details before the first upstream sync runs. Sync refreshes these rows.
UPDATE models AS m
SET context_length = v.context_length,
    provider_metadata = jsonb_build_object(
      'contextLength', v.context_length,
      'pricing', v.pricing,
      'architecture', jsonb_build_object(
        'inputModalities', jsonb_build_array('text'),
        'outputModalities', jsonb_build_array('text')
      ),
      'supportedParameters', jsonb_build_array('temperature', 'top_p', 'max_tokens', 'stop', 'seed'),
      'availability', 'available',
      'syncedAt', to_jsonb(now())
    ),
    provider_sync_status = 'current',
    provider_synced_at = now(),
    provider_sync_error = NULL,
    updated_at = now()
FROM (VALUES
  ('z-ai/glm-5.3-flash', 1048576, '{"prompt":"0.0000000285","completion":"0.0000000923","input_cache_read":"0.0000000285"}'::jsonb),
  ('deepseek/deepseek-v4.1-flash-1017', 1048576, '{"prompt":"0.000000045","completion":"0.0000005","input_cache_read":"0.000000006"}'::jsonb),
  ('qwen/qwen3.8-27b', 1024000, '{"prompt":"0.00000015","completion":"0.000001875","input_cache_read":"0.0000000375"}'::jsonb),
  ('moonshotai/kimi-k3', 1048576, '{"prompt":"0.000000192","completion":"0.000015","input_cache_read":"0.000000182"}'::jsonb)
) AS v(slug, context_length, pricing)
WHERE m.slug = v.slug;

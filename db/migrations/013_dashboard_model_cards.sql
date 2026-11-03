-- Dashboard model cards and the model list the user chose (2026-11-02):
--   z-ai/glm-5.3-flash, deepseek/deepseek-v4.1-flash-1017, qwen/qwen3.8-27b,
--   moonshotai/kimi-k3.
--
-- Databases differ in how these rows exist: a fresh install has 008's short
-- slugs ('glm-5-3-flash'), while production already holds them under the
-- provider ids as slugs. Rows are therefore matched by provider model id, slugs
-- are never renamed (past conversations store the slug), and only missing
-- models are inserted. Pricing and context length are not set here:
-- GET /api/models refreshes them from the provider catalog.
--
-- All statements are idempotent so re-running the migration is safe.

ALTER TABLE models ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE models ADD COLUMN IF NOT EXISTS display_provider text;

CREATE TEMP TABLE wanted_models (
  provider_model_slug text PRIMARY KEY,
  display_name text NOT NULL,
  family text NOT NULL,
  source_url text NOT NULL,
  featured boolean NOT NULL,
  sort_order integer NOT NULL,
  description text NOT NULL,
  display_provider text NOT NULL
) ON COMMIT DROP;

INSERT INTO wanted_models VALUES
  ('z-ai/glm-5.3-flash', 'GLM 5.3 Flash', 'GLM', 'https://z.ai', true, 10, 'Efficient and capable for real-world applications.', 'Z.ai'),
  ('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash', 'DeepSeek', 'https://www.deepseek.com', false, 20, 'High performance for complex reasoning and long-context tasks.', 'DeepSeek'),
  ('qwen/qwen3.8-27b', 'Qwen3.8 27B', 'Qwen', 'https://chat.qwen.ai', false, 30, 'General purpose, strong across reasoning, coding, and tool use.', 'Qwen'),
  ('moonshotai/kimi-k3', 'Kimi K3', 'Kimi', 'https://www.moonshot.ai', false, 40, 'High performance for complex reasoning and long-context tasks.', 'Moonshot AI');

-- The user asked for DeepSeek's dated 1017 release; move the existing row to it.
UPDATE models
SET provider_model_slug = 'deepseek/deepseek-v4.1-flash-1017', provider_sync_status = 'never', updated_at = now()
WHERE provider = 'openrouter'
  AND provider_model_slug = 'deepseek/deepseek-v4.1-flash'
  AND NOT EXISTS (SELECT 1 FROM models WHERE provider = 'openrouter' AND provider_model_slug = 'deepseek/deepseek-v4.1-flash-1017');

UPDATE models AS m
SET display_name = w.display_name,
    family = w.family,
    source_url = w.source_url,
    status = 'active',
    visibility = 'public',
    featured = w.featured,
    sort_order = w.sort_order,
    description = w.description,
    display_provider = w.display_provider,
    updated_at = now()
FROM wanted_models AS w
WHERE m.provider = 'openrouter' AND m.provider_model_slug = w.provider_model_slug;

INSERT INTO models (
  slug, display_name, family, provider, provider_model_slug, source_url,
  status, visibility, featured, sort_order, description, display_provider,
  license_status, provider_terms_status, provider_sync_status
)
SELECT w.provider_model_slug, w.display_name, w.family, 'openrouter', w.provider_model_slug, w.source_url,
       'active', 'public', w.featured, w.sort_order, w.description, w.display_provider,
       'unavailable', 'unavailable', 'never'
FROM wanted_models AS w
WHERE NOT EXISTS (SELECT 1 FROM models AS m WHERE m.provider = 'openrouter' AND m.provider_model_slug = w.provider_model_slug)
  AND NOT EXISTS (SELECT 1 FROM models AS m WHERE m.slug = w.provider_model_slug);

-- Exactly these four models are offered; anything else from the provider goes.
DELETE FROM models
WHERE provider = 'openrouter'
  AND provider_model_slug NOT IN (SELECT provider_model_slug FROM wanted_models);

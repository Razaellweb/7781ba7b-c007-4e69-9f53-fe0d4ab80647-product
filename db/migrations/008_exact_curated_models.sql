-- Replace the curated set without importing or discovering additional provider models.
-- The curated slug is the first-party UI/server identity; provider_model_slug is
-- the exact upstream OpenRouter identifier used only by server-side routing.
ALTER TABLE models ADD COLUMN IF NOT EXISTS source_url text;

DELETE FROM models WHERE provider = 'openrouter';

CREATE UNIQUE INDEX IF NOT EXISTS models_provider_model_slug_unique ON models(provider, provider_model_slug);
CREATE UNIQUE INDEX IF NOT EXISTS models_public_curated_slug_unique ON models(slug) WHERE visibility = 'public';

INSERT INTO models (
  slug, display_name, family, provider, provider_model_slug, source_url,
  status, visibility, featured, sort_order, context_length,
  license_status, provider_terms_status, provider_sync_status
) VALUES
  ('glm-5-3-flash', 'GLM 5.3 Flash', 'GLM', 'openrouter', 'z-ai/glm-5.3-flash', 'https://openrouter.ai/z-ai/glm-5.3-flash', 'active', 'public', true, 10, NULL, 'unavailable', 'unavailable', 'never'),
  ('qwen-3-8-27b', 'Qwen 3.8 27B', 'Qwen', 'openrouter', 'qwen/qwen3.8-27b', 'https://openrouter.ai/qwen/qwen3.8-27b', 'active', 'public', true, 20, NULL, 'unavailable', 'unavailable', 'never'),
  ('deepseek-v4-1-flash', 'DeepSeek V4.1 Flash', 'DeepSeek', 'openrouter', 'deepseek/deepseek-v4.1-flash', 'https://openrouter.ai/deepseek/deepseek-v4.1-flash', 'active', 'public', false, 30, NULL, 'unavailable', 'unavailable', 'never'),
  ('kimi-k3', 'Kimi K3', 'Kimi', 'openrouter', 'moonshotai/kimi-k3', 'https://openrouter.ai/moonshotai/kimi-k3', 'active', 'public', false, 40, NULL, 'unavailable', 'unavailable', 'never'),
  ('gemma-4-31b', 'Gemma 4 31B', 'Gemma', 'openrouter', 'google/gemma-4-31b-it', 'https://openrouter.ai/google/gemma-4-31b-it', 'active', 'public', false, 50, NULL, 'unavailable', 'unavailable', 'never');

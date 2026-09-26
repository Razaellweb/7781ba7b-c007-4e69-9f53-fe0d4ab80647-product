ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_expiry_after_creation;
ALTER TABLE api_keys DROP COLUMN IF EXISTS expires_at;

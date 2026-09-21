CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  key_prefix text NOT NULL CHECK (key_prefix = 'ow_live'),
  secret_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['chat:write','account:read']::text[],
  rate_limit_per_minute integer NOT NULL DEFAULT 20 CHECK (rate_limit_per_minute BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT api_keys_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_account_name_ci ON api_keys(account_id, lower(name));
CREATE INDEX IF NOT EXISTS api_keys_hash_active ON api_keys(secret_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_keys_account_created ON api_keys(account_id, created_at DESC);

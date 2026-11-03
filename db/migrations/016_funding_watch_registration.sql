-- Funding monitoring: every generated deposit address must be registered for
-- incoming USDG ERC-20 monitoring on the active Robinhood Chain network, and no
-- address may be silently left unwatched.
--
-- Mirrors supabase/migrations/20250220000000_funding_watch_registration.sql so the
-- runtime migration runner (lib/server/migrate.ts) produces the same schema.
-- Every statement is idempotent so re-running the migration is safe.

ALTER TABLE funding_wallets
  ADD COLUMN IF NOT EXISTS watch_status text NOT NULL DEFAULT 'unwatched',
  ADD COLUMN IF NOT EXISTS watch_webhook_id text,
  ADD COLUMN IF NOT EXISTS watch_registered_at timestamptz,
  ADD COLUMN IF NOT EXISTS watch_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watch_last_error text,
  ADD COLUMN IF NOT EXISTS watch_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_scanned_block bigint;

ALTER TABLE funding_wallets DROP CONSTRAINT IF EXISTS funding_wallets_watch_status_check;
ALTER TABLE funding_wallets
  ADD CONSTRAINT funding_wallets_watch_status_check
  CHECK (watch_status IN ('unwatched','watched','failed'));

CREATE INDEX IF NOT EXISTS funding_wallets_watch_pending
  ON funding_wallets(watch_next_attempt_at)
  WHERE watch_status <> 'watched';

ALTER TABLE funding_deposits
  ADD COLUMN IF NOT EXISTS block_number bigint,
  ADD COLUMN IF NOT EXISTS block_hash text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS reorged_at timestamptz,
  ADD COLUMN IF NOT EXISTS reorg_reason text,
  ADD COLUMN IF NOT EXISTS credit_reversed boolean NOT NULL DEFAULT false;

ALTER TABLE funding_deposits DROP CONSTRAINT IF EXISTS funding_deposits_amount_raw_check;
ALTER TABLE funding_deposits
  ADD CONSTRAINT funding_deposits_amount_raw_check CHECK (amount_raw >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS funding_deposits_tx_log_unique
  ON funding_deposits(chain_id, tx_hash, log_index);

CREATE UNIQUE INDEX IF NOT EXISTS funding_deposits_idempotency_key
  ON funding_deposits(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS funding_deposits_block_hash
  ON funding_deposits(block_hash)
  WHERE block_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS funding_deposits_reorged
  ON funding_deposits(reorged_at)
  WHERE reorged_at IS NOT NULL;

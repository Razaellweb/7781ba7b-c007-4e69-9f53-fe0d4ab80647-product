-- Funding monitoring: every generated deposit address must be registered for
-- incoming USDG ERC-20 monitoring on the active Robinhood Chain network, and no
-- address may be silently left unwatched.
--
-- This migration adds the persistence needed for that promise:
--   * funding_wallets gets an explicit watch/registration state machine
--     (unwatched -> watched / failed) with an attempt counter, last error, and a
--     next-attempt timestamp so a failed Alchemy registration is retried with
--     backoff instead of being forgotten.
--   * funding_wallets also gets a reconciliation cursor (`last_scanned_block`) so
--     the polling fallback resumes where it left off after an Alchemy outage.
--   * funding_deposits gets the inclusion block identity (number + hash), the
--     provider idempotency key, and reorg bookkeeping, which is what lets a
--     previously credited deposit be flagged when its transaction is reorged out.
--
-- Every statement is idempotent so re-running the migration is safe.

-- 1) Address watch / registration state.
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

-- Registration retries are driven by (status, next attempt) so the sweeper can
-- pick up exactly the addresses that still need monitoring.
CREATE INDEX IF NOT EXISTS funding_wallets_watch_pending
  ON funding_wallets(watch_next_attempt_at)
  WHERE watch_status <> 'watched';

-- 2) Deposit block identity, provider idempotency key, and reorg bookkeeping.
ALTER TABLE funding_deposits
  ADD COLUMN IF NOT EXISTS block_number bigint,
  ADD COLUMN IF NOT EXISTS block_hash text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS reorged_at timestamptz,
  ADD COLUMN IF NOT EXISTS reorg_reason text,
  ADD COLUMN IF NOT EXISTS credit_reversed boolean NOT NULL DEFAULT false;

-- A zero-value transfer must be storable so it can be recorded as rejected for
-- audit rather than silently dropped; only positive amounts are ever credited.
ALTER TABLE funding_deposits DROP CONSTRAINT IF EXISTS funding_deposits_amount_raw_check;
ALTER TABLE funding_deposits
  ADD CONSTRAINT funding_deposits_amount_raw_check CHECK (amount_raw >= 0);

-- 3) Provider idempotency: exactly one deposit row per transfer log, keyed by
--    transaction hash plus log index. Duplicate webhook deliveries, concurrent
--    workers, and webhook/polling overlaps all collapse onto the same row, which
--    is what makes double-crediting impossible.
CREATE UNIQUE INDEX IF NOT EXISTS funding_deposits_tx_log_unique
  ON funding_deposits(chain_id, tx_hash, log_index);

-- The same idempotency key is written to the ledger entry, so the credit itself is
-- guarded a second time at the ledger's own unique key.
CREATE UNIQUE INDEX IF NOT EXISTS funding_deposits_idempotency_key
  ON funding_deposits(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS funding_deposits_block_hash
  ON funding_deposits(block_hash)
  WHERE block_hash IS NOT NULL;

-- Reorged credits need operator attention, so surface them cheaply.
CREATE INDEX IF NOT EXISTS funding_deposits_reorged
  ON funding_deposits(reorged_at)
  WHERE reorged_at IS NOT NULL;

COMMENT ON COLUMN funding_wallets.watch_status IS 'Alchemy address-activity registration state. Only ''watched'' means monitoring is confirmed active; ''failed'' rows are retried with backoff.';
COMMENT ON COLUMN funding_wallets.last_scanned_block IS 'Highest block already reconciled by the polling fallback for this address.';
COMMENT ON COLUMN funding_deposits.idempotency_key IS 'Stable credit key (chain:tx:logIndex), mirrored into compute_ledger_entries.idempotency_key so a transfer can never credit twice.';
COMMENT ON COLUMN funding_deposits.reorged_at IS 'Set when a previously mined/credited transfer is no longer present in the canonical chain.';

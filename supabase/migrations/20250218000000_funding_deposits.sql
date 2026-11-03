-- Funding: a unique per-account funding wallet whose deposits are converted into
-- compute balance.
--
-- A signed-in account gets exactly one funding wallet, created server-side with
-- Privy's wallet API (the private key never leaves Privy and never touches this
-- app). The address is persisted so closing the modal and coming back later keeps
-- the same address and the same in-flight deposit state.
--
-- Deposits are recorded one row per (chain, transaction, log index), which is what
-- makes multiple deposits independently trackable and repeated provider
-- notifications harmless. Credit itself is guarded by the unique
-- compute_ledger_entries.idempotency_key, so a replayed webhook, a retry, or two
-- concurrent workers can never credit the same transfer twice.
--
-- Every statement is idempotent so re-running the migration is safe.

-- 1) Token balance credits are a first-class ledger entry type, alongside grants.
ALTER TABLE compute_ledger_entries DROP CONSTRAINT IF EXISTS compute_ledger_entries_entry_type_check;
ALTER TABLE compute_ledger_entries ADD CONSTRAINT compute_ledger_entries_entry_type_check CHECK (entry_type IN ('grant','reservation','user_debit','release','refund','adjustment','deposit'));

-- 2) One funding wallet per account. The address is stored lower-cased and unique
--    so an incoming transfer can be resolved back to exactly one account.
CREATE TABLE IF NOT EXISTS funding_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES user_accounts(id),
  privy_wallet_id text NOT NULL UNIQUE,
  address text NOT NULL UNIQUE CHECK (address = lower(address)),
  chain_id integer NOT NULL,
  token_address text NOT NULL CHECK (token_address = lower(token_address)),
  token_symbol text NOT NULL,
  token_decimals integer NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3) Deposits. `amount_micro_usd` is the credited compute value in the ledger's
--    canonical micro-USD unit; `amount_raw` is the on-chain integer amount so the
--    original transfer can always be reconciled.
CREATE TABLE IF NOT EXISTS funding_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES user_accounts(id),
  funding_wallet_id uuid NOT NULL REFERENCES funding_wallets(id),
  chain_id integer NOT NULL,
  token_address text NOT NULL CHECK (token_address = lower(token_address)),
  tx_hash text NOT NULL CHECK (tx_hash = lower(tx_hash)),
  log_index integer NOT NULL DEFAULT 0 CHECK (log_index >= 0),
  from_address text,
  to_address text NOT NULL CHECK (to_address = lower(to_address)),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd >= 0),
  confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  -- Why a transfer was refused credit (wrong token, wrong chain, below the
  -- minimum, ambiguous). Rejected rows are kept for audit, never credited.
  rejection_reason text,
  ledger_entry_id uuid REFERENCES compute_ledger_entries(id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  confirmed_at timestamptz,
  credited_at timestamptz,
  UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS funding_deposits_account ON funding_deposits(account_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS funding_deposits_pending ON funding_deposits(last_checked_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS funding_deposits_wallet ON funding_deposits(funding_wallet_id, first_seen_at DESC);

-- 4) Raw provider notifications, kept so a failed or duplicate delivery can be
--    replayed instead of silently losing a deposit. `event_id` is the provider
--    event identifier; re-delivering the same event does not create a second row.
CREATE TABLE IF NOT EXISTS alchemy_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id text,
  event_id text,
  event_type text,
  network text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','rejected')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS alchemy_webhook_events_event_id ON alchemy_webhook_events(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alchemy_webhook_events_pending ON alchemy_webhook_events(received_at) WHERE status IN ('received','failed');

COMMENT ON TABLE funding_wallets IS 'Per-account deposit address created with the Privy server wallet API. Token/chain configuration lives in server env, not in the browser.';
COMMENT ON TABLE funding_deposits IS 'Individual incoming transfers to a funding wallet. Credited exactly once via compute_ledger_entries.idempotency_key after the configured confirmation count.';
COMMENT ON TABLE alchemy_webhook_events IS 'Verified Alchemy notifications, retained so failed processing can be retried and duplicate deliveries can be ignored.';

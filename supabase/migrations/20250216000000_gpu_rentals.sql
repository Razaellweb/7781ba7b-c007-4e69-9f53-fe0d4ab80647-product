-- GPU rentals: users rent marketplace GPUs through the workspace, paid from the
-- same compute allowance as inference.
--
-- Billing is prepaid in blocks. Each block is a normal compute_reservations hold
-- (channel 'gpu', operation_key 'gpu:<rental>:<block>'). A block that runs to its
-- end is settled in full; a rental stopped mid-block is settled for the minutes
-- it ran and the rest is released. The next block is reserved shortly before the
-- current one ends; if the balance cannot cover it, the machine is shut down when
-- the paid block ends.
--
-- All statements are idempotent so re-running the migration is safe.

ALTER TABLE compute_reservations DROP CONSTRAINT IF EXISTS compute_reservations_channel_check;
ALTER TABLE compute_reservations ADD CONSTRAINT compute_reservations_channel_check CHECK (channel IN ('app','api_key','gpu'));

CREATE TABLE IF NOT EXISTS gpu_rentals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES user_accounts(id),
  status text NOT NULL DEFAULT 'launching' CHECK (status IN ('launching','running','ended','failed')),
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('user_stopped','balance_exhausted','provider_ended','launch_failed')),
  template text NOT NULL,
  model text,
  offer_id bigint NOT NULL,
  provider_instance_id bigint,
  provider_status text,
  gpu_name text NOT NULL,
  gpu_count integer,
  gpu_ram_gb numeric(8,1),
  location text,
  -- Provider cost and the user's rate, both in micro-USD per hour.
  provider_hourly_micro_usd bigint NOT NULL CHECK (provider_hourly_micro_usd > 0),
  hourly_rate_micro_usd bigint NOT NULL CHECK (hourly_rate_micro_usd > 0),
  markup_micro bigint NOT NULL CHECK (markup_micro > 0),
  block_minutes integer NOT NULL CHECK (block_minutes > 0),
  block_index integer NOT NULL DEFAULT 0,
  block_started_at timestamptz NOT NULL,
  block_ends_at timestamptz NOT NULL,
  current_operation_key text,
  next_operation_key text,
  renewal_blocked boolean NOT NULL DEFAULT false,
  total_debited_micro_usd bigint NOT NULL DEFAULT 0,
  -- Machine time the provider billed that could not be charged to the user
  -- (for example a late sync after the balance ran out). Platform loss.
  unbilled_micro_usd bigint NOT NULL DEFAULT 0,
  lease_token_hash text NOT NULL,
  ssh_public_key text,
  ssh_key_attached boolean NOT NULL DEFAULT false,
  service_api_key text,
  connection jsonb NOT NULL DEFAULT '{}',
  sync_claimed_until timestamptz,
  last_synced_at timestamptz,
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS gpu_rentals_account_created ON gpu_rentals(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gpu_rentals_active_sync ON gpu_rentals(last_synced_at) WHERE status IN ('launching','running');

COMMENT ON TABLE gpu_rentals IS
  'GPU machines rented through the workspace. Billing holds and debits live in compute_reservations / compute_ledger_entries (channel gpu).';

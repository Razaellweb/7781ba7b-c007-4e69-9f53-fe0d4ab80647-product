ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'app' CHECK (channel IN ('app','api_key'));
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'app' CHECK (channel IN ('app','api_key'));
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS reconciliation_required boolean NOT NULL DEFAULT false;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS client_request_id text;
CREATE UNIQUE INDEX IF NOT EXISTS inference_records_account_client_request ON inference_records(account_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inference_records_channel_created ON inference_records(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS inference_records_api_key_created ON inference_records(api_key_id, created_at DESC) WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS compute_reservations_channel_created ON compute_reservations(channel, settled_at DESC);

CREATE TABLE IF NOT EXISTS inference_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  inference_id uuid REFERENCES inference_records(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES compute_reservations(id) ON DELETE SET NULL,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  operation_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('app','api_key')),
  event_type text NOT NULL CHECK (event_type IN ('provider_usage','provider_failure','cancelled','partial','uncertain','reconciled')),
  input_tokens integer,
  output_tokens integer,
  provider_cost_micro_usd bigint,
  user_debit_micro_usd bigint,
  pricing_markup_micro bigint,
  usage_status text NOT NULL CHECK (usage_status IN ('known','uncertain','pending_reconciliation','reconciled')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_key, event_type)
);
CREATE INDEX IF NOT EXISTS inference_usage_account_created ON inference_usage_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inference_usage_reconciliation ON inference_usage_events(usage_status, created_at) WHERE usage_status IN ('uncertain','pending_reconciliation');
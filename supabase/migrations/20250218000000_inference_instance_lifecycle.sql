-- Instance lifecycle + provider health (PRD: normalized health contract, warm pool).
--
-- inference_instances is the lifecycle manager's ledger of vast.ai GPU
-- instances rented ON DEMAND to serve curated models. One active row per model
-- (enforced by a partial unique index) doubles as the cross-process
-- "single instance start" lock: two concurrent requests for a cold model cannot
-- both rent a machine, because only one INSERT can satisfy the index.
--
-- provider_instance_events records structured lifecycle metrics (start, ready,
-- stop, health transition) so warm/cold latency is inspectable without reading
-- server logs.
--
-- provider_health holds the latest normalized probe per provider. It is written
-- by the background health worker and read by the Overview badge and the admin
-- control plane, so no request path pays for a live probe.
--
-- All statements are idempotent so re-running the migration is safe.

CREATE TABLE IF NOT EXISTS inference_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id text NOT NULL,
  provider text NOT NULL DEFAULT 'vast' CHECK (provider IN ('vast')),
  provider_instance_id text,
  provider_model text,
  base_url text,
  service_api_key text,
  offer_id text,
  state text NOT NULL DEFAULT 'provisioning'
    CHECK (state IN ('provisioning', 'warming', 'ready', 'idle', 'terminating', 'terminated', 'failed')),
  claim_token text,
  claim_expires_at timestamptz,
  failure_reason text,
  provider_hourly_micro_usd numeric(20, 0),
  cold_start_ms integer,
  last_used_at timestamptz,
  last_health_at timestamptz,
  health_status text,
  ready_at timestamptz,
  terminated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE inference_instances IS
  'Lifecycle-managed vast.ai inference instances. One active row per model; the partial unique index is the cross-process single-start lock.';
COMMENT ON COLUMN inference_instances.service_api_key IS
  'Instance service key used only by the server inference transport. Never returned to a client.';

CREATE UNIQUE INDEX IF NOT EXISTS inference_instances_active_model_idx
  ON inference_instances (model_id)
  WHERE state IN ('provisioning', 'warming', 'ready', 'idle');

CREATE INDEX IF NOT EXISTS inference_instances_state_idx ON inference_instances (state);
CREATE INDEX IF NOT EXISTS inference_instances_idle_idx ON inference_instances (last_used_at)
  WHERE state IN ('ready', 'idle');

CREATE TABLE IF NOT EXISTS provider_instance_events (
  id bigserial PRIMARY KEY,
  instance_id uuid REFERENCES inference_instances (id) ON DELETE SET NULL,
  model_id text,
  provider text NOT NULL DEFAULT 'vast',
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE provider_instance_events IS
  'Structured instance lifecycle metrics: instance_start_requested / instance_ready / instance_stopped / instance_start_failed / health_transition.';

CREATE INDEX IF NOT EXISTS provider_instance_events_created_idx ON provider_instance_events (created_at DESC);
CREATE INDEX IF NOT EXISTS provider_instance_events_model_idx ON provider_instance_events (model_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_health (
  provider text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('operational', 'degraded', 'unavailable')),
  healthy boolean NOT NULL,
  latency_ms integer,
  model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE provider_health IS
  'Latest normalized provider health snapshot, written by the background health worker and read by the Overview badge and the admin control plane.';

ALTER TABLE inference_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_instance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_health ENABLE ROW LEVEL SECURITY;

-- Compute metering & settlement (PRD: atomic reservation, exact settlement,
-- append-only ledger, margin per inference, idempotent retries).
--
-- Mirrors db/migrations/016_compute_metering_settlement.sql so the runtime
-- migrator (lib/server/migrate.ts) and the deploy pipeline converge.
--
-- Adds: settlement idempotency key + margin + unbilled columns on reservations,
-- reconciliation state for uncertain settlements, per-inference margin on
-- inference_records and inference_usage_events, and a reconstructable balance view.
--
-- All statements are idempotent so re-running the migration is safe.
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS margin_micro_usd bigint;
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS unbilled_micro_usd bigint NOT NULL DEFAULT 0;
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS settlement_event text;
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS settlement_key text;
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE compute_reservations ADD COLUMN IF NOT EXISTS reconciliation_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE compute_reservations DROP CONSTRAINT IF EXISTS compute_reservations_settlement_event_check;
ALTER TABLE compute_reservations ADD CONSTRAINT compute_reservations_settlement_event_check
  CHECK (settlement_event IS NULL OR settlement_event IN ('provider_usage','provider_failure','cancelled','partial','uncertain','reconciled'));

CREATE UNIQUE INDEX IF NOT EXISTS compute_reservations_settlement_key
  ON compute_reservations(settlement_key) WHERE settlement_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS compute_reservations_pending_reconciliation
  ON compute_reservations(status, settled_at) WHERE status IN ('reserved','uncertain');
CREATE INDEX IF NOT EXISTS compute_reservations_created
  ON compute_reservations(created_at) WHERE status = 'reserved';

ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS margin_micro_usd bigint;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS estimated_reservation_micro_usd bigint;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS reservation_status text;

CREATE INDEX IF NOT EXISTS inference_records_margin_created
  ON inference_records(created_at DESC) WHERE margin_micro_usd IS NOT NULL;

ALTER TABLE inference_usage_events ADD COLUMN IF NOT EXISTS margin_micro_usd bigint;
ALTER TABLE inference_usage_events ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

CREATE OR REPLACE VIEW compute_account_balances AS
SELECT
  a.id AS account_id,
  COALESCE(SUM(CASE WHEN e.entry_type IN ('grant','release','refund') THEN e.amount_micro_usd ELSE 0 END), 0)::bigint AS credited_micro_usd,
  COALESCE(SUM(CASE WHEN e.entry_type IN ('reservation','user_debit') THEN e.amount_micro_usd ELSE 0 END), 0)::bigint AS debited_micro_usd,
  GREATEST(
    COALESCE(SUM(CASE WHEN e.entry_type IN ('grant','release','refund') THEN e.amount_micro_usd WHEN e.entry_type IN ('reservation','user_debit') THEN -e.amount_micro_usd ELSE 0 END), 0),
    0
  )::bigint AS available_micro_usd
FROM user_accounts a
LEFT JOIN compute_ledger_entries e ON e.account_id = a.id
GROUP BY a.id;

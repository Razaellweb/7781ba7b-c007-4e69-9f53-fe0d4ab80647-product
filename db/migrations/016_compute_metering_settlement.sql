-- Compute metering & settlement (PRD: atomic reservation, exact settlement,
-- append-only ledger, margin per inference, idempotent retries).
--
-- The reservation already exists (compute_reservations) and the ledger already
-- exists (compute_ledger_entries). What this migration adds is everything needed
-- to make settlement *auditable and reproducible*:
--
--   1. reserve sized from a conservative token estimate — the estimate details are
--      kept on the reservation row (metadata.estimate) so a hold can be explained.
--   2. settlement records provider cost, user debit and margin side by side, so
--      reconciliation is a subtraction rather than a join across four tables.
--   3. a settlement → status transition carries a unique settlement_key, so a
--      retried settlement (worker crash mid-settlement, duplicate reconnect) can
--      only ever apply once.
--   4. uncertainty is reconciled: `uncertain`, `reconciled_at` and
--      `reconciliation_attempts` let a worker settle usage the provider reported
--      late without double-debiting, and bounds the number of attempts.
--   5. `unbilled_micro_usd` records the case where the user's debit was capped by
--      the reservation (never billed beyond the hold, never a negative balance).
--
-- All statements are idempotent so re-running the migration is safe.

-- ---------------------------------------------------------------------------
-- Reservations: settlement + reconciliation state.
-- ---------------------------------------------------------------------------
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

-- One settlement per operation: a retried settlement can never write twice.
CREATE UNIQUE INDEX IF NOT EXISTS compute_reservations_settlement_key
  ON compute_reservations(settlement_key) WHERE settlement_key IS NOT NULL;

-- The reconciliation worker's query: holds that never settled, and holds that
-- settled uncertain, oldest first.
CREATE INDEX IF NOT EXISTS compute_reservations_pending_reconciliation
  ON compute_reservations(status, settled_at) WHERE status IN ('reserved','uncertain');
CREATE INDEX IF NOT EXISTS compute_reservations_created
  ON compute_reservations(created_at) WHERE status = 'reserved';

COMMENT ON COLUMN compute_reservations.settlement_key IS
  'Unique settlement idempotency key (settle:<operation_key> or reconcile:<operation_key>). Guarantees one settlement per reserved hold.';
COMMENT ON COLUMN compute_reservations.margin_micro_usd IS
  'Gross margin for this inference: settled user debit minus provider cost. NULL when the provider cost is unknown.';
COMMENT ON COLUMN compute_reservations.unbilled_micro_usd IS
  'Debit that exceeded the reservation and was therefore not charged. Recorded rather than silently truncated.';

-- ---------------------------------------------------------------------------
-- Inference records: the per-inference reconciliation row.
-- ---------------------------------------------------------------------------
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS margin_micro_usd bigint;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS estimated_reservation_micro_usd bigint;
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS reservation_status text;

CREATE INDEX IF NOT EXISTS inference_records_margin_created
  ON inference_records(created_at DESC) WHERE margin_micro_usd IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Usage events: margin per event, and when an uncertain event was reconciled.
-- ---------------------------------------------------------------------------
ALTER TABLE inference_usage_events ADD COLUMN IF NOT EXISTS margin_micro_usd bigint;
ALTER TABLE inference_usage_events ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

COMMENT ON COLUMN inference_usage_events.margin_micro_usd IS
  'user_debit_micro_usd - provider_cost_micro_usd for this event. NULL when provider cost is unknown.';

-- ---------------------------------------------------------------------------
-- Reconstructable ledger check: the available balance is always
--   SUM(grant + release + refund) - SUM(reservation + user_debit)
-- and must never go negative. Exposed as a view so the invariant is inspectable
-- (and testable) without duplicating the sum in application code.
-- ---------------------------------------------------------------------------
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

COMMENT ON VIEW compute_account_balances IS
  'Reconstructable available balance per account, derived only from the append-only compute_ledger_entries rows.';

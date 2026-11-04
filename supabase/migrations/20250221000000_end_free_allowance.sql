-- Openweight no longer gives a free monthly allowance: an account's balance is
-- what it has deposited (USDG funding). Grants still inside their period end now,
-- so they stop counting toward the balance (AVAILABLE_BALANCE_SQL in
-- lib/server/accounting.ts counts a grant only while period_end > now()).
-- Grant rows and their ledger entries are kept as a record; nothing is deleted.
-- New grants are not issued while OPENWEIGHT_GRANT_AMOUNT_MICRO_USD is 0.
--
-- Idempotent: an ended grant no longer matches.

UPDATE compute_grants SET period_end = now() WHERE period_end > now();

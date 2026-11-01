-- Authorization is identity-based.
--
-- A verified Privy identity is sufficient for the workspace, the full curated
-- model registry, model selection, prompt submission, and streamed inference.
-- No token balance, chain state, or wallet holding is consulted anywhere in the
-- authorization path, and a linked EVM wallet is now optional identity metadata.
--
-- The historical `holder_eligibility` table is retained purely as an audit trail:
--   * `wallet_address` becomes nullable so a walletless Privy identity can still
--     record its access marker instead of failing on a NOT NULL constraint;
--   * the state CHECK constraint is widened so identity-derived markers are valid
--     and legacy ownership states remain readable without ever gating access;
--   * existing rows are left untouched.
--
-- All statements are idempotent so re-running the migration is safe.

ALTER TABLE holder_eligibility ALTER COLUMN wallet_address DROP NOT NULL;

ALTER TABLE holder_eligibility ALTER COLUMN chain_id DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN token_address DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN balance_raw DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN token_decimals DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN threshold_raw DROP NOT NULL;

ALTER TABLE holder_eligibility DROP CONSTRAINT IF EXISTS holder_eligibility_state_check;
ALTER TABLE holder_eligibility ADD CONSTRAINT holder_eligibility_state_check CHECK (
  state IN (
    'eligible',
    'identity_verified',
    'insufficient_balance',
    'wrong_wallet',
    'wrong_network',
    'rpc_failure',
    'token_misconfiguration'
  )
);

COMMENT ON TABLE holder_eligibility IS
  'Access audit trail only. Authorization is identity-based (verified Privy identity), so no row in this table can grant or revoke models, chat, or inference. chain_id/token_address/balance_raw/threshold_raw are NULL for identity-derived rows and retain historical values for pre-removal ownership checks.';

-- Authorization is identity-based (verified Privy identity).
--
-- A linked EVM wallet is optional identity metadata, so `wallet_address` must be
-- nullable for identity-derived audit rows. The state CHECK constraint is widened
-- so identity markers are valid, while legacy ownership states stay readable.
-- Nothing in this table can grant or revoke models, chat, or inference.

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
  'Access audit trail only. Authorization is identity-based (verified Privy identity); no row here grants or revokes models, chat, or inference.';

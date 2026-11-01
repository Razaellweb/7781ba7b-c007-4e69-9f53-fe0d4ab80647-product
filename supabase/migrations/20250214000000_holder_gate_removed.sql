-- Access control is identity-based.
--
-- The server no longer verifies an ERC-20 balance for the configured OPENWEIGHT
-- token on Robinhood Chain. A verified Privy identity is sufficient to grant an
-- application session and workspace/inference authorization.
--
-- This migration keeps the existing holder_eligibility table fully compatible:
--   * historical ownership-verified rows are preserved untouched and remain
--     readable for reporting;
--   * new identity-derived rows store NULL for the chain/token/balance columns,
--     so those columns must stay nullable;
--   * the existing state CHECK constraint still permits 'eligible', so no
--     constraint rewrite is required and no legacy row is invalidated.

ALTER TABLE holder_eligibility ALTER COLUMN chain_id DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN token_address DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN balance_raw DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN token_decimals DROP NOT NULL;
ALTER TABLE holder_eligibility ALTER COLUMN threshold_raw DROP NOT NULL;

COMMENT ON TABLE holder_eligibility IS
  'Access audit trail. Authorization is identity-based (verified Privy identity); chain_id/token_address/balance_raw/threshold_raw are NULL for identity-derived rows and retain historical values for pre-removal ownership checks.';

-- Per-model percentage discount for open-weight models.
--
-- The discount is stored in basis points (1 bp = 0.01%), so every balance-affecting
-- calculation stays integer: a 25.5% discount is 2550 bps and the applied multiplier
-- is (10000 - 2550) / 10000. Negative values are rejected by the CHECK, and the
-- write path clamps anything above 10000 (100%) down to 10000 so a discount can
-- never invert a charge or credit an account.
--
-- open_weight marks the models the discount is allowed to apply to. A model that is
-- not open-weight (or that has no discount at all) keeps its existing standard
-- price because discount_bps defaults to 0 and billing only applies a discount when
-- discount_bps > 0.
--
-- The request-time snapshot (inference_records.discount_bps) is what settlement
-- reads, so an admin editing a model changes new requests only -- never a request
-- that is already in flight or one whose settlement happens after streaming ends.
--
-- Every statement is idempotent so re-running the migration is safe.

ALTER TABLE models ADD COLUMN IF NOT EXISTS open_weight boolean NOT NULL DEFAULT false;
ALTER TABLE models ADD COLUMN IF NOT EXISTS discount_bps integer NOT NULL DEFAULT 0;

ALTER TABLE models DROP CONSTRAINT IF EXISTS models_discount_bps_check;
ALTER TABLE models ADD CONSTRAINT models_discount_bps_check CHECK (discount_bps >= 0 AND discount_bps <= 10000);

-- A discount only exists on an open-weight model. Any non-open-weight row is forced
-- to 0 so its standard price is preserved and cannot be discounted.
ALTER TABLE models DROP CONSTRAINT IF EXISTS models_discount_open_weight_check;
ALTER TABLE models ADD CONSTRAINT models_discount_open_weight_check CHECK (open_weight OR discount_bps = 0);

-- The curated catalogue is entirely open-weight models, so the existing rows adopt
-- the flag. This changes no price: discount_bps stays 0 above.
UPDATE models SET open_weight = true WHERE open_weight = false;

-- Request-time discount snapshot. Settlement reads this value, not the live model
-- row, so an admin change affects new requests only. NULL means "no snapshot was
-- taken" (historical rows) and is treated as no discount.
ALTER TABLE inference_records ADD COLUMN IF NOT EXISTS discount_bps integer;
ALTER TABLE inference_usage_events ADD COLUMN IF NOT EXISTS discount_bps integer;

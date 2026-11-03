import { pricingConfig } from "./config";

// Integer fixed-point pricing (PRD §7, §20). Markup is a micro-multiplier
// (2_000_000 === 2.0x). Never uses floating point for balance-affecting math.
const MICRO = 1_000_000n;

// Discounts are basis points: 1 bp = 0.01%, so 100% is 10_000 bps. Integer basis
// points keep the debit math exact -- a 25.5% discount is 2550 bps and the applied
// multiplier is (10_000 - 2550) / 10_000.
const BPS = 10_000n;
export const MAX_DISCOUNT_BPS = 10_000;

export type PricingPolicy = {
  markupMicro: bigint;
  minChargeMicroUsd: bigint;
  /** Open-weight percentage discount in basis points. Absent/0 means standard price. */
  discountBps?: number;
};

/**
 * Coerces a stored discount into a usable basis-point value.
 * Negative and non-finite input becomes 0 (no discount); anything above 100% is
 * capped at 100% so a discount can never invert a charge or credit an account.
 */
export function normalizeDiscountBps(value?: string | number | bigint | null): number {
  if (value === null || value === undefined) return 0;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const rounded = Math.round(numeric);
  if (rounded <= 0) return 0;
  return Math.min(MAX_DISCOUNT_BPS, rounded);
}

/**
 * Converts an admin-entered percentage (e.g. 12.5) into basis points, rejecting
 * negative values and capping anything above 100% at 100%.
 * Returns null when the input is not a usable number.
 */
export function discountPercentToBps(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 0) return null;
  return Math.round(Math.min(100, numeric) * 100);
}

export function bpsToDiscountPercent(bps?: number | null): number {
  return normalizeDiscountBps(bps) / 100;
}

/**
 * The discount that actually applies to a model right now. Discounts are an
 * open-weight-only feature: any other model resolves to 0 and therefore keeps its
 * existing standard price.
 */
export function modelDiscountBps(model?: { open_weight?: boolean | null; discount_bps?: string | number | bigint | null } | null): number {
  if (!model || model.open_weight !== true) return 0;
  return normalizeDiscountBps(model.discount_bps);
}

export function modelPolicy(model?: {
  markup_micro?: string | number | bigint;
  min_charge_micro_usd?: string | number | bigint;
  open_weight?: boolean | null;
  discount_bps?: string | number | bigint | null;
} | null): PricingPolicy {
  const cfg = pricingConfig();
  const markupMicro = model?.markup_micro != null ? BigInt(model.markup_micro) : cfg.defaultMarkupMicro;
  const minChargeMicroUsd = model?.min_charge_micro_usd != null ? BigInt(model.min_charge_micro_usd) : cfg.defaultMinChargeMicroUsd;
  return { markupMicro, minChargeMicroUsd, discountBps: modelDiscountBps(model) };
}

/**
 * Pins a policy to a specific discount snapshot. Settlement uses this so the price
 * of an in-flight request is never retroactively changed by an admin edit.
 */
export function policyWithDiscount(policy: PricingPolicy, discountBps?: number | null): PricingPolicy {
  return { markupMicro: policy.markupMicro, minChargeMicroUsd: policy.minChargeMicroUsd, discountBps: normalizeDiscountBps(discountBps) };
}

const ceilDiv = (value: bigint, divisor: bigint) => (value % divisor === 0n ? value / divisor : value / divisor + 1n);

// The standard price: ceil(providerCost * markup) with the policy minimum applied.
// Unchanged by this feature, so models without a discount bill exactly as before.
export function computeStandardDebit(providerCostMicroUsd: bigint, policy: PricingPolicy): bigint {
  if (providerCostMicroUsd < 0n) throw new Error("providerCost cannot be negative");
  const debit = ceilDiv(providerCostMicroUsd * policy.markupMicro, MICRO);
  return debit > policy.minChargeMicroUsd ? debit : policy.minChargeMicroUsd;
}

/**
 * userDebit = ceil(standardDebit * (100% - discount)). The policy minimum charge is
 * part of the standard price, so a configured open-weight discount reduces the
 * amount actually debited; with no discount the value is byte-identical to the
 * pre-discount calculation.
 */
export function computeUserDebit(providerCostMicroUsd: bigint, policy: PricingPolicy): bigint {
  const standard = computeStandardDebit(providerCostMicroUsd, policy);
  const discountBps = normalizeDiscountBps(policy.discountBps);
  if (discountBps <= 0) return standard;
  const retained = BigInt(MAX_DISCOUNT_BPS - discountBps);
  return ceilDiv(standard * retained, BPS);
}

export function grossMargin(userDebit: bigint, providerCostMicroUsd: bigint | null): bigint | null {
  if (providerCostMicroUsd == null) return null;
  return userDebit - providerCostMicroUsd;
}

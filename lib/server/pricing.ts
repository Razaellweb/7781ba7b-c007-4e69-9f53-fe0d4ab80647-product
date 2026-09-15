import { pricingConfig } from "./config";

// Integer fixed-point pricing (PRD §7, §20). Markup is a micro-multiplier
// (2_000_000 === 2.0x). Never uses floating point for balance-affecting math.
const MICRO = 1_000_000n;

export type PricingPolicy = { markupMicro: bigint; minChargeMicroUsd: bigint };

export function modelPolicy(model?: { markup_micro?: string | number | bigint; min_charge_micro_usd?: string | number | bigint } | null): PricingPolicy {
  const cfg = pricingConfig();
  const markupMicro = model?.markup_micro != null ? BigInt(model.markup_micro) : cfg.defaultMarkupMicro;
  const minChargeMicroUsd = model?.min_charge_micro_usd != null ? BigInt(model.min_charge_micro_usd) : cfg.defaultMinChargeMicroUsd;
  return { markupMicro, minChargeMicroUsd };
}

// userDebit = ceil(providerCost * markup) with a policy minimum charge applied.
// Rounds UP to the smallest accounting unit (PRD §9.6).
export function computeUserDebit(providerCostMicroUsd: bigint, policy: PricingPolicy): bigint {
  if (providerCostMicroUsd < 0n) throw new Error("providerCost cannot be negative");
  const scaled = providerCostMicroUsd * policy.markupMicro;
  const debit = scaled % MICRO === 0n ? scaled / MICRO : scaled / MICRO + 1n; // ceil
  return debit > policy.minChargeMicroUsd ? debit : policy.minChargeMicroUsd;
}

export function grossMargin(userDebit: bigint, providerCostMicroUsd: bigint | null): bigint | null {
  if (providerCostMicroUsd == null) return null;
  return userDebit - providerCostMicroUsd;
}

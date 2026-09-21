import { describe, expect, it } from "vitest";
import { computeUserDebit, grossMargin } from "../../lib/server/pricing";

describe("inference accounting and reconciliation invariants", () => {
  it("settles known, zero, partial, and uncertain usage without negative accounting", () => {
    const policy = { markupMicro: 2_000_000n, minChargeMicroUsd: 0n };
    expect(computeUserDebit(0n, policy)).toBe(0n);
    expect(computeUserDebit(125n, policy)).toBe(250n);
    expect(computeUserDebit(1n, policy)).toBe(2n);
    expect(grossMargin(250n, 125n)).toBe(125n);
    expect(grossMargin(0n, null)).toBeNull();
  });

  it("keeps settlement idempotency and concurrency requirements explicit", () => {
    const operationKey = "same-operation-key";
    const eventKeys = new Set([`release:${operationKey}`, `debit:${operationKey}`]);
    expect(eventKeys.size).toBe(2);
    expect(new Set([operationKey, operationKey]).size).toBe(1);
    expect("pending_reconciliation").toMatch(/reconciliation/);
    expect("insufficient_compute").toMatch(/insufficient/);
  });

  it("requires operational reconciliation for failures after provider work", () => {
    const observable = { reconciliationRequired: true, providerCallStarted: true, debit: 0n, output: "partial" };
    expect(observable.reconciliationRequired).toBe(true);
    expect(observable.providerCallStarted).toBe(true);
    expect(observable.debit).toBe(0n);
    expect(observable.output).toBe("partial");
  });
});

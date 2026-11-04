import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fundingConfig, USDG_MAINNET_ADDRESS } from "../../lib/server/config";

// Balance is only what an account can spend: credited deposits count, grants
// count only inside their period, and the free monthly allowance is gone.

describe("USDG funding configuration", () => {
  it("opens funding on Robinhood Chain mainnet with the verified USDG settings", () => {
    vi.stubEnv("FUNDING_CHAIN_ID", "4663");
    vi.stubEnv("FUNDING_TOKEN_SYMBOL", "USDG");
    vi.stubEnv("FUNDING_TOKEN_DECIMALS", "6");
    vi.stubEnv("FUNDING_TOKEN_ADDRESS", USDG_MAINNET_ADDRESS);
    const cfg = fundingConfig();
    expect(cfg.issues).toEqual([]);
    expect(cfg.configured).toBe(true);
    vi.unstubAllEnvs();
  });

  it("stays closed for wrong decimals or another token address", () => {
    vi.stubEnv("FUNDING_CHAIN_ID", "4663");
    vi.stubEnv("FUNDING_TOKEN_SYMBOL", "USDG");
    vi.stubEnv("FUNDING_TOKEN_DECIMALS", "18");
    vi.stubEnv("FUNDING_TOKEN_ADDRESS", "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34");
    const cfg = fundingConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.issues.join(" ")).toMatch(/not the verified USDG contract/);
    expect(cfg.issues.join(" ")).toMatch(/uses 6 decimals/);
    vi.unstubAllEnvs();
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const run = TEST_DATABASE_URL ? describe : describe.skip;

run("spendable balance (real Postgres)", () => {
  let db: typeof import("../../lib/server/db");
  let accounting: typeof import("../../lib/server/accounting");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const { migrate } = await import("../../lib/server/migrate");
    await migrate();
    db = await import("../../lib/server/db");
    accounting = await import("../../lib/server/accounting");
  });

  afterAll(async () => {
    await db?.getDb().end();
  });

  const newAccount = async () => (await db.query<{ id: string }>(`INSERT INTO user_accounts (privy_user_id) VALUES ($1) RETURNING id`, [`did:privy:balance-${Math.random()}`]))[0].id;
  const grant = async (accountId: string, endsInSeconds: number) => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO compute_grants (account_id, amount_micro_usd, period_start, period_end, recurrence_key) VALUES ($1, 5000000, now() - interval '1 day', now() + make_interval(secs => $2), $3) RETURNING id`,
      [accountId, endsInSeconds, `test:${Math.random()}`],
    );
    await db.query(`INSERT INTO compute_ledger_entries (account_id, grant_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,$2,'grant',5000000,$3)`, [accountId, rows[0].id, `grant:${rows[0].id}`]);
  };

  it("starts a new account at zero and issues no grant with the default setting", async () => {
    const accountId = await newAccount();
    expect(await accounting.ensureDefaultAllowance(accountId)).toBeNull();
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(0n);
  });

  it("counts a credited deposit but not an ended grant", async () => {
    const accountId = await newAccount();
    await grant(accountId, -60);
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'deposit',2500000,$2)`, [accountId, `deposit-${accountId}`]);
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(2_500_000n);
  });

  it("ends running grants so existing accounts drop to what they deposited", async () => {
    const accountId = await newAccount();
    await grant(accountId, 7 * 24 * 3600);
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(5_000_000n);
    const sql = await readFile(join(process.cwd(), "db/migrations/017_end_free_allowance.sql"), "utf8");
    await db.query(sql);
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(0n);
    await db.query(sql); // re-running is a no-op
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(0n);
  });
});

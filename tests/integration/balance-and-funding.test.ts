import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { fundingConfig, USDG_MAINNET_ADDRESS, USDG_MAINNET_DECIMALS } from "../../lib/server/config";

// Balance is only what an account can spend: credited deposits count, grants
// count only inside their period, and the free monthly allowance is gone.

// Every funding/chain variable the configuration reads. A deployment (or a local
// .env fixture) that carries any of these must not be allowed to leak into a test
// that is supposed to exercise the defaults, so each case starts from "cleared"
// (an empty value is treated as absent by the config helpers) and only the values a
// given case genuinely wants are stubbed afterwards.
const FUNDING_ENV_NAMES = [
  "FUNDING_CHAIN_ID",
  "FUNDING_TOKEN_SYMBOL",
  "FUNDING_TOKEN_DECIMALS",
  "FUNDING_TOKEN_ADDRESS",
  "ROBINHOOD_CHAIN_ID",
  "NEXT_PUBLIC_ROBINHOOD_CHAIN_ID",
] as const;

function clearFundingEnv() {
  for (const name of FUNDING_ENV_NAMES) vi.stubEnv(name, "");
}

describe("USDG funding configuration", () => {
  beforeEach(() => {
    clearFundingEnv();
  });

  afterEach(() => {
    // Restores the real environment that clearFundingEnv()/vi.stubEnv() replaced.
    vi.unstubAllEnvs();
  });

  // INTENTIONAL BEHAVIOUR CHANGE (please review): this configuration used to report
  // configured:false with no funding env at all. It now resolves chain 4663 and the
  // verified USDG entry from USDG_NETWORK_REGISTRY, so funding is open on Robinhood
  // Chain mainnet by default. All six funding/chain variables are explicitly cleared
  // below so a .env fixture value can never accidentally stand in for the default.
  it("resolves the verified mainnet USDG defaults when no funding or chain env is set", () => {
    const cfg = fundingConfig();
    expect(cfg.issues).toEqual([]);
    expect(cfg.configured).toBe(true);
    expect(cfg.chainId).toBe(4663);
    expect(cfg.tokenAddress).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(cfg.tokenAddressLower).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
    expect(cfg.tokenAddressLower).toBe(cfg.tokenAddress.toLowerCase());
    expect(cfg.tokenSymbol).toBe("USDG");
    expect(cfg.tokenDecimals).toBe(6);
    expect(cfg.unconfiguredReason).toBeNull();
  });

  it("opens funding on Robinhood Chain mainnet with the verified USDG settings", () => {
    vi.stubEnv("FUNDING_CHAIN_ID", "4663");
    vi.stubEnv("FUNDING_TOKEN_SYMBOL", "USDG");
    vi.stubEnv("FUNDING_TOKEN_DECIMALS", "6");
    vi.stubEnv("FUNDING_TOKEN_ADDRESS", USDG_MAINNET_ADDRESS);
    const cfg = fundingConfig();
    expect(cfg.issues).toEqual([]);
    expect(cfg.configured).toBe(true);
    expect(cfg.chainId).toBe(4663);
    expect(cfg.tokenAddress).toBe(USDG_MAINNET_ADDRESS);
    expect(cfg.tokenAddressLower).toBe(USDG_MAINNET_ADDRESS.toLowerCase());
    expect(cfg.tokenDecimals).toBe(USDG_MAINNET_DECIMALS);
    expect(cfg.tokenSymbol).toBe("USDG");
  });

  it("resolves the chain in FUNDING_CHAIN_ID, ROBINHOOD_CHAIN_ID, NEXT_PUBLIC_ROBINHOOD_CHAIN_ID order", () => {
    vi.stubEnv("NEXT_PUBLIC_ROBINHOOD_CHAIN_ID", "46630");
    vi.stubEnv("ROBINHOOD_CHAIN_ID", "46630");
    vi.stubEnv("FUNDING_CHAIN_ID", "4663");
    expect(fundingConfig().chainId).toBe(4663);

    clearFundingEnv();
    vi.stubEnv("NEXT_PUBLIC_ROBINHOOD_CHAIN_ID", "46630");
    vi.stubEnv("ROBINHOOD_CHAIN_ID", "4663");
    expect(fundingConfig().chainId).toBe(4663);

    clearFundingEnv();
    vi.stubEnv("NEXT_PUBLIC_ROBINHOOD_CHAIN_ID", "4663");
    expect(fundingConfig().chainId).toBe(4663);
  });

  it("fails closed on a nonnumeric or unknown chain id instead of falling back", () => {
    vi.stubEnv("FUNDING_CHAIN_ID", "robinhood");
    const nonNumeric = fundingConfig();
    expect(nonNumeric.configured).toBe(false);
    expect(nonNumeric.chainId).toBe(0);
    expect(nonNumeric.issues.join(" ")).toMatch(/FUNDING_CHAIN_ID is not a positive integer chain id: robinhood/);

    clearFundingEnv();
    vi.stubEnv("ROBINHOOD_CHAIN_ID", "999");
    const unknown = fundingConfig();
    expect(unknown.configured).toBe(false);
    expect(unknown.issues.join(" ")).toMatch(/ROBINHOOD_CHAIN_ID 999 is not a supported USDG funding network/);
  });

  it("keeps funding closed for the unverified testnet chain", () => {
    vi.stubEnv("FUNDING_CHAIN_ID", "46630");
    const cfg = fundingConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.chainId).toBe(46630);
    expect(cfg.tokenAddress).toBe("");
    expect(cfg.tokenDecimals).toBe(0);
    expect(cfg.issues.join(" ")).toMatch(/USDG is not verified for Robinhood Chain Testnet \(chain id 46630\)/);
  });

  it("never uses an unverified registry address as a fallback", () => {
    vi.stubEnv("FUNDING_CHAIN_ID", "46630");
    const cfg = fundingConfig({
      networkRegistry: {
        46630: {
          chainId: 46630,
          chainName: "Robinhood Chain Testnet",
          tokenAddress: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
          tokenDecimals: 18,
          verified: false,
          verificationSource: null,
          pendingVerificationAddress: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
          confirmations: 3,
        },
      },
    });
    expect(cfg.configured).toBe(false);
    expect(cfg.tokenAddress).toBe("");
    expect(cfg.tokenDecimals).toBe(0);
    expect(cfg.issues.join(" ")).toMatch(/USDG is not verified for Robinhood Chain Testnet/);
  });

  it("rejects a non-checksummed or mismatched explicit address", () => {
    vi.stubEnv("FUNDING_TOKEN_ADDRESS", USDG_MAINNET_ADDRESS.toLowerCase());
    const lower = fundingConfig();
    expect(lower.configured).toBe(false);
    expect(lower.issues.join(" ")).toMatch(/is not EIP-55 checksummed/);

    clearFundingEnv();
    vi.stubEnv("FUNDING_TOKEN_ADDRESS", "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34");
    const other = fundingConfig();
    expect(other.configured).toBe(false);
    expect(other.issues.join(" ")).toMatch(/is not the verified USDG contract/);
  });

  it("rejects a checksummed address that differs from the registry entry", () => {
    // Same network, valid EIP-55 checksum, but not the USDG contract USDG_NETWORK_REGISTRY
    // carries for chain 4663: the override must lose to the verified entry.
    vi.stubEnv("FUNDING_CHAIN_ID", "4663");
    vi.stubEnv("FUNDING_TOKEN_ADDRESS", "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34");
    const cfg = fundingConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.issues.join(" ")).toMatch(
      /FUNDING_TOKEN_ADDRESS 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34 is not the verified USDG contract 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 on Robinhood Chain Mainnet \(chain id 4663\)/,
    );
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
  });

  it("rejects out-of-range decimals and non-USDG symbols", () => {
    vi.stubEnv("FUNDING_TOKEN_DECIMALS", "37");
    const decimals = fundingConfig();
    expect(decimals.configured).toBe(false);
    expect(decimals.issues.join(" ")).toMatch(/FUNDING_TOKEN_DECIMALS is not an integer between 0 and 36: 37/);

    clearFundingEnv();
    vi.stubEnv("FUNDING_TOKEN_DECIMALS", "-1");
    const negative = fundingConfig();
    expect(negative.configured).toBe(false);
    expect(negative.issues.join(" ")).toMatch(/FUNDING_TOKEN_DECIMALS is not an integer between 0 and 36: -1/);

    clearFundingEnv();
    vi.stubEnv("FUNDING_TOKEN_DECIMALS", "6.5");
    const fractional = fundingConfig();
    expect(fractional.configured).toBe(false);
    expect(fractional.issues.join(" ")).toMatch(/FUNDING_TOKEN_DECIMALS is not an integer between 0 and 36: 6.5/);

    clearFundingEnv();
    vi.stubEnv("FUNDING_TOKEN_SYMBOL", "USDC");
    const symbol = fundingConfig();
    expect(symbol.configured).toBe(false);
    expect(symbol.issues.join(" ")).toMatch(/FUNDING_TOKEN_SYMBOL is USDC; deposits are credited in USDG only/);
  });

  it("fails closed when the default chain is missing from the registry", () => {
    const cfg = fundingConfig({
      networkRegistry: {
        46630: {
          chainId: 46630,
          chainName: "Robinhood Chain Testnet",
          tokenAddress: null,
          tokenDecimals: null,
          verified: false,
          verificationSource: null,
          pendingVerificationAddress: null,
          confirmations: 3,
        },
      },
    });
    expect(cfg.configured).toBe(false);
    expect(cfg.chainId).toBe(0);
    expect(cfg.tokenAddress).toBe("");
    expect(cfg.issues.join(" ")).toMatch(/the default chain 4663 is not a supported USDG funding network/);
  });

  it("resolves the defaults from a supplied registry that carries the verified 4663 entry", () => {
    // The registry used by the deposit-monitoring suite is mocked with exactly this
    // shape; the mock must keep the verified 4663 USDG entry so funding stays open.
    const cfg = fundingConfig({
      networkRegistry: {
        4663: {
          chainId: 4663,
          chainName: "Robinhood Chain Mainnet",
          tokenAddress: USDG_MAINNET_ADDRESS,
          tokenDecimals: USDG_MAINNET_DECIMALS,
          verified: true,
          verificationSource: "test",
          pendingVerificationAddress: null,
          confirmations: 3,
        },
      },
    });
    expect(cfg.configured).toBe(true);
    expect(cfg.chainId).toBe(4663);
    expect(cfg.tokenAddress).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(cfg.tokenAddressLower).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
    expect(cfg.tokenSymbol).toBe("USDG");
    expect(cfg.tokenDecimals).toBe(6);
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

  // Settlement used to lock "reservations LEFT JOIN inference_records ... FOR
  // UPDATE", which Postgres rejects (0A000), so every chat failed at the end and
  // its reservation was never released. Mocks could not see it; real SQL does.
  it("settles a reservation: debits the usage and releases the rest", async () => {
    const accountId = await newAccount();
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'deposit',1000000,$2)`, [accountId, `deposit-${accountId}`]);
    const op = `settle-${Math.random()}`;
    await accounting.reserveCompute(accountId, op, 500_000n, { channel: "app" });
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(500_000n);
    await accounting.settleReservation(op, 1_200n, 600n, false, { eventType: "provider_usage", markupMicro: 0n });
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(998_800n);
  });

  // The inference reservation cap is a ceiling, not a minimum: an account with a
  // positive balance below the cap must still be able to run a request, and the
  // hold must be exactly what it can cover. An exhausted balance is still rejected
  // rather than becoming a zero-value reservation that skips the balance check.
  it("holds the smaller of the cap and the available balance, and rejects an empty balance", async () => {
    const cap = 500_000n;

    const small = await newAccount();
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'deposit',3000,$2)`, [small, `deposit-${small}`]);
    const tinyHold = await accounting.reserveCompute(small, `clamp-${Math.random()}`, cap, { channel: "app" });
    expect(BigInt(tinyHold.reserved_micro_usd)).toBe(3_000n);
    expect(await accounting.availableComputeMicroUsd(small)).toBe(0n);

    const rich = await newAccount();
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'deposit',2000000,$2)`, [rich, `deposit-${rich}`]);
    const fullHold = await accounting.reserveCompute(rich, `cap-${Math.random()}`, cap, { channel: "app" });
    expect(BigInt(fullHold.reserved_micro_usd)).toBe(cap);
    expect(await accounting.availableComputeMicroUsd(rich)).toBe(2_000_000n - cap);

    const empty = await newAccount();
    await expect(accounting.reserveCompute(empty, `empty-${Math.random()}`, cap, { channel: "app" })).rejects.toMatchObject({ code: "INSUFFICIENT_COMPUTE" });
  });

  // Prepaid GPU blocks stay all-or-nothing: a block is either fully covered or the
  // machine must not run, so the gpu channel requires the whole estimate.
  it("requires the full estimate for prepaid GPU blocks", async () => {
    const accountId = await newAccount();
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'deposit',100000,$2)`, [accountId, `deposit-${accountId}`]);
    await expect(accounting.reserveCompute(accountId, `gpu-${Math.random()}`, 460_000n, { channel: "gpu" })).rejects.toMatchObject({ code: "INSUFFICIENT_COMPUTE" });
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(100_000n);
  });

  // The chat routes save the assistant reply with this exact conflict target. It
  // must restate the partial index's full predicate (inference_id IS NOT NULL AND
  // role='assistant'), or Postgres rejects it (42P10) and every reply is lost.
  it("saves one assistant reply per inference with the routes' conflict target", async () => {
    const accountId = await newAccount();
    const [conv] = await db.query<{ id: string }>(`INSERT INTO conversations (account_id, title) VALUES ($1,'t') RETURNING id`, [accountId]);
    const [inf] = await db.query<{ id: string }>(`INSERT INTO inference_records (account_id, operation_key, provider, model, provider_model, conversation_id, status, markup_micro, metadata) VALUES ($1,$2,'openrouter','m','m',$3,'started',0,'{}') RETURNING id`, [accountId, `op-${Math.random()}`, conv.id]);
    for (const route of ["app/api/chat/route.ts", "app/api/v1/chat/completions/route.ts"]) {
      const source = await readFile(join(process.cwd(), route), "utf8");
      const target = source.match(/ON CONFLICT \(inference_id\) WHERE [^`]*?DO NOTHING/)?.[0];
      expect(target, route).toBeTruthy();
      for (let i = 0; i < 2; i++) {
        await db.query(`INSERT INTO messages (inference_id,conversation_id,account_id,role,content,partial) VALUES ($1,$2,$3,'assistant','hi',false) ${target}`, [inf.id, conv.id, accountId]);
      }
    }
    const rows = await db.query(`SELECT id FROM messages WHERE inference_id=$1`, [inf.id]);
    expect(rows).toHaveLength(1);
  });

  it("releases the whole reservation when the provider call fails", async () => {
    const accountId = await newAccount();
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'deposit',1000000,$2)`, [accountId, `deposit-${accountId}`]);
    const op = `fail-${Math.random()}`;
    await accounting.reserveCompute(accountId, op, 500_000n, { channel: "app" });
    await accounting.settleReservation(op, 0n, null, false, { eventType: "provider_failure", markupMicro: 0n });
    expect(await accounting.availableComputeMicroUsd(accountId)).toBe(1_000_000n);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests lock the Alchemy deposit-monitoring contract:
//   * an address is only `watched` when Alchemy accepted the registration, and a
//     failed registration is retried with backoff instead of being forgotten;
//   * EVERY server-side wallet is registered without the user opening the Fund
//     dialog (the population-wide backfill), and a configuration-gated miss does not
//     consume a registration attempt;
//   * a webhook must carry a valid HMAC signature or nothing happens;
//   * wrong-chain / wrong-token / unknown-recipient / zero-value transfers never
//     credit;
//   * a transfer is credited only at the configured confirmation depth, and only
//     once no matter how many times or how concurrently it is delivered;
//   * the polling fallback applies the same rules; and
//   * a credited deposit that is reorged out is flagged.
//
// The database and RPC layers are mocked; nothing here talks to a live service.

const TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TOKEN_LOWER = TOKEN.toLowerCase();
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "ab".repeat(32);
const SIGNING_KEY = "test-signing-key";

// ---------------------------------------------------------------- db mock

type Row = Record<string, unknown>;

const state = {
  wallets: [] as Row[],
  deposits: [] as Row[],
  ledger: [] as Row[],
  events: [] as Row[],
};

function resetState() {
  state.wallets = [];
  state.deposits = [];
  state.ledger = [];
  state.events = [];
}

// A very small SQL interpreter: just enough to make the funding module's actual
// statements behave like Postgres for these cases (unique wallet/deposit rows,
// idempotent ledger insert, status transitions).
async function fakeQuery(text: string, values: unknown[] = []): Promise<Row[]> {
  const sql = text.replace(/\s+/g, " ").trim();

  if (sql.startsWith("SELECT * FROM funding_wallets WHERE account_id")) {
    return state.wallets.filter((row) => row.account_id === values[0]);
  }
  if (sql.startsWith("SELECT * FROM funding_wallets WHERE address")) {
    return state.wallets.filter((row) => row.address === values[0]);
  }
  if (sql.startsWith("SELECT * FROM funding_wallets WHERE id")) {
    return state.wallets.filter((row) => row.id === values[0]);
  }
  // retryPendingWatches: honours the attempt cap ($1) and the batch limit ($2).
  if (sql.startsWith("SELECT * FROM funding_wallets WHERE watch_status <> 'watched' AND watch_next_attempt_at")) {
    return state.wallets
      .filter((row) => row.watch_status !== "watched")
      .filter((row) => Number(row.watch_attempts) < Number(values[0]))
      .filter((row) => new Date(row.watch_next_attempt_at as Date).getTime() <= Date.now())
      .slice(0, Number(values[1]));
  }
  // registerUnwatchedWallets: the population pass ignores backoff and the cap.
  if (sql.startsWith("SELECT * FROM funding_wallets WHERE watch_status <> 'watched' ORDER BY")) {
    return state.wallets.filter((row) => row.watch_status !== "watched").slice(0, Number(values[0]));
  }
  if (sql.startsWith("INSERT INTO funding_wallets")) {
    if (state.wallets.some((row) => row.account_id === values[0])) return [];
    const row: Row = {
      id: `wallet-${state.wallets.length + 1}`,
      account_id: values[0],
      privy_wallet_id: values[1],
      address: values[2],
      chain_id: values[3],
      token_address: values[4],
      token_symbol: values[5],
      token_decimals: values[6],
      watch_status: "unwatched",
      watch_webhook_id: null,
      watch_registered_at: null,
      watch_attempts: 0,
      watch_last_error: null,
      watch_next_attempt_at: new Date(),
      last_scanned_block: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    state.wallets.push(row);
    return [row];
  }
  if (sql.startsWith("UPDATE funding_wallets")) {
    const wallet = state.wallets.find((row) => row.id === values[0]);
    if (!wallet) return [];
    if (sql.includes("watch_status='watched'")) {
      wallet.watch_status = "watched";
      wallet.watch_webhook_id = values[1] ?? null;
      wallet.watch_registered_at = new Date();
      wallet.watch_attempts = Number(wallet.watch_attempts) + 1;
      wallet.watch_last_error = null;
      wallet.watch_next_attempt_at = new Date();
    } else if (sql.includes("watch_status='failed'") && sql.includes("watch_attempts=$2")) {
      // A real provider failure consumes an attempt and backs off.
      wallet.watch_status = "failed";
      wallet.watch_attempts = values[1];
      wallet.watch_last_error = values[2];
      wallet.watch_next_attempt_at = new Date(Date.now() + Number(values[3]) * 1000);
    } else if (sql.includes("watch_status='failed'")) {
      // A configuration-gated miss is recorded verbatim and stays immediately
      // retryable: no attempt is consumed and no backoff is applied.
      wallet.watch_status = "failed";
      wallet.watch_last_error = values[1];
      wallet.watch_next_attempt_at = new Date();
    } else if (sql.includes("last_scanned_block")) {
      wallet.last_scanned_block = values[1];
    }
    return [];
  }

  if (sql.startsWith("INSERT INTO funding_deposits")) {
    const existing = state.deposits.find(
      (row) => row.chain_id === values[2] && row.tx_hash === values[4] && row.log_index === values[5],
    );
    if (existing) {
      existing.last_checked_at = new Date();
      existing.last_error = null;
      // Mirrors REOPEN_REJECTED in recordActivity's ON CONFLICT clause.
      if (existing.status === "rejected" && values[10] === "pending" && !existing.credited_at && !existing.reorged_at
          && existing.rejection_reason !== "transaction_reverted") {
        existing.status = "pending";
        existing.rejection_reason = null;
        existing.amount_micro_usd = String(values[9]);
      }
      return [existing];
    }
    const row: Row = {
      id: `deposit-${state.deposits.length + 1}`,
      account_id: values[0],
      funding_wallet_id: values[1],
      chain_id: values[2],
      token_address: values[3],
      tx_hash: values[4],
      log_index: values[5],
      from_address: values[6],
      to_address: values[7],
      amount_raw: String(values[8]),
      amount_micro_usd: String(values[9]),
      status: values[10],
      rejection_reason: values[11],
      idempotency_key: values[12],
      confirmations: 0,
      ledger_entry_id: null,
      attempts: 0,
      last_error: null,
      first_seen_at: new Date(),
      last_checked_at: new Date(),
      confirmed_at: null,
      credited_at: null,
      block_number: null,
      block_hash: null,
      reorged_at: null,
      reorg_reason: null,
      credit_reversed: false,
    };
    state.deposits.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT * FROM funding_deposits WHERE id")) {
    // `FOR UPDATE` does not change the row set; the lock is what serializes workers.
    return state.deposits.filter((row) => row.id === values[0]);
  }
  if (sql.startsWith("SELECT * FROM funding_deposits WHERE account_id")) {
    return state.deposits.filter((row) => row.account_id === values[0]);
  }
  if (sql.startsWith("UPDATE funding_deposits")) {
    const deposit = state.deposits.find((row) => row.id === values[0]);
    if (!deposit) return [];
    if (sql.includes("status='confirmed'") && sql.includes("ledger_entry_id")) {
      deposit.status = "confirmed";
      deposit.ledger_entry_id = values[1];
      deposit.confirmed_at = new Date();
      deposit.credited_at = new Date();
    } else if (sql.includes("status='rejected'")) {
      deposit.status = "rejected";
      deposit.rejection_reason = sql.includes("transaction_reverted") ? "transaction_reverted" : deposit.rejection_reason;
      deposit.amount_micro_usd = "0";
    } else if (sql.includes("reorged_at=COALESCE")) {
      deposit.reorged_at = new Date();
      deposit.reorg_reason = values[1];
    } else if (sql.includes("confirmations=$2")) {
      deposit.confirmations = values[1];
      deposit.block_number = values[2] ?? deposit.block_number;
      deposit.block_hash = values[3] ?? deposit.block_hash;
    }
    return [];
  }

  if (sql.startsWith("INSERT INTO compute_ledger_entries")) {
    const key = values[2];
    if (state.ledger.some((row) => row.idempotency_key === key)) return [];
    const row: Row = { id: `ledger-${state.ledger.length + 1}`, account_id: values[0], amount_micro_usd: values[1], idempotency_key: key };
    state.ledger.push(row);
    return [{ id: row.id }];
  }
  if (sql.startsWith("SELECT id FROM compute_ledger_entries WHERE idempotency_key")) {
    return state.ledger.filter((row) => row.idempotency_key === values[0]).map((row) => ({ id: row.id }));
  }
  if (sql.startsWith("SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type")) {
    const total = state.ledger
      .filter((row) => row.account_id === values[0])
      .reduce((sum, row) => sum + Number(row.amount_micro_usd), 0);
    return [{ available: String(total) }];
  }

  if (sql.startsWith("INSERT INTO alchemy_webhook_events")) return [{ id: `event-${state.events.length + 1}` }];
  if (sql.startsWith("UPDATE alchemy_webhook_events")) return [];
  return [];
}

vi.mock("../../lib/server/db", () => ({
  query: async (text: string, values: unknown[] = []) => fakeQuery(text, values),
  // pg's PoolClient.query resolves to a QueryResult with a `rows` property.
  transaction: async (work: (client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> }) => Promise<unknown>) =>
    work({ query: async (text: string, values: unknown[] = []) => ({ rows: await fakeQuery(text, values) }) }),
}));

vi.mock("@privy-io/server-auth", () => ({
  PrivyClient: class {
    walletApi = {
      createWallet: async () => ({ id: `privy-${WALLET}`, address: WALLET }),
    };
  },
}));

const receipt: { current: { blockNumber: number; blockHash: string; status: string } | null } = { current: null };
const head: { current: bigint } = { current: 0n };
const logs: { current: Array<{ txHash: string; logIndex: number; tokenAddress: string; fromAddress: string | null; toAddress: string | null; rawAmount: string | null; blockNumber: number }> } = { current: [] };

vi.mock("../../lib/server/alchemy", async () => {
  const actual = await vi.importActual<typeof import("../../lib/server/alchemy")>("../../lib/server/alchemy");
  return {
    ...actual,
    getTransactionReceiptInfo: async () => receipt.current,
    getBlockNumber: async () => head.current,
    getLogScanHead: async () => head.current,
    fetchIncomingTokenLogs: async () => logs.current,
  };
});

// ---------------------------------------------------------------- setup

const ENV = {
  PRIVY_APP_ID: "test-app-id",
  PRIVY_APP_SECRET: "test-app-secret",
  FUNDING_CHAIN_ID: "4663",
  FUNDING_TOKEN_SYMBOL: "USDG",
  FUNDING_TOKEN_DECIMALS: "6",
  FUNDING_TOKEN_ADDRESS: TOKEN,
  FUNDING_CONFIRMATIONS: "3",
  ALCHEMY_API_KEY: "test-key",
  ALCHEMY_NETWORK: "robinhood-mainnet",
  ALCHEMY_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
  ALCHEMY_NOTIFY_AUTH_TOKEN: "notify-token",
  ALCHEMY_WEBHOOK_ID: "wh_test",
};

// The registry the funding module is evaluated against in this file. It mirrors the
// shipped USDG_NETWORK_REGISTRY's verified Robinhood Chain mainnet (4663) entry, so
// the default-config path (no chain env) resolves to mainnet USDG exactly as it does
// in production; supplying it here keeps the suite independent of future registry edits.
const verifiedRegistry = {
  4663: {
    chainId: 4663,
    chainName: "Robinhood Chain Mainnet",
    tokenAddress: TOKEN,
    tokenDecimals: 6,
    verified: true,
    verificationSource: "test",
    pendingVerificationAddress: null,
    confirmations: 3,
  },
};

vi.mock("../../lib/server/config", async () => {
  const actual = await vi.importActual<typeof import("../../lib/server/config")>("../../lib/server/config");
  return {
    ...actual,
    // Proxy fundingConfig so every call is evaluated against a verified registry.
    fundingConfig: (options: unknown = {}) =>
      actual.fundingConfig({ ...(options as object), networkRegistry: verifiedRegistry } as never),
  };
});

beforeEach(() => {
  resetState();
  receipt.current = null;
  head.current = 0n;
  logs.current = [];
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- tests

describe("Alchemy deposit monitoring", () => {
  it("rejects a webhook with a missing or invalid signature without touching state", async () => {
    const { verifyAlchemySignature } = await import("../../lib/server/alchemy");
    const body = JSON.stringify({ id: "evt_1", type: "ADDRESS_ACTIVITY", event: { network: "ROBINHOOD_MAINNET", activity: [] } });

    expect(verifyAlchemySignature(body, null)).toBe(false);
    expect(verifyAlchemySignature(body, "deadbeef")).toBe(false);
    expect(verifyAlchemySignature(body, "not-hex")).toBe(false);
    expect(state.events).toHaveLength(0);
  });

  it("accepts a signature computed over the exact raw body", async () => {
    const { verifyAlchemySignature, signAlchemyBody } = await import("../../lib/server/alchemy");
    const body = JSON.stringify({ id: "evt_2", type: "ADDRESS_ACTIVITY" });
    const signature = signAlchemyBody(body, SIGNING_KEY);

    expect(verifyAlchemySignature(body, signature)).toBe(true);
    // A body mutated after signing must not verify.
    expect(verifyAlchemySignature(body + " ", signature)).toBe(false);
  });

  it("parses address-activity token transfers including the log index", async () => {
    const { parseAddressActivity } = await import("../../lib/server/alchemy");
    const parsed = parseAddressActivity({
      event: {
        network: "ROBINHOOD_MAINNET",
        activity: [{
          fromAddress: "0xabc",
          toAddress: WALLET,
          hash: TX,
          logIndex: "0x2",
          category: "erc20",
          rawContract: { address: TOKEN, rawValue: "0x1e8480", decimal: "0x6" },
        }],
      },
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0].txHash).toBe(TX);
    expect(parsed[0].logIndex).toBe(2);
    expect(parsed[0].toAddress).toBe(WALLET);
    expect(parsed[0].tokenAddress).toBe(TOKEN_LOWER);
    expect(parsed[0].rawAmount).toBe("2000000");
  });

  it("marks a wallet watched only when Alchemy accepted the registration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    const { getOrCreateFundingWallet } = await import("../../lib/server/funding");

    const result = await getOrCreateFundingWallet("account-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/update-webhook-addresses");
    expect(result.monitored).toBe(true);
    expect(result.wallet.watch_status).toBe("watched");
  });

  it("registers a newly provisioned wallet immediately, without a later user step", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    const { getOrCreateFundingWallet } = await import("../../lib/server/funding");

    const result = await getOrCreateFundingWallet("account-new");

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { addresses_to_add: string[] };
    expect(body.addresses_to_add).toEqual([WALLET]);
    expect(result.created).toBe(true);
    expect(result.monitored).toBe(true);
    expect(result.wallet.watch_registered_at).not.toBeNull();
  });

  it("records a failed registration with backoff instead of claiming it is watched", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 500 }));
    const { getOrCreateFundingWallet } = await import("../../lib/server/funding");

    const result = await getOrCreateFundingWallet("account-2");

    expect(result.monitored).toBe(false);
    expect(result.wallet.watch_status).toBe("failed");
    expect(result.wallet.watch_attempts).toBe(1);
    expect(String(result.wallet.watch_last_error)).toContain("500");
    expect(new Date(result.wallet.watch_next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("retries a failed registration and promotes it to watched on success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
    const { getOrCreateFundingWallet, retryPendingWatches } = await import("../../lib/server/funding");

    const failed = await getOrCreateFundingWallet("account-3");
    expect(failed.wallet.watch_status).toBe("failed");

    // Alchemy recovers, and the backoff window is over.
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    const wallet = state.wallets.find((row) => row.account_id === "account-3");
    if (wallet) wallet.watch_next_attempt_at = new Date(Date.now() - 1000);

    const retried = await retryPendingWatches(10);

    expect(retried.watched).toBeGreaterThanOrEqual(1);
    expect(state.wallets.find((row) => row.account_id === "account-3")?.watch_status).toBe("watched");
  });

  describe("watch-list lifecycle (no user action required)", () => {
    const seedLegacyWallet = (overrides: Partial<Row> = {}) => {
      // Mirrors a row written BEFORE watch tracking existed: `unwatched`, no
      // attempts, no webhook id.
      const row: Row = {
        id: "wallet-legacy",
        account_id: "account-legacy",
        privy_wallet_id: "privy-legacy",
        address: OTHER_WALLET,
        chain_id: 4663,
        token_address: TOKEN_LOWER,
        token_symbol: "USDG",
        token_decimals: 6,
        watch_status: "unwatched",
        watch_webhook_id: null,
        watch_registered_at: null,
        watch_attempts: 0,
        watch_last_error: null,
        watch_next_attempt_at: new Date(),
        last_scanned_block: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
      };
      state.wallets.push(row);
      return row;
    };

    it("adds pre-existing server-side wallets to the watch list in one batched call", async () => {
      seedLegacyWallet();
      seedLegacyWallet({ id: "wallet-legacy-2", account_id: "account-legacy-2", address: WALLET });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
      const { registerUnwatchedWallets } = await import("../../lib/server/funding");

      const sweep = await registerUnwatchedWallets(50);

      // One Notify call for the whole population, not one per address.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { addresses_to_add: string[] };
      expect(body.addresses_to_add.sort()).toEqual([WALLET, OTHER_WALLET].sort());
      expect(sweep.attempted).toBe(2);
      expect(sweep.watched).toBe(2);
      expect(sweep.batches).toBe(1);
      expect(state.wallets.every((row) => row.watch_status === "watched")).toBe(true);
      expect(state.wallets.every((row) => row.watch_webhook_id === "wh_test")).toBe(true);
    });

    it("retries a wallet whose backoff has not elapsed and whose attempts were exhausted", async () => {
      // Exhausted while Alchemy was unconfigured: the pass must still pick it up.
      seedLegacyWallet({ watch_status: "failed", watch_attempts: 99, watch_next_attempt_at: new Date(Date.now() + 3_600_000) });
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
      const { registerUnwatchedWallets } = await import("../../lib/server/funding");

      const sweep = await registerUnwatchedWallets(50);

      expect(sweep.watched).toBe(1);
      expect(state.wallets[0].watch_status).toBe("watched");
    });

    it("does not mark a wallet watched when the Alchemy webhook is not configured", async () => {
      vi.stubEnv("ALCHEMY_WEBHOOK_ID", "");
      vi.stubEnv("ALCHEMY_WEBHOOK_URL", "");
      seedLegacyWallet();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
      const { registerUnwatchedWallets } = await import("../../lib/server/funding");

      const sweep = await registerUnwatchedWallets(50);

      // No HTTP call is attempted against an unconfigured deployment...
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sweep.watched).toBe(0);
      expect(sweep.reason).toBe("alchemy_notify_unconfigured");
      // ...and the address is truthfully recorded as NOT watched.
      expect(state.wallets[0].watch_status).toBe("failed");
      expect(state.wallets[0].watch_last_error).toBe("alchemy_notify_unconfigured");
      // A configuration miss consumes no attempt and stays immediately retryable.
      expect(state.wallets[0].watch_attempts).toBe(0);
      expect(new Date(state.wallets[0].watch_next_attempt_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("keeps a wallet unwatched when Alchemy has no usable RPC endpoint", async () => {
      vi.stubEnv("ALCHEMY_API_KEY", "");
      vi.stubEnv("ALCHEMY_RPC_URL", "");
      seedLegacyWallet();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
      const { registerUnwatchedWallets } = await import("../../lib/server/funding");

      const sweep = await registerUnwatchedWallets(50);

      expect(fetchMock).not.toHaveBeenCalled();
      // A bare ALCHEMY_NETWORK cannot build an endpoint on its own, so the config
      // reports the generic unconfigured reason.
      expect(sweep.reason).toBe("alchemy_not_configured");
      expect(state.wallets[0].watch_status).toBe("failed");
      expect(state.wallets[0].watch_last_error).toBe("alchemy_not_configured");
    });

    it("becomes watched on the first pass after the missing configuration is supplied", async () => {
      vi.stubEnv("ALCHEMY_NOTIFY_AUTH_TOKEN", "");
      seedLegacyWallet();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
      const { registerUnwatchedWallets } = await import("../../lib/server/funding");

      await registerUnwatchedWallets(50);
      expect(state.wallets[0].watch_status).toBe("failed");

      vi.stubEnv("ALCHEMY_NOTIFY_AUTH_TOKEN", "notify-token");
      const second = await registerUnwatchedWallets(50);

      expect(second.watched).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(state.wallets[0].watch_status).toBe("watched");
      expect(state.wallets[0].watch_last_error).toBeNull();
    });

    it("is safe to repeat", async () => {
      seedLegacyWallet();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
      const { registerUnwatchedWallets } = await import("../../lib/server/funding");

      await registerUnwatchedWallets(50);
      await registerUnwatchedWallets(50);
      await registerUnwatchedWallets(50);

      // Already-watched addresses are never resubmitted.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(state.wallets).toHaveLength(1);
      expect(state.wallets[0].watch_status).toBe("watched");
    });
  });

  describe("with a watched address", () => {
    const seedWatchedWallet = (overrides: Partial<Row> = {}) => {
      const row: Row = {
        id: "wallet-test",
        account_id: "account-test",
        privy_wallet_id: "privy-test",
        address: WALLET,
        chain_id: 4663,
        token_address: TOKEN_LOWER,
        token_symbol: "USDG",
        token_decimals: 6,
        watch_status: "watched",
        watch_webhook_id: "wh_test",
        watch_registered_at: new Date(),
        watch_attempts: 1,
        watch_last_error: null,
        watch_next_attempt_at: new Date(),
        last_scanned_block: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
      };
      state.wallets.push(row);
      return row as unknown as import("../../lib/server/funding").FundingWalletRow;
    };

    it("does not credit a transfer to an address that was never watched", async () => {
      seedWatchedWallet({ watch_status: "failed" });
      const { ingestActivities } = await import("../../lib/server/funding");

      const result = await ingestActivities([{ fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "2000000", tokenDecimals: 6 }]);

      expect(result.recorded).toBe(0);
      expect(result.credited).toBe(0);
      expect(state.deposits).toHaveLength(0);
    });

    it("rejects wrong-token, wrong-chain, unknown-recipient, and zero-value transfers", async () => {
      const wallet = seedWatchedWallet();
      const { validateTransfer } = await import("../../lib/server/funding");
      const { fundingConfig } = await import("../../lib/server/config");
      const cfg = fundingConfig();
      const base = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "2000000", tokenDecimals: 6 };

      expect(validateTransfer(cfg, wallet, base).rejection).toBeNull();
      // Alchemy's own webhook label for the configured network is the same chain.
      expect(validateTransfer(cfg, wallet, { ...base, network: "ROBINHOOD_MAINNET" }).rejection).toBeNull();
      expect(validateTransfer(cfg, wallet, { ...base, tokenAddress: OTHER_WALLET }).rejection).toBe("wrong_token");
      expect(validateTransfer(cfg, wallet, { ...base, tokenAddress: null }).rejection).toBe("not_the_configured_token");
      expect(validateTransfer(cfg, wallet, { ...base, network: "ETH_MAINNET" }).rejection).toBe("wrong_chain");
      expect(validateTransfer(cfg, wallet, { ...base, toAddress: OTHER_WALLET }).rejection).toBe("unknown_recipient");
      expect(validateTransfer(cfg, wallet, { ...base, rawAmount: "0" }).rejection).toBe("zero_value");
      expect(validateTransfer(cfg, wallet, { ...base, rawAmount: null }).rejection).toBe("malformed_amount");
      expect(validateTransfer(cfg, wallet, { ...base, rawAmount: "not-a-number" }).rejection).toBe("malformed_amount");
    });

    it("keeps a deposit pending until the confirmation threshold is reached", async () => {
      seedWatchedWallet();
      const { ingestActivities, processDeposit } = await import("../../lib/server/funding");
      const activity = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "2000000", tokenDecimals: 6 };

      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 100n; // 1 confirmation
      await ingestActivities([activity]);
      expect(state.deposits[0].status).toBe("pending");
      expect(state.ledger).toHaveLength(0);

      head.current = 101n; // 2 confirmations
      await processDeposit(String(state.deposits[0].id));
      expect(state.deposits[0].status).toBe("pending");
      expect(state.ledger).toHaveLength(0);

      head.current = 102n; // 3 confirmations -> credit
      const done = await processDeposit(String(state.deposits[0].id));
      expect(done.credited).toBe(true);
      expect(state.deposits[0].status).toBe("confirmed");
      expect(state.ledger).toHaveLength(1);
      expect(state.ledger[0].amount_micro_usd).toBe("2000000");
    });

    it("re-opens a transfer an earlier rule wrongly rejected once it validates, and credits it once", async () => {
      const wallet = seedWatchedWallet();
      // What the deployed code left behind: Alchemy's "ROBINHOOD_MAINNET" label
      // was compared literally with "robinhood-mainnet" and refused.
      state.deposits.push({
        id: "deposit-old", account_id: wallet.account_id, funding_wallet_id: wallet.id, chain_id: 4663, token_address: TOKEN_LOWER,
        tx_hash: TX, log_index: 0, from_address: "0xabc", to_address: WALLET, amount_raw: "1000000", amount_micro_usd: "0",
        status: "rejected", rejection_reason: "wrong_chain", idempotency_key: `4663:${TX}:0`, confirmations: 0, ledger_entry_id: null,
        attempts: 0, last_error: null, first_seen_at: new Date(), last_checked_at: new Date(), confirmed_at: null, credited_at: null,
        block_number: null, block_hash: null, reorged_at: null, reorg_reason: null, credit_reversed: false,
      });
      const { ingestActivities } = await import("../../lib/server/funding");
      const activity = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "ROBINHOOD_MAINNET", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "1000000", tokenDecimals: 6 };
      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 105n;

      const first = await ingestActivities([activity]);
      await ingestActivities([activity]);

      expect(first.credited).toBe(1);
      expect(state.deposits).toHaveLength(1);
      expect(state.deposits[0].status).toBe("confirmed");
      expect(state.deposits[0].rejection_reason).toBeNull();
      expect(state.ledger).toHaveLength(1);
      expect(state.ledger[0].amount_micro_usd).toBe("1000000");
    });

    it("keeps a rejection when the transfer still fails validation or was reverted on chain", async () => {
      const wallet = seedWatchedWallet();
      const base = {
        account_id: wallet.account_id, funding_wallet_id: wallet.id, chain_id: 4663, token_address: TOKEN_LOWER, log_index: 0,
        from_address: "0xabc", to_address: WALLET, amount_raw: "1000000", amount_micro_usd: "0", status: "rejected", confirmations: 0,
        ledger_entry_id: null, attempts: 0, last_error: null, first_seen_at: new Date(), last_checked_at: new Date(), confirmed_at: null,
        credited_at: null, block_number: null, block_hash: null, reorged_at: null, reorg_reason: null, credit_reversed: false,
      };
      const TX2 = "0x" + "cd".repeat(32);
      state.deposits.push({ ...base, id: "d-chain", tx_hash: TX, rejection_reason: "wrong_chain", idempotency_key: `4663:${TX}:0` });
      state.deposits.push({ ...base, id: "d-reverted", tx_hash: TX2, rejection_reason: "transaction_reverted", idempotency_key: `4663:${TX2}:0` });
      const { ingestActivities } = await import("../../lib/server/funding");
      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 105n;

      await ingestActivities([
        { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "ETH_MAINNET", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "1000000", tokenDecimals: 6 },
        { fromAddress: "0xabc", toAddress: WALLET, txHash: TX2, logIndex: 0, network: "ROBINHOOD_MAINNET", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "1000000", tokenDecimals: 6 },
      ]);

      expect(state.deposits.map((d) => [d.id, d.status, d.rejection_reason])).toEqual([
        ["d-chain", "rejected", "wrong_chain"],
        ["d-reverted", "rejected", "transaction_reverted"],
      ]);
      expect(state.ledger).toHaveLength(0);
    });

    it("credits a duplicate delivery exactly once", async () => {
      seedWatchedWallet();
      const { ingestActivities } = await import("../../lib/server/funding");
      const activity = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "2000000", tokenDecimals: 6 };

      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 105n;

      await ingestActivities([activity]);
      await ingestActivities([activity]);
      await ingestActivities([activity]);

      expect(state.deposits).toHaveLength(1);
      expect(state.ledger).toHaveLength(1);
    });

    it("credits concurrent deliveries of the same transfer exactly once", async () => {
      seedWatchedWallet();
      const { ingestActivities } = await import("../../lib/server/funding");
      const activity = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 3, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "5000000", tokenDecimals: 6 };

      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 110n;

      const results = await Promise.all([
        ingestActivities([activity]),
        ingestActivities([activity]),
        ingestActivities([activity]),
      ]);

      expect(results.reduce((sum, result) => sum + result.credited, 0)).toBe(1);
      expect(state.deposits).toHaveLength(1);
      expect(state.ledger).toHaveLength(1);
    });

    it("treats distinct log indexes in one transaction as separate deposits", async () => {
      seedWatchedWallet();
      const { ingestActivities } = await import("../../lib/server/funding");
      const base = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "1000000", tokenDecimals: 6 };

      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 110n;

      await ingestActivities([{ ...base, logIndex: 0 }, { ...base, logIndex: 1 }]);

      expect(state.deposits).toHaveLength(2);
      expect(state.ledger).toHaveLength(2);
    });

    it("reconciles missed transfers from polled logs with the same rules", async () => {
      const wallet = seedWatchedWallet({ last_scanned_block: "100" });
      const { reconcileWallet } = await import("../../lib/server/funding");

      head.current = 120n;
      logs.current = [
        // genuine USDG transfer to the watched address
        { txHash: TX, logIndex: 0, tokenAddress: TOKEN_LOWER, fromAddress: "0xabc", toAddress: WALLET, rawAmount: "3000000", blockNumber: 110 },
        // unexpected contract, must be ignored
        { txHash: "0x" + "cd".repeat(32), logIndex: 0, tokenAddress: OTHER_WALLET, fromAddress: "0xabc", toAddress: WALLET, rawAmount: "3000000", blockNumber: 111 },
        // unexpected recipient, must be ignored
        { txHash: "0x" + "ef".repeat(32), logIndex: 0, tokenAddress: TOKEN_LOWER, fromAddress: "0xabc", toAddress: OTHER_WALLET, rawAmount: "3000000", blockNumber: 112 },
        // zero value, must be ignored
        { txHash: "0x" + "01".repeat(32), logIndex: 0, tokenAddress: TOKEN_LOWER, fromAddress: "0xabc", toAddress: WALLET, rawAmount: "0", blockNumber: 113 },
      ];
      receipt.current = { blockNumber: 110, blockHash: "0x" + "11".repeat(32), status: "0x1" };

      const result = await reconcileWallet(wallet);

      expect(result.status).toBe("ok");
      expect(result.recorded).toBe(1);
      expect(state.deposits).toHaveLength(1);
      expect(state.deposits[0].amount_micro_usd).toBe("3000000");
      expect(state.ledger).toHaveLength(1);
      expect(state.wallets[0].last_scanned_block).toBe("120");
    });

    it("applies the confirmation threshold on the polling path too", async () => {
      const wallet = seedWatchedWallet({ last_scanned_block: "100" });
      const { reconcileWallet } = await import("../../lib/server/funding");

      head.current = 111n;
      logs.current = [{ txHash: TX, logIndex: 0, tokenAddress: TOKEN_LOWER, fromAddress: "0xabc", toAddress: WALLET, rawAmount: "3000000", blockNumber: 110 }];
      receipt.current = { blockNumber: 110, blockHash: "0x" + "11".repeat(32), status: "0x1" };

      await reconcileWallet(wallet);

      // 2 confirmations at block 110 with head 111: still pending, nothing credited.
      expect(state.deposits[0].status).toBe("pending");
      expect(state.ledger).toHaveLength(0);
    });

    it("skips polling for an address that is not watched", async () => {
      const wallet = seedWatchedWallet({ watch_status: "failed" });
      const { reconcileWallet } = await import("../../lib/server/funding");

      head.current = 500n;
      logs.current = [{ txHash: TX, logIndex: 0, tokenAddress: TOKEN_LOWER, fromAddress: "0xabc", toAddress: WALLET, rawAmount: "3000000", blockNumber: 480 }];

      const result = await reconcileWallet(wallet);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("address_not_watched");
      expect(state.deposits).toHaveLength(0);
    });

    it("flags a previously credited deposit when its transaction is reorged out", async () => {
      seedWatchedWallet();
      const { ingestActivities, processDeposit } = await import("../../lib/server/funding");
      const activity = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "2000000", tokenDecimals: 6 };

      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 105n;
      await ingestActivities([activity]);
      expect(state.deposits[0].status).toBe("confirmed");

      // The transaction disappears from the canonical chain.
      receipt.current = null;
      const result = await processDeposit(String(state.deposits[0].id));

      expect(result.reorg).toBe(true);
      expect(state.deposits[0].reorged_at).not.toBeNull();
      expect(state.deposits[0].reorg_reason).toBe("transaction_not_on_chain");
    });

    it("flags a credited deposit whose inclusion block changed", async () => {
      seedWatchedWallet();
      const { ingestActivities, processDeposit } = await import("../../lib/server/funding");
      const activity = { fromAddress: "0xabc", toAddress: WALLET, txHash: TX, logIndex: 0, network: "robinhood-mainnet", category: "erc20", asset: null, tokenAddress: TOKEN_LOWER, rawAmount: "2000000", tokenDecimals: 6 };

      receipt.current = { blockNumber: 100, blockHash: "0x" + "11".repeat(32), status: "0x1" };
      head.current = 105n;
      await ingestActivities([activity]);

      receipt.current = { blockNumber: 99, blockHash: "0x" + "22".repeat(32), status: "0x1" };
      const result = await processDeposit(String(state.deposits[0].id));

      expect(result.reorg).toBe(true);
      expect(state.deposits[0].reorg_reason).toBe("inclusion_block_changed");
    });
  });

  it("computes an exponential registration backoff capped at one hour", async () => {
    const { registrationRetryDelaySeconds } = await import("../../lib/server/alchemy");
    expect(registrationRetryDelaySeconds(1)).toBe(30);
    expect(registrationRetryDelaySeconds(2)).toBe(60);
    expect(registrationRetryDelaySeconds(3)).toBe(120);
    expect(registrationRetryDelaySeconds(50)).toBe(3600);
  });
});

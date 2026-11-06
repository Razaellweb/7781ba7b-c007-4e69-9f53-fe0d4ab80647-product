import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests lock the SWEEP contract for the polling fallback:
//   * the first run scans back exactly FUNDING_RECONCILE_CHUNK_BLOCKS from head;
//   * a larger subsequent gap is split into bounded eth_getLogs windows rather
//     than one oversized query;
//   * a rate limit or timeout part-way through returns a PARTIAL summary, keeps the
//     cursor at the last fully-scanned block, and leaves the remaining wallets
//     untouched so the next run resumes without losing progress;
//   * wallets whose watch_status is not `watched` are skipped and reported with a
//     reason instead of silently vanishing from the sweep, and they never crowd out
//     a sweepable address.
//
// The database and RPC layers are mocked; nothing here talks to a live service.

const TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TOKEN_LOWER = TOKEN.toLowerCase();
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

type Row = Record<string, unknown>;

const state = {
  wallets: [] as Row[],
  deposits: [] as Row[],
  ledger: [] as Row[],
};

// Every eth_getLogs window the sweep issued, in order.
const logCalls: Array<{ fromBlock: bigint; toBlock: bigint; toAddress: string }> = [];
const logs: { current: Array<{ txHash: string; logIndex: number; tokenAddress: string; fromAddress: string | null; toAddress: string | null; rawAmount: string | null; blockNumber: number }> } = { current: [] };
const head: { current: bigint } = { current: 0n };
const receipt: { current: { blockNumber: number; blockHash: string; status: string } | null } = { current: null };
// When set, the Nth (0-based) eth_getLogs call throws this error instead.
const logFailure: { current: { atCall: number; error: unknown } | null } = { current: null };

async function fakeQuery(text: string, values: unknown[] = []): Promise<Row[]> {
  const sql = text.replace(/\s+/g, " ").trim();

  if (sql.startsWith("SELECT * FROM funding_wallets WHERE watch_status <> 'watched'")) {
    return state.wallets.filter((row) => row.watch_status !== "watched").slice(0, Number(values[1]));
  }
  // recoverFunding's candidate list: watched addresses first, then oldest cursor.
  if (sql.startsWith("SELECT * FROM funding_wallets ORDER BY (watch_status <> 'watched') ASC")) {
    const ordered = [...state.wallets].sort((a, b) => {
      const aWatched = a.watch_status === "watched" ? 0 : 1;
      const bWatched = b.watch_status === "watched" ? 0 : 1;
      if (aWatched !== bWatched) return aWatched - bWatched;
      return Number(a.last_scanned_block ?? 0) - Number(b.last_scanned_block ?? 0);
    });
    return ordered.slice(0, Number(values[0]));
  }
  if (sql.startsWith("UPDATE funding_wallets")) {
    const wallet = state.wallets.find((row) => row.id === values[0]);
    if (wallet && sql.includes("last_scanned_block")) wallet.last_scanned_block = values[1];
    return [];
  }

  if (sql.startsWith("INSERT INTO funding_deposits")) {
    const existing = state.deposits.find(
      (row) => row.chain_id === values[2] && row.tx_hash === values[4] && row.log_index === values[5],
    );
    if (existing) return [existing];
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
    return state.deposits.filter((row) => row.id === values[0]);
  }
  if (sql.startsWith("SELECT * FROM funding_deposits WHERE credited_at IS NOT NULL")) {
    return [];
  }
  if (sql.startsWith("SELECT id FROM funding_deposits WHERE status='pending'")) {
    return [];
  }
  if (sql.startsWith("UPDATE funding_deposits")) {
    const deposit = state.deposits.find((row) => row.id === values[0]);
    if (!deposit) return [];
    if (sql.includes("status='confirmed'") && sql.includes("ledger_entry_id")) {
      deposit.status = "confirmed";
      deposit.ledger_entry_id = values[1];
      deposit.credited_at = new Date();
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
  if (sql.startsWith("SELECT id FROM alchemy_webhook_events")) return [];
  if (sql.startsWith("SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type")) return [{ available: "0" }];
  return [];
}

vi.mock("../../lib/server/db", () => ({
  query: async (text: string, values: unknown[] = []) => fakeQuery(text, values),
  transaction: async (work: (client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> }) => Promise<unknown>) =>
    work({ query: async (text: string, values: unknown[] = []) => ({ rows: await fakeQuery(text, values) }) }),
}));

vi.mock("@privy-io/server-auth", () => ({ PrivyClient: class { walletApi = { createWallet: async () => ({ id: "privy", address: WALLET }) }; } }));

vi.mock("../../lib/server/alchemy", async () => {
  const actual = await vi.importActual<typeof import("../../lib/server/alchemy")>("../../lib/server/alchemy");
  return {
    ...actual,
    getBlockNumber: async () => head.current,
    getTransactionReceiptInfo: async () => receipt.current,
    fetchIncomingTokenLogs: async (params: { fromBlock: bigint; toBlock: bigint; toAddress: string }) => {
      const callIndex = logCalls.length;
      logCalls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock, toAddress: params.toAddress });
      const failure = logFailure.current;
      if (failure && failure.atCall === callIndex) throw failure.error;
      return logs.current.filter(
        (log) => BigInt(log.blockNumber) >= params.fromBlock && BigInt(log.blockNumber) <= params.toBlock,
      );
    },
  };
});

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
  FUNDING_RECONCILE_CHUNK_BLOCKS: "5000",
};

function seedWallet(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: `wallet-${state.wallets.length + 1}`,
    account_id: `account-${state.wallets.length + 1}`,
    privy_wallet_id: `privy-${state.wallets.length + 1}`,
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
  return row;
}

beforeEach(() => {
  state.wallets = [];
  state.deposits = [];
  state.ledger = [];
  logCalls.length = 0;
  logs.current = [];
  head.current = 0n;
  receipt.current = null;
  logFailure.current = null;
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("funding reconciliation sweep", () => {
  it("scans back exactly one chunk window from head on the first run", async () => {
    const wallet = seedWallet({ last_scanned_block: null }) as unknown as import("../../lib/server/funding").FundingWalletRow;
    const { reconcileWallet } = await import("../../lib/server/funding");

    head.current = 12_000n;

    const result = await reconcileWallet(wallet, { maxChunkBlocks: 5000 });

    expect(result.status).toBe("ok");
    // head 12000, chunk 5000 -> first window starts at 7000 (12000 - 5000).
    expect(logCalls[0].fromBlock).toBe(7_000n);
    expect(logCalls[0].toBlock).toBe(11_999n);
    // Every window is bounded by the chunk size.
    for (const call of logCalls) expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(5_000n);
    expect(result.cursorBefore).toBeNull();
    expect(result.cursorAfter).toBe("12000");
    expect(state.wallets[0].last_scanned_block).toBe("12000");
  });

  it("chunks a larger subsequent gap instead of issuing one oversized log query", async () => {
    const wallet = seedWallet({ last_scanned_block: "1000" }) as unknown as import("../../lib/server/funding").FundingWalletRow;
    const { reconcileWallet } = await import("../../lib/server/funding");

    head.current = 25_000n;

    const result = await reconcileWallet(wallet, { maxChunkBlocks: 5000 });

    expect(result.status).toBe("ok");
    expect(result.scannedChunks).toBe(5);
    expect(logCalls).toHaveLength(5);
    expect(logCalls[0].fromBlock).toBe(1_001n);
    expect(logCalls[4].toBlock).toBe(25_000n);
    // No window exceeded the configured chunk size, and the windows tile the gap.
    for (let i = 0; i < logCalls.length; i += 1) {
      expect(logCalls[i].toBlock - logCalls[i].fromBlock + 1n).toBeLessThanOrEqual(5_000n);
      if (i > 0) expect(logCalls[i].fromBlock).toBe(logCalls[i - 1].toBlock + 1n);
    }
    expect(result.cursorAfter).toBe("25000");
    expect(result.scannedBlocks).toBe("24000");
  });

  it("recovers a missed 1 USDG transfer and credits it once at three confirmations", async () => {
    const wallet = seedWallet({ last_scanned_block: "100" }) as unknown as import("../../lib/server/funding").FundingWalletRow;
    const { reconcileWallet } = await import("../../lib/server/funding");

    head.current = 120n;
    logs.current = [{
      txHash: "0x" + "ab".repeat(32),
      logIndex: 0,
      tokenAddress: TOKEN_LOWER,
      fromAddress: "0xabc",
      toAddress: WALLET,
      // 1 USDG with 6 decimals.
      rawAmount: "1000000",
      blockNumber: 110,
    }];
    receipt.current = { blockNumber: 110, blockHash: "0x" + "11".repeat(32), status: "0x1" };

    const result = await reconcileWallet(wallet);

    expect(result.recorded).toBe(1);
    expect(result.credited).toBe(1);
    expect(state.deposits).toHaveLength(1);
    expect(state.deposits[0].amount_micro_usd).toBe("1000000");
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0].amount_micro_usd).toBe("1000000");

    // A second sweep over the same blocks must not create a second credit.
    state.wallets[0].last_scanned_block = "100";
    await reconcileWallet({ ...wallet, last_scanned_block: "100" });
    expect(state.deposits).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
  });

  it("returns a partial summary and keeps the cursor when the provider rate limits mid-sweep", async () => {
    const wallet = seedWallet({ last_scanned_block: "1000" }) as unknown as import("../../lib/server/funding").FundingWalletRow;
    const { reconcileWallet } = await import("../../lib/server/funding");
    const { AlchemyError } = await import("../../lib/server/alchemy");

    head.current = 25_000n;
    // The first window succeeds, the second is rate limited.
    logFailure.current = { atCall: 1, error: new AlchemyError("rate limited", "ALCHEMY_RATE_LIMITED") };

    const result = await reconcileWallet(wallet, { maxChunkBlocks: 5000 });

    expect(result.status).toBe("partial");
    expect(result.transient).toBe(true);
    expect(result.reason).toBe("alchemy_rate_limited");
    // The first window completed, so the cursor advanced to its end and no further.
    expect(result.scannedChunks).toBe(1);
    expect(result.cursorAfter).toBe("6000");
    expect(state.wallets[0].last_scanned_block).toBe("6000");
    // The remaining gap was never queried, so it stays eligible for the next run.
    expect(logCalls).toHaveLength(2);
  });

  it("treats a timeout the same way as a rate limit", async () => {
    const wallet = seedWallet({ last_scanned_block: "1000" }) as unknown as import("../../lib/server/funding").FundingWalletRow;
    const { reconcileWallet } = await import("../../lib/server/funding");
    const { AlchemyError } = await import("../../lib/server/alchemy");

    head.current = 25_000n;
    logFailure.current = { atCall: 0, error: new AlchemyError("timed out", "ALCHEMY_TIMEOUT") };

    const result = await reconcileWallet(wallet, { maxChunkBlocks: 5000 });

    expect(result.status).toBe("partial");
    expect(result.reason).toBe("alchemy_timeout");
    // Nothing was scanned, so the cursor is untouched.
    expect(result.scannedChunks).toBe(0);
    expect(result.cursorAfter).toBe("1000");
    expect(state.wallets[0].last_scanned_block).toBe("1000");
  });

  it("reports a non-watched wallet as skipped with its reason", async () => {
    const wallet = seedWallet({ watch_status: "failed" }) as unknown as import("../../lib/server/funding").FundingWalletRow;
    const { reconcileWallet } = await import("../../lib/server/funding");

    head.current = 500n;

    const result = await reconcileWallet(wallet);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("address_not_watched");
    expect(logCalls).toHaveLength(0);
    expect(state.deposits).toHaveLength(0);
  });

  it("reports skipped wallets in the sweep summary and stops on a transient fault", async () => {
    // Wallet 1 is unwatched; wallet 2 is sweepable.
    seedWallet({ watch_status: "failed", address: OTHER_WALLET });
    seedWallet({ last_scanned_block: "1000" });
    const { recoverFunding } = await import("../../lib/server/funding");
    const { AlchemyError } = await import("../../lib/server/alchemy");

    head.current = 25_000n;
    logFailure.current = { atCall: 0, error: new AlchemyError("rate limited", "ALCHEMY_RATE_LIMITED") };

    const summary = await recoverFunding(10);

    expect(summary.status).toBe("partial");
    expect(summary.partial).toBe(true);
    expect(summary.reason).toBe("alchemy_rate_limited");
    expect(summary.wallets).toBe(2);
    expect(summary.reconciled).toBe(0);
    expect(summary.skipped).toEqual([
      { walletId: "wallet-1", address: OTHER_WALLET, reason: "address_not_watched" },
    ]);
    expect(summary.partialWallets).toBe(1);
    // The watched wallet is swept first, so the transient fault cuts the run there
    // and the unwatched address is still visited and reported afterwards.
    expect(summary.walletResults.map((result) => result.walletId)).toEqual(["wallet-2", "wallet-1"]);
    expect(summary.walletResults.map((result) => result.status)).toEqual(["partial", "skipped"]);
  });

  it("never lets an unwatched address starve a sweepable one", async () => {
    seedWallet({ watch_status: "failed", address: OTHER_WALLET });
    seedWallet({ last_scanned_block: "100" });
    const { recoverFunding } = await import("../../lib/server/funding");

    head.current = 120n;
    logs.current = [{
      txHash: "0x" + "ef".repeat(32),
      logIndex: 0,
      tokenAddress: TOKEN_LOWER,
      fromAddress: "0xabc",
      toAddress: WALLET,
      rawAmount: "1000000",
      blockNumber: 110,
    }];
    receipt.current = { blockNumber: 110, blockHash: "0x" + "11".repeat(32), status: "0x1" };

    const summary = await recoverFunding(10);

    expect(summary.status).toBe("ok");
    expect(summary.reconciled).toBe(1);
    expect(summary.credited).toBe(1);
    expect(summary.skipped).toHaveLength(1);
    // Only the watched address was scanned.
    expect(logCalls.every((call) => call.toAddress === WALLET)).toBe(true);
  });

  it("completes cleanly when the provider is healthy and reports no skips", async () => {
    seedWallet({ last_scanned_block: "100" });
    const { recoverFunding } = await import("../../lib/server/funding");

    head.current = 120n;
    logs.current = [{
      txHash: "0x" + "cd".repeat(32),
      logIndex: 0,
      tokenAddress: TOKEN_LOWER,
      fromAddress: "0xabc",
      toAddress: WALLET,
      rawAmount: "1000000",
      blockNumber: 110,
    }];
    receipt.current = { blockNumber: 110, blockHash: "0x" + "11".repeat(32), status: "0x1" };

    const summary = await recoverFunding(10);

    expect(summary.status).toBe("ok");
    expect(summary.partial).toBe(false);
    expect(summary.reason).toBeNull();
    expect(summary.reconciled).toBe(1);
    expect(summary.credited).toBe(1);
    expect(summary.skipped).toEqual([]);
  });
});

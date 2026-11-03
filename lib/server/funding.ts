import { PrivyClient } from "@privy-io/server-auth";
import { fundingConfig, fundingReconcileConfig, privyConfig, privyWalletConfig, FUNDING_TOKEN_SYMBOL_USDG, type FundingConfig } from "./config";
import {
  AlchemyError,
  fetchIncomingTokenLogs,
  getBlockNumber,
  getTransactionReceiptInfo,
  networkMatchesConfiguredChain,
  parseAddressActivity,
  registerMonitoredAddress,
  registrationRetryDelaySeconds,
  transferLogToActivity,
  type AlchemyAddressActivity,
} from "./alchemy";
import { query, transaction } from "./db";

// Funding: USDG deposits on the configured Robinhood Chain network become compute
// balance.
//
// Flow
//   1. Fund -> getOrCreateFundingWallet(): one Privy server wallet per account.
//      The private key lives inside Privy; this app only ever stores the address.
//   2. The address is REGISTERED for Alchemy address-activity monitoring before it
//      is treated as watched. A registration failure keeps the row in a retryable
//      `failed` state with backoff, so an address is never silently left unwatched.
//   3. The user sends USDG on the configured chain. Alchemy notifies us (preferred),
//      and the polling fallback reads the same USDG Transfer logs when a delivery is
//      missed.
//   4. `eth_getTransactionReceipt` against `eth_blockNumber` gives the deposit's
//      depth on chain. At FUNDING_CONFIRMATIONS (three) the deposit is credited to
//      the account's compute ledger — exactly once — and the user-visible status
//      only then leaves `pending`.
//
// Correctness rules enforced here:
//   * The creditable asset is USDG, identified by the explicitly configured
//     FUNDING_TOKEN_ADDRESS for the *active* network and scaled by the explicitly
//     configured FUNDING_TOKEN_DECIMALS. Nothing is inherited from the legacy
//     holder token.
//   * Webhook and polling feed the SAME validation and credit path, so neither can
//     bypass a chain/token/address/confirmation check.
//   * Only that token contract on that chain, to an address we generated and have
//     confirmed is watched, with a positive amount, is creditable. Native-coin
//     transfers, other tokens, other networks, zero-value and unknown recipients
//     are recorded (or logged) as rejected for audit and never touch the ledger.
//   * Duplicates are impossible: the deposit row is unique on
//     (chain, tx, logIndex) and the ledger entry is unique on the same identity, so
//     replayed deliveries, concurrent workers, and webhook/polling overlap all
//     converge on one credit.
//   * A credited deposit whose transaction is no longer on the canonical chain is
//     flagged for review rather than silently uncredited.
//
// Access eligibility is untouched by this module: funding only moves value.

export class FundingError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = "FundingError";
    this.code = code;
    this.status = status;
  }
}

export type WatchStatus = "unwatched" | "watched" | "failed";

export type FundingWalletRow = {
  id: string;
  account_id: string;
  privy_wallet_id: string;
  address: string;
  chain_id: number;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  watch_status: WatchStatus;
  watch_webhook_id: string | null;
  watch_registered_at: Date | null;
  watch_attempts: number;
  watch_last_error: string | null;
  watch_next_attempt_at: Date;
  last_scanned_block: string | null;
  created_at: Date;
  updated_at: Date;
};

export type DepositRow = {
  id: string;
  account_id: string;
  funding_wallet_id: string;
  chain_id: number;
  token_address: string;
  tx_hash: string;
  log_index: number;
  from_address: string | null;
  to_address: string;
  amount_raw: string;
  amount_micro_usd: string;
  confirmations: number;
  status: "pending" | "confirmed" | "rejected";
  rejection_reason: string | null;
  ledger_entry_id: string | null;
  attempts: number;
  last_error: string | null;
  first_seen_at: Date;
  last_checked_at: Date | null;
  confirmed_at: Date | null;
  credited_at: Date | null;
  block_number: string | number | null;
  block_hash: string | null;
  idempotency_key: string | null;
  reorged_at: Date | null;
  reorg_reason: string | null;
  credit_reversed: boolean;
};

let privyClient: PrivyClient | undefined;

function client(): PrivyClient {
  if (!privyClient) {
    const c = privyConfig();
    const wallet = privyWalletConfig();
    privyClient = new PrivyClient(c.appId, c.appSecret, wallet.authorizationPrivateKey ? { walletApi: { authorizationPrivateKey: wallet.authorizationPrivateKey } } : {});
  }
  return privyClient;
}

/** Converts an on-chain integer amount into the ledger's micro-USD unit. */
export function tokenAmountToMicroUsd(rawAmount: string, decimals: number, microUsdPerToken: bigint): bigint {
  let raw: bigint;
  try { raw = BigInt(rawAmount); } catch { return 0n; }
  if (raw <= 0n) return 0n;
  const scale = 10n ** BigInt(decimals);
  const base = raw * microUsdPerToken;
  return base / scale;
}

/**
 * Splits a whole-token threshold like "0.5" into its smallest-unit form using the
 * configured decimals, so the minimum-deposit rule is expressed in USDG terms and
 * evaluated with USDG's actual scale rather than a hard-coded one.
 */
export function minimumRawAmount(minDepositTokens: string, decimals: number): bigint {
  const text = (minDepositTokens ?? "0").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 0n;
  const [whole, fraction = ""] = text.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  try { return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0"); } catch { return 0n; }
}

/** The funding asset identity, as reported to clients. Always USDG. */
export function fundingAsset(cfg: FundingConfig = fundingConfig()) {
  return {
    address: cfg.tokenAddress,
    symbol: FUNDING_TOKEN_SYMBOL_USDG,
    decimals: cfg.tokenDecimals,
    microUsdPerToken: cfg.microUsdPerToken.toString(),
  };
}

/** The stable credit identity for a transfer log. Mirrored into the ledger key. */
export function depositIdempotencyKey(chainId: number, txHash: string, logIndex: number): string {
  return `deposit:${chainId}:${txHash.toLowerCase()}:${logIndex}`;
}

/**
 * Registers a deposit address for Alchemy address-activity monitoring and persists
 * the outcome.
 *
 * A row becomes `watched` ONLY when Alchemy accepted the registration. Anything
 * else (missing Notify credentials, HTTP failure, unreachable dashboard) records a
 * `failed` state with the reason, an incremented attempt count, and a backoff
 * timestamp so `retryPendingWatches()` picks it up again.
 */
export async function ensureWalletWatched(
  wallet: FundingWalletRow,
  options: { force?: boolean } = {},
): Promise<{ watched: boolean; reason?: string }> {
  if (wallet.watch_status === "watched" && !options.force) return { watched: true };

  const registration = await registerMonitoredAddress(wallet.address);
  if (registration.monitored) {
    await query(
      `UPDATE funding_wallets
          SET watch_status='watched', watch_webhook_id=$2, watch_registered_at=now(),
              watch_attempts=watch_attempts+1, watch_last_error=NULL,
              watch_next_attempt_at=now(), updated_at=now()
        WHERE id=$1`,
      [wallet.id, registration.webhookId ?? null]
    );
    console.info(JSON.stringify({ event: "funding_wallet_watched", walletId: wallet.id, chainId: wallet.chain_id }));
    return { watched: true };
  }

  const attempts = (wallet.watch_attempts ?? 0) + 1;
  const reason = registration.reason ?? "alchemy_registration_failed";
  await query(
    `UPDATE funding_wallets
        SET watch_status='failed', watch_attempts=$2, watch_last_error=$3,
            watch_next_attempt_at=now() + make_interval(secs => $4::double precision), updated_at=now()
      WHERE id=$1`,
    [wallet.id, attempts, reason, registrationRetryDelaySeconds(attempts)]
  );
  console.warn(JSON.stringify({ event: "funding_wallet_not_watched", walletId: wallet.id, attempts, reason }));
  return { watched: false, reason };
}

/**
 * Retries every address whose monitoring registration is not yet confirmed and
 * whose backoff has elapsed. This is what guarantees an address left unwatched by
 * an Alchemy outage is eventually watched rather than forgotten.
 */
export async function retryPendingWatches(limit = 25): Promise<{ attempted: number; watched: number }> {
  const { maxRegistrationAttempts } = fundingReconcileConfig();
  const pending = await query<FundingWalletRow>(
    `SELECT * FROM funding_wallets
      WHERE watch_status <> 'watched'
        AND watch_next_attempt_at <= now()
        AND watch_attempts < $1
      ORDER BY watch_next_attempt_at
      LIMIT $2`,
    [maxRegistrationAttempts, limit]
  );
  let watched = 0;
  for (const wallet of pending) {
    const result = await ensureWalletWatched(wallet).catch(() => null);
    if (result?.watched) watched += 1;
  }
  return { attempted: pending.length, watched };
}

/**
 * Returns the account's funding wallet, creating it on first use.
 *
 * Wallet creation is deterministic per account: the row is claimed with
 * `ON CONFLICT (account_id) DO NOTHING`, so two concurrent clicks cannot create
 * two addresses. The Privy request carries our account id as the idempotency key
 * for the same reason. The address is registered for monitoring immediately; the
 * returned `monitored` flag is true only when that registration actually succeeded.
 */
export async function getOrCreateFundingWallet(accountId: string): Promise<{ wallet: FundingWalletRow; created: boolean; monitored: boolean; watchReason?: string }> {
  const cfg = fundingConfig();
  if (!cfg.configured) throw new FundingError(cfg.unconfiguredReason ?? "Deposits are not configured on this deployment.", "FUNDING_UNCONFIGURED", 503);

  const existing = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE account_id=$1`, [accountId]);
  if (existing[0]) {
    // Re-assert Alchemy monitoring so an address whose registration failed — or was
    // removed elsewhere — is re-registered rather than assumed watched.
    const registration = await ensureWalletWatched(existing[0]);
    const refreshed = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE id=$1`, [existing[0].id]);
    const wallet = refreshed[0] ?? { ...existing[0], watch_status: registration.watched ? ("watched" as const) : existing[0].watch_status };
    return { wallet, created: false, monitored: registration.watched, watchReason: registration.reason };
  }

  let created;
  try {
    created = await client().walletApi.createWallet({ chainType: "ethereum", idempotencyKey: `funding-wallet:${accountId}` });
  } catch (error) {
    console.error(JSON.stringify({ event: "funding_wallet_creation_failed", accountId, error: error instanceof Error ? error.name : "unknown" }));
    throw new FundingError("A funding address could not be created right now. Try again in a moment.", "FUNDING_WALLET_UNAVAILABLE", 503);
  }

  const address = created.address.toLowerCase();
  const inserted = await query<FundingWalletRow>(
    `INSERT INTO funding_wallets (account_id, privy_wallet_id, address, chain_id, token_address, token_symbol, token_decimals)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id) DO NOTHING
     RETURNING *`,
    [accountId, created.id, address, cfg.chainId, cfg.tokenAddressLower, FUNDING_TOKEN_SYMBOL_USDG, cfg.tokenDecimals]
  );
  if (inserted[0]) {
    const registration = await ensureWalletWatched(inserted[0]);
    const refreshed = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE id=$1`, [inserted[0].id]);
    const wallet = refreshed[0] ?? { ...inserted[0], watch_status: registration.watched ? ("watched" as const) : ("failed" as const) };
    console.info(JSON.stringify({ event: "funding_wallet_created", accountId, chainId: cfg.chainId, token: FUNDING_TOKEN_SYMBOL_USDG, monitored: registration.watched }));
    return { wallet, created: true, monitored: registration.watched, watchReason: registration.reason };
  }

  // Lost the race: another request inserted the wallet first. Use that one.
  const winner = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE account_id=$1`, [accountId]);
  if (!winner[0]) throw new FundingError("Funding address could not be stored.", "FUNDING_WALLET_UNAVAILABLE", 503);
  const registration = await ensureWalletWatched(winner[0]);
  return { wallet: winner[0], created: false, monitored: registration.watched, watchReason: registration.reason };
}

type Validation = { rejection: string | null; microUsd: bigint };

/**
 * The single chain/token/amount validation used by BOTH the webhook path and the
 * polling path. Nothing may be credited without passing through here.
 */
export function validateTransfer(
  cfg: FundingConfig,
  wallet: Pick<FundingWalletRow, "address" | "chain_id" | "token_address">,
  activity: AlchemyAddressActivity,
): Validation {
  const tokenAddress = activity.tokenAddress;
  const toAddress = activity.toAddress;

  // Wrong chain: Alchemy reported a different network than the configured one.
  if (!networkMatchesConfiguredChain(activity.network)) return { rejection: "wrong_chain", microUsd: 0n };
  // Unknown recipient: must be the address this wallet row owns.
  if (!toAddress || toAddress !== wallet.address.toLowerCase()) return { rejection: "unknown_recipient", microUsd: 0n };
  // The wallet must have been recorded on the active chain with the active token.
  if (wallet.chain_id !== cfg.chainId) return { rejection: "wrong_chain", microUsd: 0n };
  // Wrong token: native transfers carry no contract; anything else must be USDG's
  // configured contract for this network.
  if (tokenAddress === null) return { rejection: "not_the_configured_token", microUsd: 0n };
  if (cfg.tokenAddressLower === "" || tokenAddress !== cfg.tokenAddressLower) return { rejection: "wrong_token", microUsd: 0n };
  if (wallet.token_address !== cfg.tokenAddressLower) return { rejection: "wrong_token", microUsd: 0n };

  const rawAmount = activity.rawAmount;
  if (rawAmount === null) return { rejection: "malformed_amount", microUsd: 0n };
  let raw: bigint;
  try { raw = BigInt(rawAmount); } catch { return { rejection: "malformed_amount", microUsd: 0n }; }
  if (raw < 0n) return { rejection: "malformed_amount", microUsd: 0n };
  if (raw === 0n) return { rejection: "zero_value", microUsd: 0n };

  const floor = minimumRawAmount(cfg.minDepositTokens, cfg.tokenDecimals);
  if (floor > 0n && raw < floor) return { rejection: "below_minimum_amount", microUsd: 0n };

  const microUsd = tokenAmountToMicroUsd(rawAmount, cfg.tokenDecimals, cfg.microUsdPerToken);
  if (microUsd <= 0n) return { rejection: "below_minimum_amount", microUsd: 0n };
  return { rejection: null, microUsd };
}

/**
 * Records one transfer against a specific funding wallet.
 *
 * Deduplicated on (chain_id, tx_hash, log_index): the same transfer reported by a
 * webhook, a polled log, and a retried delivery all update one row. Rejected rows
 * are retained for audit and never credited.
 */
export async function recordActivity(
  activity: AlchemyAddressActivity,
  wallet: FundingWalletRow,
): Promise<DepositRow | null> {
  const cfg = fundingConfig();
  if (!cfg.configured) return null;

  const validation = validateTransfer(cfg, wallet, activity);
  const idempotencyKey = depositIdempotencyKey(cfg.chainId, activity.txHash, activity.logIndex);

  if (validation.rejection) {
    console.warn(JSON.stringify({
      event: "funding_transfer_rejected",
      reason: validation.rejection,
      txHash: activity.txHash,
      logIndex: activity.logIndex,
      chainId: cfg.chainId,
      tokenAddress: activity.tokenAddress,
      toAddress: activity.toAddress,
    }));
  }

  const rows = await query<DepositRow>(
    `INSERT INTO funding_deposits
       (account_id, funding_wallet_id, chain_id, token_address, tx_hash, log_index, from_address, to_address,
        amount_raw, amount_micro_usd, status, rejection_reason, idempotency_key, last_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
     ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE
       SET last_checked_at = now(),
           last_error = NULL
     RETURNING *`,
    [
      wallet.account_id,
      wallet.id,
      cfg.chainId,
      cfg.tokenAddressLower,
      activity.txHash.toLowerCase(),
      activity.logIndex,
      activity.fromAddress,
      wallet.address,
      // A refused transfer keeps its real (possibly zero) amount so the audit trail
      // is accurate; the CHECK constraint allows zero for that reason.
      activity.rawAmount ?? "0",
      validation.microUsd.toString(),
      validation.rejection ? "rejected" : "pending",
      validation.rejection,
      idempotencyKey,
    ]
  );
  return rows[0] ?? null;
}

/** Resolves the watched funding wallet an activity is addressed to, if any. */
async function resolveWatchedWallet(activity: AlchemyAddressActivity): Promise<FundingWalletRow | null> {
  if (!activity.toAddress) return null;
  const rows = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE address=$1`, [activity.toAddress.toLowerCase()]);
  const wallet = rows[0];
  if (!wallet) {
    console.warn(JSON.stringify({ event: "funding_activity_unknown_recipient", toAddress: activity.toAddress, txHash: activity.txHash }));
    return null;
  }
  if (wallet.watch_status !== "watched") {
    // An address whose Alchemy registration never succeeded is not a monitored
    // address: it must not be credited from a notification. The polling fallback
    // picks these transfers up once the address is watched.
    console.warn(JSON.stringify({ event: "funding_activity_unwatched_recipient", walletId: wallet.id, watchStatus: wallet.watch_status, txHash: activity.txHash }));
    return null;
  }
  return wallet;
}

/**
 * Credits a deposit to the account's compute ledger, exactly once.
 *
 * The ledger insert carries the deposit identity as its unique idempotency key, so
 * a duplicate call is a no-op that adopts the original entry. The deposit row is
 * locked FOR UPDATE first, so two concurrent workers serialize instead of racing.
 */
async function creditDeposit(deposit: DepositRow): Promise<{ credited: boolean; ledgerEntryId: string | null }> {
  const microUsd = BigInt(deposit.amount_micro_usd);
  if (microUsd <= 0n) return { credited: false, ledgerEntryId: null };
  const idempotencyKey = deposit.idempotency_key ?? depositIdempotencyKey(deposit.chain_id, deposit.tx_hash, deposit.log_index);

  return transaction(async (db) => {
    const locked = await db.query<DepositRow>(`SELECT * FROM funding_deposits WHERE id=$1 FOR UPDATE`, [deposit.id]);
    const row = locked.rows[0];
    if (!row) return { credited: false, ledgerEntryId: null };
    if (row.credited_at && row.ledger_entry_id) return { credited: false, ledgerEntryId: row.ledger_entry_id };
    if (row.status === "rejected") return { credited: false, ledgerEntryId: null };

    const entry = await db.query<{ id: string }>(
      `INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key, metadata)
       VALUES ($1, 'deposit', $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        row.account_id,
        microUsd.toString(),
        idempotencyKey,
        JSON.stringify({
          source: "alchemy_deposit",
          asset: FUNDING_TOKEN_SYMBOL_USDG,
          chainId: row.chain_id,
          tokenAddress: row.token_address,
          txHash: row.tx_hash,
          logIndex: row.log_index,
          fromAddress: row.from_address,
          toAddress: row.to_address,
          amountRaw: row.amount_raw,
          confirmations: row.confirmations,
          blockNumber: row.block_number,
          blockHash: row.block_hash,
        }),
      ]
    );

    // A concurrent worker may have won the insert; adopt its entry id.
    const ledgerEntryId = entry.rows[0]?.id
      ?? (await db.query<{ id: string }>(`SELECT id FROM compute_ledger_entries WHERE idempotency_key=$1`, [idempotencyKey])).rows[0]?.id
      ?? null;

    await db.query(
      `UPDATE funding_deposits
          SET status='confirmed', ledger_entry_id=$2, confirmed_at=COALESCE(confirmed_at, now()),
              credited_at=now(), last_error=NULL, last_checked_at=now()
        WHERE id=$1`,
      [row.id, ledgerEntryId]
    );

    console.info(JSON.stringify({ event: "funding_deposit_credited", depositId: row.id, accountId: row.account_id, chainId: row.chain_id, confirmations: row.confirmations, asset: FUNDING_TOKEN_SYMBOL_USDG, inserted: Boolean(entry.rows[0]) }));
    return { credited: Boolean(entry.rows[0]), ledgerEntryId };
  });
}

/**
 * Re-checks an already-credited deposit against the canonical chain and flags it
 * if the transfer is no longer there (a reorg). The credit is left in place and
 * flagged for operator review instead of being silently reversed.
 */
export async function detectReorg(deposit: DepositRow): Promise<{ flagged: boolean; reason?: string }> {
  let receipt;
  try { receipt = await getTransactionReceiptInfo(deposit.tx_hash); }
  catch { return { flagged: false }; }

  if (receipt && deposit.block_hash && receipt.blockHash === deposit.block_hash) return { flagged: false };

  const reason = receipt ? "inclusion_block_changed" : "transaction_not_on_chain";
  await query(
    `UPDATE funding_deposits
        SET reorged_at=COALESCE(reorged_at, now()), reorg_reason=COALESCE(reorg_reason, $2),
            last_checked_at=now()
      WHERE id=$1`,
    [deposit.id, reason]
  );
  console.error(JSON.stringify({ event: "funding_deposit_reorg_detected", depositId: deposit.id, accountId: deposit.account_id, txHash: deposit.tx_hash, logIndex: deposit.log_index, reason, ledgerEntryId: deposit.ledger_entry_id }));
  return { flagged: true, reason };
}

/**
 * Re-checks one deposit: reads its depth from Alchemy and credits it once the
 * configured confirmation count is reached. Errors are recorded on the row so a
 * later retry can pick it up; they are never allowed to throw out of a webhook.
 */
export async function processDeposit(depositId: string): Promise<{ status: DepositRow["status"]; credited: boolean; confirmations: number; reorg: boolean }> {
  const cfg = fundingConfig();
  const rows = await query<DepositRow>(`SELECT * FROM funding_deposits WHERE id=$1`, [depositId]);
  const deposit = rows[0];
  if (!deposit) throw new FundingError("Deposit not found", "NOT_FOUND", 404);
  if (deposit.status === "rejected") return { status: "rejected", credited: false, confirmations: deposit.confirmations, reorg: false };

  // Already credited: only reorg verification remains.
  if (deposit.credited_at) {
    const reorg = await detectReorg(deposit);
    return { status: "confirmed", credited: false, confirmations: deposit.confirmations, reorg: reorg.flagged };
  }

  let receipt;
  try {
    receipt = await getTransactionReceiptInfo(deposit.tx_hash);
  } catch (error) {
    await query(`UPDATE funding_deposits SET attempts=attempts+1, last_error=$2, last_checked_at=now() WHERE id=$1`, [deposit.id, `alchemy:${error instanceof AlchemyError ? error.code : "rpc_error"}`]);
    return { status: "pending", credited: false, confirmations: deposit.confirmations, reorg: false };
  }

  if (!receipt) {
    // Not mined (yet), or dropped from the mempool. Stay pending.
    await query(`UPDATE funding_deposits SET attempts=attempts+1, last_error='not_mined', last_checked_at=now() WHERE id=$1`, [deposit.id]);
    return { status: "pending", credited: false, confirmations: deposit.confirmations, reorg: false };
  }

  // A reverted transaction cannot have moved tokens; never credit it.
  if (receipt.status === "0x0") {
    await query(
      `UPDATE funding_deposits SET status='rejected', rejection_reason='transaction_reverted', amount_micro_usd=0, last_checked_at=now(), attempts=attempts+1 WHERE id=$1`,
      [deposit.id]
    );
    console.warn(JSON.stringify({ event: "funding_transfer_rejected", reason: "transaction_reverted", txHash: deposit.tx_hash, logIndex: deposit.log_index }));
    return { status: "rejected", credited: false, confirmations: 0, reorg: false };
  }

  // Pre-credit reorg: the transaction moved to another block, so its confirmations
  // restart from the new inclusion block.
  let blockHash = deposit.block_hash;
  let blockNumber = receipt.blockNumber;
  if (deposit.block_hash && deposit.block_hash !== receipt.blockHash) {
    console.warn(JSON.stringify({ event: "funding_deposit_reorg_preconfirm", depositId: deposit.id, txHash: deposit.tx_hash, previousBlockHash: deposit.block_hash, currentBlockHash: receipt.blockHash }));
    await query(`UPDATE funding_deposits SET block_number=$2, block_hash=$3, confirmations=0, last_checked_at=now() WHERE id=$1`, [deposit.id, receipt.blockNumber, receipt.blockHash]);
    blockHash = receipt.blockHash;
  }

  let head: bigint;
  try { head = await getBlockNumber(); }
  catch (error) {
    await query(`UPDATE funding_deposits SET attempts=attempts+1, last_error=$2, last_checked_at=now() WHERE id=$1`, [deposit.id, `alchemy:${error instanceof AlchemyError ? error.code : "rpc_error"}`]);
    return { status: "pending", credited: false, confirmations: deposit.confirmations, reorg: false };
  }

  const included = BigInt(receipt.blockNumber);
  const confirmations = head < included ? 0 : Number(head - included) + 1;

  await query(
    `UPDATE funding_deposits
        SET confirmations=$2, block_number=$3, block_hash=$4, last_checked_at=now(), last_error=NULL
      WHERE id=$1`,
    [deposit.id, confirmations, blockNumber, blockHash]
  );
  if (confirmations < cfg.confirmations) return { status: "pending", credited: false, confirmations, reorg: false };

  const credit = await creditDeposit({ ...deposit, confirmations, block_number: blockNumber, block_hash: blockHash });
  return { status: credit.credited || credit.ledgerEntryId ? "confirmed" : "pending", credited: credit.credited, confirmations, reorg: false };
}

/**
 * Handles one verified Alchemy notification payload: records every activity it
 * carries, then immediately advances the ones that have already reached depth.
 * Returns per-activity outcomes so the caller can decide whether to retry.
 */
export async function ingestActivities(activities: AlchemyAddressActivity[]): Promise<{ recorded: number; credited: number; failed: number }> {
  let recorded = 0;
  let credited = 0;
  let failed = 0;
  for (const activity of activities) {
    try {
      const wallet = await resolveWatchedWallet(activity);
      if (!wallet) continue;
      const deposit = await recordActivity(activity, wallet);
      if (!deposit) continue;
      recorded += 1;
      if (deposit.status === "pending") {
        const processed = await processDeposit(deposit.id);
        if (processed.credited) credited += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({ event: "funding_activity_failed", txHash: activity.txHash, logIndex: activity.logIndex, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  return { recorded, credited, failed };
}

/** Parses a stored notification payload and ingests it. */
export async function replayWebhookEvent(eventRowId: string): Promise<{ recorded: number; credited: number; failed: number }> {
  const rows = await query<{ id: string; payload: unknown; attempts: number }>(`SELECT id, payload, attempts FROM alchemy_webhook_events WHERE id=$1`, [eventRowId]);
  const row = rows[0];
  if (!row) throw new FundingError("Notification not found", "NOT_FOUND", 404);
  try {
    const activities = parseAddressActivity(row.payload);
    const result = await ingestActivities(activities);
    const status = result.failed > 0 ? "failed" : "processed";
    await query(`UPDATE alchemy_webhook_events SET status=$2, attempts=attempts+1, last_error=$3, processed_at=CASE WHEN $2='processed' THEN now() ELSE processed_at END WHERE id=$1`, [row.id, status, result.failed > 0 ? `${result.failed} activity item(s) failed` : null]);
    return result;
  } catch (error) {
    await query(`UPDATE alchemy_webhook_events SET status='failed', attempts=attempts+1, last_error=$2 WHERE id=$1`, [row.id, error instanceof Error ? error.message.slice(0, 500) : "unknown error"]);
    throw error;
  }
}

/**
 * Polling fallback for one watched address: reads USDG Transfer logs addressed to
 * it and runs them through the exact same record/confirm/credit path the webhook
 * uses. The scan is filtered at the RPC level by contract address and the indexed
 * `to` topic, so nothing outside the configured asset reaches validation.
 */
export async function reconcileWallet(
  wallet: FundingWalletRow,
  options: { maxChunkBlocks?: number } = {},
): Promise<{ status: "ok" | "skipped" | "error"; scanned: number; recorded: number; credited: number; reason?: string }> {
  const cfg = fundingConfig();
  if (!cfg.configured) return { status: "skipped", scanned: 0, recorded: 0, credited: 0, reason: "funding_unconfigured" };
  if (wallet.watch_status !== "watched") return { status: "skipped", scanned: 0, recorded: 0, credited: 0, reason: "address_not_watched" };
  if (wallet.chain_id !== cfg.chainId) return { status: "skipped", scanned: 0, recorded: 0, credited: 0, reason: "wrong_chain" };

  const { maxChunkBlocks } = fundingReconcileConfig();
  const chunk = BigInt(Math.max(100, options.maxChunkBlocks ?? maxChunkBlocks));

  let head: bigint;
  try { head = await getBlockNumber(); }
  catch (error) {
    console.warn(JSON.stringify({ event: "funding_reconcile_head_unavailable", walletId: wallet.id, error: error instanceof Error ? error.name : "unknown" }));
    return { status: "error", scanned: 0, recorded: 0, credited: 0, reason: "alchemy_unreachable" };
  }

  const cursor = wallet.last_scanned_block !== null && wallet.last_scanned_block !== undefined ? BigInt(wallet.last_scanned_block) : null;
  const from = cursor !== null ? cursor + 1n : (head > chunk ? head - chunk : 0n);
  let recorded = 0;
  let credited = 0;
  let scanned = 0;

  for (let start = from; start <= head; start += chunk) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n;
    let logs;
    try {
      logs = await fetchIncomingTokenLogs({ tokenAddress: cfg.tokenAddress, toAddress: wallet.address, fromBlock: start, toBlock: end });
    } catch (error) {
      console.warn(JSON.stringify({ event: "funding_reconcile_scan_failed", walletId: wallet.id, fromBlock: start.toString(), toBlock: end.toString(), error: error instanceof Error ? error.name : "unknown" }));
      return { status: "error", scanned, recorded, credited, reason: "alchemy_scan_failed" };
    }
    scanned += 1;

    for (const log of logs) {
      // Defense in depth: the RPC filter already scopes these, but never credit an
      // unexpected contract, recipient, or non-positive amount.
      if (log.tokenAddress !== cfg.tokenAddressLower) {
        console.warn(JSON.stringify({ event: "funding_reconcile_ignored_token", walletId: wallet.id, tokenAddress: log.tokenAddress }));
        continue;
      }
      if (!log.toAddress || log.toAddress !== wallet.address.toLowerCase()) {
        console.warn(JSON.stringify({ event: "funding_reconcile_ignored_recipient", walletId: wallet.id, toAddress: log.toAddress }));
        continue;
      }
      if (!log.rawAmount || log.rawAmount === "0") {
        console.warn(JSON.stringify({ event: "funding_reconcile_ignored_amount", walletId: wallet.id, txHash: log.txHash, logIndex: log.logIndex }));
        continue;
      }
      const deposit = await recordActivity(transferLogToActivity(log), wallet).catch(() => null);
      if (!deposit) continue;
      recorded += 1;
      if (deposit.status === "pending") {
        const processed = await processDeposit(deposit.id).catch(() => null);
        if (processed?.credited) credited += 1;
      }
    }

    await query(`UPDATE funding_wallets SET last_scanned_block=$2, updated_at=now() WHERE id=$1`, [wallet.id, end.toString()]);
  }

  return { status: "ok", scanned, recorded, credited };
}

/**
 * Retry/recovery sweep: retries address registrations, re-runs failed
 * notifications, re-checks pending deposits (including ones only seen once by
 * Alchemy), polls for transfers a missed webhook would have carried, and verifies
 * credited deposits for reorgs. Safe to call from a cron or the status endpoint.
 */
export async function recoverFunding(limit = 25): Promise<{
  watches: { attempted: number; watched: number };
  events: number;
  deposits: number;
  credited: number;
  reconciled: number;
  reorgs: number;
}> {
  const watches = await retryPendingWatches(limit);

  const events = await query<{ id: string }>(`SELECT id FROM alchemy_webhook_events WHERE status IN ('received','failed') AND attempts < 8 ORDER BY received_at LIMIT $1`, [limit]);
  for (const event of events) {
    await replayWebhookEvent(event.id).catch((error) => console.error(JSON.stringify({ event: "funding_event_retry_failed", eventRow: event.id, error: error instanceof Error ? error.name : "unknown" })));
  }

  const pending = await query<{ id: string }>(`SELECT id FROM funding_deposits WHERE status='pending' AND attempts < 200 AND (last_checked_at IS NULL OR last_checked_at < now() - interval '20 seconds') ORDER BY first_seen_at LIMIT $1`, [limit]);
  let credited = 0;
  for (const deposit of pending) {
    const result = await processDeposit(deposit.id).catch(() => null);
    if (result?.credited) credited += 1;
  }

  // Polling fallback: addresses whose webhook deliveries may have been missed.
  const wallets = await query<FundingWalletRow>(
    `SELECT * FROM funding_wallets WHERE watch_status='watched' ORDER BY COALESCE(last_scanned_block, 0) ASC LIMIT $1`,
    [limit]
  );
  let reconciled = 0;
  for (const wallet of wallets) {
    const result = await reconcileWallet(wallet).catch(() => null);
    if (result?.status === "ok") reconciled += 1;
  }

  // Reorg check on recently credited deposits (bounded, most recent first).
  const creditedRows = await query<DepositRow>(
    `SELECT * FROM funding_deposits
      WHERE credited_at IS NOT NULL AND reorged_at IS NULL AND credited_at > now() - interval '2 days'
      ORDER BY credited_at DESC LIMIT $1`,
    [limit]
  );
  let reorgs = 0;
  for (const row of creditedRows) {
    const result = await detectReorg(row).catch(() => null);
    if (result?.flagged) reorgs += 1;
  }

  return { watches, events: events.length, deposits: pending.length, credited, reconciled, reorgs };
}

/** Available compute balance in micro-USD, using the canonical ledger convention. */
async function availableMicroUsd(accountId: string): Promise<string> {
  const rows = await query<{ available: string }>(
    `SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund','deposit','adjustment') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0),0)::text available FROM compute_ledger_entries WHERE account_id=$1`,
    [accountId]
  );
  return rows[0]?.available ?? "0";
}

/** Browser-safe funding state. No Privy ids, no webhook internals, no secrets. */
export type PublicDeposit = {
  id: string;
  txHash: string;
  status: "pending" | "confirmed" | "rejected";
  amountMicroUsd: string;
  /** Amount of USDG received, formatted with the configured decimals. */
  amountToken: string;
  assetSymbol: string;
  confirmations: number;
  requiredConfirmations: number;
  rejectionReason: string | null;
  /** Set when a credited deposit was reorged out; the credit is under review. */
  reorgFlagged: boolean;
  blockNumber: string | null;
  firstSeenAt: string;
  creditedAt: string | null;
};

function formatTokenAmount(rawAmount: string, decimals: number): string {
  let raw: bigint;
  try { raw = BigInt(rawAmount); } catch { return "0"; }
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function publicDeposit(deposit: DepositRow, cfg: FundingConfig): PublicDeposit {
  return {
    id: deposit.id,
    txHash: deposit.tx_hash,
    status: deposit.status,
    amountMicroUsd: deposit.amount_micro_usd,
    amountToken: formatTokenAmount(deposit.amount_raw, cfg.tokenDecimals),
    assetSymbol: FUNDING_TOKEN_SYMBOL_USDG,
    confirmations: deposit.confirmations,
    requiredConfirmations: cfg.confirmations,
    rejectionReason: deposit.rejection_reason,
    reorgFlagged: Boolean(deposit.reorged_at),
    blockNumber: deposit.block_number === null || deposit.block_number === undefined ? null : String(deposit.block_number),
    firstSeenAt: new Date(deposit.first_seen_at).toISOString(),
    creditedAt: deposit.credited_at ? new Date(deposit.credited_at).toISOString() : null,
  };
}

/** The monitoring state of a deposit address, as shown to its owner. */
export function publicWatchState(wallet: FundingWalletRow) {
  return {
    status: wallet.watch_status,
    watched: wallet.watch_status === "watched",
    registeredAt: wallet.watch_registered_at ? new Date(wallet.watch_registered_at).toISOString() : null,
    attempts: wallet.watch_attempts,
    lastError: wallet.watch_last_error,
    nextAttemptAt: new Date(wallet.watch_next_attempt_at).toISOString(),
  };
}

/**
 * Everything the Fund surface renders: whether funding is available at all, the
 * configured chain and USDG asset, the deposit address (once created) with its
 * monitoring state, the individual deposits with their confirmation progress, and
 * the resulting balance.
 */
export async function fundingState(accountId: string, options: { createWallet?: boolean } = {}) {
  const cfg = fundingConfig();
  if (!cfg.configured) {
    return {
      configured: false as const,
      message: cfg.unconfiguredReason ?? "Deposits are not configured on this deployment.",
      issues: cfg.issues,
      chain: null,
      token: null,
      wallet: null,
      monitoring: null,
      deposits: [] as PublicDeposit[],
      balanceMicroUsd: await availableMicroUsd(accountId),
      requiredConfirmations: cfg.confirmations,
    };
  }

  let wallet: FundingWalletRow | null = (await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE account_id=$1`, [accountId]))[0] ?? null;
  if (!wallet && options.createWallet) {
    wallet = (await getOrCreateFundingWallet(accountId)).wallet;
  }

  // An address that was never successfully watched is retried as the surface is
  // opened, so monitoring self-heals without operator action.
  if (wallet && wallet.watch_status !== "watched") {
    await ensureWalletWatched(wallet).catch(() => null);
    wallet = (await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE id=$1`, [wallet.id]))[0] ?? wallet;
  }

  // Deposits still in flight are re-checked as the surface is opened, so a missed
  // webhook does not strand a confirmed transfer.
  if (wallet) {
    const stale = await query<{ id: string }>(`SELECT id FROM funding_deposits WHERE account_id=$1 AND status='pending' AND (last_checked_at IS NULL OR last_checked_at < now() - interval '15 seconds') ORDER BY first_seen_at LIMIT 10`, [accountId]);
    for (const row of stale) await processDeposit(row.id).catch(() => null);
  }

  const deposits = await query<DepositRow>(`SELECT * FROM funding_deposits WHERE account_id=$1 ORDER BY first_seen_at DESC LIMIT 25`, [accountId]);
  return {
    configured: true as const,
    message: null,
    issues: [] as string[],
    chain: { id: cfg.chainId, name: cfg.chainName },
    token: fundingAsset(cfg),
    wallet: wallet ? { address: wallet.address, createdAt: new Date(wallet.created_at).toISOString() } : null,
    monitoring: wallet ? publicWatchState(wallet) : null,
    deposits: deposits.map((deposit) => publicDeposit(deposit, cfg)),
    balanceMicroUsd: await availableMicroUsd(accountId),
    requiredConfirmations: cfg.confirmations,
  };
}

export type FundingState = Awaited<ReturnType<typeof fundingState>>;

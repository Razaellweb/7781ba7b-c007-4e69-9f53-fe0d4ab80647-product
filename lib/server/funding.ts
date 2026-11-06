import { availableComputeMicroUsd } from "./accounting";
import { PrivyClient } from "@privy-io/server-auth";
import { fundingConfig, fundingReconcileConfig, privyConfig, privyWalletConfig, FUNDING_TOKEN_SYMBOL_USDG, type FundingConfig } from "./config";
import {
  AlchemyError,
  fetchIncomingTokenLogs,
  getBlockNumber,
  getTransactionReceiptInfo,
  isAlchemyRegistrationConfigReason,
  isAlchemyTransient,
  networkMatchesConfiguredChain,
  parseAddressActivity,
  registerMonitoredAddresses,
  registrationRetryDelaySeconds,
  transferLogToActivity,
  type AddressWatchRegistration,
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
//      This is NOT a user action: every server-side wallet in `funding_wallets` is
//      reconciled onto the Alchemy watch list by the lifecycle passes below, so
//      opening the Fund dialog is never required for monitoring to begin.
//   3. The user sends USDG on the configured chain. Alchemy notifies us (preferred),
//      and the polling fallback reads the same USDG Transfer logs when a delivery is
//      missed.
//   4. `eth_getTransactionReceipt` against `eth_blockNumber` gives the deposit's
//      depth on chain. At FUNDING_CONFIRMATIONS (three) the deposit is credited to
//      the account's compute ledger — exactly once — and the user-visible status
//      only then leaves `pending`.
//
// Watch-list lifecycle (all of it lives here, none of it needs a browser):
//   * ensureWalletWatched() registers ONE address (used when a wallet is created and
//     when a surface that already has that wallet asks it to self-heal).
//   * retryPendingWatches() retries addresses past their backoff, batched into a
//     single Alchemy call per group.
//   * registerUnwatchedWallets() is the population-wide pass: EVERY server-side
//     wallet that is not yet confirmed watched — including pre-existing rows
//     written before this feature, rows whose backoff has not elapsed, and rows that
//     used up their attempts while the Alchemy configuration was missing — is
//     submitted to the watch list. It runs on server boot, on each funding-status
//     visit and on each recovery sweep, so wallets become watched automatically once
//     configuration is supplied.
//   * Every outcome is written back truthfully: only an address Alchemy actually
//     accepted becomes `watched`. A configuration-gated miss is recorded with its
//     real reason but does NOT consume a registration attempt, so a later run with
//     the missing credential in place still registers it.
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
//   * Reconciliation skips (and reports) addresses that are not confirmed watched,
//     because Alchemy would not be monitoring them either.
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

/**
 * Addresses submitted to Alchemy's Notify API in one call. The dashboard API
 * accepts an address list, so a whole population of deposit addresses is added to
 * the watch list with a single round trip instead of one call per wallet.
 */
const WATCH_REGISTRATION_BATCH = 50;

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
 * Writes the true outcome of one Alchemy registration attempt onto the wallet rows.
 *
 * Success marks the address `watched` — and nothing else here ever does. Failure
 * records the provider's reason, and the two failure kinds are treated differently
 * on purpose:
 *   * A CONFIGURATION-gated miss (no RPC endpoint, no Notify token, no webhook, an
 *     unparseable network, an unusable address) says nothing about the address, so
 *     it is recorded without consuming a registration attempt and is retried on the
 *     very next run — which is what lets wallets become watched the moment the
 *     missing variable is supplied.
 *   * A real provider failure (HTTP error, unreachable dashboard) increments the
 *     attempt count and schedules the next try with exponential backoff.
 *
 * Returns the number of addresses that became watched.
 */
async function persistWatchOutcome(rows: FundingWalletRow[], registration: AddressWatchRegistration): Promise<number> {
  if (registration.monitored) {
    let watched = 0;
    for (const row of rows) {
      await query(
        `UPDATE funding_wallets
            SET watch_status='watched', watch_webhook_id=$2, watch_registered_at=now(),
                watch_attempts=watch_attempts+1, watch_last_error=NULL,
                watch_next_attempt_at=now(), updated_at=now()
          WHERE id=$1`,
        [row.id, registration.webhookId ?? null]
      );
      watched += 1;
      console.info(JSON.stringify({ event: "funding_wallet_watched", walletId: row.id, chainId: row.chain_id, batchSize: rows.length }));
    }
    return watched;
  }

  const reason = registration.reason ?? "alchemy_registration_failed";
  const configurationGated = isAlchemyRegistrationConfigReason(reason);
  for (const row of rows) {
    if (configurationGated) {
      await query(
        `UPDATE funding_wallets
            SET watch_status='failed', watch_last_error=$2, watch_next_attempt_at=now(), updated_at=now()
          WHERE id=$1`,
        [row.id, reason]
      );
    } else {
      const attempts = (row.watch_attempts ?? 0) + 1;
      await query(
        `UPDATE funding_wallets
            SET watch_status='failed', watch_attempts=$2, watch_last_error=$3,
                watch_next_attempt_at=now() + make_interval(secs => $4::double precision), updated_at=now()
          WHERE id=$1`,
        [row.id, attempts, reason, registrationRetryDelaySeconds(attempts)]
      );
    }
    console.warn(JSON.stringify({
      event: "funding_wallet_not_watched",
      walletId: row.id,
      attempts: configurationGated ? row.watch_attempts : (row.watch_attempts ?? 0) + 1,
      reason,
      configurationGated,
    }));
  }
  return 0;
}

/**
 * Registers a deposit address for Alchemy address-activity monitoring and persists
 * the outcome.
 *
 * A row becomes `watched` ONLY when Alchemy accepted the registration. Anything
 * else (missing Notify credentials, HTTP failure, unreachable dashboard) records a
 * `failed` state with the reason so `retryPendingWatches()` / the population sweep
 * pick it up again.
 */
export async function ensureWalletWatched(
  wallet: FundingWalletRow,
  options: { force?: boolean } = {},
): Promise<{ watched: boolean; reason?: string }> {
  if (wallet.watch_status === "watched" && !options.force) return { watched: true };

  const registration = await registerMonitoredAddresses([wallet.address]);
  const watched = await persistWatchOutcome([wallet], registration);
  return { watched: watched > 0, reason: registration.monitored ? undefined : registration.reason };
}

/**
 * Retries every address whose monitoring registration is not yet confirmed and
 * whose backoff has elapsed. This is what guarantees an address left unwatched by
 * an Alchemy outage is eventually watched rather than forgotten.
 *
 * Addresses are submitted to the watch list in BATCHES, so retrying a large backlog
 * costs a handful of Notify calls instead of one per wallet. Every accepted address
 * is promoted to `watched`; every rejected one keeps a truthful failure record.
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
  for (let index = 0; index < pending.length; index += WATCH_REGISTRATION_BATCH) {
    const batch = pending.slice(index, index + WATCH_REGISTRATION_BATCH);
    const registration = await registerMonitoredAddresses(batch.map((wallet) => wallet.address));
    watched += await persistWatchOutcome(batch, registration);
  }
  return { attempted: pending.length, watched };
}

/** Outcome of one population-wide watch registration pass. */
export type WatchRegistrationSweep = {
  /** Wallets submitted to the watch list this pass. */
  attempted: number;
  /** Wallets Alchemy accepted and that are now recorded `watched`. */
  watched: number;
  /** Notify calls issued (one per address batch). */
  batches: number;
  /** Why the pass could not register (configuration/provider), when it could not. */
  reason: string | null;
};

/**
 * Population-wide watch-list registration: submits EVERY server-side wallet that is
 * not yet confirmed watched to the Alchemy Address Activity webhook.
 *
 * This is the lifecycle pass that removes the old requirement for a user to open the
 * Fund dialog before monitoring could start. It deliberately ignores the backoff
 * window and the per-address attempt cap:
 *   * a pre-existing wallet row written before watch tracking existed has
 *     `watch_status = 'unwatched'` and is covered here;
 *   * a wallet whose registration failed while ALCHEMY_NOTIFY_AUTH_TOKEN /
 *     ALCHEMY_WEBHOOK_ID / ALCHEMY_WEBHOOK_SIGNING_KEY were missing must still be
 *     registered once they are supplied, and configuration-gated failures do not
 *     consume attempts, so the cap never locks it out;
 *   * a wallet whose backoff has not elapsed is still safely retried here because a
 *     repeat registration is a no-op at Alchemy and this pass is batched.
 *
 * Nothing is assumed: an address only becomes `watched` when Alchemy accepted it.
 * The pass is cheap when there is no work — an empty selection issues no HTTP call
 * at all — and cheap when there is, because addresses are submitted in batches.
 */
export async function registerUnwatchedWallets(limit = 200): Promise<WatchRegistrationSweep> {
  const wallets = await query<FundingWalletRow>(
    `SELECT * FROM funding_wallets
      WHERE watch_status <> 'watched'
      ORDER BY watch_next_attempt_at ASC, created_at ASC
      LIMIT $1`,
    [Math.max(1, limit)]
  ).catch((error) => {
    console.error(JSON.stringify({ event: "funding_watch_backfill_query_failed", error: error instanceof Error ? error.name : "unknown" }));
    return [] as FundingWalletRow[];
  });

  const sweep: WatchRegistrationSweep = { attempted: wallets.length, watched: 0, batches: 0, reason: null };
  if (wallets.length === 0) return sweep;

  for (let index = 0; index < wallets.length; index += WATCH_REGISTRATION_BATCH) {
    const batch = wallets.slice(index, index + WATCH_REGISTRATION_BATCH);
    const registration = await registerMonitoredAddresses(batch.map((wallet) => wallet.address));
    sweep.batches += 1;
    sweep.watched += await persistWatchOutcome(batch, registration);
    if (!registration.monitored) sweep.reason = registration.reason ?? "alchemy_registration_failed";
  }

  console.info(JSON.stringify({
    event: "funding_watch_backfill",
    attempted: sweep.attempted,
    watched: sweep.watched,
    batches: sweep.batches,
    reason: sweep.reason,
  }));
  return sweep;
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
    // A newly provisioned wallet joins the watch list immediately, without the user
    // having to interact with anything else.
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
// SET expressions read the existing row, so all three see the pre-update values.
const REOPEN_REJECTED = `funding_deposits.status = 'rejected' AND EXCLUDED.status = 'pending'
  AND funding_deposits.credited_at IS NULL AND funding_deposits.reorged_at IS NULL
  AND funding_deposits.rejection_reason IS DISTINCT FROM 'transaction_reverted'`;

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
           last_error = NULL,
           -- A transfer an earlier rule refused (e.g. the chain label check before
           -- it understood Alchemy's "ROBINHOOD_MAINNET") is re-opened when the
           -- same transfer validates now. Never one already credited, reorged, or
           -- found reverted on chain.
           status = CASE WHEN ${REOPEN_REJECTED} THEN 'pending' ELSE funding_deposits.status END,
           rejection_reason = CASE WHEN ${REOPEN_REJECTED} THEN NULL ELSE funding_deposits.rejection_reason END,
           amount_micro_usd = CASE WHEN ${REOPEN_REJECTED} THEN EXCLUDED.amount_micro_usd ELSE funding_deposits.amount_micro_usd END
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
 *
 * Confirmations are on-chain depth: the transfer's inclusion block plus every block
 * mined after it, measured against the chain head at the time of the check.
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
 * Upper bound on `eth_getLogs` windows scanned for one address in a single run.
 * A wallet that has been idle for a long time is caught up over consecutive runs
 * instead of issuing an unbounded number of log queries, which is what trips a
 * provider rate limit and would otherwise abort the whole sweep.
 */
const MAX_CHUNK_SCANS_PER_WALLET = 40;

/** Maps an RPC failure onto a stable reason code plus whether it is retryable. */
function reconcileFailure(error: unknown): { reason: string; transient: boolean } {
  if (error instanceof AlchemyError) {
    switch (error.code) {
      case "ALCHEMY_RATE_LIMITED": return { reason: "alchemy_rate_limited", transient: true };
      case "ALCHEMY_TIMEOUT": return { reason: "alchemy_timeout", transient: true };
      case "ALCHEMY_UNREACHABLE": return { reason: "alchemy_unreachable", transient: true };
      case "ALCHEMY_UPSTREAM_ERROR": return { reason: "alchemy_upstream_error", transient: true };
      case "ALCHEMY_UNCONFIGURED": return { reason: "alchemy_unconfigured", transient: false };
      case "ALCHEMY_INVALID_FILTER": return { reason: "alchemy_invalid_filter", transient: false };
      default: return { reason: "alchemy_error", transient: false };
    }
  }
  return { reason: "alchemy_error", transient: isAlchemyTransient(error) };
}

/** Per-address outcome of one polling sweep. Always carries a machine-readable reason. */
export type ReconcileWalletSummary = {
  walletId: string;
  accountId: string;
  address: string;
  status: "ok" | "skipped" | "partial" | "error";
  /** Why the address was skipped, or why the sweep stopped early. */
  reason: string | null;
  /** True when the stop was a rate limit/timeout and the work resumes next run. */
  transient: boolean;
  /** Chain head used for this sweep. */
  head: string | null;
  /** Inclusive block range actually scanned (null when nothing was scanned). */
  fromBlock: string | null;
  toBlock: string | null;
  /** Resume cursor before and after the sweep. */
  cursorBefore: string | null;
  cursorAfter: string | null;
  scannedChunks: number;
  scannedBlocks: string;
  /** Qualifying transfers recorded (credited or still pending confirmations). */
  recorded: number;
  credited: number;
  /** Transfers recorded but still short of FUNDING_CONFIRMATIONS. */
  pendingConfirmations: number;
  /** Logs filtered out because they were not the configured USDG / this address. */
  ignored: number;
};

/**
 * Why an address cannot be polled at all, or null when it can. Mirrors the
 * preconditions `reconcileWallet` checks before it issues any chain call, so the
 * sweep can report an address it deliberately did not touch without spending a
 * request to discover the same thing.
 */
function unsweepableReason(wallet: FundingWalletRow, cfg: FundingConfig): string | null {
  if (!cfg.configured) return "funding_unconfigured";
  // An address that is not confirmed watched is never polled: Alchemy would not be
  // monitoring it either, and crediting it would bypass the monitoring contract.
  if (wallet.watch_status !== "watched") return "address_not_watched";
  if (wallet.chain_id !== cfg.chainId) return "wrong_chain";
  if (wallet.token_address !== cfg.tokenAddressLower) return "wrong_token";
  return null;
}

/**
 * Polling fallback for one watched address: reads USDG Transfer logs addressed to
 * it and runs them through the exact same record/confirm/credit path the webhook
 * uses. The scan is filtered at the RPC level by contract address and the indexed
 * `to` topic, so nothing outside the configured asset reaches validation.
 *
 * Scanning is CHUNKED. On the first run (no cursor) it looks back
 * FUNDING_RECONCILE_CHUNK_BLOCKS from head. On later runs it resumes one block past
 * the stored cursor and walks forward in windows of the same size, so a large gap is
 * covered by several bounded `eth_getLogs` calls rather than one oversized query.
 * The cursor is advanced only after a window completes end to end, so a rate limit
 * or timeout part-way through leaves the remaining blocks to be retried — nothing
 * is skipped and nothing is re-scanned needlessly.
 */
export async function reconcileWallet(
  wallet: FundingWalletRow,
  options: { maxChunkBlocks?: number; maxChunks?: number } = {},
): Promise<ReconcileWalletSummary> {
  const summary: ReconcileWalletSummary = {
    walletId: wallet.id,
    accountId: wallet.account_id,
    address: wallet.address,
    status: "ok",
    reason: null,
    transient: false,
    head: null,
    fromBlock: null,
    toBlock: null,
    cursorBefore: wallet.last_scanned_block ?? null,
    cursorAfter: wallet.last_scanned_block ?? null,
    scannedChunks: 0,
    scannedBlocks: "0",
    recorded: 0,
    credited: 0,
    pendingConfirmations: 0,
    ignored: 0,
  };

  const cfg = fundingConfig();
  // Not watched (or otherwise not sweepable): reported as skipped, never polled.
  const unsweepable = unsweepableReason(wallet, cfg);
  if (unsweepable) return { ...summary, status: "skipped", reason: unsweepable };

  const { maxChunkBlocks } = fundingReconcileConfig();
  const chunk = BigInt(Math.max(1, options.maxChunkBlocks ?? maxChunkBlocks));
  const maxChunks = Math.max(1, options.maxChunks ?? MAX_CHUNK_SCANS_PER_WALLET);

  let head: bigint;
  try {
    head = await getBlockNumber();
  } catch (error) {
    const failure = reconcileFailure(error);
    console.warn(JSON.stringify({ event: "funding_reconcile_head_unavailable", walletId: wallet.id, reason: failure.reason, transient: failure.transient }));
    return { ...summary, status: failure.transient ? "partial" : "error", reason: failure.reason, transient: failure.transient };
  }
  summary.head = head.toString();

  const cursor = wallet.last_scanned_block !== null && wallet.last_scanned_block !== undefined
    ? BigInt(wallet.last_scanned_block)
    : null;
  // First run: look back exactly one chunk window from head. Later runs: resume
  // one block past the last fully-scanned block.
  const from = cursor !== null ? cursor + 1n : (head > chunk ? head - chunk : 0n);
  if (from > head) return { ...summary, status: "ok", reason: "up_to_date" };

  let recorded = 0;
  let credited = 0;
  let pendingConfirmations = 0;
  let ignored = 0;
  let scannedChunks = 0;
  let scannedBlocks = 0n;
  let cursorAfter: bigint | null = cursor;
  let start = from;
  let firstStart: bigint | null = null;
  let lastEnd: bigint | null = null;

  while (start <= head && scannedChunks < maxChunks) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n;
    let logs;
    try {
      logs = await fetchIncomingTokenLogs({ tokenAddress: cfg.tokenAddress, toAddress: wallet.address, fromBlock: start, toBlock: end });
    } catch (error) {
      const failure = reconcileFailure(error);
      console.warn(JSON.stringify({ event: "funding_reconcile_scan_failed", walletId: wallet.id, fromBlock: start.toString(), toBlock: end.toString(), reason: failure.reason, transient: failure.transient }));
      // The cursor stays where it was: this window and everything after it will be
      // retried on the next run, so no transfer is lost.
      return {
        ...summary,
        status: failure.transient ? "partial" : "error",
        reason: failure.reason,
        transient: failure.transient,
        fromBlock: (firstStart ?? start).toString(),
        toBlock: lastEnd === null ? null : lastEnd.toString(),
        cursorAfter: cursorAfter === null ? null : cursorAfter.toString(),
        scannedChunks,
        scannedBlocks: scannedBlocks.toString(),
        recorded,
        credited,
        pendingConfirmations,
        ignored,
      };
    }

    if (firstStart === null) firstStart = start;
    scannedChunks += 1;
    scannedBlocks += end - start + 1n;

    for (const log of logs) {
      // Defense in depth: the RPC filter already scopes these, but never credit an
      // unexpected contract, recipient, or non-positive amount.
      if (log.tokenAddress !== cfg.tokenAddressLower) {
        ignored += 1;
        console.warn(JSON.stringify({ event: "funding_reconcile_ignored_token", walletId: wallet.id, tokenAddress: log.tokenAddress }));
        continue;
      }
      if (!log.toAddress || log.toAddress !== wallet.address.toLowerCase()) {
        ignored += 1;
        console.warn(JSON.stringify({ event: "funding_reconcile_ignored_recipient", walletId: wallet.id, toAddress: log.toAddress }));
        continue;
      }
      if (!log.rawAmount || log.rawAmount === "0") {
        ignored += 1;
        console.warn(JSON.stringify({ event: "funding_reconcile_ignored_amount", walletId: wallet.id, txHash: log.txHash, logIndex: log.logIndex }));
        continue;
      }

      const deposit = await recordActivity(transferLogToActivity(log), wallet).catch((error) => {
        console.error(JSON.stringify({ event: "funding_reconcile_record_failed", walletId: wallet.id, txHash: log.txHash, logIndex: log.logIndex, error: error instanceof Error ? error.name : "unknown" }));
        return null;
      });
      if (!deposit) continue;
      recorded += 1;

      // The deposit row is durable at this point, so even if the depth check fails
      // transiently the transfer is recovered by the pending-deposit retry on the
      // next run instead of being lost.
      if (deposit.status === "pending") {
        const processed = await processDeposit(deposit.id).catch(() => null);
        if (processed?.credited) credited += 1;
        else pendingConfirmations += 1;
      } else if (deposit.status === "rejected") {
        ignored += 1;
      }
    }

    // Advance the resume cursor only once this window completed end to end.
    cursorAfter = end;
    lastEnd = end;
    await query(`UPDATE funding_wallets SET last_scanned_block=$2, updated_at=now() WHERE id=$1`, [wallet.id, end.toString()]);
    start = end + 1n;
  }

  return {
    ...summary,
    status: "ok",
    reason: null,
    fromBlock: (firstStart ?? from).toString(),
    toBlock: lastEnd === null ? null : lastEnd.toString(),
    cursorAfter: cursorAfter === null ? null : cursorAfter.toString(),
    scannedChunks,
    scannedBlocks: scannedBlocks.toString(),
    recorded,
    credited,
    pendingConfirmations,
    ignored,
  };
}

/** Aggregate outcome of one reconciliation sweep. */
export type FundingRecoverySummary = {
  /** "ok" when every step completed, "partial" when a transient fault stopped it. */
  status: "ok" | "partial";
  /** True when a rate limit/timeout cut the run short; the rest resumes next run. */
  partial: boolean;
  /** Machine-readable reason the run was partial (e.g. alchemy_rate_limited). */
  reason: string | null;
  watches: { attempted: number; watched: number };
  /** Population-wide watch-list pass (covers pre-existing wallets with no backoff). */
  watchBackfill: WatchRegistrationSweep;
  events: number;
  eventsFailed: number;
  deposits: number;
  credited: number;
  /** Wallets swept this run (including skipped ones). */
  wallets: number;
  /** Wallets fully reconciled. */
  reconciled: number;
  /** Wallets that stopped on a transient fault and resume next run. */
  partialWallets: number;
  /** Addresses deliberately not swept, with the reason for each. */
  skipped: Array<{ walletId: string; address: string; reason: string }>;
  /** Full per-address detail, including scanned block ranges and cursors. */
  walletResults: ReconcileWalletSummary[];
  reorgs: number;
  errors: string[];
  durationMs: number;
};

/**
 * Retry/recovery sweep: registers every not-yet-watched deposit address on the
 * Alchemy watch list, re-runs failed notifications, re-checks pending deposits
 * (including ones only seen once by Alchemy), polls for transfers a missed webhook
 * would have carried, and verifies credited deposits for reorgs. Safe to call from a
 * cron or the status endpoint.
 *
 * The watch step has two parts on purpose: the backoff-respecting retry (which
 * honours the per-address attempt cap) and then the population pass, which is what
 * brings PRE-EXISTING server-side wallets onto the watch list even if they were
 * written before watch tracking existed or exhausted their attempts while the
 * Alchemy configuration was missing. Both are batched Notify calls and both are
 * safe to repeat.
 *
 * The polling step is fault tolerant on purpose: a rate limit or timeout part-way
 * through stops the CHAIN WORK, reports a partial summary, and leaves every wallet
 * that was not processed eligible for the next run. Wallets already advanced keep
 * their persisted cursor, so progress is never lost and never re-scanned needlessly.
 * The sweep still VISITS every remaining candidate so each one is reported with its
 * reason (an unwatched address is skipped, a sweepable one is deferred) instead of
 * silently vanishing from the summary.
 */
export async function recoverFunding(limit = 25): Promise<FundingRecoverySummary> {
  const startedAt = Date.now();
  const { maxWalletsPerRun } = fundingReconcileConfig();
  const walletLimit = Math.max(1, Math.min(limit, maxWalletsPerRun));
  const cfg = fundingConfig();
  const errors: string[] = [];

  const watches = await retryPendingWatches(limit).catch((error) => {
    errors.push(`watch_retry:${error instanceof Error ? error.name : "unknown"}`);
    return { attempted: 0, watched: 0 };
  });

  // Population-wide registration: every server-side wallet that is still not
  // confirmed watched, regardless of backoff or the attempt cap.
  const watchBackfill = await registerUnwatchedWallets(Math.max(limit, 50)).catch((error) => {
    errors.push(`watch_backfill:${error instanceof Error ? error.name : "unknown"}`);
    return { attempted: 0, watched: 0, batches: 0, reason: null } as WatchRegistrationSweep;
  });

  const events = await query<{ id: string }>(`SELECT id FROM alchemy_webhook_events WHERE status IN ('received','failed') AND attempts < 8 ORDER BY received_at LIMIT $1`, [limit]).catch(() => [] as Array<{ id: string }>);
  let eventsFailed = 0;
  for (const event of events) {
    try {
      await replayWebhookEvent(event.id);
    } catch (error) {
      eventsFailed += 1;
      console.error(JSON.stringify({ event: "funding_event_retry_failed", eventRow: event.id, error: error instanceof Error ? error.name : "unknown" }));
    }
  }

  const pending = await query<{ id: string }>(`SELECT id FROM funding_deposits WHERE status='pending' AND attempts < 200 AND (last_checked_at IS NULL OR last_checked_at < now() - interval '20 seconds') ORDER BY first_seen_at LIMIT $1`, [limit]).catch(() => [] as Array<{ id: string }>);
  let credited = 0;
  for (const deposit of pending) {
    const result = await processDeposit(deposit.id).catch(() => null);
    if (result?.credited) credited += 1;
  }

  // Polling fallback. Watched addresses come FIRST (least recently scanned first),
  // so an address that can never be swept cannot starve the ones that can. Every
  // candidate is still visited and any address that is not watched is REPORTED as
  // skipped with its reason rather than silently disappearing from the sweep.
  const wallets = await query<FundingWalletRow>(
    `SELECT * FROM funding_wallets
      ORDER BY (watch_status <> 'watched') ASC, COALESCE(last_scanned_block, 0) ASC, updated_at ASC
      LIMIT $1`,
    [walletLimit]
  ).catch((error) => {
    errors.push(`wallet_query:${error instanceof Error ? error.name : "unknown"}`);
    return [] as FundingWalletRow[];
  });

  const walletResults: ReconcileWalletSummary[] = [];
  let reconciled = 0;
  let partialWallets = 0;
  let aborted = false;
  let partialReason: string | null = null;

  for (const wallet of wallets) {
    // A transient provider fault is not a per-wallet problem: once it happens the
    // sweep stops issuing chain calls so the remaining wallets stay untouched and
    // eligible for the next run. They are still VISITED and reported with the reason
    // they were not swept, so no address silently disappears from the summary.
    if (aborted) {
      const reason = unsweepableReason(wallet, cfg) ?? "sweep_deferred";
      walletResults.push({
        walletId: wallet.id,
        accountId: wallet.account_id,
        address: wallet.address,
        status: "skipped",
        reason,
        transient: false,
        head: null,
        fromBlock: null,
        toBlock: null,
        cursorBefore: wallet.last_scanned_block ?? null,
        cursorAfter: wallet.last_scanned_block ?? null,
        scannedChunks: 0,
        scannedBlocks: "0",
        recorded: 0,
        credited: 0,
        pendingConfirmations: 0,
        ignored: 0,
      });
      continue;
    }

    let result: ReconcileWalletSummary;
    try {
      result = await reconcileWallet(wallet);
    } catch (error) {
      const failure = reconcileFailure(error);
      errors.push(`wallet:${wallet.id}:${failure.reason}`);
      result = {
        walletId: wallet.id,
        accountId: wallet.account_id,
        address: wallet.address,
        status: failure.transient ? "partial" : "error",
        reason: failure.reason,
        transient: failure.transient,
        head: null,
        fromBlock: null,
        toBlock: null,
        cursorBefore: wallet.last_scanned_block ?? null,
        cursorAfter: wallet.last_scanned_block ?? null,
        scannedChunks: 0,
        scannedBlocks: "0",
        recorded: 0,
        credited: 0,
        pendingConfirmations: 0,
        ignored: 0,
      };
    }

    walletResults.push(result);
    credited += result.credited;
    if (result.status === "ok") reconciled += 1;
    if (result.status === "partial") {
      partialWallets += 1;
      aborted = true;
      partialReason = partialReason ?? result.reason;
    }
    if (result.status === "error" && result.reason) errors.push(`wallet:${wallet.id}:${result.reason}`);

    if (result.transient) {
      aborted = true;
      partialReason = partialReason ?? result.reason;
    }
  }

  // Reorg verification is skipped when the provider is already throttling us; it is
  // a safety net over already-credited value and runs on the next sweep.
  let reorgs = 0;
  if (!aborted) {
    const creditedRows = await query<DepositRow>(
      `SELECT * FROM funding_deposits
        WHERE credited_at IS NOT NULL AND reorged_at IS NULL AND credited_at > now() - interval '2 days'
        ORDER BY credited_at DESC LIMIT $1`,
      [limit]
    ).catch(() => [] as DepositRow[]);
    for (const row of creditedRows) {
      const result = await detectReorg(row).catch(() => null);
      if (result?.flagged) reorgs += 1;
    }
  }

  const skipped = walletResults
    .filter((result) => result.status === "skipped" && result.reason)
    .map((result) => ({ walletId: result.walletId, address: result.address, reason: result.reason as string }));

  const summary: FundingRecoverySummary = {
    status: aborted ? "partial" : "ok",
    partial: aborted,
    reason: aborted ? partialReason : null,
    watches,
    watchBackfill,
    events: events.length,
    eventsFailed,
    deposits: pending.length,
    credited,
    wallets: walletResults.length,
    reconciled,
    partialWallets,
    skipped,
    walletResults,
    reorgs,
    errors,
    durationMs: Date.now() - startedAt,
  };

  if (aborted) {
    console.warn(JSON.stringify({ event: "funding_reconcile_partial", reason: partialReason, wallets: walletResults.length, reconciled, credited, skipped: skipped.length }));
  }
  return summary;
}

/** Available compute balance in micro-USD, using the canonical ledger convention. */
async function availableMicroUsd(accountId: string): Promise<string> {
  return (await availableComputeMicroUsd(accountId)).toString();
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
    minimumDeposit: cfg.minDepositTokens,
  };
}

export type FundingState = Awaited<ReturnType<typeof fundingState>>;

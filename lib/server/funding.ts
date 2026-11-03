import { PrivyClient } from "@privy-io/server-auth";
import { fundingConfig, privyConfig, privyWalletConfig } from "./config";
import { AlchemyError, getTransactionConfirmations, networkMatchesConfiguredChain, parseAddressActivity, registerMonitoredAddress, type AlchemyAddressActivity } from "./alchemy";
import { query, transaction } from "./db";

// Funding: token deposits on the configured chain become compute balance.
//
// Flow
//   1. Fund -> getOrCreateFundingWallet(): one Privy server wallet per account.
//      The private key lives inside Privy; this app only ever stores the address.
//   2. The user sends the configured token (USDG) on the configured chain.
//   3. Alchemy monitors that address and notifies us. `eth_getTransactionReceipt`
//      against `eth_blockNumber` gives the deposit's depth on chain.
//   4. At FUNDING_CONFIRMATIONS (three) the deposit is credited to the account's
//      compute ledger — exactly once.
//
// Correctness rules enforced here:
//   * Only the configured token contract on the configured chain is credited.
//     Native-coin transfers, other tokens, and other networks are recorded as
//     `rejected` for audit and never touch the ledger.
//   * Multiple deposits are independent rows keyed by (chain, tx, logIndex).
//   * Credit is an idempotent ledger insert: the unique idempotency key is the
//     deposit identity, so duplicate notifications, retries, and concurrent
//     workers cannot credit the same transfer twice.
//   * A provider delivery that fails is retained and retried, and deposits left
//     pending (including ones only seen once by Alchemy) are re-checked.

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

export type FundingWalletRow = {
  id: string;
  account_id: string;
  privy_wallet_id: string;
  address: string;
  chain_id: number;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
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

function assetSymbolConfigured(symbol: string): string {
  return fundingConfig().tokenSymbol || symbol;
}

/**
 * Returns the account's funding wallet, creating it on first use.
 *
 * Wallet creation is deterministic per account: the row is claimed with
 * `ON CONFLICT (account_id) DO NOTHING`, so two concurrent clicks cannot create
 * two addresses. The Privy request carries our account id as the idempotency key
 * for the same reason.
 */
export async function getOrCreateFundingWallet(accountId: string): Promise<{ wallet: FundingWalletRow; created: boolean; monitored: boolean }> {
  const cfg = fundingConfig();
  if (!cfg.configured) throw new FundingError("Funding is not configured on this deployment.", "FUNDING_UNCONFIGURED", 503);

  const existing = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE account_id=$1`, [accountId]);
  if (existing[0]) {
    // Re-assert Alchemy monitoring so an address added elsewhere is re-registered.
    const registration = await registerMonitoredAddress(existing[0].address);
    return { wallet: existing[0], created: false, monitored: registration.monitored };
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
    [accountId, created.id, address, cfg.chainId, cfg.tokenAddress, cfg.tokenSymbol, cfg.tokenDecimals]
  );
  if (inserted[0]) {
    const registration = await registerMonitoredAddress(address);
    if (!registration.monitored) console.warn(JSON.stringify({ event: "funding_wallet_not_monitored", accountId, reason: registration.reason }));
    console.info(JSON.stringify({ event: "funding_wallet_created", accountId, chainId: cfg.chainId }));
    return { wallet: inserted[0], created: true, monitored: registration.monitored };
  }

  // Lost the race: another request inserted the wallet first. Use that one.
  const winner = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE account_id=$1`, [accountId]);
  if (!winner[0]) throw new FundingError("Funding address could not be stored.", "FUNDING_WALLET_UNAVAILABLE", 503);
  return { wallet: winner[0], created: false, monitored: false };
}

type DepositCandidate = {
  activity: AlchemyAddressActivity;
  wallet: FundingWalletRow;
};

/**
 * Resolves which funding wallet an Alchemy activity belongs to, and refuses
 * activities that are not a transfer *to* a monitored address.
 */
async function resolveCandidate(activity: AlchemyAddressActivity): Promise<DepositCandidate | null> {
  if (!activity.toAddress) return null;
  const rows = await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE address=$1`, [activity.toAddress]);
  if (!rows[0]) return null;
  return { activity, wallet: rows[0] };
}

/**
 * Records one Alchemy activity as a deposit row (pending or rejected).
 *
 * Deduplicated on (chain_id, tx_hash, log_index) so the same transfer reported by
 * several notifications — or by a retried delivery — updates one row instead of
 * creating duplicates.
 */
async function recordActivity(activity: AlchemyAddressActivity): Promise<{ deposit: DepositRow; inserted: boolean } | null> {
  const candidate = await resolveCandidate(activity);
  if (!candidate) return null;
  const cfg = fundingConfig();
  const { wallet } = candidate;

  // Native-coin transfers carry no contract address and are never credited.
  const tokenAddress = activity.tokenAddress;
  const isNative = tokenAddress === null && (activity.category === null || activity.category === "external" || activity.category === "internal");
  const isOurToken = tokenAddress !== null && tokenAddress === cfg.tokenAddress && wallet.token_address === cfg.tokenAddress;
  const rawAmount = activity.rawAmount;

  let rejection: string | null = null;
  if (!networkMatchesConfiguredChain(activity.network)) rejection = "wrong_chain";
  else if (isNative) rejection = "not_the_configured_token";
  else if (!isOurToken) rejection = "wrong_token";
  else if (!rawAmount || rawAmount === "0") rejection = "unreadable_amount";

  const decimals = activity.tokenDecimals ?? wallet.token_decimals;
  const microUsd = rejection ? 0n : tokenAmountToMicroUsd(rawAmount as string, decimals, cfg.microUsdPerToken);
  if (rejection === null && microUsd <= 0n) rejection = "below_minimum_amount";

  const rows = await query<DepositRow>(
    `INSERT INTO funding_deposits (account_id, funding_wallet_id, chain_id, token_address, tx_hash, log_index, from_address, to_address, amount_raw, amount_micro_usd, status, rejection_reason, last_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     ON CONFLICT (chain_id, tx_hash, log_index) DO UPDATE SET last_checked_at = now()
     RETURNING *`,
    [
      wallet.account_id,
      wallet.id,
      cfg.chainId,
      (tokenAddress ?? wallet.token_address).toLowerCase(),
      activity.txHash,
      activity.logIndex,
      activity.fromAddress,
      wallet.address,
      rawAmount && rawAmount !== "0" ? rawAmount : "1",
      microUsd.toString(),
      rejection ? "rejected" : "pending",
      rejection,
    ]
  );
  const deposit = rows[0];
  if (!deposit) return null;
  return { deposit, inserted: deposit.first_seen_at.getTime() === deposit.last_checked_at?.getTime() };
}

/**
 * Credits a deposit to the account's compute ledger, exactly once.
 *
 * The ledger insert carries a unique idempotency key built from the deposit
 * identity, so a duplicate call is a no-op that still returns the original entry.
 * The deposit row is only marked credited when the entry did not previously exist
 * for another deposit.
 */
async function creditDeposit(deposit: DepositRow): Promise<{ credited: boolean; ledgerEntryId: string | null }> {
  const microUsd = BigInt(deposit.amount_micro_usd);
  if (microUsd <= 0n) return { credited: false, ledgerEntryId: null };
  const idempotencyKey = `deposit:${deposit.chain_id}:${deposit.tx_hash}:${deposit.log_index}`;

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
          chainId: row.chain_id,
          tokenAddress: row.token_address,
          txHash: row.tx_hash,
          logIndex: row.log_index,
          fromAddress: row.from_address,
          toAddress: row.to_address,
          amountRaw: row.amount_raw,
          confirmations: row.confirmations,
        }),
      ]
    );

    // A concurrent worker may have won the insert; adopt its entry id.
    const ledgerEntryId = entry.rows[0]?.id
      ?? (await db.query<{ id: string }>(`SELECT id FROM compute_ledger_entries WHERE idempotency_key=$1`, [idempotencyKey])).rows[0]?.id
      ?? null;

    await db.query(
      `UPDATE funding_deposits SET status='confirmed', ledger_entry_id=$2, confirmed_at=COALESCE(confirmed_at, now()), credited_at=now(), last_error=NULL, last_checked_at=now() WHERE id=$1`,
      [row.id, ledgerEntryId]
    );

    console.info(JSON.stringify({ event: "funding_deposit_credited", depositId: row.id, accountId: row.account_id, chainId: row.chain_id, confirmations: row.confirmations }));
    return { credited: Boolean(entry.rows[0]), ledgerEntryId };
  });
}

/**
 * Re-checks one pending deposit: reads its depth from Alchemy and credits it once
 * the configured confirmation count is reached. Errors are recorded on the row so a
 * later retry can pick it up; they are never allowed to throw out of a webhook.
 */
export async function processDeposit(depositId: string): Promise<{ status: DepositRow["status"]; credited: boolean; confirmations: number }> {
  const cfg = fundingConfig();
  const rows = await query<DepositRow>(`SELECT * FROM funding_deposits WHERE id=$1`, [depositId]);
  const deposit = rows[0];
  if (!deposit) throw new FundingError("Deposit not found", "NOT_FOUND", 404);
  if (deposit.status === "rejected") return { status: "rejected", credited: false, confirmations: deposit.confirmations };
  if (deposit.credited_at) return { status: "confirmed", credited: false, confirmations: deposit.confirmations };

  let confirmations = deposit.confirmations;
  try {
    confirmations = await getTransactionConfirmations(deposit.tx_hash);
  } catch (error) {
    await query(`UPDATE funding_deposits SET attempts=attempts+1, last_error=$2, last_checked_at=now() WHERE id=$1`, [deposit.id, `alchemy:${error instanceof AlchemyError ? error.code : "rpc_error"}`]);
    return { status: "pending", credited: false, confirmations };
  }

  await query(`UPDATE funding_deposits SET confirmations=$2, last_checked_at=now(), last_error=NULL WHERE id=$1`, [deposit.id, confirmations]);
  if (confirmations < cfg.confirmations) return { status: "pending", credited: false, confirmations };

  const credit = await creditDeposit({ ...deposit, confirmations });
  return { status: credit.credited || credit.ledgerEntryId ? "confirmed" : "pending", credited: credit.credited, confirmations };
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
      const result = await recordActivity(activity);
      if (!result) continue;
      recorded += 1;
      if (result.deposit.status === "pending") {
        const processed = await processDeposit(result.deposit.id);
        if (processed.credited) credited += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({ event: "funding_activity_failed", txHash: activity.txHash, error: error instanceof Error ? error.name : "unknown" }));
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
 * Retry/recovery: re-runs failed notifications and re-checks pending deposits.
 * Called by the scheduled sweep and by the status endpoint, so a missed webhook
 * delivery does not lose a deposit.
 */
export async function recoverFunding(limit = 25): Promise<{ events: number; deposits: number; credited: number }> {
  const events = await query<{ id: string }>(`SELECT id FROM alchemy_webhook_events WHERE status IN ('received','failed') AND attempts < 8 ORDER BY received_at LIMIT $1`, [limit]);
  for (const event of events) {
    await replayWebhookEvent(event.id).catch((error) => console.error(JSON.stringify({ event: "funding_event_retry_failed", eventRow: event.id, error: error instanceof Error ? error.name : "unknown" })));
  }

  const pending = await query<{ id: string }>(`SELECT id FROM funding_deposits WHERE status='pending' AND attempts < 50 AND (last_checked_at IS NULL OR last_checked_at < now() - interval '20 seconds') ORDER BY first_seen_at LIMIT $1`, [limit]);
  let credited = 0;
  for (const deposit of pending) {
    const result = await processDeposit(deposit.id).catch(() => null);
    if (result?.credited) credited += 1;
  }
  return { events: events.length, deposits: pending.length, credited };
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
  amountToken: string;
  confirmations: number;
  requiredConfirmations: number;
  rejectionReason: string | null;
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

function publicDeposit(deposit: DepositRow): PublicDeposit {
  const cfg = fundingConfig();
  return {
    id: deposit.id,
    txHash: deposit.tx_hash,
    status: deposit.status,
    amountMicroUsd: deposit.amount_micro_usd,
    amountToken: formatTokenAmount(deposit.amount_raw, cfg.tokenDecimals),
    confirmations: deposit.confirmations,
    requiredConfirmations: cfg.confirmations,
    rejectionReason: deposit.rejection_reason,
    firstSeenAt: new Date(deposit.first_seen_at).toISOString(),
    creditedAt: deposit.credited_at ? new Date(deposit.credited_at).toISOString() : null,
  };
}

/**
 * Everything the Fund surface renders: whether funding is available at all, the
 * configured chain and token, the deposit address (once created), the individual
 * deposits with their confirmation progress, and the resulting balance.
 */
export async function fundingState(accountId: string, options: { createWallet?: boolean } = {}) {
  const cfg = fundingConfig();
  if (!cfg.configured) {
    return {
      configured: false as const,
      message: cfg.unconfiguredReason ?? "Funding is not configured on this deployment.",
      chain: null,
      token: null,
      wallet: null,
      deposits: [] as PublicDeposit[],
      balanceMicroUsd: await availableMicroUsd(accountId),
      requiredConfirmations: cfg.confirmations,
    };
  }

  let wallet: FundingWalletRow | null = (await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE account_id=$1`, [accountId]))[0] ?? null;
  if (!wallet && options.createWallet) {
    wallet = (await getOrCreateFundingWallet(accountId)).wallet;
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
    chain: { id: cfg.chainId, name: cfg.chainName },
    token: { address: cfg.tokenAddress, symbol: assetSymbolConfigured(cfg.tokenSymbol), decimals: cfg.tokenDecimals, microUsdPerToken: cfg.microUsdPerToken.toString() },
    wallet: wallet ? { address: wallet.address, createdAt: new Date(wallet.created_at).toISOString() } : null,
    deposits: deposits.map(publicDeposit),
    balanceMicroUsd: await availableMicroUsd(accountId),
    requiredConfirmations: cfg.confirmations,
  };
}

export type FundingState = Awaited<ReturnType<typeof fundingState>>;

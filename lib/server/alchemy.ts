import { createHmac, timingSafeEqual } from "node:crypto";
import { alchemyConfig } from "./config";

// Alchemy is the ONLY chain-monitoring provider in this funding flow.
//
// Three responsibilities live here and nowhere else:
//   1. Notifications. A funding address is registered on an Alchemy Address
//      Activity webhook, so Alchemy pushes every transfer that touches it. Each
//      delivery is authenticated with the webhook's signing key
//      (`X-Alchemy-Signature` = hex HMAC-SHA256 of the raw request body), which is
//      the signature mechanism Alchemy supports for webhooks.
//   2. Confirmation counting. Confirmations are read back from Alchemy's HTTP RPC
//      (`eth_getTransactionReceipt` against `eth_blockNumber`), so a deposit is only
//      credited once it actually has the configured depth on chain. The receipt's
//      block hash is returned too, which is what makes reorg detection possible.
//   3. Polling fallback. `eth_getLogs` filtered to the configured USDG contract and
//      the watched deposit address reconstructs the same transfers when webhook
//      deliveries are missed, so reconciliation never depends on a single channel.
//
// Credentials are read from the server environment and never leave this process.

export class AlchemyError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.code = code; this.name = "AlchemyError"; }
}

const NOTIFY_API = "https://dashboard.alchemy.com/api";

/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** True when an Alchemy RPC endpoint is configured (notifications optional). */
export function alchemyMonitoringEnabled(): boolean {
  return alchemyConfig().enabled;
}

/** True when webhook signature verification is possible. */
export function alchemyWebhooksEnabled(): boolean {
  const cfg = alchemyConfig();
  return cfg.webhookConfigured && Boolean(cfg.rpcUrl);
}

/** True when deposit addresses can actually be registered on a Notify webhook. */
export function alchemyRegistrationEnabled(): boolean {
  const cfg = alchemyConfig();
  return cfg.addressRegistrationConfigured && Boolean(cfg.network);
}

/**
 * Verifies an Alchemy webhook delivery.
 *
 * `signature` is the hex HMAC-SHA256 of the exact raw body, keyed with the
 * webhook's signing key. The body must be the unparsed bytes Alchemy sent: parsing
 * and re-serializing would change the payload and break the comparison.
 */
export function verifyAlchemySignature(rawBody: string, signature: string | null | undefined): boolean {
  const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim();
  if (!signingKey) return false;
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac("sha256", signingKey).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try { provided = Buffer.from(signature, "hex"); } catch { return false; }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Computes the signature Alchemy would send for a body (used by the tests). */
export function signAlchemyBody(rawBody: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(rawBody, "utf8").digest("hex");
}

/**
 * Optional bearer check. Alchemy does not require it, but an operator can pin a
 * shared secret on the webhook URL; it is accepted only when configured.
 */
export function verifyAlchemyAuthToken(authorization: string | null): boolean {
  const expected = alchemyConfig().authToken;
  if (!expected) return true;
  if (!authorization) return false;
  const provided = authorization.replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const cfg = alchemyConfig();
  if (!cfg.rpcUrl) throw new AlchemyError("Alchemy RPC is not configured", "ALCHEMY_UNCONFIGURED");
  const response = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  if (!response.ok) throw new AlchemyError(`Alchemy RPC failed with status ${response.status}`, "ALCHEMY_HTTP_ERROR");
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) throw new AlchemyError(payload.error.message ?? "Alchemy RPC error", "ALCHEMY_RPC_ERROR");
  return payload.result as T;
}

/** Current chain head according to Alchemy. */
export async function getBlockNumber(): Promise<bigint> {
  const hex = await rpc<string>("eth_blockNumber", []);
  return BigInt(hex);
}

export type TransactionReceiptInfo = {
  blockNumber: number;
  /** Lower-cased inclusion block hash, used to detect a reorg of a credited tx. */
  blockHash: string;
  status: string | null;
};

/** Full receipt identity for a transaction, or null while it is not mined. */
export async function getTransactionReceiptInfo(txHash: string): Promise<TransactionReceiptInfo | null> {
  const receipt = await rpc<{ blockNumber?: string; blockHash?: string; status?: string } | null>("eth_getTransactionReceipt", [txHash]);
  if (!receipt?.blockNumber || !receipt.blockHash) return null;
  return {
    blockNumber: Number(BigInt(receipt.blockNumber)),
    blockHash: receipt.blockHash.toLowerCase(),
    status: typeof receipt.status === "string" ? receipt.status.toLowerCase() : null,
  };
}

/**
 * Confirmations for a transfer, measured the way the brief specifies: the
 * transaction's inclusion block plus each block mined after it. A transfer whose
 * transaction is not in a block yet has zero confirmations.
 */
export async function getTransactionConfirmations(txHash: string): Promise<number> {
  const identity = await getTransactionReceiptInfo(txHash);
  if (!identity) return 0;
  const head = await getBlockNumber();
  const included = BigInt(identity.blockNumber);
  if (head < included) return 0;
  return Number(head - included) + 1;
}

export type AlchemyAddressActivity = {
  fromAddress: string | null;
  toAddress: string | null;
  txHash: string;
  logIndex: number;
  network: string | null;
  category: string | null;
  /** Human-readable asset label Alchemy reported (e.g. "USDC"), when present. */
  asset: string | null;
  /** Contract address of the transferred asset, lower-cased, when there is one. */
  tokenAddress: string | null;
  /** Raw integer amount as a decimal string, when Alchemy supplied it. */
  rawAmount: string | null;
  tokenDecimals: number | null;
};

const hexToDecimalString = (value: string | undefined | null): string | null => {
  if (!value) return null;
  if (/^0x[0-9a-f]+$/i.test(value)) return BigInt(value).toString(10);
  if (/^\d+$/.test(value)) return value;
  return null;
};

/**
 * Reads Alchemy's Address Activity payload into a provider-neutral shape.
 * Tolerant of both the documented `event.activity` envelope and a bare activity
 * array, because Alchemy has shipped both forms.
 */
export function parseAddressActivity(payload: unknown): AlchemyAddressActivity[] {
  const root = payload as { event?: { activity?: unknown; network?: unknown }; activity?: unknown; network?: unknown } | null;
  if (!root || typeof root !== "object") return [];
  const container = root.event ?? root;
  const rawActivity = (container as { activity?: unknown }).activity;
  const network = typeof (container as { network?: unknown }).network === "string" ? (container as { network: string }).network : null;
  if (!Array.isArray(rawActivity)) return [];
  const parsed: AlchemyAddressActivity[] = [];
  for (const entry of rawActivity) {
    if (!entry || typeof entry !== "object") continue;
    const activity = entry as {
      fromAddress?: string; toAddress?: string; hash?: string; blockNum?: string;
      logIndex?: string | number; category?: string; asset?: string; network?: string;
      rawContract?: { address?: string | null; rawValue?: string | null; decimal?: string | number | null };
    };
    const hash = typeof activity.hash === "string" ? activity.hash.toLowerCase() : null;
    if (!hash) continue;
    const contract = activity.rawContract?.address;
    const tokenAddress = typeof contract === "string" && /^0x[0-9a-fA-F]{40}$/.test(contract) ? contract.toLowerCase() : null;
    const decimalRaw = activity.rawContract?.decimal;
    const decimals = decimalRaw == null ? null : Number(hexToDecimalString(String(decimalRaw)) ?? decimalRaw);
    const logIndexRaw = activity.logIndex;
    const logIndex = logIndexRaw == null ? 0 : Number(hexToDecimalString(String(logIndexRaw)) ?? logIndexRaw) || 0;
    parsed.push({
      fromAddress: typeof activity.fromAddress === "string" ? activity.fromAddress.toLowerCase() : null,
      toAddress: typeof activity.toAddress === "string" ? activity.toAddress.toLowerCase() : null,
      txHash: hash,
      logIndex: Number.isFinite(logIndex) ? logIndex : 0,
      network: typeof activity.network === "string" ? activity.network : network,
      category: typeof activity.category === "string" ? activity.category : null,
      asset: typeof activity.asset === "string" ? activity.asset : null,
      tokenAddress,
      rawAmount: hexToDecimalString(activity.rawContract?.rawValue),
      tokenDecimals: decimals !== null && Number.isFinite(decimals) ? decimals : null,
    });
  }
  return parsed;
}

/** A single ERC-20 Transfer log, in the same shape as an address activity. */
export type TokenTransferLog = {
  txHash: string;
  logIndex: number;
  tokenAddress: string;
  fromAddress: string | null;
  toAddress: string | null;
  rawAmount: string | null;
  blockNumber: number;
};

function topicAddress(topic: string | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  const body = topic.slice(2).slice(-40);
  if (!/^[0-9a-fA-F]{40}$/.test(body)) return null;
  if (/^0+$/.test(body)) return null;
  return `0x${body.toLowerCase()}`;
}

function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function blockTag(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/**
 * Polling fallback: reads ERC-20 Transfer logs for the configured USDG contract
 * addressed to one watched deposit address. Filtering happens in the RPC call
 * itself (contract address + indexed `to` topic), so the payload can only ever
 * contain transfers of the configured token to the watched address.
 */
export async function fetchIncomingTokenLogs(params: {
  tokenAddress: string;
  toAddress: string;
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<TokenTransferLog[]> {
  const cfg = alchemyConfig();
  if (!cfg.rpcUrl || !cfg.network) throw new AlchemyError("Alchemy RPC is not configured", "ALCHEMY_UNCONFIGURED");
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.tokenAddress)) throw new AlchemyError("Invalid token address for log scan", "ALCHEMY_INVALID_FILTER");
  const to = BigInt(params.toBlock);
  let from = BigInt(params.fromBlock);
  if (from < 0n) from = 0n;
  if (to < from) return [];

  const logs = await rpc<Array<{ address?: string; topics?: string[]; data?: string; transactionHash?: string; logIndex?: string; blockNumber?: string; removed?: boolean }>>(
    "eth_getLogs",
    [{
      fromBlock: blockTag(from),
      toBlock: blockTag(to),
      address: params.tokenAddress.toLowerCase(),
      topics: [ERC20_TRANSFER_TOPIC, null, addressTopic(params.toAddress)],
    }]
  );
  if (!Array.isArray(logs)) return [];

  const transfers: TokenTransferLog[] = [];
  for (const log of logs) {
    if (!log || log.removed) continue;
    const txHash = typeof log.transactionHash === "string" ? log.transactionHash.toLowerCase() : null;
    const tokenAddress = typeof log.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(log.address) ? log.address.toLowerCase() : null;
    if (!txHash || !tokenAddress) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (topics.length < 3 || (topics[0] ?? "").toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    const rawAmount = hexToDecimalString(typeof log.data === "string" ? log.data : null);
    const logIndexRaw = typeof log.logIndex === "string" ? Number(BigInt(log.logIndex)) : Number.NaN;
    transfers.push({
      txHash,
      logIndex: Number.isFinite(logIndexRaw) ? logIndexRaw : 0,
      tokenAddress,
      fromAddress: topicAddress(topics[1]),
      toAddress: topicAddress(topics[2]),
      rawAmount,
      blockNumber: typeof log.blockNumber === "string" ? Number(BigInt(log.blockNumber)) : 0,
    });
  }
  return transfers;
}

/** Adapts a polled transfer log into the same shape webhook activities use. */
export function transferLogToActivity(log: TokenTransferLog): AlchemyAddressActivity {
  return {
    fromAddress: log.fromAddress,
    toAddress: log.toAddress,
    txHash: log.txHash,
    logIndex: log.logIndex,
    // The RPC endpoint belongs to the configured network by construction, so the
    // polled path reports the configured label rather than guessing from payload.
    network: alchemyConfig().network ?? null,
    category: "erc20",
    asset: null,
    tokenAddress: log.tokenAddress,
    rawAmount: log.rawAmount,
    tokenDecimals: null,
  };
}

/**
 * Registers a funding address on the Alchemy Address Activity webhook so Alchemy
 * monitors it.
 *
 * IMPORTANT: this reports success only when Alchemy actually accepted the
 * registration. A missing Notify token, an unaccepted HTTP status, or an
 * unreachable dashboard returns `monitored: false` with a reason, and the caller
 * keeps the address in a retryable, not-yet-watched state. Registration is never
 * assumed to have worked.
 */
export async function registerMonitoredAddress(address: string): Promise<{ monitored: boolean; reason?: string; webhookId?: string }> {
  const cfg = alchemyConfig();
  const notifyToken = cfg.notifyToken;
  const webhookId = cfg.webhookId;
  const webhookUrl = cfg.webhookUrl;
  const network = cfg.network;
  if (!cfg.apiKeyConfigured || !network) return { monitored: false, reason: "alchemy_unconfigured" };
  if (!notifyToken) return { monitored: false, reason: "alchemy_notify_unconfigured" };

  try {
    if (webhookId) {
      const response = await fetch(`${NOTIFY_API}/update-webhook-addresses`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Alchemy-Token": notifyToken },
        body: JSON.stringify({ webhook_id: webhookId, addresses_to_add: [address], addresses_to_remove: [] }),
        cache: "no-store",
      });
      if (!response.ok) return { monitored: false, reason: `alchemy_address_registration_failed_${response.status}` };
      return { monitored: true, webhookId };
    }
    if (webhookUrl) {
      const response = await fetch(`${NOTIFY_API}/create-webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Alchemy-Token": notifyToken },
        body: JSON.stringify({ network: alchemyWebhookNetwork(network), webhook_type: "ADDRESS_ACTIVITY", webhook_url: webhookUrl, addresses: [address] }),
        cache: "no-store",
      });
      if (!response.ok) return { monitored: false, reason: `alchemy_webhook_create_failed_${response.status}` };
      const payload = await response.json().catch(() => null) as { data?: { id?: string } } | null;
      const createdId = payload?.data?.id;
      return { monitored: true, webhookId: typeof createdId === "string" ? createdId : undefined };
    }
    return { monitored: false, reason: "alchemy_notify_unconfigured" };
  } catch {
    return { monitored: false, reason: "alchemy_notify_unreachable" };
  }
}

/** Alchemy network identifiers we accept as "the configured chain". */
export function networkMatchesConfiguredChain(observed: string | null): boolean {
  const configured = alchemyConfig().network;
  // When no Alchemy network label is configured there is nothing to contradict the
  // chain id we already validated server-side.
  if (!configured) return true;
  if (!observed) return true;
  // Webhooks label the chain "ROBINHOOD_MAINNET"; the configured name is in
  // hostname form ("robinhood-mainnet"). Compare them as the same identifier.
  return alchemyWebhookNetwork(observed) === alchemyWebhookNetwork(configured);
}

/** A network name in the form Alchemy's Notify API uses ("ROBINHOOD_MAINNET"). */
export function alchemyWebhookNetwork(network: string): string {
  return network.trim().toUpperCase().replace(/-/g, "_");
}

/**
 * Exponential backoff (seconds) for a failed address registration, capped at one
 * hour. Attempt 1 waits 30s, then 60s, 120s … so an Alchemy outage is retried
 * without hammering the dashboard API.
 */
export function registrationRetryDelaySeconds(attempts: number): number {
  const safe = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  return Math.min(30 * 2 ** (safe - 1), 3600);
}

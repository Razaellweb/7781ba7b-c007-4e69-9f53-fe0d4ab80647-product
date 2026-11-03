import { createHmac, timingSafeEqual } from "node:crypto";
import { alchemyConfig } from "./config";

// Alchemy is the ONLY chain-monitoring provider in this funding flow.
//
// Two responsibilities live here and nowhere else:
//   1. Notifications. A funding address is registered on an Alchemy Address
//      Activity webhook, so Alchemy pushes every transfer that touches it. Each
//      delivery is authenticated with the webhook's signing key
//      (`X-Alchemy-Signature` = hex HMAC-SHA256 of the raw request body), which is
//      the signature mechanism Alchemy supports for webhooks.
//   2. Confirmation counting. Confirmations are read back from Alchemy's HTTP RPC
//      (`eth_getTransactionReceipt` against `eth_blockNumber`), so a deposit is only
//      credited once it actually has the configured depth on chain.
//
// Credentials are read from the server environment and never leave this process.

export class AlchemyError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.code = code; this.name = "AlchemyError"; }
}

const NOTIFY_API = "https://dashboard.alchemy.com/api";

/** True when an Alchemy RPC endpoint is configured (notifications optional). */
export function alchemyMonitoringEnabled(): boolean {
  return alchemyConfig().enabled;
}

/** True when webhook signature verification is possible. */
export function alchemyWebhooksEnabled(): boolean {
  const cfg = alchemyConfig();
  return cfg.webhookConfigured && Boolean(cfg.rpcUrl);
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

/**
 * Confirmations for a transfer, measured the way the brief specifies: the
 * transaction's inclusion block plus each block mined after it. A transfer whose
 * transaction is not in a block yet has zero confirmations.
 */
export async function getTransactionConfirmations(txHash: string): Promise<number> {
  const receipt = await rpc<{ blockNumber?: string } | null>("eth_getTransactionReceipt", [txHash]);
  if (!receipt?.blockNumber) return 0;
  const included = BigInt(receipt.blockNumber);
  const head = await getBlockNumber();
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

/**
 * Registers a funding address on the Alchemy Address Activity webhook so Alchemy
 * monitors it. Best-effort: when the notify API is unconfigured the address is
 * still reconciled by the sweep, which reads the same Alchemy RPC.
 */
export async function registerMonitoredAddress(address: string): Promise<{ monitored: boolean; reason?: string }> {
  const cfg = alchemyConfig();
  const notifyToken = process.env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
  const webhookId = process.env.ALCHEMY_WEBHOOK_ID?.trim();
  const webhookUrl = process.env.ALCHEMY_WEBHOOK_URL?.trim();
  const network = cfg.network;
  if (!cfg.apiKeyConfigured || !network) return { monitored: false, reason: "alchemy_unconfigured" };

  try {
    if (notifyToken && webhookId) {
      const response = await fetch(`${NOTIFY_API}/update-webhook-addresses`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Alchemy-Token": notifyToken },
        body: JSON.stringify({ webhook_id: webhookId, addresses_to_add: [address], addresses_to_remove: [] }),
        cache: "no-store",
      });
      if (!response.ok) return { monitored: false, reason: `alchemy_address_registration_failed_${response.status}` };
      return { monitored: true };
    }
    if (notifyToken && webhookUrl) {
      const response = await fetch(`${NOTIFY_API}/create-webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Alchemy-Token": notifyToken },
        body: JSON.stringify({ network, webhook_type: "ADDRESS_ACTIVITY", webhook_url: webhookUrl, addresses: [address] }),
        cache: "no-store",
      });
      if (!response.ok) return { monitored: false, reason: `alchemy_webhook_create_failed_${response.status}` };
      return { monitored: true };
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
  return observed.toUpperCase() === configured.toUpperCase();
}

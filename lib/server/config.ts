import { getAddress } from "viem";

export class ConfigurationError extends Error {
  readonly code = "CONFIGURATION_ERROR";
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}

function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new ConfigurationError(`Missing required server configuration: ${name}`); return value; }
function optional(name: string): string | undefined { const value = process.env[name]?.trim(); return value || undefined; }
function integer(name: string, fallback?: number): number { const raw = optional(name); if (!raw && fallback !== undefined) return fallback; const value = Number(raw); if (!Number.isInteger(value) || value < 0) throw new ConfigurationError(`Invalid integer server configuration: ${name}`); return value; }
export function databaseConfig() { const raw = optional("DATABASE_URL") ?? optional("POSTGRES_URL"); if (!raw && !optional("PGHOST")) throw new ConfigurationError("Missing required server configuration: DATABASE_URL or PGHOST"); const url = raw?.replace(/([?&])sslmode=[^&]*(&|$)/i, (_m, p1, p2) => (p2 === "&" ? p1 : "")).replace(/[?&]$/, ""); const managed = Boolean(url && /supabase|amazonaws|pooler|render|neon|railway/.test(url)); return { connectionString: url, host: optional("PGHOST"), port: integer("PGPORT", 5432), database: optional("PGDATABASE"), user: optional("PGUSER"), password: optional("PGPASSWORD"), ssl: managed || process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined, max: integer("PG_POOL_MAX", 5) }; }
export function redisConfig() { const url = optional("UPSTASH_REDIS_REST_URL") ?? optional("REDIS_REST_URL"); const token = optional("UPSTASH_REDIS_REST_TOKEN") ?? optional("REDIS_REST_TOKEN"); return { enabled: Boolean(url && token), url, token, keyPrefix: optional("REDIS_KEY_PREFIX") ?? "openweight:" }; }
// Access control is identity-based: a verified Privy identity is sufficient to
// open a session and authorize workspace/inference use. There is intentionally no
// chain, RPC, or token-holding configuration in this module any more.
//
// The recurring compute allowance defaults to ZERO. There is no placeholder or
// demo credit: an account that has never been funded reads exactly $0.00, and a
// balance only appears once value is reflected in the compute ledger (a credited
// funding deposit). An operator can still configure an explicit grant amount,
// which is the only way the allowance mechanism ever credits anything.
export function allowanceConfig() { const amount = optional("OPENWEIGHT_GRANT_AMOUNT_MICRO_USD"); return { amountMicroUsd: BigInt(amount ?? "0"), recurrence: (optional("OPENWEIGHT_GRANT_RECURRENCE") ?? "MONTHLY").toUpperCase(), durationSeconds: integer("OPENWEIGHT_GRANT_DURATION_SECONDS", 2592000) }; }
export function pricingConfig() { const raw = optional("DEFAULT_MARKUP_MULTIPLIER") ?? "2.0"; const multiplier = Number(raw); if (!Number.isFinite(multiplier) || multiplier <= 0) throw new ConfigurationError("DEFAULT_MARKUP_MULTIPLIER must be a positive number"); return { defaultMarkupMicro: BigInt(Math.round(multiplier * 1_000_000)), defaultMinChargeMicroUsd: BigInt(optional("DEFAULT_MIN_CHARGE_MICRO_USD") ?? "0"), reservationCapMicroUsd: BigInt(optional("INFERENCE_RESERVATION_CAP_MICRO_USD") ?? "500000") }; }
export function userRateLimit() { return integer("INFERENCE_USER_RATE_LIMIT_PER_MINUTE", 20); }
export function privyConfig() { return { appId: required("PRIVY_APP_ID"), appSecret: required("PRIVY_APP_SECRET") }; }
export function openRouterConfig() { const enabled = (optional("OPENROUTER_ENABLED") ?? "false") === "true"; if (!enabled) return { enabled: false as const }; return { enabled: true as const, apiKey: required("OPENROUTER_API_KEY"), baseUrl: optional("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1" }; }
// Vast.ai GPU marketplace credentials. This is a SERVER-ONLY boundary: the key is
// read from the process environment, is only ever attached to outbound requests by
// lib/server/vast.ts, and is never returned to a client, embedded in a response
// body, or written to a log. Like openRouterConfig(), a disabled/missing key is a
// normal configuration state rather than a hard crash, so the offers endpoint can
// degrade to a sanitized "temporarily unavailable" response.
// The project's environment settings are seeded with VAST_API_KEY_PLACEHOLDER so
// the variable is visible and editable before a real key exists. The placeholder
// counts as a missing key: it is reported as "unconfigured" and never sent upstream.
export const VAST_API_KEY_PLACEHOLDER = "REPLACE_WITH_YOUR_VAST_API_KEY";
// GPU rental economics and guardrails. The user's hourly rate is the provider's
// hourly cost times GPU_MARKUP_MULTIPLIER (default 1.15, the 15% margin). Time is
// prepaid in GPU_BILLING_BLOCK_MINUTES blocks from the compute allowance.
function positiveNumber(name: string, fallback: number): number { const raw = optional(name); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value) || value <= 0) throw new ConfigurationError(`${name} must be a positive number`); return value; }
export function gpuRentalConfig() { const markup = positiveNumber("GPU_MARKUP_MULTIPLIER", 1.15); const productionHost = optional("VERCEL_PROJECT_PRODUCTION_URL"); return { markupMicro: BigInt(Math.round(markup * 1_000_000)), blockMinutes: Math.max(10, Math.round(positiveNumber("GPU_BILLING_BLOCK_MINUTES", 60))), maxHourlyUsd: positiveNumber("GPU_MAX_HOURLY_USD", 5), maxActiveRentals: Math.max(1, Math.round(positiveNumber("GPU_MAX_ACTIVE_RENTALS", 2))), diskGb: Math.round(positiveNumber("GPU_DISK_GB", 40)), appBaseUrl: (optional("APP_BASE_URL") ?? (productionHost ? `https://${productionHost}` : undefined))?.replace(/\/+$/, ""), cronSecret: optional("CRON_SECRET") }; }
export function vastConfig() { const raw = optional("VAST_API_KEY"); const apiKey = raw === VAST_API_KEY_PLACEHOLDER ? undefined : raw; if (!apiKey) return { enabled: false as const, apiKey: undefined, baseUrl: undefined }; return { enabled: true as const, apiKey, baseUrl: (optional("VAST_API_BASE_URL") ?? "https://console.vast.ai/api/v0").replace(/\/+$/, "") }; }

/* ==========================================================================
   Funding (USDG deposit -> compute balance)

   The funding asset is USDG on a Robinhood Chain network, and nothing else.

   Defaults come ONLY from the verified USDG registry entry for the active chain:
   `USDG_NETWORK_REGISTRY[chainId]` supplies the token address and decimals (and
   USDG is the only symbol) when and only when that entry exists and `verified` is
   true. An unverified entry is never used as a fallback, so funding stays closed
   on a network whose USDG deployment nobody has confirmed.

   The active chain is resolved in the order FUNDING_CHAIN_ID, ROBINHOOD_CHAIN_ID,
   NEXT_PUBLIC_ROBINHOOD_CHAIN_ID, defaulting to Robinhood Chain mainnet (4663)
   only when none of them is set. A value that IS set but is unusable (nonnumeric,
   not a positive integer, or not a known funding network) fails closed instead of
   silently falling back to the default.

   An explicit FUNDING_TOKEN_ADDRESS / FUNDING_TOKEN_DECIMALS / FUNDING_TOKEN_SYMBOL
   still wins over the registry default, but it must survive the same validation as
   before: EIP-55 checksummed, the verified USDG contract for the active network,
   decimals an integer in 0..36 that matches the registry entry, and the symbol
   USDG. Anything else reports itself unconfigured (fail closed) with an explicit
   reason instead of guessing.

   There is deliberately NO HOLDER_TOKEN_ADDRESS fallback: an unrelated holder token
   can never be credited by accident.

   Deposit credit uses this project's existing compute ledger convention: balances
   are integer micro-USD (`compute_ledger_entries.amount_micro_usd`). USDG is a
   USD-denominated stablecoin, so one whole token equals one USD of compute
   allowance by default (1 token = 1_000_000 micro-USD). FUNDING_USD_PER_TOKEN lets
   an operator change that without a code change.
   ========================================================================== */

// How many block confirmations a transfer must reach before it is credited. The
// product requirement is three; the environment override exists for other nets.
const FUNDING_CONFIRMATIONS_DEFAULT = 3;

/** The only asset this deployment accepts for deposits. */
export const FUNDING_TOKEN_SYMBOL_USDG = "USDG";

/**
 * USDG on Robinhood Chain mainnet. Verified 2026-11-04: Paxos (the issuer) lists
 * it as the Robinhood Mainnet token address (docs.paxos.com/guides/stablecoin/
 * usdg/mainnet), and the contract on chain 4663 reports name "Global Dollar",
 * symbol "USDG" and 6 decimals.
 */
export const USDG_MAINNET_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_MAINNET_DECIMALS = 6;

/**
 * Per-network USDG configuration. Addresses are NEVER shared between networks:
 * Robinhood Chain mainnet (4663) and testnet (46630) are distinct deploy
 * environments with distinct USDG deployments, so each entry carries its own
 * address, decimals, and verification state.
 *
 * `verified` is only true once somebody has confirmed the address and decimals
 * against official Robinhood Chain / Global Dollar documentation and recorded the
 * source. While it is false, funding is closed on that network on purpose.
 */
export type UsdgNetworkEntry = {
  chainId: number;
  chainName: string;
  /** Verified USDG contract address (EIP-55 checksummed), or null while unverified. */
  tokenAddress: string | null;
  /** Verified USDG decimals on this network, or null while unverified. */
  tokenDecimals: number | null;
  verified: boolean;
  verificationSource: string | null;
  /** Address under consideration that has NOT been verified yet. Never enabled. */
  pendingVerificationAddress: string | null;
  /** Confirmations required on this network before credit. */
  confirmations: number;
};

export type UsdgNetworkRegistry = Record<number, UsdgNetworkEntry>;

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

/** Network used when no chain-selection variable is present at all. */
export const DEFAULT_FUNDING_CHAIN_ID = ROBINHOOD_MAINNET_CHAIN_ID;

// Chain-selection precedence: the first variable that is SET wins, even if its
// value turns out to be unusable (an explicit bad value never silently falls back).
const FUNDING_CHAIN_ENV_NAMES = ["FUNDING_CHAIN_ID", "ROBINHOOD_CHAIN_ID", "NEXT_PUBLIC_ROBINHOOD_CHAIN_ID"] as const;

// Mainnet USDG is verified (see USDG_MAINNET_ADDRESS). Testnet has no verified
// USDG deployment, so funding stays closed there. Flip an entry only after
// confirming its address and decimals in official docs, and record the source.
export const USDG_NETWORK_REGISTRY: UsdgNetworkRegistry = {
  [ROBINHOOD_MAINNET_CHAIN_ID]: {
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    chainName: "Robinhood Chain Mainnet",
    tokenAddress: USDG_MAINNET_ADDRESS,
    tokenDecimals: USDG_MAINNET_DECIMALS,
    verified: true,
    verificationSource: "Paxos USDG mainnet docs (docs.paxos.com/guides/stablecoin/usdg/mainnet) + on-chain name/symbol/decimals read on chain 4663, 2026-11-04",
    pendingVerificationAddress: null,
    confirmations: FUNDING_CONFIRMATIONS_DEFAULT,
  },
  [ROBINHOOD_TESTNET_CHAIN_ID]: {
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    chainName: "Robinhood Chain Testnet",
    tokenAddress: null,
    tokenDecimals: null,
    verified: false,
    verificationSource: null,
    pendingVerificationAddress: null,
    confirmations: FUNDING_CONFIRMATIONS_DEFAULT,
  },
};

export type FundingConfig = {
  configured: boolean;
  unconfiguredReason: string | null;
  /** Every individual configuration problem found, for startup logging/tests. */
  issues: string[];
  chainId: number;
  chainName: string;
  /** EIP-55 checksummed USDG contract address, or "" when unusable. */
  tokenAddress: string;
  /** Lower-cased form of `tokenAddress` for storage and transfer matching. */
  tokenAddressLower: string;
  tokenSymbol: string;
  tokenDecimals: number;
  confirmations: number;
  /** Micro-USD credited per whole token. */
  microUsdPerToken: bigint;
  /** Smallest deposit that receives credit, in whole-token units. */
  minDepositTokens: string;
};

/**
 * Validates an EVM address the strict way: 20 bytes, 0x-prefixed, and EIP-55
 * checksummed. A bare lower/upper-case address is rejected because a mistyped
 * funding contract would silently black-hole deposits.
 */
function checksummedAddress(raw: string): { address: string } | { error: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return { error: "is not a 20-byte 0x-prefixed EVM address" };
  const body = raw.slice(2);
  if (body === body.toLowerCase()) return { error: "is not EIP-55 checksummed (all lower case)" };
  if (body === body.toUpperCase()) return { error: "is not EIP-55 checksummed (all upper case)" };
  let checksummed: string;
  try { checksummed = getAddress(raw); } catch { return { error: "has an invalid EIP-55 checksum" }; }
  if (checksummed !== raw) return { error: "has an invalid EIP-55 checksum" };
  return { address: checksummed };
}

export function fundingConfig(options: { networkRegistry?: UsdgNetworkRegistry } = {}): FundingConfig {
  const registry = options.networkRegistry ?? USDG_NETWORK_REGISTRY;
  const supported = Object.values(registry).map((entry) => `${entry.chainId} (${entry.chainName})`).join(", ");
  const issues: string[] = [];

  // 1) Active network. FUNDING_CHAIN_ID beats ROBINHOOD_CHAIN_ID beats
  //    NEXT_PUBLIC_ROBINHOOD_CHAIN_ID; the default applies only when none is set.
  const selectedChain = FUNDING_CHAIN_ENV_NAMES
    .map((name) => [name, optional(name)] as const)
    .find(([, value]) => value !== undefined);
  let chainId = 0;
  if (!selectedChain) {
    // No chain was chosen at all: use the default network. It is still required to
    // exist in the registry, so this can never resolve to an empty asset.
    if (registry[DEFAULT_FUNDING_CHAIN_ID]) chainId = DEFAULT_FUNDING_CHAIN_ID;
    else issues.push(`FUNDING_CHAIN_ID is not set and the default chain ${DEFAULT_FUNDING_CHAIN_ID} is not a supported USDG funding network (supported: ${supported})`);
  } else {
    const [name, chainRaw] = selectedChain;
    const parsed = Number(chainRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) issues.push(`${name} is not a positive integer chain id: ${chainRaw}`);
    else if (!registry[parsed]) issues.push(`${name} ${parsed} is not a supported USDG funding network (supported: ${supported})`);
    else chainId = parsed;
  }
  const entry = chainId ? registry[chainId] : undefined;
  const chainName = entry?.chainName ?? optional("FUNDING_CHAIN_NAME") ?? "Robinhood Chain";

  // A registry entry is only usable as a source of defaults when it is verified AND
  // actually carries an address and decimals. An unverified entry is NEVER used.
  const verifiedEntry = entry && entry.verified && entry.tokenAddress && entry.tokenDecimals !== null ? entry : undefined;

  // 2) Asset symbol. USDG is the only creditable asset, and the default.
  const symbolRaw = optional("FUNDING_TOKEN_SYMBOL");
  if (symbolRaw !== undefined && symbolRaw.toUpperCase() !== FUNDING_TOKEN_SYMBOL_USDG) {
    issues.push(`FUNDING_TOKEN_SYMBOL is ${symbolRaw}; deposits are credited in ${FUNDING_TOKEN_SYMBOL_USDG} only`);
  }

  // 3) Decimals. An explicit value wins, otherwise the verified registry value for
  //    the active network is used. Nothing is guessed for an unverified network.
  const decimalsRaw = optional("FUNDING_TOKEN_DECIMALS");
  let tokenDecimals = 0;
  if (decimalsRaw === undefined) {
    if (verifiedEntry) tokenDecimals = verifiedEntry.tokenDecimals as number;
  } else {
    const parsed = Number(decimalsRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36) issues.push(`FUNDING_TOKEN_DECIMALS is not an integer between 0 and 36: ${decimalsRaw}`);
    else tokenDecimals = parsed;
  }

  // 4) Address. An explicit value wins, otherwise the verified registry address for
  //    the active network is used. There is no other fallback.
  const addressRaw = optional("FUNDING_TOKEN_ADDRESS");
  let tokenAddress = "";
  if (addressRaw === undefined) {
    if (verifiedEntry) tokenAddress = verifiedEntry.tokenAddress as string;
  } else {
    const parsed = checksummedAddress(addressRaw);
    if ("error" in parsed) issues.push(`FUNDING_TOKEN_ADDRESS ${parsed.error}: ${addressRaw}`);
    else tokenAddress = parsed.address;
  }

  // 5) Network-specific verification. An address is only usable on the network it
  //    was verified for; an unverified or unknown entry keeps funding closed.
  if (entry) {
    if (!verifiedEntry) {
      const candidate = entry.pendingVerificationAddress ? ` The supplied candidate ${entry.pendingVerificationAddress} is unverified; confirm USDG's address and decimals for ${entry.chainName} (chain id ${entry.chainId}) against official Robinhood Chain documentation before enabling it.` : "";
      issues.push(`USDG is not verified for ${entry.chainName} (chain id ${entry.chainId}), so funding is closed.${candidate}`);
    } else if (tokenAddress) {
      if (verifiedEntry.tokenAddress!.toLowerCase() !== tokenAddress.toLowerCase()) {
        issues.push(`FUNDING_TOKEN_ADDRESS ${tokenAddress} is not the verified USDG contract ${verifiedEntry.tokenAddress} on ${entry.chainName} (chain id ${entry.chainId})`);
      }
      if (tokenDecimals !== verifiedEntry.tokenDecimals) {
        issues.push(`FUNDING_TOKEN_DECIMALS is ${tokenDecimals} but USDG uses ${verifiedEntry.tokenDecimals} decimals on ${entry.chainName}`);
      }
      for (const other of Object.values(registry)) {
        if (other.chainId === entry.chainId) continue;
        if (other.tokenAddress && other.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()) {
          issues.push(`USDG address ${tokenAddress} is already assigned to ${other.chainName}; each Robinhood Chain network needs its own USDG contract address`);
        }
      }
    }
  }

  const pin = optional("FUNDING_USD_PER_TOKEN");
  const pinMicro = pin === undefined ? 1_000_000n : BigInt(Math.round(Number(pin) * 1_000_000));
  const microUsdPerToken = pinMicro > 0n ? pinMicro : 1_000_000n;
  const confirmations = Math.max(1, integer("FUNDING_CONFIRMATIONS", entry?.confirmations ?? FUNDING_CONFIRMATIONS_DEFAULT));
  const issueList = Array.from(new Set(issues));

  return {
    configured: issueList.length === 0,
    unconfiguredReason: issueList.length === 0 ? null : issueList.join("; "),
    issues: issueList,
    chainId,
    chainName,
    tokenAddress,
    tokenAddressLower: tokenAddress.toLowerCase(),
    tokenSymbol: FUNDING_TOKEN_SYMBOL_USDG,
    tokenDecimals,
    confirmations,
    microUsdPerToken,
    minDepositTokens: optional("FUNDING_MIN_DEPOSIT_TOKENS") ?? "0",
  };
}

/**
 * Startup/route-time guard: throws a ConfigurationError listing every funding
 * problem. Used wherever funding must be provably correct before continuing.
 */
export function assertFundingConfig(options: { networkRegistry?: UsdgNetworkRegistry } = {}): FundingConfig {
  const cfg = fundingConfig(options);
  if (!cfg.configured) throw new ConfigurationError(`Invalid funding configuration: ${cfg.unconfiguredReason}`);
  return cfg;
}

/* ==========================================================================
   Alchemy (only chain-monitoring provider)

   Alchemy is the only chain-monitoring provider used here: notifications arrive as
   an Alchemy Address Activity webhook (verified with the webhook's signing key) and
   the fallback reconciliation reads the same account's JSON-RPC endpoint. Every
   credential is server-only and never leaves this process.

   The JSON-RPC endpoint can be supplied in EITHER of two ways:

     1. ALCHEMY_RPC_URL — the complete HTTP endpoint copied from the Alchemy
        dashboard (https://<network>.g.alchemy.com/v2/<key>, or any other https
        endpoint). It is used EXACTLY as given: no key or network segment is ever
        appended to an explicit endpoint, because doing so would corrupt it.
     2. ALCHEMY_API_KEY + ALCHEMY_NETWORK — the key is combined with the parsed
        network to build the standard Alchemy endpoint shape
        https://<network>.g.alchemy.com/v2/<key>.

   ALCHEMY_NETWORK arrives in three shapes and all three resolve to one network:
   the RPC hostname form ("robinhood-mainnet"), Alchemy's webhook form
   ("ROBINHOOD_MAINNET"), or the whole RPC URL pasted from the Alchemy dashboard
   ("https://robinhood-mainnet.g.alchemy.com/v2/<key>", which is also usable as the
   endpoint itself).

   Configuration states are reported DISTINCTLY rather than collapsed into one
   generic failure, so an operator (and the Fund surface) can tell a missing
   credential from a missing/unparseable network:
     * "alchemy_not_configured"        — no key and no endpoint at all
     * "alchemy_network_not_configured" — bare key with no ALCHEMY_NETWORK
     * "alchemy_network_invalid"       — ALCHEMY_NETWORK is unparseable
     * "alchemy_rpc_url_invalid"       — ALCHEMY_RPC_URL is not an http(s) URL
   In every one of those states `enabled` is false, so no partial configuration is
   ever treated as working monitoring.
   ========================================================================== */

export type AlchemyUnconfiguredReason =
  | "alchemy_not_configured"
  | "alchemy_network_not_configured"
  | "alchemy_network_invalid"
  | "alchemy_rpc_url_invalid";

const ALCHEMY_UNCONFIGURED_MESSAGES: Record<AlchemyUnconfiguredReason, string> = {
  alchemy_not_configured: "Alchemy monitoring is not configured. Set ALCHEMY_RPC_URL to the full endpoint, or ALCHEMY_API_KEY together with ALCHEMY_NETWORK.",
  alchemy_network_not_configured: "ALCHEMY_API_KEY is set but ALCHEMY_NETWORK is not, so no RPC endpoint can be built. Set ALCHEMY_NETWORK (for example robinhood-mainnet) or ALCHEMY_RPC_URL.",
  alchemy_network_invalid: "ALCHEMY_NETWORK is not a usable Alchemy network name or RPC URL. Use robinhood-mainnet, ROBINHOOD_MAINNET, or the full https://<network>.g.alchemy.com/v2/<key> URL.",
  alchemy_rpc_url_invalid: "ALCHEMY_RPC_URL is not a usable http(s) URL. Paste the complete endpoint from the Alchemy dashboard.",
};

/**
 * Normalizes an Alchemy network identifier to its RPC hostname form
 * ("ROBINHOOD_MAINNET" -> "robinhood-mainnet"). Returns undefined for a value that
 * is not a recognizable network rather than inventing one.
 */
function normalizeAlchemyNetworkName(raw: string): string | undefined {
  const candidate = raw.trim().toLowerCase().replace(/_/g, "-");
  if (!candidate) return undefined;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)) return undefined;
  return candidate;
}

/** Extracts the network from an Alchemy endpoint URL, if the URL is one. */
function alchemyNetworkFromUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^https?:\/\/([a-z0-9-]+)\.g\.alchemy\.com\/v2\/[^/\s]+\/?$/i);
  return match ? normalizeAlchemyNetworkName(match[1]) : undefined;
}

/**
 * Parses ALCHEMY_NETWORK. Accepts the RPC hostname ("robinhood-mainnet"), the
 * webhook label ("ROBINHOOD_MAINNET"), or a full Alchemy RPC URL, which also
 * supplies the endpoint itself.
 */
export function parseAlchemyNetwork(raw: string | undefined): { network?: string; rpcUrl?: string; invalid?: boolean } {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const network = alchemyNetworkFromUrl(trimmed);
    if (!network) return { invalid: true };
    return { network, rpcUrl: trimmed.replace(/\/+$/, "") };
  }
  const network = normalizeAlchemyNetworkName(trimmed);
  if (!network) return { invalid: true };
  return { network };
}

/** True when the value is a complete http(s) endpoint, used exactly as given. */
function explicitRpcEndpoint(raw: string | undefined): { url?: string; invalid: boolean } {
  if (!raw) return { invalid: false };
  const trimmed = raw.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return { invalid: true };
  return { url: trimmed.replace(/\/+$/, ""), invalid: false };
}

export type AlchemyConfig = {
  /** True when EITHER ALCHEMY_API_KEY or a full ALCHEMY_RPC_URL endpoint is set. */
  apiKeyConfigured: boolean;
  /** Webhook signature verification is only possible with a signing key. */
  webhookConfigured: boolean;
  webhookId: string | undefined;
  webhookUrl: string | undefined;
  /** Notify API token, used to register deposit addresses for address activity. */
  notifyToken: string | undefined;
  /** True when an address can actually be registered on a Notify webhook. */
  addressRegistrationConfigured: boolean;
  authToken: string | undefined;
  network: string | undefined;
  /** Resolved JSON-RPC endpoint. An explicit ALCHEMY_RPC_URL is never rewritten. */
  rpcUrl: string | undefined;
  /** True only when a usable rpcUrl exists. */
  enabled: boolean;
  /** Machine-readable reason the endpoint is unusable; null when enabled. */
  unconfiguredReason: AlchemyUnconfiguredReason | null;
  /** Human-readable counterpart, safe to surface in an API response or a log. */
  message: string | null;
};

export function alchemyConfig(): AlchemyConfig {
  const apiKey = optional("ALCHEMY_API_KEY");
  const signingKey = optional("ALCHEMY_WEBHOOK_SIGNING_KEY");
  const authToken = optional("ALCHEMY_WEBHOOK_AUTH_TOKEN");
  const notifyToken = optional("ALCHEMY_NOTIFY_AUTH_TOKEN");
  const webhookId = optional("ALCHEMY_WEBHOOK_ID");
  const webhookUrl = optional("ALCHEMY_WEBHOOK_URL");
  const networkRaw = optional("ALCHEMY_NETWORK") ?? optional("FUNDING_ALCHEMY_NETWORK");
  const parsed = parseAlchemyNetwork(networkRaw);
  // An explicit endpoint wins and is used intact; the network label then comes from
  // ALCHEMY_NETWORK when present, otherwise from the endpoint's own hostname.
  const explicit = explicitRpcEndpoint(optional("ALCHEMY_RPC_URL"));
  const network = parsed.network ?? alchemyNetworkFromUrl(explicit.url);

  let rpcUrl: string | undefined = explicit.url ?? parsed.rpcUrl;
  if (!rpcUrl && apiKey && network) rpcUrl = `https://${network}.g.alchemy.com/v2/${apiKey}`;

  let unconfiguredReason: AlchemyUnconfiguredReason | null = null;
  if (!rpcUrl) {
    if (explicit.invalid) unconfiguredReason = "alchemy_rpc_url_invalid";
    else if (parsed.invalid) unconfiguredReason = "alchemy_network_invalid";
    else if (apiKey) unconfiguredReason = "alchemy_network_not_configured";
    else unconfiguredReason = "alchemy_not_configured";
  }

  return {
    apiKeyConfigured: Boolean(apiKey || explicit.url || parsed.rpcUrl),
    webhookConfigured: Boolean(signingKey),
    webhookId,
    webhookUrl,
    notifyToken,
    addressRegistrationConfigured: Boolean(notifyToken && (webhookId || webhookUrl)),
    authToken,
    network,
    rpcUrl,
    enabled: Boolean(rpcUrl),
    unconfiguredReason,
    message: unconfiguredReason ? ALCHEMY_UNCONFIGURED_MESSAGES[unconfiguredReason] : null,
  };
}

/**
 * Reconciliation tuning for the polling fallback and address-registration retry.
 * All values are optional with conservative defaults so a deployment without any
 * of these variables still reconciles.
 */
export function fundingReconcileConfig() {
  return {
    cronSecret: optional("CRON_SECRET"),
    maxWalletsPerRun: Math.max(1, integer("FUNDING_RECONCILE_MAX_WALLETS", 25)),
    maxChunkBlocks: Math.max(100, integer("FUNDING_RECONCILE_CHUNK_BLOCKS", 5000)),
    reorgDepthBlocks: Math.max(1, integer("FUNDING_REORG_DEPTH", 12)),
    maxRegistrationAttempts: Math.max(1, integer("FUNDING_REGISTRATION_MAX_ATTEMPTS", 8)),
  };
}

// Privy server-side wallet API. The optional authorization key is only needed when
// the Privy app has an authorization keypair enabled for wallet creation; when it is
// present it is used exclusively inside this process to sign outbound wallet-api
// requests. It is never sent to a browser and never logged.
export function privyWalletConfig() { return { authorizationPrivateKey: optional("PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY") }; }

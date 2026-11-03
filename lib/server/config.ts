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
export function allowanceConfig() { const amount = optional("OPENWEIGHT_GRANT_AMOUNT_MICRO_USD"); return { amountMicroUsd: BigInt(amount ?? "5000000"), recurrence: (optional("OPENWEIGHT_GRANT_RECURRENCE") ?? "MONTHLY").toUpperCase(), durationSeconds: integer("OPENWEIGHT_GRANT_DURATION_SECONDS", 2592000) }; }
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
   Funding (deposit -> compute balance)

   Every network and token value below is read from the server environment. This
   module never invents a chain id, a token contract, or a conversion rate: if the
   configured values are absent the funding surface reports itself as
   unconfigured instead of guessing. Token, chain, and Privy credentials stay
   server-side and are never drafted into a client bundle.

   Deposit credit uses this project's existing compute ledger convention: balances
   are integer micro-USD (`compute_ledger_entries.amount_micro_usd`). The token is a
   USD-denominated stablecoin, so one whole token equals one USD of compute
   allowance by default (1 token = 1_000_000 micro-USD). FUNDING_USD_PER_TOKEN lets
   an operator change that without a code change.
   ========================================================================== */

// How many block confirmations a transfer must reach before it is credited. The
// product requirement is three; the environment override exists for other nets.
const FUNDING_CONFIRMATIONS_DEFAULT = 3;

function chainIdFromEnv(): number | undefined {
  const raw = optional("FUNDING_CHAIN_ID") ?? optional("ROBINHOOD_CHAIN_ID") ?? optional("NEXT_PUBLIC_ROBINHOOD_CHAIN_ID");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export type FundingConfig = {
  configured: boolean;
  unconfiguredReason: string | null;
  chainId: number;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  confirmations: number;
  /** Micro-USD credited per whole token. */
  microUsdPerToken: bigint;
  /** Smallest deposit that receives credit, in whole-token units. */
  minDepositTokens: string;
};

// Token configuration deliberately falls back to HOLDER_TOKEN_ADDRESS: that is the
// token this project already configures for Robinhood Chain, so the funding flow
// reuses the operator's existing network/token choice rather than introducing a
// second, possibly conflicting, contract address.
export function fundingConfig(): FundingConfig {
  const chainId = chainIdFromEnv();
  const tokenAddress = (optional("FUNDING_TOKEN_ADDRESS") ?? optional("HOLDER_TOKEN_ADDRESS"))?.toLowerCase();
  const tokenIsAddress = Boolean(tokenAddress && /^0x[a-f0-9]{40}$/.test(tokenAddress));
  const tokenSymbol = optional("FUNDING_TOKEN_SYMBOL") ?? "USDG";
  const tokenDecimals = integer("FUNDING_TOKEN_DECIMALS", 6);
  const pin = optional("FUNDING_USD_PER_TOKEN");
  const wholeTokens = pin === undefined ? 1_000_000n : BigInt(Math.round(Number(pin) * 1_000_000));
  const unconfiguredReason = !chainId
    ? "FUNDING_CHAIN_ID is not set"
    : !tokenIsAddress
      ? "FUNDING_TOKEN_ADDRESS (or HOLDER_TOKEN_ADDRESS) is not set to a valid token contract"
      : null;
  return {
    configured: unconfiguredReason === null,
    unconfiguredReason,
    chainId: chainId ?? 0,
    chainName: optional("FUNDING_CHAIN_NAME") ?? "Robinhood Chain",
    tokenAddress: tokenIsAddress ? (tokenAddress as string) : "",
    tokenSymbol,
    tokenDecimals,
    confirmations: Math.max(1, integer("FUNDING_CONFIRMATIONS", FUNDING_CONFIRMATIONS_DEFAULT)),
    microUsdPerToken: wholeTokens > 0n ? wholeTokens : 1_000_000n,
    minDepositTokens: optional("FUNDING_MIN_DEPOSIT_TOKENS") ?? "0",
  };
}

// Alchemy is the only chain-monitoring provider used here: notifications arrive as
// an Alchemy Address Activity webhook (verified with the webhook's signing key) and
// confirmation counts are read from Alchemy's HTTP RPC endpoint for the same app.
export function alchemyConfig() {
  const apiKey = optional("ALCHEMY_API_KEY");
  const signingKey = optional("ALCHEMY_WEBHOOK_SIGNING_KEY");
  const authToken = optional("ALCHEMY_WEBHOOK_AUTH_TOKEN");
  const network = optional("ALCHEMY_NETWORK") ?? optional("FUNDING_ALCHEMY_NETWORK");
  // Standard Alchemy HTTP endpoint shape: https://<network>.g.alchemy.com/v2/<key>
  const rpcUrl = optional("ALCHEMY_RPC_URL") ?? (apiKey && network ? `https://${network}.g.alchemy.com/v2/${apiKey}` : undefined);
  return {
    apiKeyConfigured: Boolean(apiKey),
    webhookConfigured: Boolean(signingKey),
    authToken,
    network,
    rpcUrl,
    enabled: Boolean(rpcUrl),
  };
}

// Privy server-side wallet API. The optional authorization key is only needed when
// the Privy app has an authorization keypair enabled for wallet creation; when it is
// present it is used exclusively inside this process to sign outbound wallet-api
// requests. It is never sent to a browser and never logged.
export function privyWalletConfig() { return { authorizationPrivateKey: optional("PRIVY_WALLET_AUTHORIZATION_PRIVATE_KEY") }; }

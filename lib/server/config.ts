export class ConfigurationError extends Error {
  readonly code = "CONFIGURATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required server configuration: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integer(name: string, fallback?: number): number {
  const raw = optional(name);
  if (!raw && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new ConfigurationError(`Invalid integer server configuration: ${name}`);
  return value;
}

// Public RPC endpoints for Robinhood Chain (used when ROBINHOOD_RPC_URL is not set).
const PUBLIC_RPC: Record<number, string> = {
  4663: "https://rpc.mainnet.chain.robinhood.com",
  46630: "https://rpc.testnet.chain.robinhood.com",
};

export function databaseConfig() {
  const raw = optional("DATABASE_URL") ?? optional("POSTGRES_URL");
  if (!raw && !optional("PGHOST")) throw new ConfigurationError("Missing required server configuration: DATABASE_URL or PGHOST");
  // Strip sslmode from the URL: newer node-postgres interprets `sslmode=require`
  // as certificate verification, which fails against Supabase's pooler chain.
  // We attach an explicit ssl object below instead.
  const url = raw?.replace(/([?&])sslmode=[^&]*(&|$)/i, (_m, p1, p2) => (p2 === "&" ? p1 : "")).replace(/[?&]$/, "");
  const managed = Boolean(url && /supabase|amazonaws|pooler|render|neon|railway/.test(url));
  return {
    connectionString: url,
    host: optional("PGHOST"),
    port: integer("PGPORT", 5432),
    database: optional("PGDATABASE"),
    user: optional("PGUSER"),
    password: optional("PGPASSWORD"),
    // Managed Postgres requires TLS but presents a cert that does not verify
    // against the pooler hostname, so we connect with TLS without verification.
    ssl: managed || process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    max: integer("PG_POOL_MAX", 5),
  };
}

// Upstash Redis REST configuration. The stored secrets are Upstash REST
// credentials, not a redis:// URL, so the transport is HTTP.
export function redisConfig() {
  const url = optional("UPSTASH_REDIS_REST_URL") ?? optional("REDIS_REST_URL");
  const token = optional("UPSTASH_REDIS_REST_TOKEN") ?? optional("REDIS_REST_TOKEN");
  const enabled = Boolean(url && token);
  return { enabled, url, token, keyPrefix: optional("REDIS_KEY_PREFIX") ?? "openweight:" };
}

export function holderConfig() {
  const chainId = integer("ROBINHOOD_CHAIN_ID", process.env.NODE_ENV === "production" ? 4663 : 46630);
  if (chainId !== 4663 && chainId !== 46630) throw new ConfigurationError("ROBINHOOD_CHAIN_ID must be 4663 or 46630");
  const rpcUrl = optional("ROBINHOOD_RPC_URL") ?? optional("OPENWEIGHT_RPC_URL") ?? PUBLIC_RPC[chainId];
  if (!rpcUrl) throw new ConfigurationError("Missing required server configuration: ROBINHOOD_RPC_URL");
  return {
    chainId,
    tokenAddress: (optional("HOLDER_TOKEN_ADDRESS") ?? required("OPENWEIGHT_TOKEN_ADDRESS")) as `0x${string}`,
    rpcUrl,
    // Threshold is expressed in whole tokens; on-chain decimals convert it to
    // raw units at verification time so we never depend on a stored decimals value.
    thresholdWholeTokens: BigInt(optional("HOLDER_MINIMUM_TOKENS") ?? required("OPENWEIGHT_HOLDER_THRESHOLD")),
    // Optional override if a caller wants to supply decimals explicitly.
    tokenDecimalsOverride: optional("HOLDER_TOKEN_DECIMALS") ? integer("HOLDER_TOKEN_DECIMALS") : undefined,
    freshnessSeconds: integer("OPENWEIGHT_ELIGIBILITY_FRESHNESS_SECONDS", 900),
  };
}

export function allowanceConfig() {
  const amount = optional("OPENWEIGHT_GRANT_AMOUNT_MICRO_USD");
  return {
    // Default $5.00 / month, expiring at period end (no rollover).
    amountMicroUsd: BigInt(amount ?? "5000000"),
    recurrence: (optional("OPENWEIGHT_GRANT_RECURRENCE") ?? "MONTHLY").toUpperCase(),
    // Retained for non-monthly recurrences; MONTHLY uses calendar boundaries.
    durationSeconds: integer("OPENWEIGHT_GRANT_DURATION_SECONDS", 2592000),
  };
}

// Pricing policy. Markup is stored as an integer micro-multiplier so all
// accounting stays in integer fixed-point (2.0x === 2_000_000).
export function pricingConfig() {
  const raw = optional("DEFAULT_MARKUP_MULTIPLIER") ?? "2.0";
  const multiplier = Number(raw);
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new ConfigurationError("DEFAULT_MARKUP_MULTIPLIER must be a positive number");
  return {
    defaultMarkupMicro: BigInt(Math.round(multiplier * 1_000_000)),
    defaultMinChargeMicroUsd: BigInt(optional("DEFAULT_MIN_CHARGE_MICRO_USD") ?? "0"),
    // Safety cap reserved per request before actual usage settles.
    reservationCapMicroUsd: BigInt(optional("INFERENCE_RESERVATION_CAP_MICRO_USD") ?? "500000"),
  };
}

export function privyConfig() {
  return { appId: required("PRIVY_APP_ID"), appSecret: required("PRIVY_APP_SECRET") };
}

export function openRouterConfig() {
  const enabled = (optional("OPENROUTER_ENABLED") ?? "false") === "true";
  if (!enabled) return { enabled: false as const };
  return { enabled: true as const, apiKey: required("OPENROUTER_API_KEY"), baseUrl: optional("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1" };
}

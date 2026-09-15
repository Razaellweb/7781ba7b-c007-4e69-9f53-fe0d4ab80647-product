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

export function databaseConfig() {
  const url = optional("DATABASE_URL");
  if (!url && !optional("PGHOST")) throw new ConfigurationError("Missing required server configuration: DATABASE_URL or PGHOST");
  return {
    connectionString: url,
    host: optional("PGHOST"),
    port: integer("PGPORT", 5432),
    database: optional("PGDATABASE"),
    user: optional("PGUSER"),
    password: optional("PGPASSWORD"),
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    max: integer("PG_POOL_MAX", 10),
  };
}

export function redisConfig() {
  const url = required("REDIS_URL");
  return { url, keyPrefix: optional("REDIS_KEY_PREFIX") ?? "openweight:" };
}

export function holderConfig() {
  const chainId = integer("OPENWEIGHT_CHAIN_ID", process.env.NODE_ENV === "production" ? 4663 : 46630);
  if (chainId !== 4663 && chainId !== 46630) throw new ConfigurationError("OPENWEIGHT_CHAIN_ID must be 4663 or 46630");
  return {
    chainId,
    tokenAddress: required("OPENWEIGHT_TOKEN_ADDRESS") as `0x${string}`,
    rpcUrl: required("OPENWEIGHT_RPC_URL"),
    tokenDecimals: integer("OPENWEIGHT_TOKEN_DECIMALS"),
    thresholdRaw: required("OPENWEIGHT_ELIGIBILITY_THRESHOLD_RAW"),
    freshnessSeconds: integer("OPENWEIGHT_ELIGIBILITY_FRESHNESS_SECONDS", 900),
  };
}

export function allowanceConfig() {
  return {
    amountMicroUsd: BigInt(required("OPENWEIGHT_GRANT_AMOUNT_MICRO_USD")),
    recurrence: required("OPENWEIGHT_GRANT_RECURRENCE"),
    durationSeconds: integer("OPENWEIGHT_GRANT_DURATION_SECONDS"),
  };
}

export function privyConfig() {
  return { appId: required("PRIVY_APP_ID"), appSecret: required("PRIVY_APP_SECRET") };
}

export function openRouterConfig() {
  const enabled = process.env.OPENROUTER_ENABLED === "true";
  if (!enabled) return { enabled: false as const };
  return { enabled: true as const, apiKey: required("OPENROUTER_API_KEY"), baseUrl: optional("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1" };
}

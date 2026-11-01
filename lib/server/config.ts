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

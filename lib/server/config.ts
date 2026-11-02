export class ConfigurationError extends Error {
  readonly code = "CONFIGURATION_ERROR";
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}

function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new ConfigurationError(`Missing required server configuration: ${name}`); return value; }
function optional(name: string): string | undefined { const value = process.env[name]?.trim(); return value || undefined; }
function integer(name: string, fallback?: number): number { const raw = optional(name); if (!raw && fallback !== undefined) return fallback; const value = Number(raw); if (!Number.isInteger(value) || value < 0) throw new ConfigurationError(`Invalid integer server configuration: ${name}`); return value; }
// Alias-aware readers. A provider setting may be published under more than one
// documented name (for example VASTAI_BASE_URL vs. the older
// VAST_INFERENCE_BASE_URL); the first populated name wins so either spelling
// configures the deployment without a code change.
function optionalAny(...names: string[]): string | undefined { for (const name of names) { const value = optional(name); if (value) return value; } return undefined; }
function integerAny(fallback: number, ...names: string[]): number { const raw = optionalAny(...names); if (!raw) return fallback; const value = Number(raw); if (!Number.isInteger(value) || value < 0) throw new ConfigurationError(`Invalid integer server configuration: ${names[0]}`); return value; }
function nonNegativeNumberAny(fallback: number, ...names: string[]): number { const raw = optionalAny(...names); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value) || value < 0) throw new ConfigurationError(`${names[0]} must be a non-negative number`); return value; }
function positiveNumberAny(fallback: number, ...names: string[]): number { const raw = optionalAny(...names); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value) || value <= 0) throw new ConfigurationError(`${names[0]} must be a positive number`); return value; }
function booleanFlag(name: string, fallback: boolean): boolean { const raw = optional(name); if (raw === undefined) return fallback; return /^(1|true|yes|on)$/i.test(raw); }
function commaList(name: string): string[] { return (optional(name) ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean); }
export function databaseConfig() { const raw = optional("DATABASE_URL") ?? optional("POSTGRES_URL"); if (!raw && !optional("PGHOST")) throw new ConfigurationError("Missing required server configuration: DATABASE_URL or PGHOST"); const url = raw?.replace(/([?&])sslmode=[^&]*(&|$)/i, (_m, p1, p2) => (p2 === "&" ? p1 : "")).replace(/[?&]$/, ""); const managed = Boolean(url && /supabase|amazonaws|pooler|render|neon|railway/.test(url)); return { connectionString: url, host: optional("PGHOST"), port: integer("PGPORT", 5432), database: optional("PGDATABASE"), user: optional("PGUSER"), password: optional("PGPASSWORD"), ssl: managed || process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined, max: integer("PG_POOL_MAX", 5) }; }
export function redisConfig() { const url = optional("UPSTASH_REDIS_REST_URL") ?? optional("REDIS_REST_URL"); const token = optional("UPSTASH_REDIS_REST_TOKEN") ?? optional("REDIS_REST_TOKEN"); return { enabled: Boolean(url && token), url, token, keyPrefix: optional("REDIS_KEY_PREFIX") ?? "openweight:" }; }
// Access control is identity-based: a verified Privy identity is sufficient to
// open a session and authorize workspace/inference use. There is intentionally no
// chain, RPC, or token-holding configuration in this module any more.
export function allowanceConfig() { const amount = optional("OPENWEIGHT_GRANT_AMOUNT_MICRO_USD"); return { amountMicroUsd: BigInt(amount ?? "5000000"), recurrence: (optional("OPENWEIGHT_GRANT_RECURRENCE") ?? "MONTHLY").toUpperCase(), durationSeconds: integer("OPENWEIGHT_GRANT_DURATION_SECONDS", 2592000) }; }
export function pricingConfig() { const raw = optional("DEFAULT_MARKUP_MULTIPLIER") ?? "2.0"; const multiplier = Number(raw); if (!Number.isFinite(multiplier) || multiplier <= 0) throw new ConfigurationError("DEFAULT_MARKUP_MULTIPLIER must be a positive number"); return { defaultMarkupMicro: BigInt(Math.round(multiplier * 1_000_000)), defaultMinChargeMicroUsd: BigInt(optional("DEFAULT_MIN_CHARGE_MICRO_USD") ?? "0"), reservationCapMicroUsd: BigInt(optional("INFERENCE_RESERVATION_CAP_MICRO_USD") ?? "500000") }; }
// ---------------------------------------------------------------------------
// Compute metering & settlement.
// ---------------------------------------------------------------------------
// A request start holds compute BEFORE any provider work, sized from a
// deliberately conservative token estimate: the prompt is measured pessimistically
// (fewer characters per token than a real tokenizer) and the completion is assumed
// to run to its requested ceiling. The hold is then padded by the safety factor,
// floored so a tiny prompt still holds a meaningful unit, and capped so a single
// turn can never lock the whole allowance. Settlement releases the unused part.
//
// The reconciliation window is how long a hold may stay unsettled (a stream whose
// process died, a provider that answered usage late) before the worker settles it
// from whatever was durably recorded. Attempts are bounded so a permanently
// unreconcilable row cannot spin forever.
export function meteringConfig() {
  return {
    /** Characters per token used when estimating a prompt. Lower = more conservative. */
    promptCharsPerToken: Math.max(1, integer("METERING_PROMPT_CHARS_PER_TOKEN", 3)),
    /** Fixed per-message overhead added to the prompt estimate (role framing). */
    promptMessageOverheadTokens: Math.max(0, integer("METERING_PROMPT_MESSAGE_OVERHEAD_TOKENS", 4)),
    /** Completion tokens assumed when the request sets no explicit ceiling. */
    defaultCompletionTokens: Math.max(1, integer("METERING_DEFAULT_COMPLETION_TOKENS", 1024)),
    /** Multiplier applied to the estimated debit (1.25 = 25% headroom). */
    safetyMicro: BigInt(Math.round(positiveNumber("METERING_RESERVATION_SAFETY", 1.25) * 1_000_000)),
    /** Smallest hold, so a one-line prompt still reserves a billable unit. */
    minReservationMicroUsd: BigInt(integer("METERING_MIN_RESERVATION_MICRO_USD", 1_000)),
    /** How long a hold may stay unsettled before the worker intervenes. */
    reconcileAfterSeconds: Math.max(30, integer("METERING_RECONCILE_AFTER_SECONDS", 120)),
    /** How many holds the worker settles per run. */
    reconcileBatch: Math.max(1, integer("METERING_RECONCILE_BATCH", 50)),
    /** Attempt ceiling per hold, so an unreconcilable row is bounded. */
    maxReconcileAttempts: Math.max(1, integer("METERING_MAX_RECONCILE_ATTEMPTS", 5)),
    /** Window the reconciliation report covers. */
    reportWindowHours: Math.max(1, integer("METERING_REPORT_WINDOW_HOURS", 24)),
  };
}
export function userRateLimit() { return integer("INFERENCE_USER_RATE_LIMIT_PER_MINUTE", 20); }
export function privyConfig() { return { appId: required("PRIVY_APP_ID"), appSecret: required("PRIVY_APP_SECRET") }; }
export function openRouterConfig() { const enabled = (optional("OPENROUTER_ENABLED") ?? "false") === "true"; if (!enabled) return { enabled: false as const }; return { enabled: true as const, apiKey: required("OPENROUTER_API_KEY"), baseUrl: (optional("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "") }; }
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
// Every documented spelling of the marketplace key. Operators publish it as
// VAST_API_KEY, VASTAI_API_KEY or VAST_AI_API_KEY depending on which page they
// copied it from, so all accepted forms are read (first populated name wins).
// Reading only one spelling would leave a correctly-added key silently unused,
// which presents exactly like "the key does nothing".
export const VAST_API_KEY_VARIABLES = ["VAST_API_KEY", "VASTAI_API_KEY", "VAST_AI_API_KEY", "VASTAI_KEY", "VAST_AI_KEY", "VAST_API_TOKEN", "VAST_KEY"] as const;
// GPU rental economics and guardrails. The user's hourly rate is the provider's
// hourly cost times GPU_MARKUP_MULTIPLIER (default 1.15, the 15% margin). Time is
// prepaid in GPU_BILLING_BLOCK_MINUTES blocks from the compute allowance.
function positiveNumber(name: string, fallback: number): number { const raw = optional(name); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value) || value <= 0) throw new ConfigurationError(`${name} must be a positive number`); return value; }
export function gpuRentalConfig() { const markup = positiveNumber("GPU_MARKUP_MULTIPLIER", 1.15); const productionHost = optional("VERCEL_PROJECT_PRODUCTION_URL"); return { markupMicro: BigInt(Math.round(markup * 1_000_000)), blockMinutes: Math.max(10, Math.round(positiveNumber("GPU_BILLING_BLOCK_MINUTES", 60))), maxHourlyUsd: positiveNumber("GPU_MAX_HOURLY_USD", 5), maxActiveRentals: Math.max(1, Math.round(positiveNumber("GPU_MAX_ACTIVE_RENTALS", 2))), diskGb: Math.round(positiveNumber("GPU_DISK_GB", 40)), appBaseUrl: (optional("APP_BASE_URL") ?? (productionHost ? `https://${productionHost}` : undefined))?.replace(/\/+$/, ""), cronSecret: optional("CRON_SECRET") }; }
// A pasted key is normalised before use: surrounding quotes, an accidental
// `Bearer ` prefix and stray whitespace are all things a copy/paste introduces,
// and none of them should make a valid credential look rejected. The seeded
// placeholder still counts as "not configured" and is never sent upstream.
export function sanitizeVastApiKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^[\s"'`]+/, "").replace(/[\s"'`]+$/, "").replace(/^bearer\s+/i, "").trim();
  if (!cleaned || cleaned === VAST_API_KEY_PLACEHOLDER) return undefined;
  return cleaned;
}
/**
 * Which environment variable supplied the marketplace key (never the value).
 * Reported by the in-app provider check so an operator can see that the variable
 * they set is the one being read, without any credential crossing the boundary.
 */
export function vastApiKeySource(): { value: string | undefined; variable: string | null } {
  for (const name of VAST_API_KEY_VARIABLES) {
    const value = sanitizeVastApiKey(optional(name));
    if (value) return { value, variable: name };
  }
  return { value: undefined, variable: null };
}
/** The marketplace base URL, with the documented default when unset. */
export function vastApiBaseUrl(): string { return (optional("VAST_API_BASE_URL") ?? "https://console.vast.ai/api/v0").replace(/\/+$/, ""); }
// The marketplace key authorizes instance lifecycle calls only; the inference
// transport below uses its own instance service key so browsing/renting authority
// is never shared.
export function vastConfig() { const { value: apiKey } = vastApiKeySource(); if (!apiKey) return { enabled: false as const, apiKey: undefined, baseUrl: undefined }; return { enabled: true as const, apiKey, baseUrl: vastApiBaseUrl() }; }

// ---------------------------------------------------------------------------
// vast.ai INSTANCE LIFECYCLE (platform-owned warm pool).
// ---------------------------------------------------------------------------
// When the app rents its own GPU instances ON DEMAND to serve curated models
// (rather than pointing at a pre-provisioned, static instance), this block is the
// whole policy surface: which models stay warm, how many machines may exist at
// once, how long an idle machine survives, and how long a cold request may wait
// for its machine before it is failed with a retryable `model_unavailable`.
//
// Disabled by default: a deployment that publishes VASTAI_BASE_URL keeps working
// exactly as before (static endpoint, health-check half of this feature only).
export type VastLifecycleConfig = {
  /** Rent and manage instances from the marketplace on demand. */
  enabled: boolean;
  /** Curated model ids (lowercase) that must never be idle-shutdown. */
  warmPool: string[];
  /** Hard cap on simultaneously live instances. */
  maxInstances: number;
  /** Minutes an instance may sit unused before it is terminated. */
  idleShutdownMinutes: number;
  /** How long a request may wait for a cold machine before it fails, retryably. */
  coldStartBudgetMs: number;
  /** Disk requested from the marketplace, in GB. */
  diskGb: number;
  /** Refuse offers above this hourly provider price. */
  maxHourlyUsd: number;
  /** Preferred GPU model; null rents the cheapest suitable machine. */
  gpuName: string | null;
  /** Minimum per-GPU VRAM for a rented inference machine. */
  minGpuRamGb: number;
  /** Container image the instance runs (an OpenAI-compatible server). */
  image: string;
  /** Context window the served model is started with. */
  maxModelLen: number;
  /** How often the background worker re-probes provider health. */
  healthIntervalSeconds: number;
  /** Poll cadence while a cold machine boots. */
  pollIntervalMs: number;
};

export function vastLifecycleConfig(): VastLifecycleConfig {
  return {
    enabled: booleanFlag("VASTAI_LIFECYCLE_ENABLED", false),
    warmPool: commaList("VASTAI_WARM_POOL"),
    maxInstances: Math.max(1, integer("VASTAI_MAX_INSTANCES", 2)),
    idleShutdownMinutes: nonNegativeNumberAny(15, "VASTAI_IDLE_SHUTDOWN_MINUTES", "VAST_INFERENCE_IDLE_SHUTDOWN_MINUTES"),
    coldStartBudgetMs: Math.max(10_000, integer("VASTAI_COLD_START_BUDGET_MS", 240_000)),
    diskGb: Math.max(20, integer("VASTAI_INSTANCE_DISK_GB", 60)),
    maxHourlyUsd: positiveNumberAny(3, "VASTAI_INSTANCE_MAX_HOURLY_USD"),
    gpuName: optional("VASTAI_INSTANCE_GPU_NAME") ?? null,
    minGpuRamGb: nonNegativeNumberAny(24, "VASTAI_INSTANCE_MIN_VRAM_GB", "VASTAI_INSTANCE_MIN_GPU_RAM_GB"),
    image: optional("VASTAI_INSTANCE_IMAGE") ?? "vllm/vllm-openai:v0.6.4.post1",
    maxModelLen: Math.max(512, integer("VASTAI_INSTANCE_MAX_MODEL_LEN", 8192)),
    healthIntervalSeconds: Math.max(15, integer("VASTAI_HEALTH_INTERVAL_SECONDS", 60)),
    pollIntervalMs: Math.max(1_000, integer("VASTAI_COLD_START_POLL_MS", 5_000)),
  };
}

// ---------------------------------------------------------------------------
// vast.ai INFERENCE transport (a different boundary from the marketplace key).
// ---------------------------------------------------------------------------
// vast.ai rents GPU instances; each one runs a vLLM / OpenAI-compatible server.
// That server is protected by its own service key (the `--api-key` value baked
// into the instance's onstart script by gpu-templates.ts / vast-lifecycle.ts),
// NOT by the marketplace key in vastConfig(). Keeping the two apart means a
// rented machine can be reached without granting the inference path any
// marketplace authority.
//
// VASTAI_BASE_URL (or the older VAST_INFERENCE_BASE_URL) points at the
// instance's OpenAI-compatible root, e.g.
//   http://<public-ip>:<host-port>/v1
// When VASTAI_LIFECYCLE_ENABLED is on, no static URL is needed: the base URL is
// resolved per model by the lifecycle manager (ensureInstance).
export type VastTokenPricing = { promptUsdPerToken: number; completionUsdPerToken: number };

/** One curated model's vast.ai route: the identifier the vLLM server serves and,
 *  optionally, the endpoint that serves it (a second rented instance). */
export type VastModelTarget = { modelId: string; baseUrl?: string };
/** Curated model id (lowercase) → vast.ai route. */
export type VastModelMap = Record<string, VastModelTarget>;

/**
 * Parses VASTAI_MODEL_MAP. Accepts either the terse form
 *   {"glm-4.5":"glm-4.5","qwen3-235b-a22b":{"model":"Qwen/Qwen3-235B-A22B"}}
 * or the explicit form `{"id":{"model":"…","baseUrl":"http://host:port/v1"}}`.
 * Keys are normalized to lowercase so a curated slug resolves regardless of case.
 * A malformed value is a configuration error (surfaced by the startup preflight),
 * never a silent empty mapping.
 */
function parseVastModelMap(raw: string | undefined): VastModelMap {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigurationError("VASTAI_MODEL_MAP must be valid JSON mapping curated model ids to vast.ai model identifiers"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigurationError("VASTAI_MODEL_MAP must be a JSON object mapping curated model ids to vast.ai model identifiers");
  const map: VastModelMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const curated = key.trim().toLowerCase();
    if (!curated) continue;
    if (typeof value === "string") {
      if (!value.trim()) throw new ConfigurationError(`VASTAI_MODEL_MAP entry for ${key} must name a model identifier`);
      map[curated] = { modelId: value.trim() };
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      const modelId = [entry.model, entry.modelId, entry.id].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
      if (!modelId) throw new ConfigurationError(`VASTAI_MODEL_MAP entry for ${key} must name a model identifier`);
      const baseUrl = typeof entry.baseUrl === "string" && entry.baseUrl.trim() ? entry.baseUrl.trim().replace(/\/+$/, "") : undefined;
      map[curated] = { modelId: modelId.trim(), ...(baseUrl ? { baseUrl } : {}) };
      continue;
    }
    throw new ConfigurationError(`VASTAI_MODEL_MAP entry for ${key} must be a model identifier string or an object with a model identifier`);
  }
  return map;
}

export type VastInferenceConfig =
  | { enabled: false; modelMap: VastModelMap }
  | {
      enabled: true;
      /** Static OpenAI-compatible root, or null when the lifecycle manager supplies it. */
      baseUrl: string | null;
      /** True when the base URL is resolved per model by the lifecycle manager. */
      managed: boolean;
      apiKey: string | null;
      requestTimeoutMs: number;
      idleTimeoutMs: number;
      healthTimeoutMs: number;
      maxRetries: number;
      idleShutdownMinutes: number;
      tokensPerSecond: number;
      pricing: VastTokenPricing;
      modelMap: VastModelMap;
    };

export function vastInferenceConfig(): VastInferenceConfig {
  const baseUrl = optionalAny("VASTAI_BASE_URL", "VAST_INFERENCE_BASE_URL")?.replace(/\/+$/, "") ?? null;
  // The instance service key only. VASTAI_API_KEY (marketplace lifecycle) is
  // deliberately not accepted here so the inference path never carries renting
  // authority.
  const apiKey = optionalAny("VASTAI_BEARER_TOKEN", "VAST_INFERENCE_API_KEY");
  const modelMap = parseVastModelMap(optional("VASTAI_MODEL_MAP"));
  // With the lifecycle manager on, the endpoint comes from a rented instance, so
  // a static URL is optional. Without it, an unset URL is a normal "not
  // configured" state.
  const managed = vastLifecycleConfig().enabled;
  if (!baseUrl && !managed) return { enabled: false as const, modelMap };
  return {
    enabled: true as const,
    baseUrl,
    managed,
    // A rented instance may legitimately run without an --api-key when it is
    // only reachable from inside the workspace; an absent key then simply means
    // no Authorization header is attached.
    apiKey: apiKey ?? null,
    requestTimeoutMs: integerAny(120_000, "VASTAI_REQUEST_TIMEOUT_MS", "VAST_INFERENCE_TIMEOUT_MS"),
    // A stream that produces no bytes for this long is treated as stalled.
    idleTimeoutMs: integerAny(45_000, "VASTAI_IDLE_TIMEOUT_MS", "VAST_INFERENCE_IDLE_TIMEOUT_MS"),
    healthTimeoutMs: integerAny(8_000, "VASTAI_HEALTH_TIMEOUT_MS", "VAST_INFERENCE_HEALTH_TIMEOUT_MS"),
    // Retries for a non-streaming completion that fails retryably. Streaming
    // turns are never replayed (the caller decides whether to retry or fall back).
    maxRetries: integerAny(1, "VASTAI_MAX_RETRIES", "VAST_INFERENCE_MAX_RETRIES"),
    // How long a rented instance may sit without inference before the lifecycle
    // path is allowed to shut it down. Surfaced on the control plane so the
    // window is inspectable without reading the environment.
    idleShutdownMinutes: nonNegativeNumberAny(15, "VASTAI_IDLE_SHUTDOWN_MINUTES", "VAST_INFERENCE_IDLE_SHUTDOWN_MINUTES"),
    // Estimated decode throughput, used to price a completion when the upstream
    // omits usage. Configured per deployment, not per request.
    tokensPerSecond: positiveNumberAny(40, "VASTAI_TOKENS_PER_SECOND", "VAST_INFERENCE_TOKENS_PER_SECOND"),
    // Per-token pricing derived from the rented GPU's hourly cost. Both default
    // to the reference rates the curated catalogue publishes for these models.
    pricing: {
      promptUsdPerToken: nonNegativeNumberAny(0.15 / 1_000_000, "VASTAI_PROMPT_USD_PER_TOKEN", "VAST_INFERENCE_PROMPT_USD_PER_TOKEN"),
      completionUsdPerToken: nonNegativeNumberAny(0.50 / 1_000_000, "VASTAI_COMPLETION_USD_PER_TOKEN", "VAST_INFERENCE_COMPLETION_USD_PER_TOKEN"),
    } satisfies VastTokenPricing,
    // Curated model id → vast.ai model identifier / endpoint.
    modelMap,
  };
}

// ---------------------------------------------------------------------------
// Curated model registry availability.
// ---------------------------------------------------------------------------
// The registry computes each curated model's Operational / Degraded / Unavailable
// state by probing the ACTIVE provider through the normalized health contract.
// Two knobs matter:
//   refreshIntervalSeconds — how stale the stored snapshot may be before a page
//                            load re-probes. Doubles as the propagation window for
//                            an admin activate/pause and for a provider transition,
//                            so the Playground and Overview converge within it.
//   debounceRuns           — how many consecutive observations must agree before a
//                            transition is adopted. A GPU endpoint that flaps
//                            between healthy and unhealthy therefore cannot thrash
//                            the model cards.
export function modelHealthConfig(): { refreshIntervalSeconds: number; debounceRuns: number } {
  return {
    // Reuse the provider health interval by default: the registry must not be
    // fresher than the probe that feeds it.
    refreshIntervalSeconds: Math.max(5, integerAny(vastLifecycleConfig().healthIntervalSeconds, "MODEL_HEALTH_REFRESH_INTERVAL_SECONDS")),
    debounceRuns: Math.max(1, integer("MODEL_HEALTH_DEBOUNCE_RUNS", 2)),
  };
}

// ---------------------------------------------------------------------------
// Admin control plane.
// ---------------------------------------------------------------------------
// The provider control plane can be locked to an explicit allowlist of accounts
// (ADMIN_ACCOUNT_IDS / ADMIN_PRIVY_USER_IDS, comma separated). When no allowlist
// is published the deployment is single-tenant, so any authenticated account may
// use it; every change is written to admin_audit_log either way.
export function adminConfig() {
  const list = (name: string) => (optional(name) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const accountIds = list("ADMIN_ACCOUNT_IDS");
  const privyUserIds = list("ADMIN_PRIVY_USER_IDS");
  return { accountIds, privyUserIds, restricted: accountIds.length > 0 || privyUserIds.length > 0 };
}

// ---------------------------------------------------------------------------
// Provider selection (PRD: provider-agnostic with replacement support).
// ---------------------------------------------------------------------------
// "vast" and "vastai" are the same provider; both accepted so either the brief's
// spelling or the historical one configures the deployment.
export type InferenceProviderId = "vast" | "openrouter";
/** Canonical values accepted by INFERENCE_PROVIDER, for diagnostics + preflight messages. */
export const INFERENCE_PROVIDER_VALUES = ["openrouter", "vastai"] as const;
export const INFERENCE_PROVIDER_ALIASES: Record<string, InferenceProviderId> = { openrouter: "openrouter", vastai: "vast", vast: "vast", "vast.ai": "vast" };

export type InferenceProviderSelection = {
  /** The provider requests are routed through. */
  provider: InferenceProviderId;
  /**
   * The provider a failed turn may be retried on, or null when failover is
   * disabled (which is the default) or nothing else is configured.
   */
  fallback: InferenceProviderId | null;
  /**
   * Whether provider failover is enabled at all. Off unless explicitly turned on
   * by configuration (INFERENCE_FALLBACK_ENABLED) or by the admin control plane.
   * This is what makes failover opt-in: a healthy alternative provider is never
   * used silently just because it happens to be configured.
   */
  fallbackEnabled: boolean;
  /**
   * The fallback provider that would be used if failover were enabled. Reported so
   * the control plane can show "configured, currently disabled" without guessing.
   */
  fallbackCandidate: InferenceProviderId | null;
  /** INFERENCE_PROVIDER exactly as written, for the startup preflight. */
  requested: string;
  /** Set when INFERENCE_PROVIDER named something unrecognized. */
  invalid: string | null;
  /** Set when INFERENCE_FALLBACK_PROVIDER named something unrecognized. */
  invalidFallback: string | null;
};

/**
 * Reads INFERENCE_PROVIDER / INFERENCE_FALLBACK_ENABLED / INFERENCE_FALLBACK_PROVIDER.
 *
 * Parsing never throws: a request path must not fail because an operator wrote an
 * unknown provider name (the product then serves through the documented default
 * while preflightInferenceProviders() reports the mistake loudly at boot).
 *
 * Failover is opt-in twice over: the fallback provider must be named AND fallover
 * must be enabled. Naming a provider without enabling it leaves `fallback` null, so
 * a request that fails on the primary surfaces the primary's error instead of being
 * answered by a different model behind the user's back.
 */
export function inferenceProviderConfig(): InferenceProviderSelection {
  const requested = (optional("INFERENCE_PROVIDER") ?? "openrouter").toLowerCase();
  const provider = INFERENCE_PROVIDER_ALIASES[requested] ?? "openrouter";
  const invalid = INFERENCE_PROVIDER_ALIASES[requested] ? null : requested;
  const fallbackRaw = optional("INFERENCE_FALLBACK_PROVIDER")?.toLowerCase();
  const requestedFallback = fallbackRaw ? INFERENCE_PROVIDER_ALIASES[fallbackRaw] ?? null : null;
  const invalidFallback = fallbackRaw && !requestedFallback ? fallbackRaw : null;
  const fallbackCandidate = requestedFallback && requestedFallback !== provider ? requestedFallback : null;
  // Off by default. Either documented spelling enables it.
  const fallbackEnabled = booleanFlag("INFERENCE_FALLBACK_ENABLED", false) || booleanFlag("INFERENCE_FAILOVER_ENABLED", false);
  const fallback = fallbackEnabled ? fallbackCandidate : null;
  return { provider, fallback, fallbackEnabled, fallbackCandidate, requested, invalid, invalidFallback };
}

// ---------------------------------------------------------------------------
// Inference configuration diagnostics.
// ---------------------------------------------------------------------------
// Request paths must never fail because a variable is missing; they must fail
// with a message that NAMES the missing variable. These helpers produce that list
// from configuration presence only (never a value), so Overview, the Playground and
// the API gateway can tell an operator exactly what to set instead of showing an
// unexplained "no data".
export type ProviderConfigurationGap = {
  provider: InferenceProviderId;
  configured: boolean;
  /** Environment variables (or facts) that are missing for this provider. */
  missing: string[];
};

export function providerConfigurationGap(provider: InferenceProviderId): ProviderConfigurationGap {
  if (provider === "vast") {
    let enabled = false;
    let hasEndpoint = false;
    let hasKey = false;
    try {
      const config = vastInferenceConfig();
      enabled = config.enabled;
      hasEndpoint = config.enabled ? config.baseUrl !== null : Boolean(optionalAny("VASTAI_BASE_URL", "VAST_INFERENCE_BASE_URL"));
      hasKey = config.enabled ? config.apiKey !== null : Boolean(optionalAny("VASTAI_BEARER_TOKEN", "VAST_INFERENCE_API_KEY"));
    } catch {
      enabled = false;
    }
    const lifecycle = vastLifecycleConfig().enabled;
    const missing: string[] = [];
    if (!hasEndpoint && !lifecycle) missing.push("VASTAI_BASE_URL (or VASTAI_LIFECYCLE_ENABLED=true)");
    // A rented/statically-provisioned instance may run without a service key, so
    // an absent bearer token is reported but is not a hard gap.
    if (!hasKey && !lifecycle) missing.push("VASTAI_BEARER_TOKEN (the instance's --api-key, optional when the server has none)");
    return { provider, configured: enabled, missing };
  }
  let enabled = false;
  try { enabled = openRouterConfig().enabled; } catch { enabled = false; }
  const missing: string[] = [];
  if (!enabled) {
    missing.push("OPENROUTER_ENABLED=true");
    if (!optional("OPENROUTER_API_KEY")) missing.push("OPENROUTER_API_KEY");
  }
  return { provider, configured: enabled, missing };
}

/** The marketplace key variable in use, for the in-app provider check. */
export function vastMarketplaceKeyVariable(): string | null {
  return vastApiKeySource().variable;
}

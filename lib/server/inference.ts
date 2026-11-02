export type InferenceMessage = { role: "system" | "user" | "assistant"; content: string };

export type CompletionParameters = {
  systemPrompt?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  seed?: number;
  stop?: string[];
};

export type InferenceRequest = {
  operationKey: string;
  model: string;
  messages: InferenceMessage[];
  parameters?: CompletionParameters;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
  /**
   * Registry-owned cost specification for this model.
   *
   * Present so a provider whose own cost model is deployment-wide (a rented
   * vast.ai GPU priced from GPU time) charges exactly the rate the registry
   * publishes — the same number the Overview card displays. A provider with its
   * own upstream pricing (OpenRouter reports cost per response) ignores it.
   */
  cost?: ModelCostSpec | null;
};

export type InferenceUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  providerCostMicroUsd: bigint | null;
  uncertain: boolean;
};

// Why a stream ended. "stop"/"length" come from the upstream server; the other
// three are produced locally so the conversation layer can tell a finished turn
// apart from an interrupted one that still has persistable partial content.
export type InferenceFinishReason = "stop" | "length" | "cancelled" | "timeout" | "error";

/**
 * Which provider actually produced a terminal event.
 *
 * `servedBy` is the canonical provider id ("vast" / "openrouter"). `failedOver`
 * marks a response that was served by the configured fallback after the primary
 * failed, so the compute ledger and the request record can attribute the turn —
 * and its cost — to the provider that really served it.
 */
export type ProviderProvenance = { servedBy?: string; failedOver?: boolean };

export type InferenceChunk =
  | { type: "delta"; text: string }
  | ({ type: "complete"; output: string; usage: InferenceUsage; finishReason?: InferenceFinishReason } & ProviderProvenance)
  | ({ type: "error"; error: NormalizedProviderError } & ProviderProvenance);

export type NormalizedProviderError = {
  code:
    | "cancelled"
    | "unsupported_model"
    | "invalid_request"
    | "authentication"
    | "rate_limited"
    | "timeout"
    | "upstream"
    | "malformed_response"
    | "unavailable"
    /** The PRD's `model_unavailable`: the model could not be started in budget. */
    | "model_unavailable";
  message: string;
  retryable: boolean;
};

export type ProviderCatalogModel = {
  providerModelId: string;
  contextLength: number | null;
  pricing: Record<string, string>;
  architecture: { inputModalities: string[]; outputModalities: string[] };
  supportedParameters: string[];
};

// Normalized provider health. `status` is the coarse state the product shows
// ("operational" / "degraded" / "unavailable"); `healthy` is the boolean the
// request paths gate on, so both styles of caller read the same probe result.
export type InferenceStatus = "operational" | "degraded" | "unavailable";

export type InferenceHealth = {
  healthy: boolean;
  message?: "available" | "unavailable";
  status?: InferenceStatus;
  latencyMs?: number | null;
  modelIds?: string[];
  /** Lifecycle-managed fleets report how many machines are warm / still starting. */
  warmInstances?: number;
  pendingInstances?: number;
};

/** Normalized token counts. `totalTokens` is always prompt + completion. */
export type TokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

/** Per-token provider pricing in USD (the unit the model registry stores). */
export type ModelTokenPricing = { promptUsdPerToken?: number | null; completionUsdPerToken?: number | null };

/**
 * Everything the cost calculation may need for one model: either per-token
 * pricing (OpenRouter-style `{ prompt, completion }` strings or explicit
 * numbers), or the GPU-hour economics a rented vast.ai instance is billed on.
 */
export type ModelCostSpec = {
  pricing?: ModelTokenPricing | Record<string, string> | null;
  hourlyMicroUsd?: bigint | null;
  tokensPerSecond?: number | null;
};

/** Non-streaming normalized response. Provider failures ride along in `error`. */
export type InferenceCompletion = {
  output: string;
  finishReason: InferenceFinishReason;
  usage: InferenceUsage;
  model: string;
  error?: NormalizedProviderError;
  /** Which provider produced this completion (see ProviderProvenance). */
  servedBy?: string;
  failedOver?: boolean;
};

export interface InferenceProvider {
  stream(request: InferenceRequest): AsyncIterable<InferenceChunk>;
  catalog(): Promise<ProviderCatalogModel[]>;
  health(): Promise<InferenceHealth>;
  cancel(operationKey: string): Promise<void>;
}

/**
 * The full PRD provider contract. Any replacement provider implements this, so
 * the Playground, the registry sync, and the compute ledger never learn which
 * upstream served the tokens.
 */
export interface CompletionProvider extends InferenceProvider {
  complete(request: InferenceRequest): Promise<InferenceCompletion>;
  usage(response: unknown): TokenUsage & { estimated: boolean };
  cost(usage: TokenUsage, model?: ModelCostSpec | ModelTokenPricing | null): bigint | null;
}

export const PROVIDER_ERRORS: Record<NormalizedProviderError["code"], Omit<NormalizedProviderError, "code">> = {
  cancelled: { message: "Inference was cancelled.", retryable: false },
  unsupported_model: { message: "The selected model is not available.", retryable: false },
  // A cold machine that could not be brought up inside the configured budget is
  // transient: retrying (or choosing another model) can succeed.
  model_unavailable: { message: "This model could not be started right now. Please retry.", retryable: true },
  invalid_request: { message: "The inference request could not be accepted.", retryable: false },
  authentication: { message: "Inference is temporarily unavailable.", retryable: false },
  rate_limited: { message: "Inference is busy. Please try again shortly.", retryable: true },
  timeout: { message: "Inference timed out. Please try again.", retryable: true },
  upstream: { message: "Inference could not be completed.", retryable: true },
  malformed_response: { message: "Inference returned an invalid result.", retryable: true },
  unavailable: { message: "Inference is temporarily unavailable.", retryable: true },
};

// The PRD names the failure taxonomy rate_limit / auth / model_unavailable /
// timeout / upstream_error / cancelled. These aliases map those names onto the
// stored codes so every caller keeps reading one vocabulary.
export const PROVIDER_ERROR_CODE_ALIASES = {
  rate_limit: "rate_limited",
  auth: "authentication",
  model_unavailable: "model_unavailable",
  timeout: "timeout",
  upstream_error: "upstream",
  cancelled: "cancelled",
} as const satisfies Record<string, NormalizedProviderError["code"]>;

export type ProviderErrorAlias = keyof typeof PROVIDER_ERROR_CODE_ALIASES;

export function providerErrorAlias(alias: ProviderErrorAlias): NormalizedProviderError["code"] {
  return PROVIDER_ERROR_CODE_ALIASES[alias];
}

export function normalizedProviderError(code: NormalizedProviderError["code"]): NormalizedProviderError {
  return { code, ...PROVIDER_ERRORS[code] };
}

/**
 * Map an unexpected thrown value onto the normalized taxonomy.
 *
 * A provider transports its own failures as `error` chunks, but a transport bug,
 * an aborted socket or a DNS failure can still surface as an exception. This keeps
 * even those normalized, so no upstream status / stack / message ever leaks into a
 * response body: an abort is `cancelled`, a deadline is `timeout`, anything else is
 * the retryable `upstream`.
 */
export function normalizedErrorFromThrown(error: unknown): NormalizedProviderError {
  const name = error instanceof Error ? error.name : "";
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : "";
  if (name === "AbortError" || code === "ABORT_ERR" || code === "UND_ERR_ABORTED") return normalizedProviderError("cancelled");
  if (name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return normalizedProviderError("timeout");
  return normalizedProviderError("upstream");
}

/**
 * The failure modes an optional provider failover may retry elsewhere.
 *
 * These describe an OUTAGE or a capacity problem on the primary provider: the
 * upstream is failing, the turn timed out, or the model could not be started. By
 * contrast, `authentication`, `invalid_request`, `unsupported_model` and the
 * configuration-shaped `unavailable` are NOT eligible — they mean the deployment is
 * misconfigured or the request itself is wrong, so replaying it on another provider
 * would either fail identically or hide a setup mistake. `rate_limited` is likewise
 * excluded: the primary is healthy and will serve again shortly, and switching
 * providers there would silently move the user's spend.
 */
export const FALLBACK_ELIGIBLE_ERROR_CODES: ReadonlyArray<NormalizedProviderError["code"]> = ["upstream", "timeout", "model_unavailable"];

/** Whether a normalized failure is a provider outage that failover may retry. */
export function isFallbackEligibleError(error: NormalizedProviderError | null | undefined): boolean {
  if (!error) return false;
  if (!error.retryable) return false;
  return FALLBACK_ELIGIBLE_ERROR_CODES.includes(error.code);
}

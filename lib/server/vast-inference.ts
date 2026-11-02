import { vastInferenceConfig, vastLifecycleConfig, type VastInferenceConfig, type VastModelMap, type VastTokenPricing } from "./config";
import {
  normalizedProviderError,
  type CompletionProvider,
  type InferenceChunk,
  type InferenceCompletion,
  type InferenceFinishReason,
  type InferenceHealth,
  type InferenceRequest,
  type InferenceUsage,
  type ModelCostSpec,
  type ModelTokenPricing,
  type NormalizedProviderError,
  type ProviderCatalogModel,
  type TokenUsage,
} from "./inference";
import { instanceFleetHealth } from "./instance-health";
import { ensureInstance, touchInstance, InstanceUnavailableError } from "./vast-lifecycle";

// VastAIProvider — the vast.ai implementation of the normalized inference
// contract (PRD § provider abstraction).
//
// Transport: a rented vast.ai GPU instance running vLLM (or any other
// OpenAI-compatible server). The endpoint is an ordinary HTTP JSON/SSE API, so
// the only vast.ai-specific knowledge in this file is the configuration shape
// (base URL + bearer service key + per-model routes) and the cost model for GPU
// time.
//
// Two endpoint shapes:
//   - STATIC (VASTAI_BASE_URL): one pre-provisioned machine serves everything.
//   - MANAGED (VASTAI_LIFECYCLE_ENABLED): the endpoint for a curated model is
//     resolved per request by the instance lifecycle manager, which rents a
//     machine when none is warm. A cold start that exceeds the configured budget
//     surfaces as the normalized, retryable `model_unavailable` error — never as
//     an upstream status, and never with compute debited for the failed portion.
//
// Everything that leaves this module is normalized: chunks carry `delta` /
// `complete` / `error`, usage is `{ inputTokens, outputTokens, providerCostMicroUsd,
// uncertain }`, and every failure is one of the shared error codes. The
// Playground, the API gateway, the registry sync, and the compute ledger never
// see an upstream status code, header, or error body.
//
// Pricing authority: a vLLM server publishes no per-token price, so cost() prefers
// the REGISTRY's per-token rate (handed in on `request.cost`) over the
// deployment-wide default. That is what keeps a card's advertised price and the
// ledger's debit identical.
//
// Credential boundary: the service key is read from the server environment (or,
// in managed mode, from the rented instance's own row) and only ever attached as
// `Authorization: Bearer <key>`. It is never logged, never returned, and never
// embedded in an error message.

/** Resolved configuration the provider works against. */
export type VastInferenceSettings =
  | { enabled: false; modelMap?: VastModelMap }
  | {
      enabled: true;
      /** Static root, or null when the lifecycle manager resolves it per model. */
      baseUrl: string | null;
      /** True when endpoints come from rented instances. */
      managed?: boolean;
      apiKey: string | null;
      requestTimeoutMs: number;
      idleTimeoutMs: number;
      healthTimeoutMs: number;
      tokensPerSecond: number;
      pricing: VastTokenPricing;
      /** Non-streaming retry budget for retryable upstream failures. Default 1. */
      maxRetries?: number;
      /** Minutes an idle rented instance may sit before lifecycle shutdown. */
      idleShutdownMinutes?: number;
      /** Curated model id (lowercase) → vast.ai model identifier / endpoint. */
      modelMap?: VastModelMap;
    };

/** An endpoint the lifecycle manager reports as usable. */
export type ResolvedInstance = { baseUrl: string; apiKey: string | null; instanceId?: string };

/** Injectable seams, so tests can drive the transport without a live GPU. */
export type VastAIProviderOptions = {
  settings?: VastInferenceSettings;
  fetchImpl?: typeof fetch;
  /** Endpoint resolver override; defaults to the lifecycle manager in managed mode. */
  resolveInstance?: (model: string) => Promise<ResolvedInstance | null>;
};

/** Which endpoint + model identifier one request resolves to. */
export type VastRoute = { baseUrl: string; model: string; apiKey: string | null; instanceId?: string };

/** The curated→vast.ai mapping shape the registry reads (the registry column wins). */
export type VastModelMapLike = Record<string, { modelId: string; baseUrl?: string } | undefined>;

// Upstream payload shapes accepted from an OpenAI-compatible server. Every field
// is `unknown` because nothing upstream is trusted until it is validated.
type ChatCompletionBody = {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
};

type StreamEvent = {
  choices?: Array<{ delta?: { role?: unknown; content?: unknown }; finish_reason?: unknown }>;
  usage?: unknown;
  error?: unknown;
};

// In-flight streams, so cancel(operationKey) can terminate the upstream request.
// Keyed by operationKey (the same value the Playground "Stop" path and the
// inference_records row use) so a stop request reaches the right connection.
const inFlight = new Map<string, AbortController>();

/** Test/ops helper: how many upstream streams this process is currently holding. */
export function activeVastStreams(): number {
  return inFlight.size;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  }
  return null;
}

/**
 * Tokenizer-based estimate used when an upstream omits usage. Roughly four
 * characters per token, never zero for non-empty text. The result is always
 * paired with `uncertain: true` so the ledger can reconcile it later.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function finishReason(value: unknown): InferenceFinishReason {
  return value === "length" ? "length" : "stop";
}

/**
 * Maps an HTTP status onto the shared normalized error taxonomy:
 *   401 / 403 → authentication (never retried)
 *   404 → unsupported_model
 *   408 / 504 → timeout
 *   429 → rate_limited (retryable, surfaced to the UI)
 *   5xx → upstream (retryable, eligible for fallback)
 *   other 4xx → invalid_request
 */
export function normalizedErrorForStatus(status: number): NormalizedProviderError {
  if (status === 401 || status === 403) return normalizedProviderError("authentication");
  if (status === 404) return normalizedProviderError("unsupported_model");
  if (status === 408 || status === 504) return normalizedProviderError("timeout");
  if (status === 429) return normalizedProviderError("rate_limited");
  if (status >= 500) return normalizedProviderError("upstream");
  return normalizedProviderError("invalid_request");
}

/**
 * Maps a lifecycle failure onto the normalized taxonomy. A cold machine that could
 * not be started is `model_unavailable` (retryable); a capacity or configuration
 * problem is `unavailable`.
 */
export function normalizedErrorForInstance(error: unknown): NormalizedProviderError {
  if (error instanceof InstanceUnavailableError) {
    if (error.reason === "cold_start_timeout" || error.reason === "start_failed" || error.reason === "lost") return normalizedProviderError("model_unavailable");
    return normalizedProviderError("unavailable");
  }
  return normalizedProviderError("unavailable");
}

/**
 * Resolves the curated model id a caller passes (`glm-4.5`) into the identifier
 * the vast.ai server actually serves (`Qwen/Qwen3-235B-A22B`) and, when the
 * mapping names one, the endpoint that serves it. An unmapped identifier is
 * passed through unchanged, which is what a deployment with a single enormous
 * instance serving one model id expects.
 */
export function resolveVastRoute(baseUrl: string, model: string, modelMap: VastModelMap | undefined): { baseUrl: string; model: string } {
  const key = typeof model === "string" ? model.trim().toLowerCase() : "";
  const target = key && modelMap ? modelMap[key] : undefined;
  if (!target) return { baseUrl, model };
  return { baseUrl: target.baseUrl ?? baseUrl, model: target.modelId };
}

/** The marketplace identifier for a curated model, or the id itself. */
function mappedModelId(model: string, modelMap: VastModelMap | undefined): string {
  const key = typeof model === "string" ? model.trim().toLowerCase() : "";
  return (key && modelMap ? modelMap[key]?.modelId : undefined) ?? model;
}

/**
 * The deployment's per-model mapping, resolved from the environment. Used by the
 * registry (to know which models this vast.ai deployment can actually serve) and
 * by the provider itself, so there is one source of truth. The registry's
 * `vast_model_id` column takes precedence over this map.
 */
export function vastModelTargets(): VastModelMapLike {
  try {
    return vastInferenceConfig().modelMap;
  } catch {
    return {};
  }
}

const ZERO_USAGE: InferenceUsage = { inputTokens: 0, outputTokens: 0, providerCostMicroUsd: 0n, uncertain: false };

/** Sentinel resolved by the abort notice that races every blocking read. */
const ABORTED = Symbol("aborted");

/**
 * Resolves once `signal` aborts (immediately if it already has). Racing this
 * against `reader.read()` is what makes an idle stall or a caller abort break
 * out within one chunk instead of waiting for the socket to notice.
 */
function abortNotice(signal: AbortSignal): { promise: Promise<typeof ABORTED>; dispose: () => void } {
  let dispose = () => undefined as void;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, dispose };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VastAIProvider implements CompletionProvider {
  private readonly options: VastAIProviderOptions;

  constructor(options: VastAIProviderOptions = {}) {
    this.options = options;
  }

  // --- configuration -------------------------------------------------------

  private settings(): VastInferenceSettings {
    return this.options.settings ?? (vastInferenceConfig() as VastInferenceSettings);
  }

  private fetcher(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Whether endpoints come from the lifecycle manager rather than a static URL. */
  private managed(settings: Extract<VastInferenceSettings, { enabled: true }>): boolean {
    if (typeof settings.managed === "boolean") return settings.managed;
    return settings.baseUrl === null;
  }

  /**
   * Resolves the endpoint, model identifier, and service key for one request.
   *
   * Static mode: the configured base URL with the per-model mapping applied.
   * Managed mode: the lifecycle manager's warm endpoint, renting a machine when
   * none exists. The rented instance's endpoint AND its own service key always
   * win there — the model map only supplies the identifier the machine serves.
   *
   * Returns the normalized error instead of throwing, so the streaming and
   * non-streaming paths can report a cold-start failure identically.
   */
  async route(model: string): Promise<{ route: VastRoute | null; error: NormalizedProviderError | null }> {
    const settings = this.settings();
    if (!settings.enabled) return { route: null, error: normalizedProviderError("unavailable") };

    if (this.managed(settings)) {
      try {
        const resolved = this.options.resolveInstance ?? ((target: string) => ensureInstance(target));
        const instance = await resolved(model);
        if (instance) {
          return {
            route: { baseUrl: instance.baseUrl, model: mappedModelId(model, settings.modelMap), apiKey: instance.apiKey, instanceId: instance.instanceId },
            error: null,
          };
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: "vast_instance_unavailable",
          reason: error instanceof InstanceUnavailableError ? error.reason : "unknown",
          model,
        }));
        return { route: null, error: normalizedErrorForInstance(error) };
      }
    }

    if (!settings.baseUrl) return { route: null, error: normalizedProviderError("unavailable") };
    const staticRoute = resolveVastRoute(settings.baseUrl, model, settings.modelMap);
    return { route: { baseUrl: staticRoute.baseUrl, model: staticRoute.model, apiKey: settings.apiKey }, error: null };
  }

  /** The normalized failure map, exposed as part of the provider contract. */
  readonly errors = {
    fromStatus: (status: number) => normalizedErrorForStatus(status),
    cancelled: () => normalizedProviderError("cancelled"),
    timeout: () => normalizedProviderError("timeout"),
    unavailable: () => normalizedProviderError("unavailable"),
    malformed: () => normalizedProviderError("malformed_response"),
    modelUnavailable: () => normalizedProviderError("model_unavailable"),
  };

  private headers(apiKey: string | null): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  private payload(request: InferenceRequest, stream: boolean, model: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model,
      // The system prompt travels as the first message: vLLM's
      // OpenAI-compatible server has no separate system-prompt field.
      messages: request.messages,
      stream,
    };
    if (stream) payload.stream_options = { include_usage: true };
    const parameters = request.parameters ?? {};
    if (parameters.temperature !== undefined) payload.temperature = parameters.temperature;
    if (parameters.top_p !== undefined) payload.top_p = parameters.top_p;
    if (parameters.max_tokens !== undefined) payload.max_tokens = parameters.max_tokens;
    if (parameters.max_completion_tokens !== undefined) payload.max_completion_tokens = parameters.max_completion_tokens;
    if (parameters.seed !== undefined) payload.seed = parameters.seed;
    if (parameters.stop?.length) payload.stop = parameters.stop;
    return payload;
  }

  // --- usage + cost --------------------------------------------------------

  /**
   * Normalizes token counts from an upstream body (or an already-normalized
   * usage object / a bare usage record). When the upstream omits usage
   * entirely, the counts are estimated from the supplied fallback text and
   * flagged `estimated` so the ledger records it for reconciliation.
   */
  usage(response: unknown, fallback?: { promptText?: string; completionText?: string }): TokenUsage & { estimated: boolean } {
    const raw = objectValue(response);
    // Accept either a full completion body ({ usage: {...} }) or a bare usage
    // record ({ prompt_tokens, completion_tokens }).
    const usage = "prompt_tokens" in raw || "completion_tokens" in raw || "input_tokens" in raw || "output_tokens" in raw
      ? raw
      : objectValue(raw.usage);
    const promptTokens = safeCount(usage.prompt_tokens ?? usage.input_tokens);
    const completionTokens = safeCount(usage.completion_tokens ?? usage.output_tokens);
    if (promptTokens !== null || completionTokens !== null) {
      const prompt = promptTokens ?? 0;
      const completion = completionTokens ?? 0;
      return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, estimated: false };
    }
    const prompt = estimateTokens(fallback?.promptText ?? "");
    const completion = estimateTokens(fallback?.completionText ?? "");
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, estimated: true };
  }

  /**
   * Resolves per-token USD pricing, in precedence order:
   *   1. explicit numbers on the model spec (`promptUsdPerToken` / `completionUsdPerToken`)
   *   2. registry pricing strings (`{ prompt, completion }`, USD per token)
   *   3. GPU-hour economics (`hourlyMicroUsd` + `tokensPerSecond`)
   *   4. the deployment's configured default rates
   */
  private perTokenPricing(model?: ModelCostSpec | ModelTokenPricing | null): VastTokenPricing {
    const settings = this.settings();
    const fallback: VastTokenPricing = settings.enabled ? settings.pricing : { promptUsdPerToken: 0, completionUsdPerToken: 0 };
    if (!model) return fallback;

    const asSpec = model as ModelCostSpec & ModelTokenPricing;
    if (typeof asSpec.promptUsdPerToken === "number" || typeof asSpec.completionUsdPerToken === "number") {
      return {
        promptUsdPerToken: typeof asSpec.promptUsdPerToken === "number" ? asSpec.promptUsdPerToken : fallback.promptUsdPerToken,
        completionUsdPerToken: typeof asSpec.completionUsdPerToken === "number" ? asSpec.completionUsdPerToken : fallback.completionUsdPerToken,
      };
    }

    const pricing = objectValue((model as ModelCostSpec).pricing);
    const prompt = Number(pricing.prompt ?? pricing.input);
    const completion = Number(pricing.completion ?? pricing.output);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      return { promptUsdPerToken: prompt, completionUsdPerToken: completion };
    }

    // GPU-hour derivation: a rented instance's cost per token is its hourly
    // price spread over the tokens it can produce in an hour.
    const hourly = (model as ModelCostSpec).hourlyMicroUsd;
    const throughput = (model as ModelCostSpec).tokensPerSecond;
    if (hourly != null && throughput != null && throughput > 0) {
      const microPerToken = Number(hourly) / (throughput * 3600);
      return { promptUsdPerToken: microPerToken / 1_000_000, completionUsdPerToken: microPerToken / 1_000_000 };
    }

    return fallback;
  }

  /**
   * Normalized provider cost in micro-USD. Integer math at the boundary: the
   * per-token multiplication is rounded once, so the ledger never receives a
   * fractional unit.
   */
  cost(usage: TokenUsage, model?: ModelCostSpec | ModelTokenPricing | null): bigint | null {
    const pricing = this.perTokenPricing(model);
    const promptMicro = Number(usage.promptTokens) * pricing.promptUsdPerToken * 1_000_000;
    const completionMicro = Number(usage.completionTokens) * pricing.completionUsdPerToken * 1_000_000;
    const total = promptMicro + completionMicro;
    if (!Number.isFinite(total) || total < 0) return null;
    return BigInt(Math.round(total));
  }

  // --- health --------------------------------------------------------------

  /**
   * Probes the deployment's inference transport.
   *
   * Managed mode aggregates the health of every usable rented instance (each one
   * probed at its own /models route). A fleet with no warm machine still reports
   * healthy when a cold machine can be rented on demand, because the request path
   * is able to serve — the first turn simply pays the cold-start budget. That is
   * what keeps the Overview badge honest: `degraded` rather than a false outage.
   *
   * Static mode probes GET {baseUrl}/models: `operational` when the endpoint
   * answers within the configured timeout, `degraded` when it answers but rejects
   * us (auth / throttling), `unavailable` when it cannot be reached at all.
   */
  async health(): Promise<InferenceHealth> {
    const settings = this.settings();
    if (!settings.enabled) return { healthy: false, message: "unavailable", status: "unavailable", latencyMs: null, modelIds: [] };

    if (this.managed(settings)) {
      const fleet = await instanceFleetHealth();
      if (fleet.status === "operational") {
        return {
          healthy: true,
          message: "available",
          status: "operational",
          latencyMs: fleet.latencyMs,
          modelIds: fleet.modelIds,
          warmInstances: fleet.warm,
          pendingInstances: fleet.pending,
        };
      }
      // Nothing warm. Whether that is an outage depends on whether a machine may
      // still be rented: with a lifecycle policy published, a cold model warms on
      // demand, so the provider can serve and health stays usable-but-degraded.
      let rentable = false;
      try {
        rentable = vastLifecycleConfig().enabled;
      } catch {
        rentable = false;
      }
      if (rentable) {
        return {
          healthy: true,
          message: "available",
          status: "degraded",
          latencyMs: fleet.latencyMs,
          modelIds: fleet.modelIds,
          warmInstances: fleet.warm,
          pendingInstances: fleet.pending,
        };
      }
      return {
        healthy: false,
        message: "unavailable",
        status: "unavailable",
        latencyMs: fleet.latencyMs,
        modelIds: [],
        warmInstances: fleet.warm,
        pendingInstances: fleet.pending,
      };
    }

    if (!settings.baseUrl) return { healthy: false, message: "unavailable", status: "unavailable", latencyMs: null, modelIds: [] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.healthTimeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetcher()(`${settings.baseUrl}/models`, {
        method: "GET",
        headers: { Accept: "application/json", ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
        cache: "no-store",
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        const status = response.status === 401 || response.status === 403 ? "unavailable" : "degraded";
        console.error(JSON.stringify({ event: "vast_inference_health_failed", reason: "status", status: response.status }));
        return { healthy: false, message: "unavailable", status, latencyMs, modelIds: [] };
      }
      const body = objectValue(await response.json().catch(() => ({})));
      const data = Array.isArray(body.data) ? body.data : [];
      const modelIds = data
        .map((entry) => objectValue(entry).id)
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .slice(0, 100);
      return { healthy: true, message: "available", status: "operational", latencyMs, modelIds, warmInstances: 1 };
    } catch (caught) {
      const timedOut = controller.signal.aborted || (caught instanceof Error && caught.name === "AbortError");
      console.error(JSON.stringify({ event: "vast_inference_health_failed", reason: timedOut ? "timeout" : "transport" }));
      return { healthy: false, message: "unavailable", status: "unavailable", latencyMs: Date.now() - startedAt, modelIds: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The models this instance actually serves, normalized for registry sync. */
  async catalog(): Promise<ProviderCatalogModel[]> {
    const settings = this.settings();
    if (!settings.enabled) throw new Error("catalog_unavailable");

    // Managed mode has no single catalogue: each curated model maps to its own
    // machine, so the curated→provider mapping IS the catalogue.
    if (this.managed(settings) || !settings.baseUrl) {
      const map = settings.modelMap ?? {};
      const entries = Object.values(map)
        .map((target) => target.modelId.trim())
        .filter((id) => id.length > 0);
      return Array.from(new Set(entries)).map((providerModelId) => ({
        providerModelId,
        contextLength: null,
        pricing: {},
        architecture: { inputModalities: ["text"], outputModalities: ["text"] },
        supportedParameters: ["temperature", "top_p", "max_tokens", "stop", "seed"],
      }));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.healthTimeoutMs);
    try {
      const response = await this.fetcher()(`${settings.baseUrl}/models`, {
        method: "GET",
        headers: { Accept: "application/json", ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        console.error(JSON.stringify({ event: "vast_inference_catalog_failed", status: response.status }));
        throw new Error("catalog_unavailable");
      }
      const body = objectValue(await response.json().catch(() => ({})));
      if (!Array.isArray(body.data)) throw new Error("catalog_malformed");
      return body.data.flatMap((entry): ProviderCatalogModel[] => {
        const raw = objectValue(entry);
        if (typeof raw.id !== "string" || !raw.id.trim()) return [];
        const contextLength = safeCount(raw.max_model_len ?? raw.context_length);
        return [{
          providerModelId: raw.id,
          contextLength,
          // vLLM publishes no per-token pricing; cost is derived from the GPU hour.
          pricing: {},
          architecture: { inputModalities: ["text"], outputModalities: ["text"] },
          supportedParameters: ["temperature", "top_p", "max_tokens", "stop", "seed"],
        }];
      });
    } catch (caught) {
      if (caught instanceof Error && (caught.message === "catalog_unavailable" || caught.message === "catalog_malformed")) throw caught;
      console.error(JSON.stringify({ event: "vast_inference_catalog_failed", reason: "transport" }));
      throw new Error("catalog_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  // --- cancellation --------------------------------------------------------

  /** Terminates the upstream request for one operation, if it is in flight. */
  async cancel(operationKey: string): Promise<void> {
    const controller = inFlight.get(operationKey);
    if (!controller) return;
    controller.abort();
    inFlight.delete(operationKey);
  }

  // --- streaming -----------------------------------------------------------

  /**
   * Streams normalized deltas, then one terminal event.
   *
   * Terminal events, in order of what can interrupt a stream:
   *   - a clean upstream finish → `complete` with finishReason stop|length
   *   - caller abort (Playground "Stop") → `error` cancelled
   *   - idle stall / request deadline → `error` timeout
   *   - a cold machine that could not start → `error` model_unavailable
   *   - the instance dying mid-stream → `error` upstream (partial content stands)
   *   - upstream 4xx/5xx → `error` with the mapped code
   *
   * A delta is never emitted after a terminal event: the read loop breaks
   * immediately, so cancellation stops delivery within one chunk.
   */
  async *stream(request: InferenceRequest): AsyncIterable<InferenceChunk> {
    const settings = this.settings();
    if (!settings.enabled) {
      yield { type: "error", error: normalizedProviderError("unavailable") };
      return;
    }
    if (request.signal?.aborted) {
      yield { type: "error", error: normalizedProviderError("cancelled") };
      return;
    }

    // Resolve the endpoint first: in managed mode this may rent and warm a machine,
    // which is where a cold-start failure is detected (before any compute is spent).
    const resolved = await this.route(request.model);
    if (!resolved.route) {
      yield { type: "error", error: resolved.error ?? normalizedProviderError("unavailable") };
      return;
    }
    const route = resolved.route;

    const controller = new AbortController();
    inFlight.set(request.operationKey, controller);

    // "idle" and "request" describe *why* we aborted; a caller abort is tracked
    // through request.signal directly.
    let abortReason: "idle" | "request" | null = null;
    const requestTimer = setTimeout(() => {
      abortReason = "request";
      controller.abort();
    }, settings.requestTimeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortReason = "idle";
        controller.abort();
      }, settings.idleTimeoutMs);
    };
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(requestTimer);
      if (idleTimer) clearTimeout(idleTimer);
      request.signal?.removeEventListener("abort", onAbort);
      if (inFlight.get(request.operationKey) === controller) inFlight.delete(request.operationKey);
    };

    const abortError = (): NormalizedProviderError => {
      if (request.signal?.aborted) return normalizedProviderError("cancelled");
      if (abortReason === "idle" || abortReason === "request") return normalizedProviderError("timeout");
      return normalizedProviderError("upstream");
    };

    let output = "";
    let upstreamUsage: unknown = null;
    let upstreamFinish: InferenceFinishReason = "stop";
    let aborted = false;

    try {
      const response = await this.fetcher()(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers(route.apiKey), Accept: "text/event-stream" },
        body: JSON.stringify(this.payload(request, true, route.model)),
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        // Drain the body without reading it: upstream error text is never
        // surfaced, logged, or persisted.
        await response.body?.cancel().catch(() => undefined);
        console.error(JSON.stringify({ event: "vast_inference_stream_failed", reason: "status", status: response.status, correlationId: request.operationKey }));
        yield { type: "error", error: normalizedErrorForStatus(response.status) };
        return;
      }

      // Reset the instance's idle clock: this machine is in use, so the lifecycle
      // sweeper must not shut it down underneath the stream.
      if (route.instanceId) void touchInstance(route.instanceId);

      armIdle();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // One abort notice covers the whole stream: the idle timer and the caller
      // both abort `controller`, and the race below breaks out immediately.
      const notice = abortNotice(controller.signal);

      // Parses one buffered `data:` payload. Returns whether to stop the loop
      // and, when the frame carried content, the delta to deliver.
      const handleEvent = (raw: string): { stop: boolean; chunk?: InferenceChunk } => {
        if (!raw) return { stop: false };
        if (raw === "[DONE]") return { stop: true };
        let event: StreamEvent;
        try {
          event = JSON.parse(raw) as StreamEvent;
        } catch {
          // A malformed frame is skipped, not fatal: one bad frame must not
          // terminate a working conversation.
          console.error(JSON.stringify({ event: "vast_inference_malformed_frame", correlationId: request.operationKey }));
          return { stop: false };
        }
        if (event.error !== undefined) {
          console.error(JSON.stringify({ event: "vast_inference_stream_error_frame", correlationId: request.operationKey }));
          return { stop: true, chunk: { type: "error", error: normalizedProviderError("upstream") } };
        }
        const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
        const text = choice?.delta?.content;
        const delta = typeof text === "string" && text.length > 0 ? text : null;
        if (delta) output += delta;
        // The final usage frame (stream_options.include_usage) carries the real
        // token counts; keep the last one seen.
        if (event.usage !== undefined && event.usage !== null) upstreamUsage = event.usage;
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) upstreamFinish = finishReason(choice.finish_reason);
        return { stop: false, chunk: delta ? { type: "delta", text: delta } : undefined };
      };

      try {
        let finished = false;
        while (!finished) {
          // Race the blocking read against the abort notice. Without this a
          // server that holds the connection open without sending bytes (or a
          // user pressing Stop) would hang the stream indefinitely.
          const raced = await Promise.race([reader.read(), notice.promise]);
          if (raced === ABORTED) {
            aborted = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          const { done, value } = raced;
          if (done) break;
          armIdle();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const result = handleEvent(line.slice(5).trim());
            if (result.chunk) yield result.chunk;
            if (result.stop) {
              finished = true;
              break;
            }
          }
        }
        // A final frame may arrive without a trailing newline.
        if (!finished && !aborted && buffer.trim()) {
          const line = buffer.trim();
          if (line.startsWith("data:")) {
            const result = handleEvent(line.slice(5).trim());
            if (result.chunk) yield result.chunk;
          }
        }
      } finally {
        notice.dispose();
        try {
          reader.releaseLock();
        } catch {
          // A read was still pending when we tore the connection down.
        }
      }

      // Cancellation and stalls end the stream with their own terminal event,
      // so partial content is reported rather than silently truncated.
      if (aborted || controller.signal.aborted) {
        yield { type: "error", error: abortError() };
        return;
      }
      if (request.signal?.aborted) {
        yield { type: "error", error: normalizedProviderError("cancelled") };
        return;
      }

      const promptText = request.messages.map((message) => message.content).join("\n");
      const normalizedUsage = this.usage(upstreamUsage, { promptText, completionText: output });

      yield {
        type: "complete",
        output,
        finishReason: upstreamFinish,
        usage: {
          inputTokens: normalizedUsage.promptTokens,
          outputTokens: normalizedUsage.completionTokens,
          // An empty completion costs nothing: the ledger must never debit for a
          // turn that produced no tokens. Otherwise the REGISTRY's rate applies.
          providerCostMicroUsd: output.length === 0 ? 0n : this.cost(normalizedUsage, request.cost ?? null),
          uncertain: normalizedUsage.estimated,
        },
      };
      if (normalizedUsage.estimated) {
        console.error(JSON.stringify({ event: "vast_inference_usage_estimated", reconciliation: "pending", correlationId: request.operationKey }));
      }
    } catch (caught) {
      if (controller.signal.aborted || request.signal?.aborted) {
        yield { type: "error", error: abortError() };
        return;
      }
      // A machine that dies mid-stream aborts the connection. The partial content
      // already delivered stands, and `upstream` tells the caller the turn was
      // interrupted rather than truncated — the ledger then settles only the
      // tokens actually received.
      console.error(JSON.stringify({ event: "vast_inference_stream_failed", reason: caught instanceof Error ? caught.name : "unknown", correlationId: request.operationKey }));
      yield { type: "error", error: normalizedProviderError("upstream") };
    } finally {
      cleanup();
    }
  }

  // --- non-streaming ------------------------------------------------------

  /**
   * One non-streaming completion, retried up to the configured budget when the
   * failure is retryable (a 5xx, a timeout, throttling). Authentication and
   * invalid-request failures are never retried: they cannot improve by waiting.
   */
  async complete(request: InferenceRequest): Promise<InferenceCompletion> {
    const settings = this.settings();
    const maxRetries = settings.enabled ? Math.max(0, settings.maxRetries ?? 1) : 0;
    let attempt = 0;
    let completion = await this.completeOnce(request);
    while (completion.error?.retryable && attempt < maxRetries && !request.signal?.aborted) {
      attempt += 1;
      console.error(JSON.stringify({ event: "vast_inference_completion_retry", attempt, code: completion.error.code, correlationId: request.operationKey }));
      // Linear backoff, bounded so a retry can never outlive the request budget.
      await sleep(Math.min(2_000, 250 * attempt));
      completion = await this.completeOnce(request);
    }
    return completion;
  }

  /**
   * One non-streaming attempt. Provider failures are returned in `error` with
   * zero usage, so a caller can branch on the normalized code without a
   * try/catch and without ever seeing an upstream status.
   */
  private async completeOnce(request: InferenceRequest): Promise<InferenceCompletion> {
    const settings = this.settings();
    const failure = (error: NormalizedProviderError): InferenceCompletion => ({ output: "", finishReason: "error", usage: ZERO_USAGE, model: request.model, error });

    if (!settings.enabled) return failure(normalizedProviderError("unavailable"));
    if (request.signal?.aborted) return failure(normalizedProviderError("cancelled"));

    const resolved = await this.route(request.model);
    if (!resolved.route) return failure(resolved.error ?? normalizedProviderError("unavailable"));
    const route = resolved.route;

    const controller = new AbortController();
    inFlight.set(request.operationKey, controller);
    let abortReason: "idle" | "request" | null = null;
    const timer = setTimeout(() => {
      abortReason = "request";
      controller.abort();
    }, settings.requestTimeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.fetcher()(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...this.headers(route.apiKey), Accept: "application/json" },
        body: JSON.stringify(this.payload(request, false, route.model)),
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        console.error(JSON.stringify({ event: "vast_inference_completion_failed", reason: "status", status: response.status, correlationId: request.operationKey }));
        return failure(normalizedErrorForStatus(response.status));
      }

      if (route.instanceId) void touchInstance(route.instanceId);

      let body: ChatCompletionBody;
      try {
        body = (await response.json()) as ChatCompletionBody;
      } catch {
        console.error(JSON.stringify({ event: "vast_inference_completion_failed", reason: "malformed", correlationId: request.operationKey }));
        return failure(normalizedProviderError("malformed_response"));
      }

      if (body.error !== undefined) {
        console.error(JSON.stringify({ event: "vast_inference_completion_failed", reason: "error_frame", correlationId: request.operationKey }));
        return failure(normalizedProviderError("upstream"));
      }

      const choices = Array.isArray(body.choices) ? body.choices : [];
      const choice = objectValue(choices[0]);
      const message = objectValue(choice.message);
      const output = typeof message.content === "string" ? message.content : "";

      const promptText = request.messages.map((entry) => entry.content).join("\n");
      const normalizedUsage = this.usage(body.usage, { promptText, completionText: output });
      const providerCostMicroUsd = output.length === 0 ? 0n : this.cost(normalizedUsage, request.cost ?? null);

      if (normalizedUsage.estimated) {
        console.error(JSON.stringify({ event: "vast_inference_usage_estimated", reconciliation: "pending", correlationId: request.operationKey }));
      }

      return {
        output,
        finishReason: output.length === 0 ? "stop" : finishReason(choice.finish_reason),
        model: typeof body.model === "string" ? body.model : route.model,
        usage: {
          inputTokens: normalizedUsage.promptTokens,
          outputTokens: normalizedUsage.completionTokens,
          providerCostMicroUsd,
          uncertain: normalizedUsage.estimated,
        },
      };
    } catch (caught) {
      if (controller.signal.aborted || request.signal?.aborted) {
        const code = request.signal?.aborted ? "cancelled" : abortReason === "request" ? "timeout" : "upstream";
        return failure(normalizedProviderError(code));
      }
      console.error(JSON.stringify({ event: "vast_inference_completion_failed", reason: caught instanceof Error ? caught.name : "unknown", correlationId: request.operationKey }));
      return failure(normalizedProviderError("upstream"));
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (inFlight.get(request.operationKey) === controller) inFlight.delete(request.operationKey);
    }
  }
}

/**
 * Operator-facing view of the vast.ai inference transport, for the admin control
 * plane. Deliberately reports only whether a credential is present (never its
 * value) plus the non-secret operational settings.
 */
export function describeVastInference(): {
  configured: boolean;
  baseUrl: string | null;
  managed: boolean;
  bearerTokenConfigured: boolean;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  healthTimeoutMs: number;
  maxRetries: number;
  idleShutdownMinutes: number;
  tokensPerSecond: number;
  modelMapSize: number;
  modelMap: VastModelMap;
} {
  let config: VastInferenceConfig;
  try { config = vastInferenceConfig(); } catch { config = { enabled: false as const, modelMap: {} }; }
  const modelMap = config.modelMap;
  if (!config.enabled) {
    return { configured: false, baseUrl: null, managed: false, bearerTokenConfigured: false, requestTimeoutMs: 0, idleTimeoutMs: 0, healthTimeoutMs: 0, maxRetries: 0, idleShutdownMinutes: 0, tokensPerSecond: 0, modelMapSize: Object.keys(modelMap).length, modelMap };
  }
  return {
    configured: true,
    baseUrl: config.baseUrl,
    managed: config.managed,
    bearerTokenConfigured: config.apiKey !== null,
    requestTimeoutMs: config.requestTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    healthTimeoutMs: config.healthTimeoutMs,
    maxRetries: config.maxRetries,
    idleShutdownMinutes: config.idleShutdownMinutes,
    tokensPerSecond: config.tokensPerSecond,
    modelMapSize: Object.keys(config.modelMap).length,
    modelMap: config.modelMap,
  };
}

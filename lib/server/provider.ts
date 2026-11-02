import {
  ConfigurationError,
  INFERENCE_PROVIDER_VALUES,
  openRouterConfig,
  vastInferenceConfig,
  type InferenceProviderId,
  type InferenceProviderSelection,
} from "./config";
import {
  isFallbackEligibleError,
  normalizedErrorFromThrown,
  normalizedProviderError,
  type CompletionProvider,
  type InferenceChunk,
  type InferenceCompletion,
  type InferenceHealth,
  type InferenceProvider,
  type InferenceRequest,
  type ModelCostSpec,
  type ModelTokenPricing,
  type NormalizedProviderError,
  type ProviderCatalogModel,
  type TokenUsage,
} from "./inference";
import { OpenRouterProvider } from "./openrouter";
import { describeVastInference, VastAIProvider } from "./vast-inference";
import { describeVastLifecycle } from "./vast-lifecycle";
import { activeProviderSelection, normalizeProviderId, PROVIDER_LABELS, readProviderOverride, refreshProviderSettings } from "./provider-settings";

// Product-facing inference code depends on this abstraction. Provider credentials
// and provider-specific identifiers remain inside each implementation boundary,
// so the Playground, the API gateway, the registry sync, and the compute ledger
// never learn which upstream served the tokens.
//
// Selection (PRD: provider-agnostic with replacement support):
//   INFERENCE_PROVIDER=openrouter → OpenRouterProvider (the default)
//   INFERENCE_PROVIDER=vastai     → VastAIProvider (rented GPU, vLLM/OpenAI-compatible)
//   INFERENCE_FALLBACK_ENABLED    → opts in to failover (OFF by default)
//   INFERENCE_FALLBACK_PROVIDER   → the other provider, used only when failover was
//                                   explicitly enabled AND the primary fails with a
//                                   provider-outage error before any content is sent.
// The admin control plane can override the environment at runtime by persisting a
// row in inference_provider_settings (see provider-settings.ts). That override is
// read by getInferenceProviderAsync(); the synchronous getInferenceProvider() uses
// the cached selection so a request path never waits on a settings read.
//
// A provider that is not configured at all is never selected, so a deployment
// without VASTAI_BASE_URL keeps serving through OpenRouter.

/**
 * The optional accounting surface a provider may additionally implement.
 *
 * Declared locally because the documented `CompletionProvider.usage()` takes only
 * the upstream response, while a rented-GPU provider also accepts the text to
 * estimate from when the upstream omits usage entirely.
 */
type AccountingTransport = {
  complete?: (request: InferenceRequest) => Promise<InferenceCompletion>;
  usage?: (response: unknown, fallback?: { promptText?: string; completionText?: string }) => TokenUsage & { estimated: boolean };
  cost?: (usage: TokenUsage, model?: ModelCostSpec | ModelTokenPricing | null) => bigint | null;
};

/**
 * Builds one provider, or null when it is not configured.
 *
 * The config accessors throw ConfigurationError when a provider is switched on
 * but left partially configured (for example OPENROUTER_ENABLED=true with no
 * key). Selection must never surface that as a request failure: a half-configured
 * provider is simply treated as unavailable, which is what every caller already
 * knows how to handle. This keeps getInferenceProvider() non-throwing, as it was
 * before provider selection existed. The startup preflight below is what reports
 * the misconfiguration loudly.
 */
function createProvider(id: InferenceProviderId): InferenceProvider | null {
  try {
    if (id === "vast") return vastInferenceConfig().enabled ? new VastAIProvider() : null;
    return openRouterConfig().enabled ? new OpenRouterProvider() : null;
  } catch {
    console.error(JSON.stringify({ event: "inference_provider_misconfigured", provider: id }));
    return null;
  }
}

/** Whether a provider is fully configured, for the control plane. */
export function isProviderConfigured(id: InferenceProviderId): boolean {
  try {
    return id === "vast" ? vastInferenceConfig().enabled : openRouterConfig().enabled;
  } catch {
    return false;
  }
}

/**
 * A primary provider with an optional, explicitly-enabled fallback.
 *
 * Normalized failure handling lives here so both request paths (Playground and the
 * public gateway) get identical behaviour without duplicating provider knowledge:
 *
 *   - A failure the primary reports BEFORE any delta is delivered, and that
 *     describes an OUTAGE (`upstream`, `timeout`, `model_unavailable` — see
 *     isFallbackEligibleError), is retried exactly once on the fallback.
 *   - Auth / config / invalid-request failures are NEVER retried elsewhere: they
 *     mean the deployment is misconfigured or the request is wrong, so replaying
 *     them on another provider would hide the problem (or fail identically).
 *   - A stream that already delivered content is never replayed from a second
 *     provider: splicing two models' text into one answer would be visible and
 *     wrong. It aborts with `upstream`, and the caller persists the partial.
 *   - If the fallback ALSO fails, the ORIGINAL primary error is what surfaces, so
 *     the user sees the trustworthy reason instead of a confusing second one.
 *   - Cancellation is never converted into a failover, and `cancel()` reaches
 *     whichever provider is currently active (it cancels both, which is safe: an
 *     unknown operation key is a no-op in either provider).
 *   - Every terminal chunk is tagged with the provider that produced it
 *     (`servedBy` / `failedOver`) so the ledger and the conversation record can
 *     attribute the turn — and its cost — to the provider that really served it.
 *
 * health() reports healthy when either side can serve, so a single slow or
 * misconfigured endpoint does not take the whole product offline.
 */
class FallbackProvider implements InferenceProvider {
  /** The configured primary's id, so provenance is resolvable through the wrapper. */
  readonly primaryProviderId: InferenceProviderId;

  constructor(
    private readonly primary: InferenceProvider,
    private readonly fallback: InferenceProvider | null,
    primaryId: InferenceProviderId = "openrouter",
    private readonly fallbackId: InferenceProviderId | null = null
  ) {
    this.primaryProviderId = primaryId;
  }

  /**
   * Whether a primary failure may be retried on the fallback.
   *
   * Requires: a configured fallback, nothing delivered yet, no caller abort, and
   * an outage-class normalized code.
   */
  private mayFailover(error: NormalizedProviderError, request: InferenceRequest, emitted: boolean): boolean {
    if (!this.fallback || emitted) return false;
    if (request.signal?.aborted) return false;
    return isFallbackEligibleError(error);
  }

  async *stream(request: InferenceRequest): AsyncIterable<InferenceChunk> {
    const primaryId = this.primaryProviderId;
    let emitted = false;
    let failure: NormalizedProviderError | null = null;

    try {
      for await (const chunk of this.primary.stream(request)) {
        if (chunk.type === "delta") {
          emitted = true;
          yield chunk;
          continue;
        }
        if (chunk.type === "error") {
          // Nothing delivered + outage class → eligible for one retry elsewhere.
          if (this.mayFailover(chunk.error, request, emitted)) {
            failure = chunk.error;
            break;
          }
          yield { ...chunk, servedBy: primaryId };
          return;
        }
        // A clean terminal event: tag it and stop. Never replayed.
        yield { ...chunk, servedBy: primaryId };
        return;
      }
    } catch (thrown) {
      const normalized = normalizedErrorFromThrown(thrown);
      // A caller abort (Playground "Stop" / gateway timeout) is a cancellation, not
      // a provider outage: it must never trigger a failover.
      if (request.signal?.aborted) {
        yield { type: "error", error: normalizedProviderError("cancelled"), servedBy: primaryId };
        return;
      }
      if (this.mayFailover(normalized, request, emitted)) failure = normalized;
      else {
        yield { type: "error", error: normalized, servedBy: primaryId };
        return;
      }
    }

    // The primary ended without a terminal event. That is a broken transport, so it
    // is normalized like any other upstream failure rather than being ignored.
    if (!failure) failure = normalizedProviderError("upstream");

    // An abort that landed between the failure and the retry wins: the user asked to
    // stop, so report cancellation instead of starting a fresh generation.
    if (request.signal?.aborted) {
      yield { type: "error", error: normalizedProviderError("cancelled"), servedBy: primaryId };
      return;
    }

    if (!this.fallback || !this.fallbackId) {
      yield { type: "error", error: failure, servedBy: primaryId };
      return;
    }

    console.error(
      JSON.stringify({
        event: "inference_provider_fallback",
        from: primaryId,
        to: this.fallbackId,
        reason: failure.code,
        operationKey: request.operationKey,
      })
    );

    let delivered = false;
    let fallbackFailure: NormalizedProviderError | null = null;
    try {
      for await (const chunk of this.fallback.stream(request)) {
        if (chunk.type === "delta") {
          delivered = true;
          yield chunk;
          continue;
        }
        if (chunk.type === "error") {
          // A fallback that dies after delivering content reports its own error: the
          // caller already holds tokens from THIS provider, so the partial belongs
          // to it and the message must describe what actually interrupted it.
          if (delivered) {
            yield { ...chunk, servedBy: this.fallbackId, failedOver: true };
            return;
          }
          fallbackFailure = chunk.error;
          break;
        }
        yield { ...chunk, servedBy: this.fallbackId, failedOver: true };
        return;
      }
    } catch (thrown) {
      fallbackFailure = normalizedErrorFromThrown(thrown);
    }

    if (request.signal?.aborted) {
      yield { type: "error", error: normalizedProviderError("cancelled"), servedBy: this.fallbackId, failedOver: true };
      return;
    }

    // Both providers failed. Surface the PRIMARY error: it is the one the user's
    // configured provider reported, and reporting the fallback's instead would
    // misattribute the outage. The fallback's code is logged for operators only.
    console.error(
      JSON.stringify({
        event: "inference_provider_fallback_failed",
        from: primaryId,
        to: this.fallbackId,
        primaryReason: failure.code,
        fallbackReason: (fallbackFailure ?? normalizedProviderError("upstream")).code,
        operationKey: request.operationKey,
      })
    );
    yield { type: "error", error: failure, servedBy: primaryId, failedOver: true };
  }

  async catalog(): Promise<ProviderCatalogModel[]> {
    try {
      return await this.primary.catalog();
    } catch (error) {
      if (!this.fallback) throw error;
      return this.fallback.catalog();
    }
  }

  async health(): Promise<InferenceHealth> {
    const primary = await this.primary.health();
    if (primary.healthy) return primary;
    if (!this.fallback) return primary;
    const secondary = await this.fallback.health();
    if (secondary.healthy) {
      // With failover enabled the product can still serve, so `healthy` stays true
      // for request gating; the degraded status keeps the badge honest.
      return { ...secondary, healthy: true, status: primary.status === "degraded" ? "degraded" : secondary.status };
    }
    return primary;
  }

  async cancel(operationKey: string): Promise<void> {
    await Promise.all([this.primary.cancel(operationKey), this.fallback?.cancel(operationKey) ?? Promise.resolve()]);
  }

  /** Token accounting follows the primary's contract when it has one. */
  usage(response: unknown, fallback?: { promptText?: string; completionText?: string }): TokenUsage & { estimated: boolean } {
    const primary = this.primary as AccountingTransport;
    if (typeof primary.usage === "function") return primary.usage.call(this.primary, response, fallback);
    const secondary = this.fallback as AccountingTransport | null;
    if (secondary && typeof secondary.usage === "function") return secondary.usage.call(this.fallback, response, fallback);
    const usage = (response ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown };
    const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, estimated: true };
  }

  /** Cost follows the primary's rules; the ledger prices from registry usage anyway. */
  cost(usage: TokenUsage, model?: ModelCostSpec | ModelTokenPricing | null): bigint | null {
    const primary = this.primary as AccountingTransport;
    if (typeof primary.cost === "function") return primary.cost.call(this.primary, usage, model);
    const secondary = this.fallback as AccountingTransport | null;
    if (secondary && typeof secondary.cost === "function") return secondary.cost.call(this.fallback, usage, model);
    return null;
  }

  /** Non-streaming failover (same eligibility rules as stream()). */
  async complete(request: InferenceRequest): Promise<InferenceCompletion> {
    const primary = this.primary as AccountingTransport;
    if (typeof primary.complete !== "function") throw new Error("completion_not_supported");
    const completion = await primary.complete.call(this.primary, request);
    if (!completion.error) return { ...completion, servedBy: this.primaryProviderId };
    // Only a pre-content outage is eligible; a non-streaming call has no content yet.
    if (!this.fallback || !this.fallbackId || !isFallbackEligibleError(completion.error) || request.signal?.aborted) {
      return { ...completion, servedBy: this.primaryProviderId };
    }
    const secondary = this.fallback as AccountingTransport;
    if (typeof secondary.complete !== "function") return { ...completion, servedBy: this.primaryProviderId };
    console.error(JSON.stringify({ event: "inference_provider_fallback", from: this.primaryProviderId, to: this.fallbackId, reason: completion.error.code, operationKey: request.operationKey, streaming: false }));
    const fallbackResult = await secondary.complete.call(this.fallback, request);
    if (fallbackResult.error) {
      console.error(JSON.stringify({ event: "inference_provider_fallback_failed", from: this.primaryProviderId, to: this.fallbackId, primaryReason: completion.error.code, fallbackReason: fallbackResult.error.code, operationKey: request.operationKey }));
      // Surface the primary error, not the fallback's.
      return { ...completion, servedBy: this.primaryProviderId, failedOver: true };
    }
    return { ...fallbackResult, servedBy: this.fallbackId, failedOver: true };
  }
}

/** Chooses the provider id a freshly built provider represents. */
function idFor(provider: InferenceProvider): InferenceProviderId {
  if (provider instanceof VastAIProvider) return "vast";
  const wrapped = (provider as { primaryProviderId?: unknown }).primaryProviderId;
  if (wrapped === "vast" || wrapped === "openrouter") return wrapped;
  return "openrouter";
}

/** Assembles a provider from a resolved selection. Never throws. */
function assemble(selection: InferenceProviderSelection): InferenceProvider {
  const primary = createProvider(selection.provider);
  // Failover only exists when it was explicitly enabled AND names a different,
  // configured provider. A merely-configured alternative is not a fallback.
  const secondary = selection.fallbackEnabled && selection.fallback ? createProvider(selection.fallback) : null;

  // Prefer the configured provider; degrade to whichever one is actually
  // configured when it is not. With neither configured, return OpenRouter so
  // callers keep receiving normalized `unavailable` errors instead of throwing.
  if (primary) {
    if (secondary && selection.fallback) {
      return new FallbackProvider(primary, secondary, idFor(primary), selection.fallback);
    }
    return primary;
  }
  if (secondary) return secondary;
  return new OpenRouterProvider();
}

/**
 * The provider for this request, using the cached runtime selection overlay.
 * Synchronous and non-throwing, so existing call sites are unchanged.
 */
export function getInferenceProvider(): InferenceProvider {
  return assemble(activeProviderSelection());
}

/**
 * The provider after re-reading the persisted override. Used where a slightly
 * later freshness matters more than a synchronous return (the API gateway, and
 * the control plane). In-flight requests that already resolved a provider keep
 * using it, so a runtime switch never interrupts a stream.
 */
export async function getInferenceProviderAsync(): Promise<InferenceProvider> {
  return assemble(await refreshProviderSettings());
}

export async function getInferenceHealth(): Promise<InferenceHealth> {
  return (await getInferenceProviderAsync()).health();
}

/**
 * Health for every registered provider, for the admin control plane. Each probe
 * is independent: an unreachable vast.ai instance never masks OpenRouter's
 * status. Nothing credential-shaped is returned — only configuration presence.
 */
export type ProviderStatusReport = {
  id: InferenceProviderId;
  label: string;
  configured: boolean;
  active: boolean;
  fallback: boolean;
  health: InferenceHealth;
  /** vast.ai only: non-secret transport settings (model map, timeouts, window). */
  settings: ReturnType<typeof describeVastInference> | null;
  /** vast.ai only: the instance lifecycle policy that governs the warm pool. */
  lifecycle: ReturnType<typeof describeVastLifecycle> | null;
};

export async function listProviderHealth(): Promise<{
  providers: ProviderStatusReport[];
  active: InferenceProviderId;
  fallback: InferenceProviderId | null;
  /** Whether failover is enabled at all (off by default). */
  fallbackEnabled: boolean;
  /** The provider that WOULD be used if failover were enabled. */
  fallbackCandidate: InferenceProviderId | null;
  /** Error codes that may trigger a failover, for the control-plane legend. */
  fallbackOn: ReadonlyArray<NormalizedProviderError["code"]>;
  invalid: string | null;
  source: "admin" | "env";
}> {
  const selection = await refreshProviderSettings();
  const override = await readProviderOverride();
  const probe = async (id: InferenceProviderId): Promise<InferenceHealth> => {
    const provider = createProvider(id);
    if (!provider) return { healthy: false, message: "unavailable", status: "unavailable", latencyMs: null, modelIds: [] };
    try {
      return await provider.health();
    } catch {
      return { healthy: false, message: "unavailable", status: "unavailable", latencyMs: null, modelIds: [] };
    }
  };
  const providers = await Promise.all(
    (["openrouter", "vast"] as InferenceProviderId[]).map(async (id): Promise<ProviderStatusReport> => ({
      id,
      label: PROVIDER_LABELS[id],
      configured: isProviderConfigured(id),
      active: selection.provider === id,
      fallback: selection.fallback === id,
      health: await probe(id),
      settings: id === "vast" ? describeVastInference() : null,
      lifecycle: id === "vast" ? describeVastLifecycle() : null,
    }))
  );
  return {
    providers,
    active: selection.provider,
    fallback: selection.fallback,
    fallbackEnabled: selection.fallbackEnabled,
    fallbackCandidate: selection.fallbackCandidate,
    fallbackOn: ["upstream", "timeout", "model_unavailable"],
    invalid: selection.invalid,
    source: override?.source === "admin" ? "admin" : "env",
  };
}

/**
 * Resolves which provider served one turn, for the durable record and the ledger.
 * Called by the request paths with provenance carried on the terminal chunk.
 */
export function providerIdOf(provider: InferenceProvider): InferenceProviderId {
  return idFor(provider);
}

/**
 * Startup preflight (PRD: missing required config fails fast, not at first
 * request). Called from instrumentation.ts on boot.
 *
 * Throws ConfigurationError when:
 *   - INFERENCE_PROVIDER names something other than a documented value
 *     (the message lists the valid values); or
 *   - the selected provider is switched on but incompletely configured (for
 *     example vastai selected with no VASTAI_BASE_URL) and no other configured
 *     provider could serve; or
 *   - VASTAI_MODEL_MAP is not a valid mapping.
 *
 * Both providers being configured while only one is healthy is NOT a preflight
 * failure: the configured provider stays active and the health screen shows the
 * degraded one.
 */
export async function preflightInferenceProviders(): Promise<{ provider: InferenceProviderId; fallback: InferenceProviderId | null }> {
  const selection = await refreshProviderSettings(true);
  if (selection.invalid) {
    throw new ConfigurationError(
      `Unknown INFERENCE_PROVIDER value "${selection.invalid}". Valid values: ${INFERENCE_PROVIDER_VALUES.join(", ")}.`
    );
  }
  if (selection.invalidFallback) {
    throw new ConfigurationError(
      `Unknown INFERENCE_FALLBACK_PROVIDER value "${selection.invalidFallback}". Valid values: ${INFERENCE_PROVIDER_VALUES.join(", ")}.`
    );
  }

  const primaryConfigured = isProviderConfigured(selection.provider);
  const fallbackConfigured = selection.fallback ? isProviderConfigured(selection.fallback) : false;

  if (!primaryConfigured && !fallbackConfigured) {
    // Name the exact missing variable so the operator can fix it without reading
    // the source. Configuration accessors are re-run here so a partial provider
    // (enabled but missing a key) reports its own message.
    if (selection.provider === "vast") {
      let detail = "VASTAI_BASE_URL is not set (and VASTAI_LIFECYCLE_ENABLED is not true)";
      try {
        const config = vastInferenceConfig();
        if (!config.enabled) detail = "VASTAI_BASE_URL is not set (and VASTAI_LIFECYCLE_ENABLED is not true)";
      } catch (error) {
        detail = error instanceof Error ? error.message : detail;
      }
      throw new ConfigurationError(
        `INFERENCE_PROVIDER=vastai requires vast.ai inference configuration: ${detail}. Set VASTAI_BASE_URL (the instance's OpenAI-compatible root, e.g. http://<ip>:<port>/v1) and optionally VASTAI_BEARER_TOKEN, or enable VASTAI_LIFECYCLE_ENABLED=true to rent machines on demand, or set INFERENCE_PROVIDER=openrouter.`
      );
    }
    let detail = "OPENROUTER_ENABLED is not true";
    try {
      const config = openRouterConfig();
      if (!config.enabled) detail = "OPENROUTER_ENABLED is not true";
    } catch (error) {
      detail = error instanceof Error ? error.message : detail;
    }
    throw new ConfigurationError(
      `INFERENCE_PROVIDER=openrouter requires OpenRouter configuration: ${detail}. Set OPENROUTER_ENABLED=true and OPENROUTER_API_KEY, or set INFERENCE_PROVIDER=vastai with VASTAI_BASE_URL.`
    );
  }

  // A fallback that is NAMED but switched off is a configuration state worth
  // reporting, not an error: it means "configured, currently disabled" and the
  // primary alone serves.
  if (selection.fallbackCandidate && !selection.fallbackEnabled) {
    console.log(JSON.stringify({ event: "inference_fallback_configured_disabled", candidate: selection.fallbackCandidate }));
  }

  return { provider: selection.provider, fallback: selection.fallback };
}

/** Re-exported so callers can resolve a stored name without importing config. */
export { normalizeProviderId };

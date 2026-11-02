import { afterEach, describe, expect, it, vi } from "vitest";
import { getInferenceProvider, providerIdOf } from "../../lib/server/provider";
import { OpenRouterProvider } from "../../lib/server/openrouter";
import { VastAIProvider } from "../../lib/server/vast-inference";

// getInferenceProvider() is called by both request paths and must never throw:
// a provider that is switched on but only partially configured (for example
// OPENROUTER_ENABLED=true with no key) has to degrade to "unavailable", which is
// what every caller already handles, rather than escaping as a configuration
// exception and turning a provider outage into a bare 503.
//
// Failover is opt-in twice over: INFERENCE_FALLBACK_PROVIDER must name a provider AND
// INFERENCE_FALLBACK_ENABLED must be true. Naming a provider without enabling failover
// must leave the primary alone, so a healthy alternative is never used silently.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("provider selection", () => {
  it("selects the vast.ai provider when it is configured", () => {
    vi.stubEnv("INFERENCE_PROVIDER", "vast");
    vi.stubEnv("VAST_INFERENCE_BASE_URL", "http://gpu.invalid:8000/v1");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_ENABLED", "false");
    // Primary is vast; openrouter is disabled, so there is nothing to fall back to.
    const provider = getInferenceProvider();
    expect(provider).toBeInstanceOf(VastAIProvider);
    expect(providerIdOf(provider)).toBe("vast");
  });

  it("defaults to OpenRouter", () => {
    vi.stubEnv("INFERENCE_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    expect(getInferenceProvider()).toBeInstanceOf(OpenRouterProvider);
  });

  it("does not throw when a provider is only partially configured", () => {
    vi.stubEnv("INFERENCE_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => getInferenceProvider()).not.toThrow();
  });

  it("does not build a fallback when a fallback provider is named but failover is not enabled", () => {
    vi.stubEnv("INFERENCE_PROVIDER", "vast");
    vi.stubEnv("VAST_INFERENCE_BASE_URL", "http://gpu.invalid:8000/v1");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "false");

    // No wrapper: the primary alone serves, so its errors surface verbatim.
    expect(getInferenceProvider()).toBeInstanceOf(VastAIProvider);
  });

  it("wraps the primary with the fallback once failover is enabled", async () => {
    vi.stubEnv("INFERENCE_PROVIDER", "vast");
    vi.stubEnv("VAST_INFERENCE_BASE_URL", "http://gpu.invalid:8000/v1");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("INFERENCE_FALLBACK_ENABLED", "true");

    const provider = getInferenceProvider();
    // Provenance resolves to the configured primary even through the wrapper.
    expect(providerIdOf(provider)).toBe("vast");
    // Both are configured, so health stays usable.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    expect((await provider.health()).healthy).toBe(true);
  });

  it("keeps serving when the configured provider is unusable but the other is configured", async () => {
    vi.stubEnv("INFERENCE_PROVIDER", "vast");
    // No VAST_INFERENCE_BASE_URL → vast is not configured at all.
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_ENABLED", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    const health = await getInferenceProvider().health();
    // The vast endpoint is missing, so the only configured provider answers and the
    // product stays up.
    expect(health.healthy).toBe(true);
  });

  it("reports a normalized unhealthy health when nothing is configured", async () => {
    vi.stubEnv("INFERENCE_PROVIDER", "vast");
    vi.stubEnv("INFERENCE_FALLBACK_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_ENABLED", "false");
    const health = await getInferenceProvider().health();
    expect(health.healthy).toBe(false);
  });
});

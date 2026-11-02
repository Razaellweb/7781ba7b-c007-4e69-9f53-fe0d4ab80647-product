import { describe, expect, it } from "vitest";
import { modelAvailabilityStatus, modelIsOperational, registryPricing, type ModelRow } from "../../lib/server/models";

// `modelIsOperational` is the single definition of "this curated model can serve a
// billable request". It is shared by auto-selection, the Playground selector and the
// request-path guard, so the Overview badge, the dropdown and the server can never
// disagree about what is usable — including when an administrator pauses a model
// mid-conversation or a provider endpoint goes down.

function row(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    slug: "glm-4.5",
    display_name: "GLM 4.5",
    family: "GLM",
    provider: "vast",
    provider_model_slug: "zai-org/GLM-4.5",
    vast_model_id: "zai-org/GLM-4.5",
    vast_base_url: null,
    source_url: null,
    status: "active",
    visibility: "public",
    featured: false,
    sort_order: 0,
    context_length: 131072,
    prompt_usd_per_token: "0.00000015",
    completion_usd_per_token: "0.00000050",
    availability_provider: "vast",
    markup_micro: "2000000",
    min_charge_micro_usd: "0",
    license_status: "open_weight",
    provider_terms_status: "permitted",
    provider_metadata: {
      contextLength: 131072,
      pricing: { prompt: "0.00000015", completion: "0.00000050" },
      architecture: { inputModalities: ["text"], outputModalities: ["text"] },
      supportedParameters: ["temperature", "top_p", "max_tokens"],
      availability: "available",
      syncedAt: null,
    },
    provider_sync_status: "current",
    provider_synced_at: null,
    provider_sync_error: null,
    ...overrides,
  };
}

function withAvailability(model: ModelRow, availability: "available" | "degraded" | "unavailable" | "stale"): ModelRow {
  return { ...model, provider_metadata: model.provider_metadata ? { ...model.provider_metadata, availability } : null };
}

describe("curated model operational predicate", () => {
  it("accepts a synced, available, active public model", () => {
    expect(modelIsOperational(row())).toBe(true);
  });

  it("accepts a degraded model, because a cold rented GPU warms on demand", () => {
    // Degraded means the provider can still serve; the request path pays the cold
    // start rather than the card declaring a false outage.
    expect(modelIsOperational(withAvailability(row(), "degraded"))).toBe(true);
  });

  it("rejects a model paused by an administrator", () => {
    // This is the `model_unavailable` case: the next send must not stream.
    expect(modelIsOperational(row({ status: "paused" }))).toBe(false);
  });

  it("rejects a model whose provider route is gone or stale", () => {
    expect(modelIsOperational(row({ provider_sync_status: "unavailable" }))).toBe(false);
    expect(modelIsOperational(row({ provider_sync_status: "stale" }))).toBe(false);
    expect(modelIsOperational(row({ provider_sync_status: "never" }))).toBe(false);
  });

  it("rejects a model whose reported availability is not servable", () => {
    expect(modelIsOperational(withAvailability(row(), "unavailable"))).toBe(false);
    expect(modelIsOperational(withAvailability(row(), "stale"))).toBe(false);
    expect(modelIsOperational({ ...row(), provider_metadata: null })).toBe(false);
  });

  it("rejects a non-public or missing row", () => {
    expect(modelIsOperational(row({ visibility: "hidden" }))).toBe(false);
    expect(modelIsOperational(null)).toBe(false);
    expect(modelIsOperational(undefined)).toBe(false);
  });
});

describe("registry-owned metadata", () => {
  it("maps availability onto the three-state vocabulary", () => {
    expect(modelAvailabilityStatus(withAvailability(row(), "available"))).toBe("operational");
    expect(modelAvailabilityStatus(withAvailability(row(), "degraded"))).toBe("degraded");
    expect(modelAvailabilityStatus(withAvailability(row(), "unavailable"))).toBe("unavailable");
    expect(modelAvailabilityStatus(null)).toBe("unavailable");
  });

  it("reports pricing from the registry columns, which cost() consumes", () => {
    // The card and the ledger read this same value, so they cannot disagree.
    expect(registryPricing(row())).toEqual({ prompt: "0.00000015", completion: "0.00000050" });
    expect(registryPricing(row({ prompt_usd_per_token: null, completion_usd_per_token: null }))).toBeNull();
  });
});

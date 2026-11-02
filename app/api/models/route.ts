import { NextResponse } from "next/server";
import { modelHealthConfig } from "../../../lib/server/config";
import { listDiscoverableModels, modelAvailabilityStatus, registryPricing, syncCuratedModels, type ModelRow } from "../../../lib/server/models";
import { ensureMigrated } from "../../../lib/server/migrate";

// The curated model registry is not access-controlled: every visitor — and every
// Privy-authenticated account — sees the full public registry. No holder status,
// token balance, or legacy eligibility value is read here, so a missing or stale
// holder record can never hide models.
//
// What this endpoint is authoritative for:
//   * registryStatus / adminActivated — whether an administrator has activated the
//     model. A paused model is still listed (so the UI can explain why it is not
//     usable) but can never be selected in the Playground.
//   * availability + status — the per-model provider health, debounced and
//     refreshed at most once per MODEL_HEALTH_REFRESH_INTERVAL_SECONDS. `status` is
//     the three-state Operational / Degraded / Unavailable the Overview cards render.
//   * selectable — the single flag the Playground dropdown filters on: the model is
//     both admin-activated AND currently available on the active provider.
//   * contextLength / pricing — read from the REGISTRY row, never from the provider,
//     so the price a card shows is the price cost() charges.
//
// Hidden/draft/deprecated entries remain private.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function modelPayload(model: ModelRow, refreshIntervalSeconds: number) {
  const status = modelAvailabilityStatus(model);
  const pricing = registryPricing(model);
  const activated = model.status === "active";
  const selectable = activated && status !== "unavailable";
  return {
    id: model.slug,
    slug: model.slug,
    displayName: model.display_name,
    family: model.family,
    featured: model.featured,
    registryStatus: model.status,
    // Explicit admin-control signal: a paused model is unavailable *by decision*,
    // which the UI must not confuse with a provider outage.
    adminActivated: activated,
    provider: model.provider,
    providerModelSlug: model.provider_model_slug,
    // Registry-owned routing metadata. The vast.ai identifier is a server-routing
    // fact, exposed so operators can confirm the mapping without reading the DB.
    vastModelId: model.vast_model_id,
    sourceUrl: model.source_url,
    // Registry-owned pricing (USD per token strings, the unit cost() consumes).
    pricing,
    pricingSource: "registry" as const,
    architecture: model.provider_metadata?.architecture ?? null,
    inputModalities: model.provider_metadata?.architecture.inputModalities ?? null,
    outputModalities: model.provider_metadata?.architecture.outputModalities ?? null,
    supportedParameters: model.provider_metadata?.supportedParameters ?? null,
    // Registry-owned context window (never the provider's reported value).
    contextLength: model.context_length ?? model.provider_metadata?.contextLength ?? null,
    capabilityMetadata: model.provider_metadata ? "verified" : "unavailable",
    licenseStatus: model.license_status || "unavailable",
    providerTermsStatus: model.provider_terms_status || "unavailable",
    /** Operational / Degraded / Unavailable — from debounced per-model health. */
    status,
    /** Legacy availability vocabulary, kept so existing readers keep working. */
    availability: status === "operational" ? "available" as const : status === "degraded" ? "degraded" as const : "unavailable" as const,
    syncStatus: model.provider_sync_status,
    availabilityProvider: model.availability_provider,
    availabilityCheckedAt: model.provider_synced_at,
    availabilityReason: model.provider_sync_error,
    /** True only when the model may be offered in the Playground dropdown. */
    selectable,
    refreshIntervalSeconds,
  };
}

export async function GET() {
  try {
    await ensureMigrated();
    // Availability refresh is best-effort and throttled internally: a probe failure
    // degrades to the last known status instead of hiding the registry.
    const sync = await syncCuratedModels();
    const models = await listDiscoverableModels();
    const refreshIntervalSeconds = modelHealthConfig().refreshIntervalSeconds;
    const data = models.map((model) => modelPayload(model, refreshIntervalSeconds));
    const selectableIds = data.filter((model) => model.selectable).map((model) => model.id);
    return NextResponse.json(
      {
        models: data,
        count: data.length,
        // The Playground dropdown renders exactly this list, so the client and the
        // server-side guard can never disagree about what is offered.
        selectable: selectableIds,
        activeProvider: sync.provider,
        sync: {
          unavailable: sync.unavailable,
          stale: Boolean(sync.error),
          metadataAvailable: !sync.error,
          refreshIntervalSeconds,
        },
      },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Unable to load models", code: "MODELS_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
  }
}

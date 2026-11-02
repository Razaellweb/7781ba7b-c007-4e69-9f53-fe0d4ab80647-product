import { NextResponse } from "next/server";
import { listDiscoverableModels, syncCuratedModels } from "../../../lib/server/models";
import { ensureMigrated } from "../../../lib/server/migrate";

// The model registry is not access-controlled: every visitor — and every
// Privy-authenticated account — sees the full public registry. No holder status,
// token balance, or legacy eligibility value is read here, so a missing or stale
// holder record can never hide models.
//
// Include paused entries so the UI can distinguish their registry state from
// provider availability. Hidden/draft/deprecated entries remain private.
export async function GET() {
  try {
    await ensureMigrated();
    // Provider metadata refresh is best-effort: a sync failure degrades to the
    // last-known metadata instead of hiding the registry from the workspace.
    const sync = await syncCuratedModels();
    const models = await listDiscoverableModels();
    const data = models.map((model) => {
      const metadata = model.provider_metadata;
      // The card shows the company behind the model. The internal routing
      // channel (`provider`) is server plumbing and is never rendered.
      const displayProvider = model.display_provider?.trim() || model.family?.trim() || model.display_name;
      return {
        id: model.slug,
        slug: model.slug,
        displayName: model.display_name,
        description: model.description,
        family: model.family,
        featured: model.featured,
        registryStatus: model.status,
        provider: displayProvider,
        providerLabel: displayProvider,
        providerModelSlug: model.provider_model_slug,
        sourceUrl: model.source_url,
        pricing: metadata?.pricing ?? null,
        architecture: metadata?.architecture ?? null,
        inputModalities: metadata?.architecture.inputModalities ?? null,
        outputModalities: metadata?.architecture.outputModalities ?? null,
        supportedParameters: metadata?.supportedParameters ?? null,
        contextLength: metadata?.contextLength ?? model.context_length,
        capabilityMetadata: metadata ? "verified" : "unavailable",
        licenseStatus: model.license_status || "unavailable",
        providerTermsStatus: model.provider_terms_status || "unavailable",
        availability: metadata?.availability ?? "unavailable",
        syncStatus: model.provider_sync_status,
      };
    });
    return NextResponse.json({
      models: data,
      count: data.length,
      sync: { unavailable: sync.unavailable, stale: Boolean(sync.error), metadataAvailable: !sync.error },
    });
  } catch {
    return NextResponse.json({ error: "Unable to load models", code: "MODELS_UNAVAILABLE" }, { status: 503 });
  }
}

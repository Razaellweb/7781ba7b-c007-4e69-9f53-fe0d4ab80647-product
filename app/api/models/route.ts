import { NextResponse } from "next/server";
import { listActiveModels, syncCuratedModels } from "../../../lib/server/models";
import { ensureMigrated } from "../../../lib/server/migrate";

// The curated public catalog is safe for the landing Playground and workspace.
// Provider identifiers are registry metadata; inference still routes only from
// the server-side ModelRow returned by lifecycle-checked selectors.
export async function GET() {
  try {
    await ensureMigrated();
    const sync = await syncCuratedModels();
    if (sync.error) return NextResponse.json({ error: "Unable to verify curated model metadata", code: "MODELS_METADATA_UNAVAILABLE" }, { status: 503 });
    const models = await listActiveModels();
    const data = models.map((model) => {
      const metadata = model.provider_metadata;
      return {
        id: model.slug,
        slug: model.slug,
        displayName: model.display_name,
        family: model.family,
        featured: model.featured,
        registryStatus: model.status,
        provider: model.provider,
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
    return NextResponse.json({ models: data, count: data.length, sync: { unavailable: sync.unavailable, stale: false } });
  } catch {
    return NextResponse.json({ error: "Unable to load models", code: "MODELS_UNAVAILABLE" }, { status: 503 });
  }
}
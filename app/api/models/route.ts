import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { listActiveModels, syncCuratedModels } from "../../../lib/server/models";
import { ensureMigrated } from "../../../lib/server/migrate";

// Synchronization and provider access remain server-side. Only approved rows
// from the curated registry are returned to the authenticated dashboard.
export async function GET(request: Request) {
  try {
    await ensureMigrated();
    await authenticatePrivyRequest(request.headers.get("authorization"));
    const sync = await syncCuratedModels();
    const models = await listActiveModels();
    const data = models.map((model) => ({
      id: model.slug,
      displayName: model.display_name,
      family: model.family,
      featured: model.featured,
      registryStatus: model.status,
      contextLength: model.provider_metadata?.contextLength ?? model.context_length,
      provider: model.provider,
      canonicalProviderModelId: model.provider_metadata?.canonicalId ?? null,
      pricing: model.provider_metadata?.pricing ?? {},
      architecture: model.provider_metadata?.architecture ?? null,
      inputModalities: model.provider_metadata?.inputModalities ?? [],
      outputModalities: model.provider_metadata?.outputModalities ?? [],
      supportedParameters: model.provider_metadata?.supportedParameters ?? [],
      availability: model.provider_metadata?.availability ?? "unavailable",
      metadataSyncedAt: model.provider_metadata?.syncedAt ?? null,
      syncStatus: model.provider_sync_status,
    }));
    return NextResponse.json({ models: data, count: data.length, sync: { unavailable: sync.unavailable, stale: Boolean(sync.error) } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to load models", code: "MODELS_UNAVAILABLE" }, { status: 503 });
  }
}
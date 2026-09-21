import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { listActiveModels, syncCuratedModels } from "../../../lib/server/models";
import { ensureMigrated } from "../../../lib/server/migrate";

// Public model identity is always the curated first-party slug. Provider
// identifiers, pricing, headers, metadata, and synchronization details remain server-side.
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
      provider: "curated",
      canonicalProviderModelId: null,
      pricing: {},
      architecture: null,
      inputModalities: [],
      outputModalities: [],
      supportedParameters: [],
      contextLength: model.provider_metadata?.contextLength ?? model.context_length,
      availability: model.provider_metadata?.availability ?? "unavailable",
      syncStatus: model.provider_sync_status,
    }));
    return NextResponse.json({ models: data, count: data.length, sync: { unavailable: sync.unavailable, stale: Boolean(sync.error) } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to load models", code: "MODELS_UNAVAILABLE" }, { status: 503 });
  }
}

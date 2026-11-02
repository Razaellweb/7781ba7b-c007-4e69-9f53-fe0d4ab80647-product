import { NextResponse } from "next/server";
import { authenticateRequest, AuthenticationError } from "../../../../lib/server/auth";
import { adminConfig, modelHealthConfig } from "../../../../lib/server/config";
import { ensureMigrated } from "../../../../lib/server/migrate";
import {
  listDiscoverableModels,
  ModelStatusError,
  modelAvailabilityStatus,
  modelIsOperational,
  registryPricing,
  setModelStatus,
  syncCuratedModels,
  type ModelActivation,
} from "../../../../lib/server/models";

// Admin control plane — curated model registry (PRD §12).
//
// GET  lists every public curated model with its registry state and its live
//      per-model provider health: the vast.ai / vLLM identifier it maps to, its
//      Operational / Degraded / Unavailable status, whether an administrator has
//      activated it, and whether the Playground may therefore offer it. Pricing is
//      read from the registry row (never the provider), so an operator sees exactly
//      what the ledger's cost() will charge.
// POST activates or pauses a curated model. A pause takes effect on the next
//      registry read: the request path re-reads the row and rejects it immediately,
//      while a request already streaming finishes on the model it started with.
//      Availability is force-refreshed so the Overview cards and the Playground
//      selector converge inside one health-refresh interval rather than waiting for
//      the cron.
//
// Authorization: a verified session plus, when ADMIN_ACCOUNT_IDS /
// ADMIN_PRIVY_USER_IDS are published, membership of that allowlist. Every change
// is written to admin_audit_log.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function authorized(account: { accountId: string; privyUserId: string }): boolean {
  const config = adminConfig();
  if (!config.restricted) return true;
  return config.accountIds.includes(account.accountId) || config.privyUserIds.includes(account.privyUserId);
}

function forbidden(requestId: string) {
  return NextResponse.json({ error: "Administrator access is required.", code: "FORBIDDEN", requestId }, { status: 403, headers: NO_STORE });
}

async function registryReport(provider: string) {
  const models = await listDiscoverableModels();
  return models.map((model) => {
    const status = modelAvailabilityStatus(model);
    return {
      slug: model.slug,
      displayName: model.display_name,
      family: model.family,
      registryStatus: model.status,
      adminActivated: model.status === "active",
      provider: model.provider,
      providerModelSlug: model.provider_model_slug,
      // The vast.ai route this model resolves to. NULL is a configuration error the
      // probe already logged; it is surfaced here so an operator can fix it.
      vastModelId: model.vast_model_id,
      vastBaseUrl: model.vast_base_url,
      mappingConfigured: Boolean(model.vast_model_id || model.provider_model_slug),
      status,
      availability: model.provider_metadata?.availability ?? "unavailable",
      availabilityProvider: model.availability_provider ?? provider,
      availabilityCheckedAt: model.provider_synced_at,
      availabilityReason: model.provider_sync_error,
      selectable: modelIsOperational(model),
      contextLength: model.context_length,
      pricing: registryPricing(model),
      featured: model.featured,
      sortOrder: model.sort_order,
    };
  });
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    const account = await authenticateRequest(request.headers.get("authorization"));
    if (!authorized(account)) return forbidden(requestId);
    const sync = await syncCuratedModels();
    const models = await registryReport(sync.provider);
    return NextResponse.json(
      {
        activeProvider: sync.provider,
        models,
        count: models.length,
        refreshIntervalSeconds: modelHealthConfig().refreshIntervalSeconds,
        debounceRuns: modelHealthConfig().debounceRuns,
        requestId,
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: 401, headers: NO_STORE });
    console.error(JSON.stringify({ event: "admin_models_read_failed", requestId, error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "The model registry is temporarily unavailable.", code: "MODELS_UNAVAILABLE", requestId }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    const account = await authenticateRequest(request.headers.get("authorization"));
    if (!authorized(account)) return forbidden(requestId);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "A JSON body with a model slug and status is required.", code: "INVALID_REQUEST", requestId }, { status: 400, headers: NO_STORE });
    }
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug) return NextResponse.json({ error: "A model slug is required.", code: "INVALID_REQUEST", requestId }, { status: 400, headers: NO_STORE });

    // `active` / `paused` are the only transitions an operator may make here;
    // review/draft/deprecated are catalogue-authoring states, not runtime controls.
    const requested = typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
    const status: ModelActivation | null = requested === "active" ? "active" : requested === "paused" ? "paused" : null;
    if (!status) {
      return NextResponse.json({ error: "status must be \"active\" or \"paused\".", code: "INVALID_STATUS", requestId }, { status: 400, headers: NO_STORE });
    }

    const result = await setModelStatus(slug, status, { accountId: account.accountId, privyUserId: account.privyUserId, requestId });
    // Force the availability refresh so the change is reflected in the Overview
    // cards and the Playground dropdown immediately, not on the next cron tick.
    const sync = await syncCuratedModels({ force: true });
    const models = await registryReport(sync.provider);
    return NextResponse.json(
      {
        changed: { slug, previous: result.previous, current: result.current },
        activeProvider: sync.provider,
        models,
        requestId,
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: 401, headers: NO_STORE });
    if (error instanceof ModelStatusError) {
      const status = error.code === "UNKNOWN_MODEL" ? 404 : error.code === "INVALID_STATUS" ? 400 : 503;
      return NextResponse.json({ error: error.message, code: error.code, requestId }, { status, headers: NO_STORE });
    }
    console.error(JSON.stringify({ event: "admin_model_status_failed", requestId, error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "The model status could not be changed.", code: "MODEL_STATUS_FAILED", requestId }, { status: 503, headers: NO_STORE });
  }
}

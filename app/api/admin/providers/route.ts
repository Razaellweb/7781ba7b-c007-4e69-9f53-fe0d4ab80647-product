import { NextResponse } from "next/server";
import { authenticateRequest, AuthenticationError } from "../../../../lib/server/auth";
import { adminConfig, INFERENCE_PROVIDER_VALUES } from "../../../../lib/server/config";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { listProviderHealth } from "../../../../lib/server/provider";
import {
  acceptedProviderValues,
  activeProviderSelection,
  listProviderAudit,
  normalizeProviderId,
  ProviderSettingsError,
  setActiveProvider,
  type ProviderSwitch,
} from "../../../../lib/server/provider-settings";

// Admin control plane — inference providers (PRD § provider configuration).
//
// GET  lists every registered provider with its live health, whether it is the
//      active one, whether failover to it is enabled, and (for vast.ai) the
//      non-secret transport settings: base URL presence, bearer-token presence,
//      timeouts, retry budget, idle-shutdown window and the curated→vast.ai model
//      map. No credential value is ever returned.
// POST switches the active provider and/or the failover switch. The change is
//      persisted to inference_provider_settings, an admin_audit_log row records the
//      previous and new state, and the selection cache is invalidated so the next
//      request uses it — no restart. Requests already streaming keep the provider
//      they started on.
//
// Failover is OFF by default and separately switchable: `fallback` names the
// candidate provider, `fallbackEnabled` decides whether it is actually used. Only
// provider-outage failures (`upstream`, `timeout`, `model_unavailable`) are ever
// retried on the alternate provider; auth/config errors never are.
//
// Authorization: a verified session plus, when ADMIN_ACCOUNT_IDS /
// ADMIN_PRIVY_USER_IDS are published, membership of that allowlist.

export const runtime = "nodejs";

type AdminAccount = { accountId: string; privyUserId: string };

function authorized(account: AdminAccount): boolean {
  const config = adminConfig();
  if (!config.restricted) return true;
  return config.accountIds.includes(account.accountId) || config.privyUserIds.includes(account.privyUserId);
}

function unauthorized(requestId: string) {
  return NextResponse.json({ error: "Administrator access is required.", code: "FORBIDDEN", requestId }, { status: 403 });
}

/**
 * Reads the optional boolean switch from a request body.
 * Returns undefined when the field is absent ("keep the current value") and null
 * when it is present but not a boolean ("reject the request").
 */
function booleanField(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    const account = await authenticateRequest(request.headers.get("authorization"));
    if (!authorized(account)) return unauthorized(requestId);
    const report = await listProviderHealth();
    const audit = await listProviderAudit(10);
    return NextResponse.json(
      {
        providers: report.providers,
        active: report.active,
        fallback: report.fallback,
        // The switch itself, and the candidate it would use. This is what lets the
        // control plane render "configured, currently disabled" honestly.
        fallbackEnabled: report.fallbackEnabled,
        fallbackCandidate: report.fallbackCandidate,
        fallbackOn: report.fallbackOn,
        source: report.source,
        // An invalid INFERENCE_PROVIDER is surfaced here rather than hidden: the
        // startup preflight also fails on it, and this makes the mistake visible
        // in the UI that is meant to fix it.
        invalid: report.invalid,
        envProviderValues: [...INFERENCE_PROVIDER_VALUES],
        acceptedValues: acceptedProviderValues(),
        audit,
        requestId,
      },
      { headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } }
    );
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: 401 });
    console.error(JSON.stringify({ event: "admin_providers_read_failed", requestId, error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Provider status is temporarily unavailable.", code: "PROVIDERS_UNAVAILABLE", requestId }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    const account = await authenticateRequest(request.headers.get("authorization"));
    if (!authorized(account)) return unauthorized(requestId);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "A JSON body with a provider is required.", code: "INVALID_REQUEST", requestId }, { status: 400 });
    }

    const provider = normalizeProviderId(body.provider);
    if (!provider) {
      return NextResponse.json(
        {
          error: `Unknown provider \"${String(body.provider ?? "")}\". Valid values: ${acceptedProviderValues().join(", ")}.`,
          code: "INVALID_PROVIDER",
          acceptedValues: acceptedProviderValues(),
          requestId,
        },
        { status: 400 }
      );
    }

    // Failover is opt-in. An explicit null / "none" clears the candidate; omitting
    // the field keeps whatever is currently configured, so switching the primary
    // provider never silently changes (or drops) the configured fallback.
    let fallbackProvider: ProviderSwitch["fallbackProvider"];
    if (body.fallback === "none" || body.fallback === null) fallbackProvider = null;
    else if (body.fallback === undefined) fallbackProvider = activeProviderSelection().fallbackCandidate;
    else {
      const resolved = normalizeProviderId(body.fallback);
      if (!resolved) {
        return NextResponse.json(
          {
            error: `Unknown fallback provider \"${String(body.fallback)}\". Valid values: ${acceptedProviderValues().join(", ")}, or \"none\".`,
            code: "INVALID_PROVIDER",
            acceptedValues: acceptedProviderValues(),
            requestId,
          },
          { status: 400 }
        );
      }
      fallbackProvider = resolved === provider ? null : resolved;
    }

    // The switch. Omitting it preserves the current value, so a provider change and
    // a failover change are independent operations.
    const fallbackEnabled = booleanField(body.fallbackEnabled ?? body.failoverEnabled);
    if (fallbackEnabled === null) {
      return NextResponse.json({ error: "fallbackEnabled must be true or false.", code: "INVALID_REQUEST", requestId }, { status: 400 });
    }

    const result = await setActiveProvider({ provider, fallbackProvider, fallbackEnabled, accountId: account.accountId, privyUserId: account.privyUserId, requestId });
    const report = await listProviderHealth();
    console.log(JSON.stringify({ event: "admin_provider_switched", provider, fallback: result.current.fallback, fallbackEnabled: result.current.fallbackEnabled, requestId }));

    return NextResponse.json(
      {
        switched: result.current,
        previous: result.previous,
        providers: report.providers,
        active: report.active,
        fallback: report.fallback,
        fallbackEnabled: report.fallbackEnabled,
        fallbackCandidate: report.fallbackCandidate,
        fallbackOn: report.fallbackOn,
        requestId,
      },
      { headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } }
    );
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: 401 });
    if (error instanceof ProviderSettingsError) {
      return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: error.code === "INVALID_PROVIDER" ? 400 : 503 });
    }
    console.error(JSON.stringify({ event: "admin_provider_switch_failed", requestId, error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "The provider selection could not be changed.", code: "PROVIDER_SWITCH_FAILED", requestId }, { status: 503 });
  }
}

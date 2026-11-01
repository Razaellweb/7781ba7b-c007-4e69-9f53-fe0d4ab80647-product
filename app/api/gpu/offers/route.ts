import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { searchGpuOffers, VastUnavailableError, GPU_OFFERS_UNAVAILABLE_MESSAGE } from "../../../../lib/server/vast";
import { rateLimit } from "../../../../lib/server/redis";
import { ensureMigrated } from "../../../../lib/server/migrate";

// Browse-only GPU offers for the /gpu workspace page.
//
// Access control: the existing Privy session only. A verified Privy identity is
// sufficient to browse offers — there is no additional user authentication, no
// secondary credential, and no user-provided Vast.ai key. The endpoint accepts no
// key material of any kind, so there is nothing to collect in the UI.
//
// Credential boundary: the Vast.ai API key lives exclusively in the server
// environment and is attached to the outbound request by lib/server/vast.ts.
// It is never echoed in this response, never placed in a URL, and never logged.
// A missing or rejected key is indistinguishable from any other upstream failure
// here — the client always receives the same sanitized message the GPU page
// renders as "GPU offers are temporarily unavailable".
//
// Read-only: this route maps to Vast.ai's documented offers lookup
// (GET /api/v0/bundles/?q=…) and never creates an ask or rents an instance.

const NO_STORE = { "Cache-Control": "no-store" } as const;
const USER_RATE_LIMIT = 60;
const USER_RATE_WINDOW_SECONDS = 60;

function numericParam(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function textParam(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 80) : null;
}

/** Single sanitized failure shape. No upstream status text, URL, or credential fragment. */
function unavailable(error?: VastUnavailableError, status = 503) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (error?.retryAfterSeconds) headers["Retry-After"] = String(error.retryAfterSeconds);
  return NextResponse.json(
    {
      error: GPU_OFFERS_UNAVAILABLE_MESSAGE,
      code: "GPU_OFFERS_UNAVAILABLE",
      // Machine-readable reason only — never the upstream message. `unconfigured`
      // and `credentials_rejected` come from the server environment, not the user.
      kind: error?.kind ?? "upstream",
      retryable: error?.retryable ?? true,
      retryAfterSeconds: error?.retryAfterSeconds ?? null,
    },
    { status, headers },
  );
}

export async function GET(request: Request) {
  // 1. Schema readiness. A migration failure is an infrastructure problem: the
  //    page gets the same generic message instead of a stack trace.
  try {
    await ensureMigrated();
  } catch {
    console.error(JSON.stringify({ event: "gpu_offers_store_unavailable" }));
    return unavailable();
  }

  // 2. Existing Privy session is the only access requirement.
  let account;
  try {
    account = await authenticatePrivyRequest(request.headers.get("authorization"));
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 401, headers: NO_STORE });
    }
    console.error(JSON.stringify({ event: "gpu_offers_auth_unavailable" }));
    return unavailable();
  }

  // 3. Rate limit per authenticated account so one session cannot exhaust the
  //    server-held provider credential. Filter changes are debounced client-side,
  //    yet the response stays correct when the limiter trips. A Redis outage must
  //    not take browsing down, so coordination failures fail open.
  try {
    const allowed = await rateLimit(`gpu:offers:${account.accountId}`, USER_RATE_LIMIT, USER_RATE_WINDOW_SECONDS);
    if (!allowed) {
      return NextResponse.json(
        {
          error: "Too many requests. Try again shortly.",
          code: "RATE_LIMITED",
          kind: "rate_limited",
          retryable: true,
          retryAfterSeconds: USER_RATE_WINDOW_SECONDS,
        },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(USER_RATE_WINDOW_SECONDS) } },
      );
    }
  } catch {
    console.error(JSON.stringify({ event: "gpu_offers_rate_limit_unavailable" }));
  }

  // 4. Only filter parameters are read from the request — never credentials.
  const params = new URL(request.url).searchParams;
  try {
    const result = await searchGpuOffers({
      query: textParam(params.get("q")),
      gpuName: textParam(params.get("gpu")),
      minPricePerHour: numericParam(params.get("minPricePerHour")),
      maxPricePerHour: numericParam(params.get("maxPricePerHour")),
      minGpuRamGb: numericParam(params.get("minGpuRamGb")),
      maxGpuRamGb: numericParam(params.get("maxGpuRamGb")),
      minReliability: numericParam(params.get("minReliability")),
      limit: numericParam(params.get("limit")),
    });

    return NextResponse.json(
      {
        offers: result.offers,
        count: result.offers.length,
        total: result.total,
        gpuModels: result.gpuModels,
        filters: {
          q: textParam(params.get("q")),
          gpu: textParam(params.get("gpu")),
        },
        access: { authorized: true, method: "privy_identity" },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof VastUnavailableError) {
      // Missing key, rejected key, timeout, throttling, malformed payload and
      // transport failure all collapse to the same sanitized body.
      return unavailable(error);
    }
    // Anything unexpected (driver failure, programming error) is reported as the
    // generic message too — no internal detail reaches the client.
    console.error(JSON.stringify({ event: "gpu_offers_unhandled_failure" }));
    return unavailable();
  }
}

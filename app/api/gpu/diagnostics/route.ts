import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { rateLimit } from "../../../../lib/server/redis";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { readProviderDiagnostics } from "../../../../lib/server/provider-diagnostics";

// Read-only provider diagnostics for the workspace.
//
// Why this route exists: the GPU page's unavailable panel and the Overview cards
// previously had no way to distinguish "no credential configured" from "the
// provider host is unreachable" from "the marketplace is genuinely empty" — all
// three rendered the same generic message. This endpoint answers that question in
// normalized form so the UI can name the exact fix.
//
// Access control: the existing Privy session, same as /api/gpu/offers. No
// additional credential is accepted or required.
//
// Credential boundary: the vast.ai API key is used only inside lib/server/vast.ts.
// This response contains presence flags, the NAME of the environment variable that
// supplied the key, host names, outcome tags, latencies, and offer counts. It never
// contains the key, a fragment of it, an upstream URL, or an upstream error body.
//
// Side effects: none. Every probe is a read-only HTTP GET.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const DIAGNOSTICS_RATE_LIMIT = 12;
const DIAGNOSTICS_RATE_WINDOW_SECONDS = 60;

export async function GET(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));

    // The diagnostic probes outbound hosts, so it is rate limited per account: one
    // session cannot use it to hammer the marketplace or exhaust the credential.
    // A limiter outage fails open, exactly like the offers route.
    try {
      const allowed = await rateLimit(`gpu:diagnostics:${account.accountId}`, DIAGNOSTICS_RATE_LIMIT, DIAGNOSTICS_RATE_WINDOW_SECONDS);
      if (!allowed) {
        return NextResponse.json(
          { error: "Too many diagnostic checks. Try again shortly.", code: "RATE_LIMITED" },
          { status: 429, headers: { ...NO_STORE, "Retry-After": String(DIAGNOSTICS_RATE_WINDOW_SECONDS) } },
        );
      }
    } catch {
      console.error(JSON.stringify({ event: "gpu_diagnostics_rate_limit_unavailable" }));
    }

    const diagnostics = await readProviderDiagnostics();
    return NextResponse.json(diagnostics, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 401, headers: NO_STORE });
    }
    console.error(JSON.stringify({ event: "gpu_diagnostics_failed" }));
    return NextResponse.json(
      { error: "Provider diagnostics are temporarily unavailable.", code: "DIAGNOSTICS_UNAVAILABLE" },
      { status: 503, headers: NO_STORE },
    );
  }
}

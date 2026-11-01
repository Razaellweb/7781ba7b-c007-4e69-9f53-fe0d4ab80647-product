import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { resolveIdentityAccess } from "../../../../lib/server/holder";
import { rateLimit } from "../../../../lib/server/redis";
import { ensureMigrated } from "../../../../lib/server/migrate";

// Legacy compatibility endpoint.
//
// Access is no longer gated on OPENWEIGHT token holdings on Robinhood Chain, so
// there is nothing to verify on-chain. This handler is retained (rather than
// deleted) so older clients that still POST here keep receiving a valid,
// successful response instead of a 404 or a server error. It performs no RPC
// call, reads no token balance, and never denies access based on wallet holdings.
export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const force = new URL(request.url).searchParams.get("force") === "true";
    if (!(await rateLimit(`holder:${account.accountId}`, force ? 3 : 12, 60))) return NextResponse.json({ error: "Too many requests. Try again shortly.", code: "RATE_LIMITED" }, { status: 429 });
    const access = await resolveIdentityAccess(account);
    return NextResponse.json({
      eligibility: access,
      access: { authorized: true, method: access.method },
      gate: "removed",
      message: "Access is granted by verified identity; holdings are not checked.",
    });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Access status is temporarily unavailable", code: "VERIFICATION_ERROR" }, { status: 503 });
  }
}

// GET mirrors POST so legacy probes degrade gracefully instead of 405ing.
export async function GET(request: Request) {
  return POST(request);
}

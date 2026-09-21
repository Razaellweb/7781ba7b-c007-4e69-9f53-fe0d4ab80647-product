import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { verifyHolder } from "../../../../lib/server/holder";
import { rateLimit } from "../../../../lib/server/redis";
import { ensureMigrated } from "../../../../lib/server/migrate";

export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const force = new URL(request.url).searchParams.get("force") === "true";
    if (!(await rateLimit(`holder:${account.accountId}`, force ? 3 : 12, 60))) return NextResponse.json({ error: "Too many verification attempts. Try again shortly.", code: "RATE_LIMITED" }, { status: 429 });
    const result = await verifyHolder(account, { force });
    return NextResponse.json({ eligibility: result });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Holder verification is temporarily unavailable", code: "VERIFICATION_ERROR" }, { status: 503 });
  }
}
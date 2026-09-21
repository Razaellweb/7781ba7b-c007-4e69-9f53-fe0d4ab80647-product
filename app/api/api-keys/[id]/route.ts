import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { ApiKeyError, revokeApiKey } from "../../../../lib/server/api-keys";
import { ensureMigrated } from "../../../../lib/server/migrate";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const { id } = await params;
    return NextResponse.json(await revokeApiKey(account.accountId, id));
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof ApiKeyError) return NextResponse.json({ error: error.message, code: error.code }, { status: error instanceof ApiKeyError ? error.status : 401 });
    return NextResponse.json({ error: "API key action is temporarily unavailable", code: "API_KEY_ACTION_FAILED" }, { status: 503 });
  }
}

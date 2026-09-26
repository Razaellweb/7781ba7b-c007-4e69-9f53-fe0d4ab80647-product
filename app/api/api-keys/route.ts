import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { ApiKeyError, createApiKey, listApiKeys } from "../../../lib/server/api-keys";
import { ensureMigrated } from "../../../lib/server/migrate";

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationError || error instanceof ApiKeyError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error instanceof ApiKeyError ? error.status : 401 },
    );
  }
  return NextResponse.json(
    { error: "API key service is temporarily unavailable. Please try again.", code: "API_KEYS_UNAVAILABLE" },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    return NextResponse.json({ keys: await listApiKeys(account.accountId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const parsedBody: unknown = await request.json().catch(() => ({}));
    const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
      ? parsedBody as { name?: unknown; scopes?: unknown; rateLimitPerMinute?: unknown }
      : {};
    const created = await createApiKey(account.accountId, body);
    return NextResponse.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
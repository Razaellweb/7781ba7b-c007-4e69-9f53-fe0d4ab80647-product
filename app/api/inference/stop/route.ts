import { NextResponse } from "next/server";
import { authenticateRequest, AuthenticationError } from "../../../../lib/server/auth";
import { query } from "../../../../lib/server/db";
import { cacheSet } from "../../../../lib/server/redis";
import { ensureMigrated } from "../../../../lib/server/migrate";

export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticateRequest(request.headers.get("authorization"), "chat:write");
    const body = await request.json().catch(() => ({})) as { operationKey?: string };
    const operationKey = body.operationKey?.trim();
    if (!operationKey) return NextResponse.json({ error: "operationKey is required", code: "INVALID_REQUEST" }, { status: 400 });
    const owned = await query(`SELECT 1 FROM inference_records WHERE operation_key=$1 AND account_id=$2`, [operationKey, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Inference not found", code: "NOT_FOUND" }, { status: 404 });
    await cacheSet(`stop:${operationKey}`, true, 120);
    return NextResponse.json({ stopped: true });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "INSUFFICIENT_SCOPE" ? 403 : 401 });
    return NextResponse.json({ error: "Unable to stop inference", code: "STOP_FAILED" }, { status: 503 });
  }
}
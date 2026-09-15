import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { query } from "../../../../lib/server/db";
import { cacheSet } from "../../../../lib/server/redis";
import { ensureMigrated } from "../../../../lib/server/migrate";

// Signals an in-flight inference to stop. The streaming handler polls this flag
// and settles known usage on the next check (PRD §7.11, §28.5). Only the owning
// account may cancel its own inference.
export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const body = await request.json().catch(() => ({})) as { operationKey?: string };
    const operationKey = body.operationKey?.trim();
    if (!operationKey) return NextResponse.json({ error: "operationKey is required", code: "INVALID_REQUEST" }, { status: 400 });
    const owned = await query(`SELECT 1 FROM inference_records WHERE operation_key=$1 AND account_id=$2`, [operationKey, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Inference not found", code: "NOT_FOUND" }, { status: 404 });
    await cacheSet(`stop:${operationKey}`, true, 120);
    return NextResponse.json({ stopped: true });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to stop inference", code: "STOP_FAILED" }, { status: 503 });
  }
}

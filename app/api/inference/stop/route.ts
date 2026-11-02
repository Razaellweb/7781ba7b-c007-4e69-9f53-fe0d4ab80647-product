import { NextResponse } from "next/server";
import { authenticateRequest, AuthenticationError } from "../../../../lib/server/auth";
import { query } from "../../../../lib/server/db";
import { requestStop } from "../../../../lib/server/inference-stop";
import { getInferenceProvider } from "../../../../lib/server/provider";
import { ensureMigrated } from "../../../../lib/server/migrate";

// "Stop" for one in-flight turn.
//
// Three effects, in order of importance:
//   1. the stop is recorded in the shared registry, so the streaming handler
//      breaks out of its read loop even if the browser's abort never reached it
//      (another instance, a dropped connection, a second tab);
//   2. the provider's in-flight upstream request is cancelled by operation key,
//      which is what actually stops a rented GPU from generating;
//   3. the endpoint is idempotent and ownership-checked, so a repeated press or
//      an unknown key is harmless.
//
// Accounting is NOT done here: the streaming handler settles the reservation
// from the tokens it actually received, so a stop debits only what arrived.
export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticateRequest(request.headers.get("authorization"), "chat:write");
    const body = await request.json().catch(() => ({})) as { operationKey?: string };
    const operationKey = typeof body.operationKey === "string" ? body.operationKey.trim() : "";
    if (!operationKey) return NextResponse.json({ error: "operationKey is required", code: "INVALID_REQUEST", retryable: false }, { status: 400 });

    const owned = await query<{ status: string }>(`SELECT status FROM inference_records WHERE operation_key=$1 AND account_id=$2`, [operationKey, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Inference not found", code: "NOT_FOUND", retryable: false }, { status: 404 });

    await requestStop(operationKey);
    await getInferenceProvider().cancel(operationKey).catch(() => undefined);

    return NextResponse.json({ stopped: true, operationKey, status: owned[0].status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, retryable: false }, { status: error.code === "INSUFFICIENT_SCOPE" ? 403 : 401 });
    return NextResponse.json({ error: "Unable to stop inference", code: "STOP_FAILED", retryable: true }, { status: 503 });
  }
}

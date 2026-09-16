import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { query } from "../../../lib/server/db";
import { ensureMigrated } from "../../../lib/server/migrate";

// Recent metered inference for the authenticated account (PRD §28.6). Read-only
// activity feed powering the "Compute activity" view.
export async function GET(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const rows = await query(
      `SELECT operation_key, model, provider_model, status, input_tokens, output_tokens,
              provider_cost_micro_usd, user_debit_micro_usd, created_at, completed_at
         FROM inference_records
        WHERE account_id=$1
        ORDER BY created_at DESC
        LIMIT 50`,
      [account.accountId]
    );
    return NextResponse.json({ activity: rows, count: rows.length });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    console.error("[activity] failed to load compute activity:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Unable to load compute activity", code: "ACTIVITY_UNAVAILABLE" }, { status: 503 });
  }
}

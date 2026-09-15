import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../../lib/server/auth";
import { query } from "../../../../lib/server/db";
import { ensureMigrated } from "../../../../lib/server/migrate";

// Returns a conversation's messages, rejecting access to another account's
// conversation (PRD §28.7, §29.1).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const { id } = await params;
    const owned = await query(`SELECT id, title, created_at, updated_at FROM conversations WHERE id=$1 AND account_id=$2`, [id, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Conversation not found", code: "NOT_FOUND" }, { status: 404 });
    const messages = await query(
      `SELECT role, content, partial, model_slug, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
      [id]
    );
    return NextResponse.json({ conversation: owned[0], messages });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to load conversation", code: "CONVERSATION_UNAVAILABLE" }, { status: 503 });
  }
}

import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { query } from "../../../lib/server/db";
import { ensureMigrated } from "../../../lib/server/migrate";

// Lists conversations belonging only to the authenticated account (PRD §28.6).
export async function GET(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const rows = await query(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE c.account_id=$1 ORDER BY c.updated_at DESC LIMIT 100`,
      [account.accountId]
    );
    return NextResponse.json({ conversations: rows, count: rows.length });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to load conversations", code: "CONVERSATIONS_UNAVAILABLE" }, { status: 503 });
  }
}

// Creates a conversation for the authenticated account (PRD §28.3).
export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const body = await request.json().catch(() => ({})) as { title?: string };
    const title = body.title?.trim()?.slice(0, 120) || "New conversation";
    const rows = await query<{ id: string; title: string; created_at: string; updated_at: string }>(
      `INSERT INTO conversations (account_id, title) VALUES ($1,$2) RETURNING id, title, created_at, updated_at`,
      [account.accountId, title]
    );
    return NextResponse.json({ conversation: rows[0] }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to create conversation", code: "CONVERSATION_CREATE_FAILED" }, { status: 503 });
  }
}

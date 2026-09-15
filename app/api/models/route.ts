import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { listActiveModels } from "../../../lib/server/models";
import { ensureMigrated } from "../../../lib/server/migrate";

// Returns only active, approved models. Never exposes provider slugs, pricing
// internals, or credentials (PRD §28.2).
export async function GET(request: Request) {
  try {
    await ensureMigrated();
    await authenticatePrivyRequest(request.headers.get("authorization"));
    const models = await listActiveModels();
    const data = models.map(m => ({ id: m.slug, displayName: m.display_name, family: m.family, featured: m.featured, contextLength: m.context_length }));
    return NextResponse.json({ models: data, count: data.length });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401 });
    return NextResponse.json({ error: "Unable to load models", code: "MODELS_UNAVAILABLE" }, { status: 503 });
  }
}

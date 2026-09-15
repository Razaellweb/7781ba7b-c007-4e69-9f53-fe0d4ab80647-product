import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { verifyHolder } from "../../../lib/server/holder";
import { reserveCompute, settleReservation } from "../../../lib/server/accounting";
import { query } from "../../../lib/server/db";
import { rateLimit } from "../../../lib/server/redis";
import { OpenRouterProvider } from "../../../lib/server/openrouter";

const approvedModels = new Set(["glm-4.5", "qwen3-235b-a22b", "deepseek-v3.1", "kimi-k2", "llama-4-maverick", "mistral-large-2", "gemma-3-27b", "yi-lightning"]);
const encoder = new TextEncoder();

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    if (!(await rateLimit(`inference:${account.accountId}`, 20, 60))) return NextResponse.json({ error: "Too many requests. Try again shortly.", code: "RATE_LIMITED", requestId }, { status: 429 });
    const body = await request.json() as { conversationId?: string; message?: string; model?: string; operationKey?: string };
    const text = body.message?.trim();
    const model = body.model === "auto" ? "glm-4.5" : body.model;
    if (!text) return NextResponse.json({ error: "Message cannot be empty", code: "INVALID_REQUEST", requestId }, { status: 400 });
    if (!model || !approvedModels.has(model)) return NextResponse.json({ error: "That model is not available", code: "UNAVAILABLE_MODEL", requestId }, { status: 400 });
    const eligibility = await verifyHolder(account);
    if (eligibility.state !== "eligible") return NextResponse.json({ error: "Holder eligibility must be confirmed before inference", code: eligibility.state, requestId }, { status: 403 });
    const conversationId = body.conversationId ?? (await query<{ id: string }>(`INSERT INTO conversations (account_id) VALUES ($1) RETURNING id`, [account.accountId]))[0].id;
    const owned = await query(`SELECT id FROM conversations WHERE id=$1 AND account_id=$2`, [conversationId, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Conversation not found", code: "NOT_FOUND", requestId }, { status: 404 });
    const operationKey = body.operationKey ?? requestId;
    await query(`INSERT INTO messages (conversation_id,account_id,role,content) VALUES ($1,$2,'user',$3)`, [conversationId, account.accountId, text]);
    await reserveCompute(account.accountId, operationKey, 1_000_000n);
    const provider = new OpenRouterProvider();
    const stream = new ReadableStream({ async start(controller) {
      let output = "";
      let completed = false;
      try {
        for await (const chunk of provider.stream({ operationKey, model, messages: [{ role: "user", content: text }] })) {
          if (chunk.type === "delta") { output += chunk.text; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: chunk.text })}\n\n`)); }
          if (chunk.type === "complete") {
            completed = true;
            await query(`INSERT INTO messages (conversation_id,account_id,role,content,partial) VALUES ($1,$2,'assistant',$3,false)`, [conversationId, account.accountId, output]);
            await settleReservation(operationKey, 1n, chunk.usage.providerCostMicroUsd, chunk.usage.uncertain);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "complete", conversationId, requestId })}\n\n`));
          }
          if (chunk.type === "error") { await settleReservation(operationKey, 0n, null, false).catch(() => undefined); controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: chunk.error.message, retryable: chunk.error.retryable })}\n\n`)); }
        }
      } catch { await settleReservation(operationKey, 0n, null, true).catch(() => undefined); controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Inference could not be completed", retryable: true })}\n\n`)); }
      finally { if (!completed && output) await query(`INSERT INTO messages (conversation_id,account_id,role,content,partial) VALUES ($1,$2,'assistant',$3,true)`, [conversationId, account.accountId, output]).catch(() => undefined); controller.close(); }
    }});
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Request-ID": requestId } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: 401 });
    return NextResponse.json({ error: "Inference is unavailable. No provider work was started.", code: "INFERENCE_UNAVAILABLE", requestId }, { status: 503 });
  }
}

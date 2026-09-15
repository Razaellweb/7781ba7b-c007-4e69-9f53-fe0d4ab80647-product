import { NextResponse } from "next/server";
import { authenticatePrivyRequest, AuthenticationError } from "../../../lib/server/auth";
import { verifyHolder } from "../../../lib/server/holder";
import { reserveCompute, settleReservation, AccountingError } from "../../../lib/server/accounting";
import { query } from "../../../lib/server/db";
import { rateLimit, cacheGet } from "../../../lib/server/redis";
import { OpenRouterProvider } from "../../../lib/server/openrouter";
import { getActiveModel, pickAutoModel, type ModelRow } from "../../../lib/server/models";
import { computeUserDebit, modelPolicy } from "../../../lib/server/pricing";
import { pricingConfig } from "../../../lib/server/config";
import { ensureMigrated } from "../../../lib/server/migrate";
import type { InferenceMessage } from "../../../lib/server/inference";

const encoder = new TextEncoder();
const CONTEXT_LIMIT = 20;

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    if (!(await rateLimit(`inference:${account.accountId}`, 20, 60))) return NextResponse.json({ error: "Too many requests. Try again shortly.", code: "RATE_LIMITED", requestId }, { status: 429 });

    const body = await request.json() as { conversationId?: string; message?: string; model?: string; operationKey?: string; clientRequestId?: string };
    const text = body.message?.trim();
    if (!text) return NextResponse.json({ error: "Message cannot be empty", code: "INVALID_REQUEST", requestId }, { status: 400 });

    // Resolve the requested model against the approved registry (PRD §12, §13).
    const requestedSlug = body.model?.trim();
    const model: ModelRow | null = !requestedSlug || requestedSlug === "auto" ? await pickAutoModel() : await getActiveModel(requestedSlug);
    if (!model) return NextResponse.json({ error: "That model is not available", code: "UNAVAILABLE_MODEL", requestId }, { status: 400 });

    // Authoritative holder verification before any billable work (PRD §5, §29).
    const eligibility = await verifyHolder(account);
    if (eligibility.state !== "eligible") return NextResponse.json({ error: "Holder eligibility must be confirmed before inference", code: eligibility.state, requestId }, { status: 403 });

    // Resolve / verify conversation ownership.
    const conversationId = body.conversationId ?? (await query<{ id: string }>(`INSERT INTO conversations (account_id) VALUES ($1) RETURNING id`, [account.accountId]))[0].id;
    const owned = await query(`SELECT id FROM conversations WHERE id=$1 AND account_id=$2`, [conversationId, account.accountId]);
    if (!owned.length) return NextResponse.json({ error: "Conversation not found", code: "NOT_FOUND", requestId }, { status: 404 });

    const operationKey = body.operationKey ?? body.clientRequestId ?? requestId;

    // Build server-side context from persisted history (PRD §16.3).
    const priorRows = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM messages WHERE conversation_id=$1 AND partial=false ORDER BY created_at ASC LIMIT $2`,
      [conversationId, CONTEXT_LIMIT]
    );
    const contextMessages: InferenceMessage[] = [...priorRows.map(r => ({ role: r.role, content: r.content })), { role: "user", content: text }];

    // Persist the user message and open an inference record.
    await query(`INSERT INTO messages (conversation_id,account_id,role,content) VALUES ($1,$2,'user',$3)`, [conversationId, account.accountId, text]);
    const cfg = pricingConfig();
    const policy = modelPolicy(model);
    await query(
      `INSERT INTO inference_records (account_id, operation_key, provider, model, provider_model, conversation_id, status, markup_micro, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'started',$7,$8) ON CONFLICT (operation_key) DO NOTHING`,
      [account.accountId, operationKey, model.provider, model.slug, model.provider_model_slug, conversationId, policy.markupMicro.toString(), JSON.stringify({ requestId })]
    );

    // Reserve a safety cap; fails if the user lacks balance (PRD §7.7, §9.4).
    try {
      await reserveCompute(account.accountId, operationKey, cfg.reservationCapMicroUsd);
    } catch (e) {
      if (e instanceof AccountingError) return NextResponse.json({ error: "Insufficient compute balance for this request", code: "INSUFFICIENT_COMPUTE", requestId }, { status: 402 });
      throw e;
    }

    const provider = new OpenRouterProvider();
    const stream = new ReadableStream({
      async start(controller) {
        let output = "";
        let settled = false;
        let deltas = 0;
        let stopRequested = false;
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        const finalize = async (
          status: "complete" | "cancelled" | "failed" | "uncertain",
          providerCost: bigint | null,
          usage: { inputTokens: number | null; outputTokens: number | null; providerModel?: string | null; requestId?: string | null } | null,
          uncertain: boolean,
        ) => {
          if (settled) return;
          settled = true;
          const userDebit = providerCost != null && !uncertain ? computeUserDebit(providerCost, policy) : 0n;
          const cappedDebit = userDebit > cfg.reservationCapMicroUsd ? cfg.reservationCapMicroUsd : userDebit;
          const isUncertain = uncertain || (status !== "complete" && providerCost == null && output.length > 0);
          await settleReservation(operationKey, cappedDebit, providerCost, isUncertain).catch(() => undefined);
          if (output) {
            await query(
              `INSERT INTO messages (conversation_id,account_id,role,content,partial,model_slug,provider_model,input_tokens,output_tokens,provider_cost_micro_usd,user_debit_micro_usd)
               VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7,$8,$9,$10)`,
              [conversationId, account.accountId, output, status !== "complete", model.slug, usage?.providerModel ?? model.provider_model_slug, usage?.inputTokens ?? null, usage?.outputTokens ?? null, providerCost?.toString() ?? null, cappedDebit.toString()]
            ).catch(() => undefined);
          }
          await query(
            `UPDATE inference_records SET status=$2, input_tokens=$3, output_tokens=$4, provider_cost_micro_usd=$5, user_debit_micro_usd=$6, provider_request_id=$7, completed_at=now() WHERE operation_key=$1`,
            [operationKey, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, providerCost?.toString() ?? null, cappedDebit.toString(), usage?.requestId ?? null]
          ).catch(() => undefined);
          await query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [conversationId]).catch(() => undefined);
        };

        try {
          for await (const chunk of provider.stream({ operationKey, model: model.provider_model_slug, messages: contextMessages })) {
            if (chunk.type === "delta") {
              output += chunk.text; deltas += 1;
              send({ type: "delta", text: chunk.text });
              // Cooperative cancellation via a shared stop flag (PRD §7.11, §28.5).
              if (deltas % 20 === 0) {
                const stop = await cacheGet<boolean>(`stop:${operationKey}`).catch(() => null);
                if (stop) { stopRequested = true; break; }
              }
            } else if (chunk.type === "complete") {
              await finalize("complete", chunk.usage.providerCostMicroUsd, { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }, chunk.usage.uncertain);
              send({ type: "complete", conversationId, requestId });
            } else if (chunk.type === "error") {
              await finalize("failed", null, null, false);
              send({ type: "error", error: chunk.error.message, retryable: chunk.error.retryable });
            }
          }
          if (stopRequested) { await finalize("cancelled", null, null, true); send({ type: "cancelled", conversationId, requestId }); }
        } catch {
          await finalize("uncertain", null, null, true);
          send({ type: "error", error: "Inference could not be completed", retryable: true });
        } finally {
          await finalize("failed", null, null, false).catch(() => undefined);
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Request-ID": requestId } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code, requestId }, { status: 401 });
    return NextResponse.json({ error: "Inference is unavailable. No provider work was started.", code: "INFERENCE_UNAVAILABLE", requestId }, { status: 503 });
  }
}

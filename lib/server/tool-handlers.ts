/**
 * Server-side tool handlers.
 *
 * The registry is EMPTY ON PURPOSE. This application defines no tools of its own,
 * so there is nothing here that could legitimately be executed on a caller's
 * behalf, and inventing a tool (a search, a database lookup, an HTTP fetch) would
 * both exceed this feature's scope and hand an arbitrary model a capability the
 * product never agreed to. A tool is executable only when it is BOTH declared in
 * the incoming request AND registered here with an allowed handler; until a real
 * handler is added below, every tool call is surfaced to the caller instead of
 * being run, and no result is ever fabricated.
 *
 * To enable execution for a tool, add one entry:
 *
 *   { definition: { type: "function", function: { name, description, parameters } },
 *     execute: async (call, context) => ({ ... }) }
 *
 * `definition` must be the exact declaration forwarded upstream, `execute` must be
 * read-only or idempotent-safe, and its return value is JSON-serialized into the
 * tool message. Handlers never receive provider credentials, API keys, or raw
 * provider diagnostics, and must not put them in their result.
 */

import type { InferenceMessage, InferenceToolCall, InferenceToolDefinition } from "./inference";

/** The minimum context a handler is given. No secrets are included. */
export type ToolHandlerContext = {
  accountId: string;
  conversationId: string;
  operationKey: string;
};

export type ToolHandler = {
  /** The exact declaration forwarded upstream; its name is the routing key. */
  definition: InferenceToolDefinition;
  /** Runs one COMPLETE tool call and returns a JSON-serializable result. */
  execute: (call: InferenceToolCall, context: ToolHandlerContext) => Promise<unknown>;
};

export const TOOL_HANDLERS: readonly ToolHandler[] = [];

const HANDLERS_BY_NAME: ReadonlyMap<string, ToolHandler> = new Map(TOOL_HANDLERS.map((handler) => [handler.definition.function.name, handler]));

/** The allowed handler for a tool name, or null when none is registered. */
export function resolveToolHandler(name: string): ToolHandler | null {
  return HANDLERS_BY_NAME.get(name) ?? null;
}

export type ToolExecutionOutcome =
  | { executable: true; results: InferenceMessage[] }
  | { executable: false };

/**
 * Executes a round of complete tool calls, strictly in the order and with the ids
 * the model produced.
 *
 * All-or-nothing: if any call was not declared by the request, has no allowed
 * handler, or its handler fails, NOTHING is executed and `executable: false` is
 * returned so the caller can surface the structured tool calls instead of
 * fabricating results. That also guarantees a round can never be half-applied and
 * then retried.
 */
export async function executeDeclaredToolCalls(
  calls: InferenceToolCall[],
  declaredNames: ReadonlySet<string>,
  context: ToolHandlerContext,
): Promise<ToolExecutionOutcome> {
  if (!calls.length) return { executable: false };
  const plan: ToolHandler[] = [];
  for (const call of calls) {
    if (!declaredNames.has(call.function.name)) return { executable: false };
    const handler = resolveToolHandler(call.function.name);
    if (!handler) return { executable: false };
    plan.push(handler);
  }
  const results: InferenceMessage[] = [];
  for (const [index, call] of calls.entries()) {
    let content: string;
    try {
      content = serializeResult(await plan[index].execute(call, context));
    } catch {
      // A failed handler ends the round without a result message: the turn falls
      // back to surfacing the structured tool call rather than reporting a made-up
      // outcome to the model.
      return { executable: false };
    }
    results.push({ role: "tool", content, tool_call_id: call.id });
  }
  return { executable: true, results };
}

/** JSON content for a tool result message. Never contains credentials. */
export function serializeResult(value: unknown): string {
  try {
    const serialized = JSON.stringify(value ?? null);
    return typeof serialized === "string" ? serialized : "null";
  } catch {
    return JSON.stringify({ error: "tool_result_unserializable" });
  }
}

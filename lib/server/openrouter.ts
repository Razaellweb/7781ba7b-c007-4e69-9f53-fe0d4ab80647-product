import { openRouterConfig } from "./config";
import { normalizedProviderError, type InferenceChunk, type InferenceMessage, type InferenceProvider, type InferenceRequest, type InferenceToolCall, type ProviderCatalogModel, type InferenceHealth } from "./inference";

type CatalogPayload = { data?: unknown };
type StreamToolCallDelta = { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
type StreamEvent = { choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }; error?: unknown };

const MAX_TOOL_CALLS = 100;

function objectValue(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function safeInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null; }
function safeStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 50) : []; }
function safePricing(value: unknown): Record<string, string> {
  const raw = objectValue(value); const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(raw)) if (/^[a-z_]+$/.test(key) && typeof item === "string" && /^-?\d+(\.\d+)?$/.test(item)) entries.push([key, item]);
  return Object.fromEntries(entries);
}
function normalizeCatalogModel(value: unknown): ProviderCatalogModel | null {
  const raw = objectValue(value); if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  const architecture = objectValue(raw.architecture);
  return { providerModelId: raw.id, contextLength: safeInteger(raw.context_length), pricing: safePricing(raw.pricing), architecture: { inputModalities: safeStringArray(architecture.input_modalities), outputModalities: safeStringArray(architecture.output_modalities) }, supportedParameters: safeStringArray(raw.supported_parameters) };
}
function errorCode(status: number): ReturnType<typeof normalizedProviderError> {
  if (status === 401 || status === 403) return normalizedProviderError("authentication");
  if (status === 404) return normalizedProviderError("unsupported_model");
  if (status === 408 || status === 504) return normalizedProviderError("timeout");
  if (status === 429) return normalizedProviderError("rate_limited");
  if (status >= 500) return normalizedProviderError("upstream");
  return normalizedProviderError("invalid_request");
}

/**
 * Rebuilds the upstream message list. `tool` results and assistant tool calls are
 * forwarded exactly as the caller supplied them; nothing is synthesized.
 */
function serializeMessages(messages: InferenceMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const serialized: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.role === "assistant" && message.tool_calls?.length) serialized.tool_calls = message.tool_calls;
    if (message.role === "tool" && message.tool_call_id) serialized.tool_call_id = message.tool_call_id;
    return serialized;
  });
}

/**
 * Accumulates streaming tool_call fragments.
 *
 * Upstream emits one logical call as several deltas sharing an index: the id and
 * name usually arrive first and the JSON arguments arrive in pieces (sometimes a
 * single character at a time), and some providers repeat the id on later deltas.
 * Fragments are joined by index, and an id that reappears under a different index
 * is treated as the same call so a split index cannot duplicate it. Only calls that
 * end up with an id, a name, and JSON-object arguments are returned, so a fragment
 * that never completed is never executed.
 */
class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  push(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry === null || typeof entry !== "object") continue;
      const delta = entry as StreamToolCallDelta;
      const index = typeof delta.index === "number" && Number.isSafeInteger(delta.index) && delta.index >= 0 ? delta.index : this.byIndex.size;
      const current = this.byIndex.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof delta.id === "string" && delta.id.trim() && !current.id) current.id = delta.id.trim();
      const fn = delta.function;
      if (fn && typeof fn === "object") {
        if (typeof fn.name === "string" && fn.name && !current.name) current.name = fn.name;
        if (typeof fn.arguments === "string" && fn.arguments) current.arguments += fn.arguments;
      }
      this.byIndex.set(index, current);
    }
  }

  /** Complete, executable calls in the order the provider first emitted them. */
  complete(): InferenceToolCall[] {
    const calls: InferenceToolCall[] = [];
    const seenIds = new Set<string>();
    for (const index of [...this.byIndex.keys()].sort((left, right) => left - right)) {
      const entry = this.byIndex.get(index);
      if (!entry || !entry.id || !entry.name) continue;
      const trimmed = entry.arguments.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      calls.push({ id: entry.id, type: "function", function: { name: entry.name, arguments: trimmed } });
      if (calls.length >= MAX_TOOL_CALLS) break;
    }
    return calls;
  }
}

export class OpenRouterProvider implements InferenceProvider {
  private config() { return openRouterConfig(); }
  async *stream(request: InferenceRequest): AsyncIterable<InferenceChunk> {
    let config: ReturnType<OpenRouterProvider["config"]>;
    try { config = this.config(); } catch { yield { type: "error", error: normalizedProviderError("unavailable") }; return; }
    if (!config.enabled) { yield { type: "error", error: normalizedProviderError("unavailable") }; return; }
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 120_000);
    const onAbort = () => timeoutController.abort();
    if (request.signal?.aborted) { clearTimeout(timeout); yield { type: "error", error: normalizedProviderError("cancelled") }; return; }
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    const payload: Record<string, unknown> = { model: request.model, messages: serializeMessages(request.messages), stream: true, usage: { include: true } };
    if (request.parameters?.temperature !== undefined) payload.temperature = request.parameters.temperature;
    if (request.parameters?.top_p !== undefined) payload.top_p = request.parameters.top_p;
    if (request.parameters?.max_tokens !== undefined) payload.max_tokens = request.parameters.max_tokens;
    if (request.parameters?.max_completion_tokens !== undefined) payload.max_completion_tokens = request.parameters.max_completion_tokens;
    if (request.parameters?.seed !== undefined) payload.seed = request.parameters.seed;
    if (request.parameters?.stop?.length) payload.stop = request.parameters.stop;
    // Tool definitions and tool_choice are forwarded only when the caller supplied
    // them, which the routes gate on the model's synced capability.
    if (request.tools?.length) payload.tools = request.tools;
    if (request.toolChoice !== undefined) payload.tool_choice = request.toolChoice;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://openweight.systems", "X-Title": "Openweight" }, body: JSON.stringify(payload), signal: timeoutController.signal });
    } catch (caught) {
      clearTimeout(timeout); request.signal?.removeEventListener("abort", onAbort);
      yield { type: "error", error: request.signal?.aborted ? normalizedProviderError("cancelled") : normalizedProviderError(timeoutController.signal.aborted ? "timeout" : "unavailable") }; return;
    }
    if (!response.ok || !response.body) { clearTimeout(timeout); request.signal?.removeEventListener("abort", onAbort); console.error(`[provider] inference transport failed status=${response.status}`); yield { type: "error", error: errorCode(response.status) }; return; }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let output = ""; let buffer = "";
    const toolCalls = new ToolCallAccumulator();
    let finalUsage: InferenceChunk = { type: "complete", output: "", usage: { inputTokens: null, outputTokens: null, providerCostMicroUsd: null, uncertain: true } };
    let endedNormally = false;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) { endedNormally = true; break; }
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.trim(); if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
          let event: StreamEvent; try { event = JSON.parse(raw) as StreamEvent; } catch { yield { type: "error", error: normalizedProviderError("malformed_response") }; return; }
          if (event.error !== undefined) { yield { type: "error", error: normalizedProviderError("upstream") }; return; }
          const delta = event.choices?.[0]?.delta;
          const text = delta?.content;
          if (typeof text === "string" && text) { output += text; yield { type: "delta", text }; }
          // Tool call fragments are buffered here and never surfaced piecemeal: the
          // route must not attempt to execute a partial call.
          if (delta?.tool_calls !== undefined) toolCalls.push(delta.tool_calls);
          if (event.usage) { const cost = typeof event.usage.cost === "number" && Number.isFinite(event.usage.cost) ? BigInt(Math.round(event.usage.cost * 1_000_000)) : null; finalUsage = { type: "complete", output, usage: { inputTokens: safeInteger(event.usage.prompt_tokens), outputTokens: safeInteger(event.usage.completion_tokens), providerCostMicroUsd: cost, uncertain: cost === null } }; }
        }
      }
      if (endedNormally) {
        // Complete calls only. A fragment left unfinished at stream end is dropped
        // so the route never executes an incomplete call.
        const complete = toolCalls.complete();
        if (complete.length) yield { type: "tool_calls", toolCalls: complete };
        yield finalUsage;
      }
    } catch {
      yield { type: "error", error: request.signal?.aborted ? normalizedProviderError("cancelled") : timeoutController.signal.aborted ? normalizedProviderError("timeout") : normalizedProviderError("upstream") };
    } finally { clearTimeout(timeout); request.signal?.removeEventListener("abort", onAbort); reader.releaseLock(); }
  }
  async catalog(): Promise<ProviderCatalogModel[]> {
    const config = this.config(); if (!config.enabled) throw new Error("catalog_unavailable");
    let response: Response; try { response = await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, cache: "no-store" }); } catch { throw new Error("catalog_unavailable"); }
    if (!response.ok) { console.error(`[provider] catalog transport failed status=${response.status}`); throw new Error("catalog_unavailable"); }
    const payload = await response.json() as CatalogPayload; if (!Array.isArray(payload.data)) throw new Error("catalog_malformed");
    return payload.data.map(normalizeCatalogModel).filter((model): model is ProviderCatalogModel => model !== null);
  }
  async health(): Promise<InferenceHealth> { try { await this.catalog(); return { healthy: true, message: "available" }; } catch { return { healthy: false, message: "unavailable" }; } }
  async cancel(_operationKey: string) { return; }
}

export async function getInferenceHealth(): Promise<InferenceHealth> { return new OpenRouterProvider().health(); }

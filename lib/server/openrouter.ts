import { openRouterConfig } from "./config";
import { normalizedProviderError, type InferenceChunk, type InferenceProvider, type InferenceRequest, type ProviderCatalogModel, type InferenceHealth } from "./inference";

type CatalogPayload = { data?: unknown };
type StreamEvent = { choices?: Array<{ delta?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }; error?: unknown };

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
    const payload: Record<string, unknown> = { model: request.model, messages: request.messages, stream: true, usage: { include: true } };
    if (request.parameters?.temperature !== undefined) payload.temperature = request.parameters.temperature;
    if (request.parameters?.top_p !== undefined) payload.top_p = request.parameters.top_p;
    if (request.parameters?.max_tokens !== undefined) payload.max_tokens = request.parameters.max_tokens;
    if (request.parameters?.max_completion_tokens !== undefined) payload.max_completion_tokens = request.parameters.max_completion_tokens;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://openweight.systems", "X-Title": "Openweight" }, body: JSON.stringify(payload), signal: timeoutController.signal });
    } catch (caught) {
      clearTimeout(timeout); request.signal?.removeEventListener("abort", onAbort);
      yield { type: "error", error: request.signal?.aborted ? normalizedProviderError("cancelled") : normalizedProviderError(timeoutController.signal.aborted ? "timeout" : "unavailable") }; return;
    }
    if (!response.ok || !response.body) { clearTimeout(timeout); request.signal?.removeEventListener("abort", onAbort); console.error(`[provider] inference transport failed status=${response.status}`); yield { type: "error", error: errorCode(response.status) }; return; }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let output = ""; let buffer = "";
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
          const text = event.choices?.[0]?.delta?.content;
          if (typeof text === "string" && text) { output += text; yield { type: "delta", text }; }
          if (event.usage) { const cost = typeof event.usage.cost === "number" && Number.isFinite(event.usage.cost) ? BigInt(Math.round(event.usage.cost * 1_000_000)) : null; finalUsage = { type: "complete", output, usage: { inputTokens: safeInteger(event.usage.prompt_tokens), outputTokens: safeInteger(event.usage.completion_tokens), providerCostMicroUsd: cost, uncertain: cost === null } }; }
        }
      }
      if (endedNormally) yield finalUsage;
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

import { openRouterConfig } from "./config";
import type { InferenceChunk, InferenceProvider, InferenceRequest } from "./inference";

export class ProviderUnavailableError extends Error { readonly code = "PROVIDER_UNAVAILABLE"; }

export class OpenRouterProvider implements InferenceProvider {
  async *stream(request: InferenceRequest): AsyncIterable<InferenceChunk> {
    const config = openRouterConfig();
    if (!config.enabled) {
      yield { type: "error", error: { code: "unavailable", message: "Inference provider is not enabled", retryable: false } };
      return;
    }
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://openweight.systems", "X-Title": "Openweight" },
      body: JSON.stringify({ model: request.model, messages: request.messages, stream: true, usage: { include: true } }),
      signal: request.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      console.error(`[openrouter] upstream request failed status=${response.status} model=${request.model} body=${detail.slice(0, 500)}`);
      yield { type: "error", error: { code: response.status === 429 ? "rate_limited" : "upstream", message: "Inference provider request failed", retryable: response.status >= 500 || response.status === 429 } };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let buffer = "";
    let usage: InferenceChunk = { type: "complete", output: "", usage: { inputTokens: null, outputTokens: null, providerCostMicroUsd: null, uncertain: true } };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Buffer across reads: an SSE line may be split across chunk boundaries.
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep the last, possibly-incomplete line for the next read
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let event: { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }; error?: { message?: string; code?: number | string } };
          try {
            event = JSON.parse(raw);
          } catch {
            // A parse failure here means a genuinely malformed event (buffering
            // already handles split lines), so surface it rather than looping.
            console.error(`[openrouter] malformed stream event model=${request.model} raw=${raw.slice(0, 300)}`);
            yield { type: "error", error: { code: "malformed_response", message: "Provider returned an invalid stream event", retryable: true } };
            return;
          }
          if (event.error) {
            console.error(`[openrouter] in-stream error model=${request.model} error=${JSON.stringify(event.error).slice(0, 500)}`);
            yield { type: "error", error: { code: "upstream", message: event.error.message || "Inference provider returned an error", retryable: true } };
            return;
          }
          const text = event.choices?.[0]?.delta?.content ?? "";
          if (text) { output += text; yield { type: "delta", text }; }
          if (event.usage) { const cost = event.usage.cost; usage = { type: "complete", output, usage: { inputTokens: event.usage.prompt_tokens ?? null, outputTokens: event.usage.completion_tokens ?? null, providerCostMicroUsd: typeof cost === "number" ? BigInt(Math.round(cost * 1_000_000)) : null, uncertain: typeof cost !== "number" } }; }
        }
      }
      yield usage;
    } finally { reader.releaseLock(); }
  }

  async health() {
    const config = openRouterConfig();
    if (!config.enabled) return { healthy: false, provider: "openrouter", message: "Provider is not enabled" };
    const response = await fetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` } }).catch(() => null);
    return { healthy: Boolean(response?.ok), provider: "openrouter", message: response?.ok ? undefined : "Provider health check failed" };
  }

  async cancel(_operationKey: string) { return; }
}

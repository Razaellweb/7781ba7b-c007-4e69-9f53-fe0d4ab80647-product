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
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: request.model, messages: request.messages, stream: true, stream_options: { include_usage: true } }),
      signal: request.signal,
    });
    if (!response.ok || !response.body) {
      yield { type: "error", error: { code: response.status === 429 ? "rate_limited" : "upstream", message: "Inference provider request failed", retryable: response.status >= 500 || response.status === 429 } };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let usage: InferenceChunk = { type: "complete", output: "", usage: { inputTokens: null, outputTokens: null, providerCostMicroUsd: null, uncertain: true } };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") continue;
          try {
            const event = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; cost?: number };
            const text = event.choices?.[0]?.delta?.content ?? "";
            if (text) { output += text; yield { type: "delta", text }; }
            if (event.usage) usage = { type: "complete", output, usage: { inputTokens: event.usage.prompt_tokens ?? null, outputTokens: event.usage.completion_tokens ?? null, providerCostMicroUsd: typeof event.cost === "number" ? BigInt(Math.round(event.cost * 1_000_000)) : null, uncertain: typeof event.cost !== "number" } };
          } catch {
            yield { type: "error", error: { code: "malformed_response", message: "Provider returned an invalid stream event", retryable: true } };
            return;
          }
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

/**
 * A single function call emitted by the assistant. `arguments` is the raw JSON
 * string the provider produced, exactly as the OpenAI-compatible contract defines
 * it, so a caller can decide whether it is executable.
 */
export type InferenceToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/**
 * A function tool definition supplied by the caller. Nothing is added here: the
 * shapes are forwarded verbatim (minus unknown keys) so a tool schema the caller
 * never declared can never reach the provider.
 */
export type InferenceToolDefinition = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
};

export type InferenceToolChoice = "none" | "auto" | "required" | { type: "function"; function: { name: string } };

/**
 * An inference message. Assistant messages may carry the tool calls the model
 * requested, and `tool` messages carry the result of one of those calls back to
 * the model. `content` stays a string everywhere so the existing persistence and
 * context paths keep working unchanged.
 */
export type InferenceMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: InferenceToolCall[];
  tool_call_id?: string;
};

export type CompletionParameters = {
  systemPrompt?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  seed?: number;
  stop?: string[];
};

export type InferenceRequest = {
  operationKey: string;
  model: string;
  messages: InferenceMessage[];
  parameters?: CompletionParameters;
  /** Only present when the selected model's synced metadata confirms `tools`. */
  tools?: InferenceToolDefinition[];
  toolChoice?: InferenceToolChoice;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
};

export type InferenceUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  providerCostMicroUsd: bigint | null;
  uncertain: boolean;
};

/**
 * Streaming events yielded by a provider.
 *
 * `delta` carries content only, exactly as before. `tool_calls` is yielded once the
 * upstream stream has ended and carries only COMPLETE tool calls: a fragment with
 * no name, no id, or unparseable arguments is dropped here rather than executed.
 * `complete` is still always the final event, so existing consumers that stop at
 * `complete` keep behaving identically.
 */
export type InferenceChunk =
  | { type: "delta"; text: string }
  | { type: "tool_calls"; toolCalls: InferenceToolCall[] }
  | { type: "complete"; output: string; usage: InferenceUsage }
  | { type: "error"; error: NormalizedProviderError };

export type NormalizedProviderError = {
  code: "cancelled" | "unsupported_model" | "invalid_request" | "authentication" | "rate_limited" | "timeout" | "upstream" | "malformed_response" | "unavailable";
  message: string;
  retryable: boolean;
};

export type ProviderCatalogModel = {
  providerModelId: string;
  contextLength: number | null;
  pricing: Record<string, string>;
  architecture: { inputModalities: string[]; outputModalities: string[] };
  supportedParameters: string[];
};

export type InferenceHealth = { healthy: boolean; message?: "available" | "unavailable" };

export interface InferenceProvider {
  stream(request: InferenceRequest): AsyncIterable<InferenceChunk>;
  catalog(): Promise<ProviderCatalogModel[]>;
  health(): Promise<InferenceHealth>;
  cancel(operationKey: string): Promise<void>;
}

export const PROVIDER_ERRORS: Record<NormalizedProviderError["code"], Omit<NormalizedProviderError, "code">> = {
  cancelled: { message: "Inference was cancelled.", retryable: false },
  unsupported_model: { message: "The selected model is not available.", retryable: false },
  invalid_request: { message: "The inference request could not be accepted.", retryable: false },
  authentication: { message: "Inference is temporarily unavailable.", retryable: false },
  rate_limited: { message: "Inference is busy. Please try again shortly.", retryable: true },
  timeout: { message: "Inference timed out. Please try again.", retryable: true },
  upstream: { message: "Inference could not be completed.", retryable: true },
  malformed_response: { message: "Inference returned an invalid result.", retryable: true },
  unavailable: { message: "Inference is temporarily unavailable.", retryable: true },
};

export function normalizedProviderError(code: NormalizedProviderError["code"]): NormalizedProviderError {
  return { code, ...PROVIDER_ERRORS[code] };
}

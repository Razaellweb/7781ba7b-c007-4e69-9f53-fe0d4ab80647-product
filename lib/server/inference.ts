export type InferenceMessage = { role: "system" | "user" | "assistant"; content: string };

export type CompletionParameters = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
};

export type InferenceRequest = {
  operationKey: string;
  model: string;
  messages: InferenceMessage[];
  parameters?: CompletionParameters;
  signal?: AbortSignal;
  metadata?: Record<string, string>;
};

export type InferenceUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  providerCostMicroUsd: bigint | null;
  uncertain: boolean;
};

export type InferenceChunk =
  | { type: "delta"; text: string }
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

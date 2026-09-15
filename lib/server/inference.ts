export type InferenceMessage = { role: "system" | "user" | "assistant"; content: string };
export type InferenceRequest = { operationKey: string; model: string; messages: InferenceMessage[]; signal?: AbortSignal; metadata?: Record<string, string> };
export type InferenceUsage = { inputTokens: number | null; outputTokens: number | null; providerCostMicroUsd: bigint | null; uncertain: boolean };
export type InferenceChunk = { type: "delta"; text: string } | { type: "complete"; output: string; usage: InferenceUsage } | { type: "error"; error: NormalizedProviderError };
export type NormalizedProviderError = { code: "unsupported_model" | "invalid_request" | "authentication" | "rate_limited" | "timeout" | "upstream" | "malformed_response" | "unavailable"; message: string; retryable: boolean };
export interface InferenceProvider { stream(request: InferenceRequest): AsyncIterable<InferenceChunk>; health(): Promise<{ healthy: boolean; provider: string; message?: string }>; cancel(operationKey: string): Promise<void>; }

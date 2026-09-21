import type { InferenceHealth, InferenceProvider } from "./inference";
import { OpenRouterProvider } from "./openrouter";

// Product-facing inference code depends on this abstraction. Provider credentials
// and provider-specific identifiers remain inside the implementation boundary.
// OpenRouterProvider preserves the InferenceProvider contract for app streaming,
// catalog synchronization, and the API gateway callers.
export function getInferenceProvider(): InferenceProvider {
  return new OpenRouterProvider();
}

export async function getInferenceHealth(): Promise<InferenceHealth> {
  return getInferenceProvider().health();
}
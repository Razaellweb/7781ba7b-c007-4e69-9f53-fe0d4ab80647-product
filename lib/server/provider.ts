import type { InferenceHealth, InferenceProvider } from "./inference";
import { OpenRouterProvider } from "./openrouter";

// Product-facing inference code depends on this abstraction. Provider credentials
// and provider-specific identifiers remain inside the implementation boundary.
export function getInferenceProvider(): InferenceProvider {
  return new OpenRouterProvider();
}

export async function getInferenceHealth(): Promise<InferenceHealth> {
  return getInferenceProvider().health();
}

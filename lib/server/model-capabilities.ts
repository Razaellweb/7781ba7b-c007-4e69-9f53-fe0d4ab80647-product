// Model feature metadata, derived from the verified OpenRouter catalog the sync in
// lib/server/models.ts already persists into `models.provider_metadata`.
//
// Three states are kept deliberately distinct, because a card must never claim a
// feature the provider has not confirmed:
//
//   supported   - the provider catalog lists the feature for this identifier
//   unsupported - the provider catalog was read and does NOT list the feature
//   unknown     - no verified metadata exists, so nothing is claimed either way
//
// "unknown" is rendered as N/A (or hidden), never as support and never as an
// explicit lack of support.

export type CapabilityState = "supported" | "unsupported" | "unknown";

// Where the numbers on screen came from. "cached" means the last successful
// provider sync is being reused because the live catalog could not be reached, so
// browsing keeps working without inventing fresh data.
export type CapabilitySource = "provider" | "cached" | "none";

export type ContextWindow = { tokens: number | null; label: string | null };

export type ModelCapabilities = {
  contextWindow: ContextWindow;
  tools: CapabilityState;
  vision: CapabilityState;
  source: CapabilitySource;
};

export type CapabilityInput = {
  /** Provider-reported context length, falling back to the registry column. */
  contextLength: number | null;
  /** Provider input modalities, or null when no verified metadata exists. */
  inputModalities: string[] | null;
  /** Provider supported request parameters, or null when unverified. */
  supportedParameters: string[] | null;
  /** True when any verified provider metadata row is present for the model. */
  metadataPresent: boolean;
  /** models.provider_sync_status for the row. */
  syncStatus: string | null;
  /** provider_metadata.availability for the row. */
  availability: string | null;
};

// Concise, readable context window: 32768 -> "32k", 128000 -> "128k",
// 1048576 -> "1M". Returns null when there is no authoritative token count.
//
// Familiar binary-ish sizes (32_768 = 32 x 1024) read best in KiB, while round
// vendor figures (128_000) read best in decimal thousands. A value that is a
// multiple of both is treated as decimal, which is what vendor docs quote.
export function formatContextWindow(tokens: number | null | undefined): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const rounded = millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1));
    return `${rounded}M`;
  }
  const binary = tokens % 1024 === 0 && tokens % 1000 !== 0 ? tokens / 1024 : tokens / 1000;
  return `${Math.max(1, Math.round(binary))}k`;
}

function stateFromList(values: string[] | null, needles: string[]): CapabilityState {
  if (values === null) return "unknown";
  const normalized = values.map((value) => value.toLowerCase());
  return needles.some((needle) => normalized.includes(needle)) ? "supported" : "unsupported";
}

export function capabilitySource(input: Pick<CapabilityInput, "metadataPresent" | "syncStatus" | "availability">): CapabilitySource {
  if (!input.metadataPresent) return "none";
  return input.syncStatus === "current" && input.availability === "available" ? "provider" : "cached";
}

export function deriveCapabilities(input: CapabilityInput): ModelCapabilities {
  const contextLength = typeof input.contextLength === "number" && input.contextLength > 0 ? input.contextLength : null;
  return {
    contextWindow: { tokens: contextLength, label: formatContextWindow(contextLength) },
    // Function calling is advertised upstream as the `tools` request parameter.
    tools: stateFromList(input.supportedParameters, ["tools"]),
    // Image input is an architecture input modality, not a parameter.
    vision: stateFromList(input.inputModalities, ["image"]),
    source: capabilitySource(input),
  };
}

/** Human copy for a capability row. Missing metadata reads as N/A. */
export function describeCapability(state: CapabilityState | null | undefined): string {
  if (state === "supported") return "Supported";
  if (state === "unsupported") return "Not supported";
  return "N/A";
}

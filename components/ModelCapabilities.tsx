"use client";

// Model feature metadata, rendered the way the workspace already labels things:
// small mono micro-labels on a hairline, never badges that shout.
//
// Three states are surfaced honestly — confirmed support, confirmed absence, and
// metadata that simply is not available. Missing metadata renders "N/A"; it is
// never promoted to "supported" and never presented as a confirmed limitation.

type CapabilityState = "supported" | "unsupported" | "unknown";
type CapabilitySource = "provider" | "cached" | "none";

export type CapabilityModel = {
  contextWindowLabel?: string | null;
  contextLength?: number | null;
  toolsSupport?: CapabilityState | null;
  visionSupport?: CapabilityState | null;
  capabilitySource?: CapabilitySource | null;
};

// 1048576 -> "1M", 32768 -> "32k", 128000 -> "128k". Mirrors
// lib/server/model-capabilities.ts so a client-side fallback never disagrees with
// the API's own label.
export function contextWindowLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const rounded = millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1));
    return `${rounded}M`;
  }
  const binary = value % 1024 === 0 && value % 1000 !== 0 ? value / 1024 : value / 1000;
  return `${Math.max(1, Math.round(binary))}k`;
}

const stateClass = (state: CapabilityState | null | undefined) => state === "supported" ? "is-on" : state === "unsupported" ? "is-off" : "is-unknown";
const stateTitle = (label: string, state: CapabilityState | null | undefined) => state === "supported" ? `${label}: supported by this model` : state === "unsupported" ? `${label}: not supported by this model` : `${label}: metadata unavailable`;

function FeatureChip({ label, state }: { label: string; state: CapabilityState | null | undefined }) {
  return <span className={`capability-chip ${stateClass(state)}`} title={stateTitle(label, state)}>
    <i aria-hidden="true" />
    {label}
    {state === "unknown" && <em>N/A</em>}
  </span>;
}

/** Compact indicator row used on model cards and the Playground model row. */
export default function ModelCapabilities({ model, className }: { model: CapabilityModel | null | undefined; className?: string }) {
  if (!model) return null;
  const context = model.contextWindowLabel?.trim() || contextWindowLabel(model.contextLength);
  return <span className={`model-capabilities ${className ?? ""}`.trim()}>
    <span className="capability-chip is-context" title={context ? `Context window: ${context} tokens` : "Context window: metadata unavailable"}>
      {context ?? <><span>Context</span><em>N/A</em></>}
    </span>
    <FeatureChip label="Tools" state={model.toolsSupport} />
    <FeatureChip label="Vision" state={model.visionSupport} />
    {model.capabilitySource === "cached" && <span className="capability-chip is-cached" title="The live provider catalog could not be reached; the last verified metadata is shown.">Cached</span>}
  </span>;
}

/** Detail surface text for a single feature, e.g. in the model modal. */
export function capabilityText(state: CapabilityState | null | undefined): string {
  if (state === "supported") return "Supported";
  if (state === "unsupported") return "Not supported";
  return "N/A";
}

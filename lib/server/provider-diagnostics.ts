import { modelHealthConfig, providerConfigurationGap, vastLifecycleConfig, type InferenceProviderId } from "./config";
import type { InferenceStatus } from "./inference";
import { listProviderHealth } from "./provider";
import { diagnoseVastMarketplace, type VastMarketplaceDiagnosis } from "./vast";

// Provider diagnostics for the workspace (READ-ONLY).
//
// Why this exists: every workspace surface (Overview cards, Playground selector,
// API gateway) degrades to "unavailable" when the active provider is not usable,
// and that is indistinguishable from "the product is broken". The single most
// common cause is a credential that was added under a name the server does not
// read, or an endpoint the deployment cannot reach. This module reports exactly
// that, in normalized form, so the UI can name the fix.
//
// Nothing credential-shaped crosses this boundary. Reported fields are:
//   - which environment VARIABLE supplied the vast.ai key (never the value),
//   - whether the provider has an endpoint / bearer token configured,
//   - each candidate host's reachability outcome and latency,
//   - how many offers/models are visible,
//   - the active provider's normalized health status.
//
// All of it is derived from configuration presence and read-only HTTP GETs. No
// request here rents, stops, or mutates anything.

export type DiagnosticsCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What to do about it, when it is not ok. */
  fix: string | null;
};

export type ProviderDiagnostics = {
  activeProvider: InferenceProviderId;
  inferenceStatus: InferenceStatus;
  /** True when inference can accept a turn right now. */
  inferenceReady: boolean;
  /** True when the GPU marketplace answered with offers. */
  marketplaceReady: boolean;
  marketplace: VastMarketplaceDiagnosis;
  checks: DiagnosticsCheck[];
  /** Short operator summary for the page header. */
  summary: string;
  checkedAt: string;
};

/** The empty diagnosis used when the marketplace probe itself fails to run. */
function emptyMarketplace(hint: string): VastMarketplaceDiagnosis {
  return {
    config: { configured: false, keyVariable: null, acceptedKeyVariables: [], hosts: [], activeHost: null },
    attempts: [],
    healthyHost: null,
    offersVisible: 0,
    modelsVisible: 0,
    latencyMs: null,
    reachable: false,
    hint,
  };
}

/** Health of the active provider, normalized. Never throws. */
async function activeInferenceHealth(): Promise<{ provider: InferenceProviderId; status: InferenceStatus; healthy: boolean }> {
  try {
    const report = await listProviderHealth();
    const active = report.providers.find((entry) => entry.id === report.active);
    const status: InferenceStatus = active?.health.status ?? (active?.health.healthy ? "operational" : "unavailable");
    return { provider: report.active, status, healthy: Boolean(active?.health.healthy) };
  } catch {
    return { provider: "openrouter", status: "unavailable", healthy: false };
  }
}

function hostLabel(host: string): string {
  try { return new URL(host).host; } catch { return host; }
}

export async function readProviderDiagnostics(): Promise<ProviderDiagnostics> {
  const [marketplace, inference] = await Promise.all([
    // The marketplace probe is independent of the inference provider: an operator
    // checking the GPUs page wants to know whether browsing works even when
    // inference is served by OpenRouter.
    diagnoseVastMarketplace().catch(() => emptyMarketplace("The marketplace diagnostic could not run.")),
    activeInferenceHealth(),
  ]);

  const checks: DiagnosticsCheck[] = [];

  // 1. Marketplace credential presence. This is the check that says, in words,
  //    which variable to add — the exact gap the UI could not express before.
  if (marketplace.attempts.length > 0 || marketplace.config.hosts.length > 0) {
    checks.push({
      id: "vast_key",
      label: "vast.ai API key",
      status: marketplace.config.configured ? "ok" : "fail",
      detail: marketplace.config.configured
        ? `Read from ${marketplace.config.keyVariable} (the value never leaves the server).`
        : "No server-side vast.ai API key is configured, so the marketplace cannot be read.",
      fix: marketplace.config.configured
        ? null
        : `Add the vast.ai account API key as ${marketplace.config.acceptedKeyVariables[0]} in the deployment environment, then redeploy. Accepted names: ${marketplace.config.acceptedKeyVariables.join(", ")}.`,
    });
  }

  // 2. Marketplace reachability, per host. "Could not reach the offers service"
  //    is a DNS/egress fact, not a product bug, and it is now visible as one.
  const reachableAttempt = marketplace.attempts.find((attempt) => attempt.outcome === "ok");
  if (marketplace.attempts.length > 0) {
    checks.push({
      id: "vast_reachability",
      label: "Marketplace endpoint",
      status: reachableAttempt ? "ok" : "fail",
      detail: reachableAttempt
        ? `Answered via ${hostLabel(reachableAttempt.host)} in ${reachableAttempt.latencyMs ?? 0} ms.`
        : marketplace.attempts.map((attempt) => `${hostLabel(attempt.host)}: ${attempt.reason ?? attempt.outcome}`).join(" · "),
      fix: reachableAttempt ? null : "Confirm the deployment allows outbound HTTPS to console.vast.ai and cloud.vast.ai.",
    });
  }

  // 3. Offer visibility. Reaching the API with a valid key but seeing no offers is
  //    a marketplace/account state, which is materially different from an outage.
  if (reachableAttempt) {
    checks.push({
      id: "vast_offers",
      label: "Visible offers",
      status: marketplace.offersVisible > 0 ? "ok" : "warn",
      detail: marketplace.offersVisible > 0
        ? `${marketplace.offersVisible} rentable verified offers across ${marketplace.modelsVisible} GPU models.`
        : "The API accepted the key but returned no rentable verified offers.",
      fix: marketplace.offersVisible > 0 ? null : "This is a marketplace state. Refresh shortly and confirm the vast.ai account has billing enabled.",
    });
  }

  // 4. Inference provider configuration. Named gaps only — the same list the
  //    startup preflight would print, surfaced where an operator can act on it.
  const gap = providerConfigurationGap(inference.provider);
  const providerLabel = inference.provider === "vast" ? "vast.ai" : "OpenRouter";
  checks.push({
    id: "inference_config",
    label: `Inference provider (${providerLabel})`,
    status: gap.configured ? "ok" : "fail",
    detail: gap.configured ? "Configured on the server." : `Not fully configured. Missing: ${gap.missing.join(", ") || "unknown"}.`,
    fix: gap.configured ? null : `Set ${gap.missing.join(", ") || "the provider configuration"} (INFERENCE_PROVIDER=${inference.provider === "vast" ? "vastai" : "openrouter"}).`,
  });

  // 5. Inference health, from the same normalized contract requests use.
  checks.push({
    id: "inference_health",
    label: "Inference health",
    status: inference.status === "operational" ? "ok" : inference.status === "degraded" ? "warn" : "fail",
    detail: inference.status === "operational"
      ? "The active provider answered its models probe."
      : inference.status === "degraded"
        ? "The provider answered, but no model instance is warm; the next turn pays a cold start."
        : "The active provider did not answer, so inference cannot accept a turn.",
    fix: inference.status === "unavailable"
      ? (gap.missing.length > 0 ? `Set ${gap.missing.join(", ")}, then redeploy.` : "Check the provider endpoint is reachable from the server and the instance is running.")
      : null,
  });

  // 6. Registry refresh window, so "the cards will update" is a stated interval
  //    rather than an indefinite "soon".
  let refreshSeconds = 60;
  try { refreshSeconds = modelHealthConfig().refreshIntervalSeconds; } catch { refreshSeconds = 60; }
  let lifecycleEnabled = false;
  try { lifecycleEnabled = vastLifecycleConfig().enabled; } catch { lifecycleEnabled = false; }
  checks.push({
    id: "refresh_window",
    label: "Availability refresh",
    status: "ok",
    detail: `Model availability and the provider badge refresh every ${refreshSeconds}s${lifecycleEnabled ? "; a cold vast.ai machine is rented on demand" : ""}.`,
    fix: null,
  });

  const failing = checks.filter((check) => check.status === "fail").length;
  const warning = checks.filter((check) => check.status === "warn").length;
  const summary = failing > 0
    ? `${failing} configuration or connectivity ${failing === 1 ? "check needs" : "checks need"} attention.`
    : warning > 0
      ? "Everything is configured; the marketplace or a model instance is still warming."
      : "All provider checks passed.";

  return {
    activeProvider: inference.provider,
    inferenceStatus: inference.status,
    inferenceReady: inference.healthy,
    marketplaceReady: Boolean(reachableAttempt) && marketplace.offersVisible > 0,
    marketplace,
    checks,
    summary,
    checkedAt: new Date().toISOString(),
  };
}

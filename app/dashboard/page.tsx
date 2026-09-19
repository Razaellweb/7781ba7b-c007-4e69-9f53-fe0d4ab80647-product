"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import "./dashboard.css";

type Eligibility = "loading" | "eligible" | "insufficient_balance" | "wrong_network" | "verification_error" | "unauthenticated";
type LoadState = "idle" | "loading" | "ready" | "error";
type Activity = { operation_key: string; model: string; status: string; input_tokens: number | null; output_tokens: number | null; user_debit_micro_usd: string | null; created_at: string };
type Model = {
  id: string;
  displayName: string;
  family: string | null;
  featured: boolean;
  registryStatus: string;
  provider: string;
  contextLength: number | null;
  canonicalProviderModelId: string | null;
  pricing: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  availability: "available" | "unavailable" | "stale";
  syncStatus: string;
};

const clampMicroUsd = (micro: string | null | undefined) => {
  try {
    const value = BigInt(micro ?? "0");
    return value > 0n ? value : 0n;
  } catch {
    return 0n;
  }
};

const formatMicroUsd = (micro: string | null | undefined) => {
  const value = clampMicroUsd(micro);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `$${whole.toString()}.${fraction}`;
};

const compactUsd = (micro: string | null | undefined) => micro == null ? "—" : formatMicroUsd(micro);
const providerUsd = (value: string | undefined) => {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return `$${(Number(value) * 1_000_000).toFixed(2)}`;
};
const contextLabel = (value: number | null) => {
  if (value == null || value <= 0) return null;
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M tokens` : `${Math.round(value / 1000)}K tokens`;
};
const relativeTime = (iso: string) => {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

function StatusPanel({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="compute-status-panel"><span className="compute-status-mark">×</span><div><h2>{title}</h2><p>{body}</p>{action}</div></div>;
}

function ModelCard({ model, canUse, onOpen }: { model: Model; canUse: boolean; onOpen: (model: Model) => void }) {
  const operational = model.availability === "available" && model.syncStatus === "current" && model.registryStatus === "active";
  const input = providerUsd(model.pricing.prompt);
  const output = providerUsd(model.pricing.completion);
  const cached = providerUsd(model.pricing.input_cache_read);
  const tags = [...new Set([...model.inputModalities, ...model.outputModalities, ...model.supportedParameters])].slice(0, 5);
  const statusLabel = model.registryStatus === "paused" ? "Paused" : model.availability === "stale" ? "Stale metadata" : model.availability === "unavailable" ? "Unavailable" : operational ? "Operational" : "Not ready";
  const statusClass = operational ? "" : model.registryStatus === "paused" ? "paused" : "unavailable";
  return <button type="button" className={`compute-model-card ${!operational || !canUse ? "is-gated" : ""}`} onClick={() => onOpen(model)} aria-label={`View details for ${model.displayName}`}>
    <div className="model-card-top"><span className="model-glyph">{(model.family || model.displayName).slice(0, 2).toUpperCase()}</span><span className={`model-status ${statusClass}`}><i /> {statusLabel}</span></div>
    <h3>{model.displayName}</h3>
    {model.family && <p>{model.family}</p>}
    {model.canonicalProviderModelId && <code className="model-provider-id">{model.canonicalProviderModelId}</code>}
    {(input || output || cached) && <div className="model-pricing"><span>{input && `Input ${input} / 1M`}</span><span>{output && `Output ${output} / 1M`}</span><span>{cached && `Cached input ${cached} / 1M`}</span></div>}
    {(contextLabel(model.contextLength) || tags.length > 0) && <div className="model-tags">{contextLabel(model.contextLength) && <span className="model-tag">{contextLabel(model.contextLength)}</span>}{tags.map((tag) => <span className="model-tag" key={tag}>{tag}</span>)}</div>}
    <span className="model-card-action">View model details <span aria-hidden="true">↗</span></span>
  </button>;
}

function ModelDetails({ model, canUse, onClose, onUse, onCopy }: { model: Model; canUse: boolean; onClose: () => void; onUse: () => void; onCopy: () => void }) {
  const operational = model.availability === "available" && model.syncStatus === "current" && model.registryStatus === "active";
  const statusLabel = model.registryStatus === "paused" ? "Paused" : model.availability === "stale" ? "Stale metadata" : model.availability === "unavailable" ? "Unavailable" : operational ? "Operational" : "Not ready";
  const input = providerUsd(model.pricing.prompt);
  const output = providerUsd(model.pricing.completion);
  const cached = providerUsd(model.pricing.input_cache_read);
  const tags = [...new Set([...model.inputModalities, ...model.outputModalities, ...model.supportedParameters])];
  return <div className="model-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-details-title">
      <header className="model-modal-header"><div><div className="compute-card-label">CURATED MODEL</div><h2 id="model-details-title">{model.displayName}</h2></div><button type="button" className="model-modal-close" onClick={onClose} aria-label="Close model details">×</button></header>
      <div className="model-modal-body">
        <div className="model-detail-status"><span className={`model-status ${operational ? "" : "unavailable"}`}><i /> {statusLabel}</span>{model.provider && <span className="model-detail-access">Access · curated {model.provider}</span>}</div>
        {model.canonicalProviderModelId && <div className="model-id-block"><span className="model-detail-label">CANONICAL PROVIDER ID</span><div className="model-id-row"><code>{model.canonicalProviderModelId}</code><button type="button" onClick={onCopy}>Copy ID</button></div></div>}
        <div className="model-detail-grid">
          {(input || output || cached) && <div className="model-detail-group"><h3>Pricing <small>per 1M tokens</small></h3>{input && <p><span>Input</span><b>{input}</b></p>}{output && <p><span>Output</span><b>{output}</b></p>}{cached && <p><span>Cached input</span><b>{cached}</b></p>}</div>}
          {(contextLabel(model.contextLength) || tags.length > 0) && <div className="model-detail-group"><h3>Capabilities</h3>{contextLabel(model.contextLength) && <p><span>Context window</span><b>{contextLabel(model.contextLength)}</b></p>}{tags.length > 0 && <div className="model-detail-tags">{tags.map((tag) => <span className="model-tag" key={tag}>{tag}</span>)}</div>}</div>}
        </div>
        <div className="model-modal-footer">{!canUse ? <p className="model-modal-note">Insufficient compute allowance. Add available compute before selecting a model.</p> : !operational ? <p className="model-modal-note">This model is not currently operational. Refresh before trying again.</p> : <button type="button" className="model-use-button" onClick={onUse}>Use this model in chat <span aria-hidden="true">→</span></button>}</div>
      </div>
    </section>
  </div>;
}

export default function DashboardPage() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const router = useRouter();
  const [eligibility, setEligibility] = useState<Eligibility>("loading");
  const [wallet, setWallet] = useState("");
  const [balanceMicroUsd, setBalanceMicroUsd] = useState("0");
  const [models, setModels] = useState<Model[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [computeState, setComputeState] = useState<LoadState>("idle");
  const [modelsState, setModelsState] = useState<LoadState>("idle");
  const [notice, setNotice] = useState("");
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");

  const authHeaders = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("No authenticated token");
    return { Authorization: `Bearer ${token}` };
  }, [getAccessToken]);

  const loadData = useCallback(async () => {
    if (!authenticated) { setEligibility("unauthenticated"); return; }
    setEligibility("loading"); setComputeState("loading"); setModelsState("loading"); setNotice("");
    try {
      const headers = await authHeaders();
      const accountResponse = await fetch("/api/account", { headers, cache: "no-store" });
      if (!accountResponse.ok) throw new Error("ACCOUNT_UNAVAILABLE");
      const account = await accountResponse.json() as { account: { walletAddress: string } };
      setWallet(account.account.walletAddress);
      const verificationResponse = await fetch("/api/holder/verify", { method: "POST", headers });
      if (!verificationResponse.ok) { setEligibility(verificationResponse.status === 401 ? "unauthenticated" : "verification_error"); setComputeState("idle"); setModelsState("idle"); return; }
      const verification = await verificationResponse.json() as { eligibility: { state: string } };
      if (verification.eligibility.state !== "eligible") {
        setEligibility(verification.eligibility.state === "insufficient_balance" ? "insufficient_balance" : verification.eligibility.state === "wrong_wallet" ? "wrong_network" : "verification_error");
        setComputeState("idle"); setModelsState("idle"); return;
      }
      setEligibility("eligible");
      const [allowanceResponse, activityResponse, modelsResponse] = await Promise.all([
        fetch("/api/allowance", { headers, cache: "no-store" }),
        fetch("/api/activity", { headers, cache: "no-store" }),
        fetch("/api/models", { headers, cache: "no-store" }),
      ]);
      if (!allowanceResponse.ok || !activityResponse.ok) setComputeState("error");
      else {
        const allowance = await allowanceResponse.json() as { balance?: { available?: string } };
        const activityData = await activityResponse.json() as { activity?: Activity[] };
        setBalanceMicroUsd(allowance.balance?.available ?? "0");
        setActivity(activityData.activity ?? []); setComputeState("ready");
      }
      if (!modelsResponse.ok) setModelsState("error");
      else { const modelData = await modelsResponse.json() as { models?: Model[] }; setModels(modelData.models ?? []); setModelsState("ready"); }
    } catch {
      setEligibility((current) => current === "loading" ? "verification_error" : current);
      setComputeState("error"); setModelsState("error");
      setNotice("The access layer is temporarily unavailable. Retry to request a fresh verification.");
    }
  }, [authenticated, authHeaders]);

  const closeModelDetails = useCallback(() => { setSelectedModel(null); setCopyFeedback(""); }, []);
  const copyModelId = useCallback(async () => {
    if (!selectedModel?.canonicalProviderModelId) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(selectedModel.canonicalProviderModelId);
      setCopyFeedback("Copied");
    } catch {
      setCopyFeedback("Copy unavailable — select the ID above to copy it manually.");
    }
  }, [selectedModel]);
  const useSelectedModel = useCallback(async () => {
    if (!selectedModel || eligibility !== "eligible" || clampMicroUsd(balanceMicroUsd) <= 0n) return;
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/models", { headers, cache: "no-store" });
      if (!response.ok) throw new Error("MODELS_UNAVAILABLE");
      const data = await response.json() as { models?: Model[] };
      const latest = data.models?.find((model) => model.id === selectedModel.id);
      const operational = latest && latest.availability === "available" && latest.syncStatus === "current" && latest.registryStatus === "active";
      if (!operational) {
        setSelectedModel(latest ?? { ...selectedModel, availability: "unavailable", syncStatus: "unavailable" });
        setNotice("This model is no longer available. No billable request was started.");
        return;
      }
      closeModelDetails();
      router.push(`/chat?model=${encodeURIComponent(latest.id)}`);
    } catch {
      setNotice("Model availability could not be confirmed. No billable request was started.");
    }
  }, [authHeaders, balanceMicroUsd, closeModelDetails, eligibility, router, selectedModel]);

  useEffect(() => { if (ready && !authenticated) router.replace("/signup"); }, [ready, authenticated, router]);
  useEffect(() => { if (ready && authenticated) void loadData(); }, [ready, authenticated, loadData]);
  useEffect(() => {
    if (!selectedModel) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeModelDetails(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeModelDetails, selectedModel]);

  if (!ready || !authenticated) return <main className="dashboard-gate"><div className="gate-inner"><span className="mark large">✦</span><p>{ready ? "Redirecting to sign in…" : "Verifying your session…"}</p></div></main>;

  const statusLabel: Record<Eligibility, string> = { loading: "VERIFYING", eligible: "ELIGIBLE", insufficient_balance: "NOT ELIGIBLE", wrong_network: "WRONG NETWORK", verification_error: "AUTH DEGRADED", unauthenticated: "AUTH REQUIRED" };
  const gated = eligibility !== "eligible";
  const hasDataError = computeState === "error" || modelsState === "error";
  const balanceAvailable = clampMicroUsd(balanceMicroUsd) > 0n;

  return <main className="compute-dashboard">
    <aside className="compute-sidebar"><div className="compute-brand"><span className="mark">✦</span><span>OPENWEIGHT</span></div><div className="compute-eyebrow">OPEN-WEIGHT FRONTIER</div><nav><a className="active" href="#overview">◉ <span>Overview</span></a><a href="/chat">◌ <span>Chat workflow</span></a><a href="/compute">◈ <span>Activity</span></a></nav><div className="compute-sidebar-foot"><div><span className={`compute-dot ${gated ? "muted" : ""}`} /> {statusLabel[eligibility]}</div><small>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Canonical wallet pending"}</small><button onClick={() => void logout()}>Sign out ↗</button></div></aside>
    <section className="compute-main" id="overview"><header className="compute-header"><div><div className="compute-eyebrow">WORKSPACE / COMPUTE LAYER</div><h1>Compute, kept<br/><em>in view.</em></h1><p>A clear allowance and a deliberate set of open-weight models, ready when your verified access is active.</p></div><div className="compute-header-actions"><span className={`compute-access ${gated ? "degraded" : ""}`}><i /> {statusLabel[eligibility]}</span><button onClick={() => void loadData()}>Refresh ↻</button></div></header>
      {gated ? <StatusPanel title={eligibility === "insufficient_balance" ? "Holder access is paused" : eligibility === "wrong_network" ? "Verify on the configured network" : eligibility === "loading" ? "Checking access" : eligibility === "unauthenticated" ? "Authentication required" : "Verification is delayed"} body={eligibility === "insufficient_balance" ? "A qualifying balance is required before compute and model information can be shown." : eligibility === "wrong_network" ? "Switch to the configured wallet and network, then retry verification." : eligibility === "loading" ? "We are checking your authenticated account and holder status." : eligibility === "unauthenticated" ? "Sign in again to verify access to this workspace." : "The verification service did not respond. Your access remains paused until it completes."} action={<button className="compute-retry" onClick={() => void loadData()}>Retry verification ↻</button>} /> : computeState === "loading" || modelsState === "loading" ? <StatusPanel title="Loading compute allowance" body="Fetching your current server ledger balance and approved model catalog. No inference access is assumed until the balance is confirmed." /> : hasDataError ? <StatusPanel title="Workspace data is unavailable" body="Compute and model information could not be loaded from the server. No balance or catalog is shown until the data is authoritative." action={<button className="compute-retry" onClick={() => void loadData()}>Retry loading ↻</button>} /> : <>
        <section className={`compute-overview-grid ${balanceAvailable ? "" : "compute-overview-insufficient"}`}><article className="compute-balance-card"><div className="compute-card-label">REMAINING COMPUTE ALLOWANCE</div><strong>{formatMicroUsd(balanceMicroUsd)}</strong><p>{balanceAvailable ? "Available internal USD compute · actual provider cost" : "Zero / insufficient compute · inference is not authorized"}</p><div className="compute-balance-rule"><span /> <small>{balanceAvailable ? "Server ledger balance · reservations reflected" : "Add available allowance before starting inference"}</small></div></article><article className="compute-note-card"><div className="compute-card-label">HOW IT WORKS</div><h2>One allowance.<br/><em>No provider setup.</em></h2><p>Choose from the curated registry or continue through the existing chat workflow. Provider credentials never enter your journey.</p></article></section>
        <section className="compute-section"><div className="compute-section-head"><div><div className="compute-card-label">APPROVED OPEN-WEIGHT MODELS</div><h2>Discover a model for the work.</h2>{!balanceAvailable && <p className="compute-insufficient-note">Catalog shown for reference only. Inference stays unavailable until compute is available.</p>}</div><a href="/models">View registry ↗</a></div>{models.length === 0 ? <div className="models-empty">No approved active models are available right now. Refresh to check the curated registry again.</div> : <div className="compute-model-grid">{models.map((model) => <ModelCard key={model.id} model={model} canUse={balanceAvailable} onOpen={setSelectedModel} />)}</div>}</section>
        <section className="compute-section activity-section"><div className="compute-section-head"><div><div className="compute-card-label">RECENT USAGE</div><h2>Compute activity</h2></div><a href="/compute">Full activity ↗</a></div>{activity.length === 0 ? <p className="compute-empty">No settled compute activity yet.</p> : <div className="compute-activity-list">{activity.slice(0, 4).map((item) => <div className="compute-activity-row" key={item.operation_key}><span className="activity-status"><i /></span><span><b>{item.model}</b><small>{relativeTime(item.created_at)} · {item.input_tokens ?? "—"} in / {item.output_tokens ?? "—"} out</small></span><strong>{compactUsd(item.user_debit_micro_usd)}</strong></div>)}</div>}</section>
      </>}{notice && <p className="compute-notice" role="status">{notice}</p>}</section>
    {selectedModel && <ModelDetails model={selectedModel} canUse={balanceAvailable && eligibility === "eligible"} onClose={closeModelDetails} onUse={() => void useSelectedModel()} onCopy={() => void copyModelId()} />}
    {copyFeedback && selectedModel && <div className="model-copy-feedback" role="status">{copyFeedback}</div>}
  </main>;
}
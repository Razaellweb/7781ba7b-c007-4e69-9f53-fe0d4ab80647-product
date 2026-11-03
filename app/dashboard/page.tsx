"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import WorkspaceShell from "../../components/WorkspaceShell";
import ModelLogo from "../../components/ModelLogo";
import ModelCapabilities, { capabilityText, contextWindowLabel, type CapabilityModel } from "../../components/ModelCapabilities";
import "./dashboard.css";
import "./dashboard-overview.css";

type SessionState = "loading" | "ready" | "error" | "unauthenticated";
type LoadState = "idle" | "loading" | "ready" | "error";
type Activity = { operation_key: string; model: string; status: string; input_tokens: number | null; output_tokens: number | null; user_debit_micro_usd: string | null; created_at: string };
type Model = CapabilityModel & { id: string; displayName: string; description?: string | null; family: string | null; featured: boolean; registryStatus: string; provider: string; providerLabel?: string | null; providerModelSlug: string; sourceUrl: string | null; contextLength: number | null; pricing: Record<string, string> | null; architecture: { inputModalities: string[]; outputModalities: string[] } | null; supportedParameters: string[] | null; licenseStatus: string; providerTermsStatus: string; availability: "available" | "unavailable" | "stale"; syncStatus: string };
type AccountResponse = { account: { walletAddress: string | null } };
type AllowanceResponse = { balance?: { available?: string }; allowance?: { amount_micro_usd?: string; period_end?: string } | null };

const clampMicroUsd = (micro: string | null | undefined) => { try { const value = BigInt(micro ?? "0"); return value > 0n ? value : 0n; } catch { return 0n; } };
// Cents for normal amounts ("$100.00"), rounded down so a balance is never
// overstated; sub-cent amounts (a single request) keep micro-dollar precision.
const formatMicroUsd = (micro: string | null | undefined) => { const value = clampMicroUsd(micro); if (value > 0n && value < 10_000n) return `$0.${value.toString().padStart(6, "0").replace(/0+$/, "")}`; const cents = value / 10_000n; return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`; };
const compactUsd = (micro: string | null | undefined) => micro == null ? "—" : formatMicroUsd(micro);
const relativeTime = (iso: string) => { const timestamp = new Date(iso).getTime(); if (Number.isNaN(timestamp)) return ""; const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago`; };
const unavailable = "Unavailable";
// Missing feature metadata is reported as N/A, never as unsupported.
const notAvailable = "N/A";
const pricingValue = (pricing: Record<string, string> | null, keys: string[]) => { const key = keys.find((candidate) => pricing?.[candidate] != null); const numeric = key ? Number(pricing?.[key]) : NaN; return Number.isFinite(numeric) && numeric >= 0 ? `$${(numeric * 1_000_000).toFixed(2)} / 1M tokens` : null; };
const operational = (model: Model) => model.registryStatus === "active" && model.syncStatus === "current" && model.availability === "available";
const statusLabel = (model: Model) => model.registryStatus === "paused" ? "Paused" : model.availability === "stale" || model.syncStatus === "stale" ? "Metadata stale" : model.availability === "unavailable" || model.syncStatus === "unavailable" || model.syncStatus === "never" ? "Unavailable" : operational(model) ? "Available" : model.registryStatus.replaceAll("_", " ");
const creatorLabel = (model: Model) => model.providerLabel?.trim() || model.family?.trim() || model.provider;
// Cards carry a one-line, plain-language description rather than raw provider
// metadata. Long names and descriptions wrap inside the card.
const cardSummary = (model: Model) => {
  const description = model.description?.trim();
  if (description) return description;
  const context = contextWindowLabel(model.contextLength);
  return context ? `${context} token context` : "Ready to use through your compute allowance.";
};
// A model identifier appears once. Duplicate registry rows never render twice.
const dedupeModels = (models: Model[]) => { const seen = new Set<string>(); const unique: Model[] = []; for (const model of models) { const key = (model.id || "").trim().toLowerCase(); if (!key || seen.has(key)) continue; seen.add(key); unique.push(model); } return unique; };
const summarizeUsage = (activity: Activity[]) => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = activity.filter((item) => { const time = new Date(item.created_at).getTime(); return Number.isFinite(time) && time >= cutoff; });
  const spend = recent.reduce((total, item) => total + clampMicroUsd(item.user_debit_micro_usd), 0n);
  const models = new Set(activity.map((item) => item.model).filter(Boolean));
  return { spendMicroUsd: spend.toString(), requests: activity.length, modelsUsed: models.size };
};

function StatusPanel({ title, body, action }: { title: string; body: string; action?: ReactNode }) { return <div className="compute-status-panel"><span className="compute-status-mark">!</span><div><h2>{title}</h2><p>{body}</p>{action}</div></div>; }

function ModelCard({ model, onOpen }: { model: Model; onOpen: (model: Model, control: HTMLButtonElement) => void }) {
  const isOperational = operational(model);
  return <button type="button" className={`compute-model-card ${!isOperational ? "is-gated" : ""}`} onClick={(event) => onOpen(model, event.currentTarget)} aria-label={`Open ${model.displayName}`}>
    <div className="model-card-top"><span className="model-glyph"><ModelLogo model={model} /></span><span className={`model-status ${isOperational ? "" : model.registryStatus === "paused" ? "paused" : "unavailable"}`}><i /> {statusLabel(model)}</span></div>
    <h3>{model.displayName}</h3>
    <p className="model-card-by">by {creatorLabel(model)}</p>
    <p className="model-card-summary">{cardSummary(model)}</p>
    <ModelCapabilities model={model} />
    <span className="model-card-arrow" aria-hidden="true"><span>→</span></span>
  </button>;
}

function CopyButton({ value, label, onCopied }: { value: string; label: string; onCopied: (message: string) => void }) { const copy = async () => { try { if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable"); await navigator.clipboard.writeText(value); onCopied(`${label} copied`); } catch { onCopied("Copy unavailable — select the readable text to copy it."); } }; return <button type="button" className="model-copy-button" onClick={() => void copy()} aria-label={`Copy ${label}`}><span aria-hidden="true">▣</span> Copy</button>; }
function DetailRow({ label, value }: { label: string; value: string }) { return <div className="model-detail-row"><span>{label}</span><b>{value}</b></div>; }
function ModelDetails({ model, onClose, onUse, onCopied }: { model: Model; onClose: () => void; onUse: () => void; onCopied: (message: string) => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex=\"-1\"])")).filter((item) => !item.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const current = document.activeElement;
      const index = items.indexOf(current as HTMLElement);
      if (event.shiftKey && (index <= 0 || current === dialog)) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0].focus(); }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => { dialog.removeEventListener("keydown", handleKeyDown); document.body.style.overflow = previousOverflow; };
  }, []);
  const input = pricingValue(model.pricing, ["prompt", "input"]);
  const cachedInput = pricingValue(model.pricing, ["input_cache_read", "cache_read", "cached_input"]);
  const output = pricingValue(model.pricing, ["completion", "output"]);
  const status = statusLabel(model);
  const endpoint = "/api/v1/chat/completions";
  const quickstart = `curl https://openweight.systems${endpoint} \\\n  -H "Authorization: Bearer $OPENWEIGHT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model.id}","messages":[{"role":"user","content":"Hello"}]}'`;
  const context = model.contextWindowLabel?.trim() || contextWindowLabel(model.contextLength);
  return <div className="model-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-details-title" aria-describedby="model-details-description" tabIndex={-1}>
    <header className="model-modal-header"><div><div className="compute-card-label">MODEL · {creatorLabel(model).toUpperCase()}</div><h2 id="model-details-title">{model.displayName}</h2><p id="model-details-description">{model.description?.trim() || (model.family ? `${model.family} family · ` : "") + "Registry details and current operational state."}</p></div><button type="button" className="model-modal-close" onClick={onClose} aria-label="Close model details">×</button></header>
    <div className="model-modal-body"><div className="model-detail-identity"><div><span className="model-detail-label">MODEL IDENTIFIER</span><code>{model.id}</code></div><CopyButton value={model.id} label="model identifier" onCopied={onCopied} /></div>
      <div className="model-detail-identity"><div><span className="model-detail-label">PROVIDER IDENTIFIER · SERVER ROUTING ONLY</span><code>{model.providerModelSlug || unavailable}</code></div>{model.providerModelSlug && <CopyButton value={model.providerModelSlug} label="provider model identifier" onCopied={onCopied} />}</div>
      <div className="model-detail-status"><span className={`model-status ${operational(model) ? "" : model.registryStatus === "paused" ? "paused" : "unavailable"}`}><i /> {status}</span><span className="model-detail-access">Registry · {model.registryStatus}</span>{model.sourceUrl ? <a href={model.sourceUrl} target="_blank" rel="noreferrer">Model source ↗</a> : <span className="model-detail-access">Model source · {unavailable}</span>}</div>
      <div className="model-detail-grid"><section className="model-detail-group"><h3>Provider pricing <small>per 1M tokens</small></h3>{input && <DetailRow label="Input" value={input} />}{cachedInput && <DetailRow label="Cached input" value={cachedInput} />}{output && <DetailRow label="Output" value={output} />}{!input && !cachedInput && !output && <DetailRow label="Pricing" value={unavailable} />}</section>
        <section className="model-detail-group"><h3>Capabilities</h3><DetailRow label="Context window" value={context ?? notAvailable} /><DetailRow label="Tools" value={capabilityText(model.toolsSupport)} /><DetailRow label="Vision" value={capabilityText(model.visionSupport)} /></section>
        <section className="model-detail-group"><h3>Modalities <small>provider catalog</small></h3><DetailRow label="Input" value={model.architecture?.inputModalities?.length ? model.architecture.inputModalities.join(" · ") : notAvailable} /><DetailRow label="Output" value={model.architecture?.outputModalities?.length ? model.architecture.outputModalities.join(" · ") : notAvailable} /><DetailRow label="Parameters" value={model.supportedParameters?.length ? model.supportedParameters.join(" · ") : notAvailable} /></section></div>
      {model.capabilitySource === "cached" && <p className="model-modal-note">The live provider catalog could not be reached, so the last verified feature metadata is shown.</p>}
      <section className="model-quickstart" aria-labelledby="model-endpoint-heading"><h3 id="model-endpoint-heading">Openweight chat-completions API</h3><p>Supported first-party OpenAI-compatible endpoint. Authenticate with an Openweight API key and use the model identifier shown above.</p><div className="model-endpoint-row"><code>POST {endpoint}</code><CopyButton value={endpoint} label="chat-completions endpoint path" onCopied={onCopied} /></div><div className="model-code-heading"><span>QUICKSTART · cURL</span><CopyButton value={quickstart} label="chat-completions example" onCopied={onCopied} /></div><pre className="model-code"><code>{quickstart}</code></pre></section>
      <div className="model-modal-footer">{operational(model) ? <button type="button" className="model-use-button" onClick={onUse}>Try in Playground <span aria-hidden="true">→</span></button> : <p className="model-modal-note">This model is {status.toLowerCase()}. It cannot be used in the Playground until provider availability is restored.</p>}</div>
    </div></section></div>;
}

// Overview is the workspace entry destination. A verified Privy identity is the
// only access requirement: models, chat, and the compute allowance all load from
// the authenticated session. There is no ownership verification screen, gate
// route, blocking modal, or holder check anywhere in this workspace.
export default function DashboardPage() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const router = useRouter();
  const [sessionState, setSessionState] = useState<SessionState>("loading");
  const [wallet, setWallet] = useState("");
  const [balanceMicroUsd, setBalanceMicroUsd] = useState<string | null>(null);
  const [allowanceMicroUsd, setAllowanceMicroUsd] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [computeState, setComputeState] = useState<LoadState>("idle");
  const [modelsState, setModelsState] = useState<LoadState>("idle");
  const [notice, setNotice] = useState("");
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [autoModel, setAutoModel] = useState(false);
  const invokingControl = useRef<HTMLButtonElement | null>(null);
  const loadingWorkspace = useRef(false);
  const authHeaders = useCallback(async () => { const token = await getAccessToken(); if (!token) throw new Error("No authenticated token"); return { Authorization: `Bearer ${token}` }; }, [getAccessToken]);
  const clearWorkspace = useCallback(() => { setComputeState("idle"); setActivity([]); setBalanceMicroUsd(null); setAllowanceMicroUsd(null); }, []);
  // The model list is public and identity-independent: every authenticated
  // account sees the same available models.
  const loadRegistry = useCallback(async () => {
    setModelsState("loading");
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) throw new Error("MODELS_UNAVAILABLE");
      const data = await response.json() as { models?: Model[] };
      const next = Array.isArray(data.models) ? dedupeModels(data.models) : [];
      // A failed or empty payload is an error state, never a partial card set.
      if (next.length === 0) throw new Error("MODELS_EMPTY");
      setModels(next);
      setModelsState("ready");
    } catch { setModels([]); setModelsState("error"); }
  }, []);
  // A verified Privy session is sufficient. The workspace renders from the
  // authenticated account immediately; nothing waits on an ownership result.
  const loadData = useCallback(async (refreshRegistry = false) => {
    if (!authenticated || loadingWorkspace.current) return;
    loadingWorkspace.current = true;
    if (refreshRegistry) { setSessionState("loading"); clearWorkspace(); void loadRegistry(); }
    setNotice("");
    try {
      const headers = await authHeaders();
      const accountResponse = await fetch("/api/account", { headers, cache: "no-store" });
      if (accountResponse.status === 401) { setSessionState("unauthenticated"); clearWorkspace(); setNotice("Your session has expired. Sign in again to continue."); return; }
      if (!accountResponse.ok) throw new Error("ACCOUNT_UNAVAILABLE");
      const account = await accountResponse.json() as AccountResponse;
      setWallet(account.account.walletAddress ?? "");
      // A verified identity is sufficient; no ownership gate applies.
      setSessionState("ready");
      setComputeState("loading");
      const [allowanceResponse, activityResponse] = await Promise.all([fetch("/api/allowance", { headers, cache: "no-store" }), fetch("/api/activity", { headers, cache: "no-store" })]);
      if (!allowanceResponse.ok || !activityResponse.ok) { setComputeState("error"); setNotice("Compute data could not be loaded. Refresh to request fresh data."); return; }
      const allowance = await allowanceResponse.json() as AllowanceResponse;
      const activityData = await activityResponse.json() as { activity?: Activity[] };
      setBalanceMicroUsd(allowance.balance?.available ?? null);
      setAllowanceMicroUsd(allowance.allowance?.amount_micro_usd ?? null);
      setActivity(activityData.activity ?? []);
      setComputeState("ready");
    } catch {
      clearWorkspace();
      setSessionState("error");
      setNotice("The workspace service is temporarily unavailable. Refresh to request fresh data.");
    } finally { loadingWorkspace.current = false; }
  }, [authenticated, authHeaders, clearWorkspace, loadRegistry]);
  const closeModelDetails = useCallback(() => { setSelectedModel(null); window.setTimeout(() => invokingControl.current?.focus(), 0); }, []);
  const openModelDetails = useCallback((model: Model, control: HTMLButtonElement) => { invokingControl.current = control; setSelectedModel(model); }, []);
  // Model selection and Playground entry depend only on the model's live
  // operational state; no account verification is re-confirmed here.
  const openSelectedModel = useCallback(async () => {
    if (!selectedModel) return;
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) throw new Error("MODELS_UNAVAILABLE");
      const data = await response.json() as { models?: Model[] };
      const latest = data.models?.find((item) => item.id === selectedModel.id);
      if (!latest || !operational(latest)) {
        if (latest) setSelectedModel(latest);
        else setSelectedModel({ ...selectedModel, availability: "unavailable", syncStatus: "unavailable" });
        setNotice("This model is no longer operational. No billable request was started.");
        return;
      }
      closeModelDetails();
      router.push(`/playground?model=${encodeURIComponent(latest.id)}`);
    } catch { setNotice("Model availability could not be confirmed. No billable request was started."); }
  }, [closeModelDetails, router, selectedModel]);
  const signOut = useCallback(async () => { try { await logout(); } finally { router.replace("/"); } }, [logout, router]);
  // The Auto-model preference is a client-side selection hint only; it never
  // changes allowance, billing, or authentication behaviour.
  const toggleAutoModel = useCallback(() => {
    setAutoModel((current) => {
      const next = !current;
      try { window.localStorage.setItem("openweight.autoModel", next ? "1" : "0"); } catch { /* preference stays in memory */ }
      return next;
    });
  }, []);
  // Unauthenticated visitors are still sent through the Privy entry flow; an
  // authenticated session (including one restored on refresh) never is.
  useEffect(() => { if (ready && !authenticated) router.replace("/signup"); }, [ready, authenticated, router]);
  useEffect(() => { if (ready && authenticated) { void loadData(false); void loadRegistry(); } }, [ready, authenticated, loadData, loadRegistry]);
  useEffect(() => { try { setAutoModel(window.localStorage.getItem("openweight.autoModel") === "1"); } catch { /* no stored preference */ } }, []);
  useEffect(() => { if (!selectedModel) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeModelDetails(); }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [closeModelDetails, selectedModel]);
  useEffect(() => { if (!copyNotice) return; const timer = window.setTimeout(() => setCopyNotice(""), 3000); return () => window.clearTimeout(timer); }, [copyNotice]);

  const usage = useMemo(() => summarizeUsage(activity), [activity]);

  if (!ready || !authenticated) return <main className="dashboard-gate"><div className="gate-inner"><span className="mark large"><img src="/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png" alt="favicon" /></span><p>{ready ? "Redirecting to sign in…" : "Restoring your session…"}</p></div></main>;
  // Session states only. Identity is the access requirement, so nothing here can
  // represent an ownership or verification check.
  const sessionLabels: Record<SessionState, string> = { loading: "RESTORING SESSION", ready: "SIGNED IN", error: "RETRY WORKSPACE", unauthenticated: "AUTH REQUIRED" };
  const sessionDegraded = sessionState === "error" || sessionState === "unauthenticated";
  const availableMicro = balanceMicroUsd === null ? null : clampMicroUsd(balanceMicroUsd);
  const totalMicro = allowanceMicroUsd === null ? null : clampMicroUsd(allowanceMicroUsd);
  const balanceAvailable = availableMicro !== null && availableMicro > 0n;
  const checking = sessionState === "loading";
  const percentAvailable = totalMicro && totalMicro > 0n && availableMicro !== null
    ? Number((availableMicro * 1000n) / totalMicro) / 10
    : null;
  const percentLabel = availableMicro === null ? "—" : percentAvailable === null ? (balanceAvailable ? "—" : "0% available") : `${Math.min(100, percentAvailable).toFixed(percentAvailable % 1 === 0 ? 0 : 1)}% available`;
  const progressWidth = percentAvailable === null ? (balanceAvailable ? 100 : 0) : Math.max(0, Math.min(100, percentAvailable));
  const allowanceValue = availableMicro === null ? "—" : formatMicroUsd(availableMicro.toString());
  const allowanceTotal = totalMicro === null ? null : formatMicroUsd(totalMicro.toString());

  const allowance = <section className="compute-allowance" aria-label="Compute allowance">
    <div className="compute-allowance-main">
      <div className="compute-card-label">COMPUTE ALLOWANCE</div>
      {computeState === "idle" || computeState === "loading" ? <div className="compute-allowance-loading" role="status"><span className="compute-allowance-skeleton" /><span className="compute-allowance-skeleton short" /><span className="compute-allowance-skeleton bar" /></div>
        : <>
          <div className="compute-allowance-figure">
            <strong>{allowanceValue}</strong>
            {allowanceTotal && <span className="compute-allowance-total">/ {allowanceTotal}</span>}
            <span className={`compute-availability ${balanceAvailable ? "" : "is-muted"}`}><i aria-hidden="true" />{percentLabel}</span>
          </div>
          <div className="compute-progress" role="img" aria-label={`${percentLabel} of the current compute allowance`}><span style={{ width: `${progressWidth}%` }} /></div>
          {!balanceAvailable && computeState === "ready" && <p className="compute-allowance-note">No compute is currently available. Refresh to request an authoritative balance.</p>}
        </>}
    </div>
    <dl className="compute-stats">
      <div><dt>USAGE (30D)</dt><dd>{computeState === "ready" ? formatMicroUsd(usage.spendMicroUsd) : "—"}</dd></div>
      <div><dt>REQUESTS</dt><dd>{computeState === "ready" ? usage.requests : "—"}</dd></div>
      <div><dt>MODELS USED</dt><dd>{computeState === "ready" ? usage.modelsUsed : "—"}</dd></div>
    </dl>
  </section>;

  const registry = <section className="compute-section models-primary">
    <div className="compute-section-head"><div><div className="compute-card-label">MODELS</div><h2>Discover a model for the work.</h2>{!balanceAvailable && sessionState === "ready" && computeState === "ready" && <p className="compute-insufficient-note">Every model is available; the Playground also needs available compute.</p>}</div><Link className="compute-open-playground" href="/playground">Open Playground <span aria-hidden="true">↗</span></Link></div>
    {modelsState === "loading" || modelsState === "idle" ? <StatusPanel title="Loading models" body="Fetching the current model catalog and provider availability. No cached availability is shown." /> : modelsState === "error" ? <div className="models-error" role="alert">Models could not be loaded. No previous availability data is shown.<br/><button onClick={() => void loadRegistry()}>Retry models ↻</button></div> : models.length === 0 ? <div className="models-error" role="alert">No models are available right now.<br/><button onClick={() => void loadRegistry()}>Retry models ↻</button></div> : <div className="compute-model-grid models-quad">{models.map((model) => <ModelCard key={model.id} model={model} onOpen={openModelDetails} />)}</div>}
    <div className={`auto-model-row ${autoModel ? "is-on" : ""}`}>
      <span className="auto-model-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 4 3.5 8.5 12 13l8.5-4.5z" /><path d="M3.5 14.5 12 19l8.5-4.5" /></svg></span>
      <div className="auto-model-copy"><h3>Auto model</h3><p>Let Openweight pick the right model for your task.</p></div>
      <button type="button" className="auto-model-toggle" role="switch" aria-checked={autoModel} aria-label="Auto model selection" onClick={toggleAutoModel}><span /></button>
    </div>
  </section>;

  return <WorkspaceShell
    section="overview"
    dashboardClassName="overview-dashboard"
    mainId="overview"
    asideFooter={<>
      <div className="compute-sidebar-state"><span className={`compute-dot ${sessionDegraded ? "muted" : ""}`} /> {sessionLabels[sessionState]}</div>
      <small className="compute-sidebar-note">{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Wallet not linked · not required"}</small>
      <button type="button" onClick={() => void signOut()}>Sign out ↗</button>
    </>}
    overlays={<>{selectedModel && <ModelDetails model={selectedModel} onClose={closeModelDetails} onUse={() => void openSelectedModel()} onCopied={setCopyNotice} />}{copyNotice && <div className="model-copy-feedback" role="status">{copyNotice}</div>}</>}
  >
    <header className="compute-header">
      <div className="compute-header-copy">
        <div className="compute-eyebrow">WORKSPACE</div>
        <h1>Compute, kept in view.</h1>
        <p>Your allowance and a set of open-weight models, ready to use.</p>
      </div>
      <div className="compute-header-actions">
        <button type="button" onClick={() => void loadData(true)} disabled={checking || loadingWorkspace.current}>{checking ? "Loading…" : "Refresh ↻"}</button>
      </div>
    </header>
    {computeState === "error" ? <StatusPanel title="Compute data is unavailable" body="The current server ledger balance and activity could not be loaded. No previous balance is presented." action={<button className="compute-retry" onClick={() => void loadData(true)}>Retry workspace ↻</button>} /> : allowance}
    {registry}
    <section className="compute-section activity-section">
      <div className="compute-section-head"><div><div className="compute-card-label">RECENT ACTIVITY</div><h2>Compute activity</h2></div><Link className="compute-open-playground" href="/settings">Manage API keys ↗</Link></div>
      {computeState === "ready" && activity.length === 0 ? <p className="compute-empty">No settled compute activity yet.</p> : computeState === "ready" ? <div className="compute-activity-list">{activity.slice(0, 5).map((item) => <div className="compute-activity-row" key={item.operation_key}><span className="activity-status"><i /></span><span><b>{item.model}</b><small>{relativeTime(item.created_at)} · {item.input_tokens ?? "—"} in / {item.output_tokens ?? "—"} out</small></span><strong>{compactUsd(item.user_debit_micro_usd)}</strong></div>)}</div> : <p className="compute-empty">Activity appears once compute data loads.</p>}
    </section>
    {notice && <p className="compute-notice" role="status">{notice}</p>}
  </WorkspaceShell>;
}

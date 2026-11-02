"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import "./dashboard.css";
import "./dashboard-overview.css";

type SessionState = "loading" | "ready" | "error" | "unauthenticated";
type LoadState = "idle" | "loading" | "ready" | "error";
type Activity = { operation_key: string; model: string; status: string; input_tokens: number | null; output_tokens: number | null; user_debit_micro_usd: string | null; created_at: string };
// One curated registry row, as /api/models reports it.
//
// `status` is the three-state provider health (Operational / Degraded /
// Unavailable) the registry computed from the active provider. `adminActivated`
// separates an operator's pause from a provider outage, and `selectable` is the
// single flag the server also uses to accept a request — so a card can never offer
// a model the Playground would reject.
type ModelStatus = "operational" | "degraded" | "unavailable";
type Model = {
  id: string;
  displayName: string;
  family: string | null;
  featured: boolean;
  registryStatus: string;
  adminActivated?: boolean;
  provider: string;
  providerModelSlug: string;
  vastModelId?: string | null;
  sourceUrl: string | null;
  contextLength: number | null;
  pricing: Record<string, string> | null;
  pricingSource?: "registry";
  architecture: { inputModalities: string[]; outputModalities: string[] } | null;
  supportedParameters: string[] | null;
  licenseStatus: string;
  providerTermsStatus: string;
  status?: ModelStatus;
  availability: "available" | "degraded" | "unavailable" | "stale";
  syncStatus: string;
  availabilityProvider?: string | null;
  availabilityCheckedAt?: string | null;
  availabilityReason?: string | null;
  selectable?: boolean;
};
type AccountResponse = { account: { walletAddress: string | null } };
// Provider health as reported by the background health worker. Coarse states only:
// nothing credential-shaped crosses this boundary.
type ProviderStatus = { provider: string; status: "operational" | "degraded" | "unavailable"; healthy: boolean; latencyMs: number | null; checkedAt: string; stale: boolean; warmInstances: number | null; pendingInstances: number | null };
type StatusResponse = { active: string; fallback: string | null; providers: ProviderStatus[] };

const clampMicroUsd = (micro: string | null | undefined) => { try { const value = BigInt(micro ?? "0"); return value > 0n ? value : 0n; } catch { return 0n; } };
const formatMicroUsd = (micro: string | null | undefined) => { const value = clampMicroUsd(micro); const whole = value / 1_000_000n; const fraction = (value % 1_000_000n).toString().padStart(6, "0"); return `$${whole.toString()}.${fraction}`; };
const compactUsd = (micro: string | null | undefined) => micro == null ? "\u2014" : formatMicroUsd(micro);
const contextLabel = (value: number | null) => { if (value == null || value <= 0) return null; return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M tokens` : `${Math.round(value / 1000)}K tokens`; };
const relativeTime = (iso: string) => { const timestamp = new Date(iso).getTime(); if (Number.isNaN(timestamp)) return ""; const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago`; };
const unavailable = "Unavailable";
// Registry-owned pricing, USD per token. The card and the ledger read the same value.
const pricingValue = (pricing: Record<string, string> | null, keys: string[]) => { const key = keys.find((candidate) => pricing?.[candidate] != null); const numeric = key ? Number(pricing?.[key]) : NaN; return Number.isFinite(numeric) && numeric >= 0 ? `$${(numeric * 1_000_000).toFixed(2)} / 1M tokens` : null; };

/** The three-state provider status for a row, tolerating an older API shape. */
const modelStatus = (model: Model): ModelStatus => {
  if (model.status) return model.status;
  if (model.availability === "available") return "operational";
  if (model.availability === "degraded") return "degraded";
  return "unavailable";
};
// An administrator's activation and live provider health together decide both the
// badge and whether the model can be opened in the Playground.
const activated = (model: Model) => model.adminActivated ?? model.registryStatus === "active";
const operational = (model: Model) => { if (model.selectable != null) return model.selectable; const status = modelStatus(model); return activated(model) && model.syncStatus === "current" && status !== "unavailable"; };
const statusLabel = (model: Model) => {
  if (!activated(model)) return model.registryStatus === "paused" ? "Paused" : model.registryStatus.replaceAll("_", " ");
  const status = modelStatus(model);
  if (status === "operational") return "Operational";
  // Degraded is honest, not decorative: with a rented vast.ai fleet it means no
  // machine is warm and the next turn pays a cold start.
  if (status === "degraded") return "Degraded";
  if (model.availability === "stale" || model.syncStatus === "stale") return "Metadata stale";
  return "Unavailable";
};
const isDeepSeekModel = (model: Model) => /deepseek/i.test(`${model.family ?? ""} ${model.displayName} ${model.providerModelSlug}`);
const isKimiModel = (model: Model) => /kimi/i.test(`${model.family ?? ""} ${model.displayName}`);
const isZaiGlmModel = (model: Model) => /glm/i.test(model.family ?? "") || /^z-ai\//i.test(model.providerModelSlug);
const isQwenModel = (model: Model) => /qwen/i.test(`${model.family ?? ""} ${model.displayName} ${model.providerModelSlug}`);
const modelBrandLogo = (model: Model) => {
  if (isDeepSeekModel(model)) return { src: "https://github.com/deepseek-ai/DeepSeek-V2/blob/main/figures/logo.svg?raw=true", alt: "DeepSeek" };
  if (isZaiGlmModel(model)) return { src: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg", alt: "Z.ai GLM" };
  if (isKimiModel(model)) return { src: "https://moonshotai.github.io/Branding-Guide/scenarios/03-icon-without-kimi/kimi-icon-rounded-corner.png", alt: "Kimi" };
  if (isQwenModel(model)) return { src: "https://img.alicdn.com/imgextra/i1/O1CN01Pzz5rH1SIBQeVFb7w_!!6000000002223-55-tps-32-32.svg", alt: "Qwen" };
  return null;
};

// The provider-health badge reflects the background worker's normalized status,
// not a client guess. A stale snapshot still renders (with an explanatory title)
// rather than disappearing, so an outage never looks like "no data".
const providerHealthLabel = (status: ProviderStatus | null) => {
  if (!status) return { text: "CHECKING", tone: "unknown" as const, title: "Waiting for the first provider health probe." };
  if (status.status === "operational") return { text: "OPERATIONAL", tone: "ok" as const, title: `Probed ${relativeTime(status.checkedAt)}${status.latencyMs != null ? ` in ${status.latencyMs}ms` : ""}.` };
  if (status.status === "degraded") return { text: "WARMING", tone: "warn" as const, title: "No instance is serving yet; a cold start will rent one on the next request." };
  return { text: "UNAVAILABLE", tone: "bad" as const, title: "The active provider cannot serve inference right now. Nothing is charged for a failed start." };
};

function StatusPanel({ title, body, action }: { title: string; body: string; action?: ReactNode }) { return <div className="compute-status-panel"><span className="compute-status-mark"></span><div><h2>{title}</h2><p>{body}</p>{action}</div></div>; }
function ModelCard({ model, onOpen }: { model: Model; onOpen: (model: Model, control: HTMLButtonElement) => void }) {
  const isOperational = operational(model);
  const status = modelStatus(model);
  const inputPrice = pricingValue(model.pricing, ["prompt", "input"]);
  const outputPrice = pricingValue(model.pricing, ["completion", "output"]);
  const modalities = model.architecture?.inputModalities ?? [];
  const brandLogo = modelBrandLogo(model);
  const statusClass = isOperational ? (status === "degraded" ? "degraded" : "") : activated(model) ? "unavailable" : "paused";
  return <button type="button" className={`compute-model-card ${!isOperational ? "is-gated" : ""}`} onClick={(event) => onOpen(model, event.currentTarget)} aria-label={`View details for ${model.displayName}`}>
    <div className="model-card-top"><span className="model-glyph"><span>{(model.family || model.displayName).slice(0, 2).toUpperCase()}</span>{brandLogo && <img className="model-logo" src={brandLogo.src} alt="" aria-label={`${brandLogo.alt} logo`} onError={(event) => { event.currentTarget.style.display = "none"; }} />}</span><span className={`model-status ${statusClass}`} title={model.availabilityReason ?? undefined}><i /> {statusLabel(model)}</span></div>
    <h3>{model.displayName}{isDeepSeekModel(model) && <img className="model-brand-icon" src="https://github.com/deepseek-ai/DeepSeek-V2/blob/main/figures/logo.svg?raw=true" alt="DeepSeek logo" onError={(event) => { event.currentTarget.hidden = true; }} />}{isZaiGlmModel(model) && <span className="model-brand-lockup"><img className="model-brand-icon" src="https://z-cdn.chatglm.cn/z-ai/static/logo.svg" alt="Z.ai logo" onError={(event) => { event.currentTarget.hidden = true; }} /><span>Z.ai (GLM)</span></span>}{isKimiModel(model) && <img className="model-brand-icon" src="https://moonshotai.github.io/Branding-Guide/scenarios/03-icon-without-kimi/kimi-icon-rounded-corner.png" alt="Kimi logo" onError={(event) => { event.currentTarget.hidden = true; }} />}{isQwenModel(model) && <img className="model-brand-icon" src="https://img.alicdn.com/imgextra/i1/O1CN01Pzz5rH1SIBQeVFb7w_!!6000000002223-55-tps-32-32.svg" alt="Qwen logo" onError={(event) => { event.currentTarget.hidden = true; }} />}</h3>{model.family && <p>{model.family}</p>}
    <div className="model-tags">{contextLabel(model.contextLength) && <span className="model-tag">{contextLabel(model.contextLength)} context</span>}{modalities.slice(0, 2).map((modality) => <span className="model-tag" key={modality}>{modality} input</span>)}{model.featured && <span className="model-tag">Featured</span>}</div>
    {(inputPrice || outputPrice) && <p className="model-card-pricing">{inputPrice ? `${inputPrice.replace(" / 1M tokens", "")} in` : "Input pricing unavailable"}{outputPrice ? `  ${outputPrice.replace(" / 1M tokens", "")} out` : ""}</p>}
    <span className="model-card-action">View model details <span aria-hidden="true">\u2197</span></span>
  </button>;
}
function CopyButton({ value, label, onCopied }: { value: string; label: string; onCopied: (message: string) => void }) { const copy = async () => { try { if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable"); await navigator.clipboard.writeText(value); onCopied(`${label} copied`); } catch { onCopied("Copy unavailable \u2014 select the readable text to copy it."); } }; return <button type="button" className="model-copy-button" onClick={() => void copy()} aria-label={`Copy ${label}`}><span aria-hidden="true">\u25a3</span> Copy</button>; }
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
  const statusClass = operational(model) ? (modelStatus(model) === "degraded" ? "degraded" : "") : activated(model) ? "unavailable" : "paused";
  return <div className="model-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-details-title" aria-describedby="model-details-description" tabIndex={-1}>
    <header className="model-modal-header"><div><div className="compute-card-label">CURATED MODEL \u00b7 {model.provider.toUpperCase()}</div><h2 id="model-details-title">{model.displayName}</h2><p id="model-details-description">{model.family ? `${model.family} family \u00b7 ` : ""}Registry details and current operational state.</p></div><button type="button" className="model-modal-close" onClick={onClose} aria-label="Close model details">\u00d7</button></header>
    <div className="model-modal-body"><div className="model-detail-identity"><div><span className="model-detail-label">CURATED IDENTIFIER</span><code>{model.id}</code></div><CopyButton value={model.id} label="curated model identifier" onCopied={onCopied} /></div>
      <div className="model-detail-identity"><div><span className="model-detail-label">PROVIDER IDENTIFIER \u00b7 SERVER ROUTING ONLY</span><code>{model.vastModelId || model.providerModelSlug || unavailable}</code></div>{(model.vastModelId || model.providerModelSlug) && <CopyButton value={model.vastModelId || model.providerModelSlug} label="provider model identifier" onCopied={onCopied} />}</div>
      <div className="model-detail-status"><span className={`model-status ${statusClass}`}><i /> {status}</span><span className="model-detail-access">Registry \u00b7 {model.registryStatus}</span>{model.availabilityCheckedAt && <span className="model-detail-access">Checked \u00b7 {relativeTime(model.availabilityCheckedAt)}</span>}{model.sourceUrl ? <a href={model.sourceUrl} target="_blank" rel="noreferrer">Model source \u2197</a> : <span className="model-detail-access">Model source \u00b7 {unavailable}</span>}</div>
      <div className="model-detail-grid"><section className="model-detail-group"><h3>Registry pricing <small>per 1M tokens</small></h3>{input && <DetailRow label="Input" value={input} />}{cachedInput && <DetailRow label="Cached input" value={cachedInput} />}{output && <DetailRow label="Output" value={output} />}{!input && !cachedInput && !output && <DetailRow label="Pricing" value={unavailable} />}</section>
        {contextLabel(model.contextLength) && <section className="model-detail-group"><h3>Context window</h3><DetailRow label="Context window" value={contextLabel(model.contextLength)!} /></section>}
        <section className="model-detail-group"><h3>Capabilities</h3><DetailRow label="Input modalities" value={model.architecture?.inputModalities?.length ? model.architecture.inputModalities.join(" \u00b7 ") : unavailable} /><DetailRow label="Output modalities" value={model.architecture?.outputModalities?.length ? model.architecture.outputModalities.join(" \u00b7 ") : unavailable} /><DetailRow label="Supported parameters" value={model.supportedParameters?.length ? model.supportedParameters.join(" \u00b7 ") : unavailable} /></section></div>
      <section className="model-quickstart" aria-labelledby="model-endpoint-heading"><h3 id="model-endpoint-heading">Openweight chat-completions API</h3><p>Supported first-party OpenAI-compatible endpoint. Authenticate with an Openweight API key; use the curated model identifier shown above.</p><div className="model-endpoint-row"><code>POST {endpoint}</code><CopyButton value={endpoint} label="chat-completions endpoint path" onCopied={onCopied} /></div><div className="model-code-heading"><span>QUICKSTART \u00b7 cURL</span><CopyButton value={quickstart} label="chat-completions example" onCopied={onCopied} /></div><pre className="model-code"><code>{quickstart}</code></pre></section>
      <div className="model-modal-footer">{operational(model) ? <button type="button" className="model-use-button" onClick={onUse}>Try in Playground <span aria-hidden="true">\u2192</span></button> : <p className="model-modal-note">This model is {status.toLowerCase()}. It cannot be used in the Playground until it is activated and available on the provider.</p>}</div>
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
  const [models, setModels] = useState<Model[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [computeState, setComputeState] = useState<LoadState>("idle");
  const [modelsState, setModelsState] = useState<LoadState>("idle");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);
  const [notice, setNotice] = useState("");
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const invokingControl = useRef<HTMLButtonElement | null>(null);
  const loadingWorkspace = useRef(false);
  const authHeaders = useCallback(async () => { const token = await getAccessToken(); if (!token) throw new Error("No authenticated token"); return { Authorization: `Bearer ${token}` }; }, [getAccessToken]);
  const clearWorkspace = useCallback(() => { setComputeState("idle"); setActivity([]); setBalanceMicroUsd(null); }, []);
  // Provider health is read from the worker-maintained snapshot: the active
  // provider's normalized status plus how many managed instances are warm. No
  // live GPU probe is triggered by rendering this page.
  const loadProviderStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("STATUS_UNAVAILABLE");
      const data = await response.json() as StatusResponse;
      const active = Array.isArray(data.providers) ? data.providers.find((entry) => entry.provider === data.active) ?? data.providers[0] ?? null : null;
      setProviderStatus(active);
    } catch { setProviderStatus(null); }
  }, []);
  // The curated registry is public and identity-independent: every authenticated
  // account sees the full available model list. Availability is already debounced
  // server-side, so re-reading it here cannot make the cards flap.
  const loadRegistry = useCallback(async () => {
    setModelsState("loading");
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) throw new Error("MODELS_UNAVAILABLE");
      const data = await response.json() as { models?: Model[] };
      setModels(Array.isArray(data.models) ? data.models : []);
      setModelsState("ready");
    } catch { setModels([]); setModelsState("error"); }
  }, []);
  // A verified Privy session is sufficient. The workspace renders from the
  // authenticated account immediately; nothing waits on an ownership result.
  const loadData = useCallback(async (refreshRegistry = false) => {
    if (!authenticated || loadingWorkspace.current) return;
    loadingWorkspace.current = true;
    if (refreshRegistry) { setSessionState("loading"); clearWorkspace(); void loadRegistry(); void loadProviderStatus(); }
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
      const allowance = await allowanceResponse.json() as { balance?: { available?: string } };
      const activityData = await activityResponse.json() as { activity?: Activity[] };
      setBalanceMicroUsd(allowance.balance?.available ?? null);
      setActivity(activityData.activity ?? []);
      setComputeState("ready");
    } catch {
      clearWorkspace();
      setSessionState("error");
      setNotice("The workspace service is temporarily unavailable. Refresh to request fresh data.");
    } finally { loadingWorkspace.current = false; }
  }, [authenticated, authHeaders, clearWorkspace, loadProviderStatus, loadRegistry]);
  const closeModelDetails = useCallback(() => { setSelectedModel(null); window.setTimeout(() => invokingControl.current?.focus(), 0); }, []);
  const openModelDetails = useCallback((model: Model, control: HTMLButtonElement) => { invokingControl.current = control; setSelectedModel(model); }, []);
  // Model selection and Playground entry depend only on the curated model's live
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
  // Unauthenticated visitors are still sent through the Privy entry flow; an
  // authenticated session (including one restored on refresh) never is.
  useEffect(() => { if (ready && !authenticated) router.replace("/signup"); }, [ready, authenticated, router]);
  useEffect(() => { if (ready && authenticated) { void loadData(false); void loadRegistry(); void loadProviderStatus(); } }, [ready, authenticated, loadData, loadRegistry, loadProviderStatus]);
  // The registry and the health snapshot are re-read on a slow timer so a
  // long-lived tab keeps showing current model state (an admin pause, a provider
  // transition) without a manual refresh.
  useEffect(() => { if (!authenticated) return; const timer = window.setInterval(() => { void loadProviderStatus(); void loadRegistry(); }, 60_000); return () => window.clearInterval(timer); }, [authenticated, loadProviderStatus, loadRegistry]);
  useEffect(() => { if (!selectedModel) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeModelDetails(); }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [closeModelDetails, selectedModel]);
  useEffect(() => { if (!copyNotice) return; const timer = window.setTimeout(() => setCopyNotice(""), 3000); return () => window.clearTimeout(timer); }, [copyNotice]);

  if (!ready || !authenticated) return <main className="dashboard-gate"><div className="gate-inner"><span className="mark large"><img src="/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png" alt="favicon" /></span><p>{ready ? "Redirecting to sign in\u2026" : "Restoring your session\u2026"}</p></div></main>;
  // Session states only. Identity is the access requirement, so nothing here can
  // represent an ownership or verification check.
  const sessionLabels: Record<SessionState, string> = { loading: "RESTORING SESSION", ready: "SIGNED IN", error: "RETRY WORKSPACE", unauthenticated: "AUTH REQUIRED" };
  const sessionDegraded = sessionState === "error" || sessionState === "unauthenticated";
  const balanceAvailable = balanceMicroUsd !== null && clampMicroUsd(balanceMicroUsd) > 0n;
  const checking = sessionState === "loading";
  const health = providerHealthLabel(providerStatus);
  const registry = <section className="compute-section models-primary"><div className="compute-section-head"><div><div className="compute-card-label">CURATED OPEN-WEIGHT MODELS</div><h2>Discover a model for the work.</h2>{!balanceAvailable && sessionState === "ready" && <p className="compute-insufficient-note">Registry is fully available; the Playground also requires available compute.</p>}</div><Link href="/playground">Open Playground \u2197</Link></div>
    {modelsState === "loading" || modelsState === "idle" ? <StatusPanel title="Loading the curated registry" body="Fetching the current public model catalog and provider availability. No cached availability is shown." /> : modelsState === "error" ? <div className="models-error" role="alert">The model registry could not be loaded. No previous availability data is shown.<br/><button onClick={() => void loadRegistry()}>Retry registry \u21bb</button></div> : models.length === 0 ? <div className="compute-empty" role="status">The curated registry currently has no public models.</div> : <div className="compute-model-grid">{models.map((model) => <ModelCard key={model.id} model={model} onOpen={openModelDetails} />)}</div>}
  </section>;
  return <main className="compute-dashboard"><aside className="compute-sidebar"><Link className="compute-brand" href="/"><span className="mark"><img src="/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png" alt="favicon" /></span><span>OPENWEIGHT</span></Link><div className="compute-eyebrow">OPEN-WEIGHT FRONTIER</div><nav aria-label="Workspace navigation"><a className="active" href="#overview" aria-current="page">{"\u25c9"} <span>Overview</span></a><Link href="/playground">{"\u25cc"} <span>Playground</span></Link><Link href="/settings">{"\u25c7"} <span>API Keys</span></Link><Link href="/gpu">{"\u25a3"} <span>GPU</span></Link></nav><div className="compute-sidebar-foot"><div><span className={`compute-dot ${sessionDegraded ? "muted" : ""}`} /> {sessionLabels[sessionState]}</div><small>{wallet ? `${wallet.slice(0, 6)}\u2026${wallet.slice(-4)}` : "Wallet not linked \u00b7 not required"}</small><button onClick={() => void signOut()}>Sign out \u2197</button></div></aside>
    <section className="compute-main" id="overview"><header className="compute-header"><div><div className="compute-eyebrow">WORKSPACE / COMPUTE LAYER</div><h1>Compute, kept<br/><em>in view.</em></h1><p>Your allowance and a deliberate set of open-weight models, ready as soon as you sign in.</p></div><div className="compute-header-actions"><div className={`provider-health ${health.tone}`} title={health.title} role="status"><i />{health.text}{providerStatus?.warmInstances != null && <small>{providerStatus.warmInstances} warm{providerStatus.pendingInstances ? ` \u00b7 ${providerStatus.pendingInstances} warming` : ""}</small>}</div><button onClick={() => void loadData(true)} disabled={checking || loadingWorkspace.current}>{checking ? "Loading\u2026" : "Refresh workspace \u21bb"}</button></div></header>
      {registry}
      {computeState === "idle" || computeState === "loading" ? <StatusPanel title="Loading workspace allowance" body="Fetching your current server ledger balance and recent compute activity." /> : computeState === "error" ? <StatusPanel title="Compute data is unavailable" body="The current server ledger balance and activity could not be loaded. No previous balance is presented." action={<button className="compute-retry" onClick={() => void loadData(true)}>Retry workspace \u21bb</button>} /> : <>
        <section className="compute-support-row"><article className={`compute-balance-card ${!balanceAvailable ? "is-unavailable" : ""}`}><div className="compute-card-label">REMAINING COMPUTE ALLOWANCE</div><strong>{balanceMicroUsd === null ? "Unavailable" : formatMicroUsd(balanceMicroUsd)}</strong><p>{balanceMicroUsd === null ? "Current server ledger balance is unavailable" : balanceAvailable ? "Available internal USD compute \u00b7 actual cost" : "Zero / insufficient compute \u00b7 refresh the allowance to continue"}</p><div className="compute-balance-rule"><span /><small>{balanceMicroUsd === null ? "Refresh to request an authoritative balance" : balanceAvailable ? "Server ledger balance \u00b7 reservations reflected" : "Allowance is separate from authentication"}</small></div></article></section>
        <section className="compute-section activity-section"><div className="compute-section-head"><div><div className="compute-card-label">RECENT USAGE</div><h2>Compute activity</h2></div><Link href="/settings">Manage API keys \u2197</Link></div>{activity.length === 0 ? <p className="compute-empty">No settled compute activity yet.</p> : <div className="compute-activity-list">{activity.slice(0, 4).map((item) => <div className="compute-activity-row" key={item.operation_key}><span className="activity-status"><i /></span><span><b>{item.model}</b><small>{relativeTime(item.created_at)} \u00b7 {item.input_tokens ?? "\u2014"} in / {item.output_tokens ?? "\u2014"} out</small></span><strong>{compactUsd(item.user_debit_micro_usd)}</strong></div>)}</div>}</section>
      </>}
      {notice && <p className="compute-notice" role="status">{notice}</p>}
    </section>{selectedModel && <ModelDetails model={selectedModel} onClose={closeModelDetails} onUse={() => void openSelectedModel()} onCopied={setCopyNotice} />}{copyNotice && <div className="model-copy-feedback" role="status">{copyNotice}</div>}</main>;
}

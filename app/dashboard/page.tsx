"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import "./dashboard.css";
import "./dashboard-overview.css";

type Eligibility = "loading" | "verification_required" | "eligible" | "insufficient_balance" | "wrong_network" | "verification_error" | "unauthenticated";
type LoadState = "idle" | "loading" | "ready" | "error";
type Activity = { operation_key: string; model: string; status: string; input_tokens: number | null; output_tokens: number | null; user_debit_micro_usd: string | null; created_at: string };
type Model = { id: string; displayName: string; family: string | null; featured: boolean; registryStatus: string; provider: string; providerModelSlug: string; sourceUrl: string | null; contextLength: number | null; pricing: Record<string, string> | null; architecture: { inputModalities: string[]; outputModalities: string[] } | null; supportedParameters: string[] | null; licenseStatus: string; providerTermsStatus: string; availability: "available" | "unavailable" | "stale"; syncStatus: string };
type AccountResponse = { account: { walletAddress: string } };

const clampMicroUsd = (micro: string | null | undefined) => { try { const value = BigInt(micro ?? "0"); return value > 0n ? value : 0n; } catch { return 0n; } };
const formatMicroUsd = (micro: string | null | undefined) => { const value = clampMicroUsd(micro); const whole = value / 1_000_000n; const fraction = (value % 1_000_000n).toString().padStart(6, "0"); return `$${whole.toString()}.${fraction}`; };
const compactUsd = (micro: string | null | undefined) => micro == null ? "—" : formatMicroUsd(micro);
const contextLabel = (value: number | null) => { if (value == null || value <= 0) return null; return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M tokens` : `${Math.round(value / 1000)}K tokens`; };
const relativeTime = (iso: string) => { const timestamp = new Date(iso).getTime(); if (Number.isNaN(timestamp)) return ""; const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago`; };
const unavailable = "Unavailable";
const pricingValue = (pricing: Record<string, string> | null, keys: string[]) => { const key = keys.find((candidate) => pricing?.[candidate] != null); const numeric = key ? Number(pricing?.[key]) : NaN; return Number.isFinite(numeric) && numeric >= 0 ? `$${(numeric * 1_000_000).toFixed(2)} / 1M tokens` : null; };
const operational = (model: Model) => model.registryStatus === "active" && model.syncStatus === "current" && model.availability === "available";
const statusLabel = (model: Model) => model.registryStatus === "paused" ? "Paused" : model.availability === "stale" || model.syncStatus === "stale" ? "Metadata stale" : model.availability === "unavailable" || model.syncStatus === "unavailable" || model.syncStatus === "never" ? "Unavailable" : operational(model) ? "Operational" : model.registryStatus.replaceAll("_", " ");
const isDeepSeekModel = (model: Model) => /deepseek/i.test(`${model.family ?? ""} ${model.displayName} ${model.providerModelSlug}`);
const isKimiModel = (model: Model) => /kimi/i.test(`${model.family ?? ""} ${model.displayName}`);
const isZaiGlmModel = (model: Model) => /glm/i.test(model.family ?? "") || /^z-ai\//i.test(model.providerModelSlug);
const isQwenModel = (model: Model) => /qwen/i.test(`${model.family ?? ""} ${model.displayName} ${model.providerModelSlug}`);

function StatusPanel({ title, body, action }: { title: string; body: string; action?: ReactNode }) { return <div className="compute-status-panel"><span className="compute-status-mark"></span><div><h2>{title}</h2><p>{body}</p>{action}</div></div>; }
function ModelCard({ model, canUse, onOpen }: { model: Model; canUse: boolean; onOpen: (model: Model, control: HTMLButtonElement) => void }) {
  const isOperational = operational(model);
  const inputPrice = pricingValue(model.pricing, ["prompt", "input"]);
  const outputPrice = pricingValue(model.pricing, ["completion", "output"]);
  const modalities = model.architecture?.inputModalities ?? [];
  return <button type="button" className={`compute-model-card ${!isOperational || !canUse ? "is-gated" : ""}`} onClick={(event) => onOpen(model, event.currentTarget)} aria-label={`View details for ${model.displayName}`}>
    <div className="model-card-top"><span className="model-glyph">{(model.family || model.displayName).slice(0, 2).toUpperCase()}</span><span className={`model-status ${isOperational ? "" : model.registryStatus === "paused" ? "paused" : "unavailable"}`}><i /> {statusLabel(model)}</span></div>
    <h3>{model.displayName}{isDeepSeekModel(model) && <img className="model-brand-icon" src="https://github.com/deepseek-ai/DeepSeek-V2/blob/main/figures/logo.svg?raw=true" alt="DeepSeek logo" onError={(event) => { event.currentTarget.hidden = true; }} />}{isZaiGlmModel(model) && <span className="model-brand-lockup"><img className="model-brand-icon" src="https://z-cdn.chatglm.cn/z-ai/static/logo.svg" alt="Z.ai logo" onError={(event) => { event.currentTarget.hidden = true; }} /><span>Z.ai (GLM)</span></span>}{isKimiModel(model) && <img className="model-brand-icon" src="https://moonshotai.github.io/Branding-Guide/scenarios/03-icon-without-kimi/kimi-icon-rounded-corner.png" alt="Kimi logo" onError={(event) => { event.currentTarget.hidden = true; }} />}{isQwenModel(model) && <img className="model-brand-icon" src="https://img.alicdn.com/imgextra/i1/O1CN01Pzz5rH1SIBQeVFb7w_!!6000000002223-55-tps-32-32.svg" alt="Qwen logo" onError={(event) => { event.currentTarget.hidden = true; }} />}</h3>{model.family && <p>{model.family}</p>}
    <div className="model-tags">{contextLabel(model.contextLength) && <span className="model-tag">{contextLabel(model.contextLength)} context</span>}{modalities.slice(0, 2).map((modality) => <span className="model-tag" key={modality}>{modality} input</span>)}{model.featured && <span className="model-tag">Featured</span>}</div>
    {(inputPrice || outputPrice) && <p className="model-card-pricing">{inputPrice ? `${inputPrice.replace(" / 1M tokens", "")} in` : "Input pricing unavailable"}{outputPrice ? `  ${outputPrice.replace(" / 1M tokens", "")} out` : ""}</p>}
    <span className="model-card-action">View model details <span aria-hidden="true">↗</span></span>
  </button>;
}
function CopyButton({ value, label, onCopied }: { value: string; label: string; onCopied: (message: string) => void }) { const copy = async () => { try { if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable"); await navigator.clipboard.writeText(value); onCopied(`${label} copied`); } catch { onCopied("Copy unavailable — select the readable text to copy it."); } }; return <button type="button" className="model-copy-button" onClick={() => void copy()} aria-label={`Copy ${label}`}><span aria-hidden="true">▣</span> Copy</button>; }
function DetailRow({ label, value }: { label: string; value: string }) { return <div className="model-detail-row"><span>{label}</span><b>{value}</b></div>; }
function ModelDetails({ model, canUse, onClose, onUse, onCopied }: { model: Model; canUse: boolean; onClose: () => void; onUse: () => void; onCopied: (message: string) => void }) {
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
  const quickstart = `curl https://<your-openweight-domain>${endpoint} \\\n  -H "Authorization: Bearer $OPENWEIGHT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${model.id}","messages":[{"role":"user","content":"Hello"}]}'`;
  return <div className="model-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-details-title" aria-describedby="model-details-description" tabIndex={-1}>
    <header className="model-modal-header"><div><div className="compute-card-label">CURATED MODEL · {model.provider.toUpperCase()}</div><h2 id="model-details-title">{model.displayName}</h2><p id="model-details-description">{model.family ? `${model.family} family · ` : ""}Registry details and current operational state.</p></div><button type="button" className="model-modal-close" onClick={onClose} aria-label="Close model details">×</button></header>
    <div className="model-modal-body"><div className="model-detail-identity"><div><span className="model-detail-label">CURATED IDENTIFIER</span><code>{model.id}</code></div><CopyButton value={model.id} label="curated model identifier" onCopied={onCopied} /></div>
      <div className="model-detail-identity"><div><span className="model-detail-label">PROVIDER IDENTIFIER · SERVER ROUTING ONLY</span><code>{model.providerModelSlug || unavailable}</code></div>{model.providerModelSlug && <CopyButton value={model.providerModelSlug} label="provider model identifier" onCopied={onCopied} />}</div>
      <div className="model-detail-status"><span className={`model-status ${operational(model) ? "" : model.registryStatus === "paused" ? "paused" : "unavailable"}`}><i /> {status}</span><span className="model-detail-access">Registry · {model.registryStatus}</span>{model.sourceUrl ? <a href={model.sourceUrl} target="_blank" rel="noreferrer">Model source ↗</a> : <span className="model-detail-access">Model source · {unavailable}</span>}</div>
      <div className="model-detail-grid"><section className="model-detail-group"><h3>Provider pricing <small>per 1M tokens</small></h3>{input && <DetailRow label="Input" value={input} />}{cachedInput && <DetailRow label="Cached input" value={cachedInput} />}{output && <DetailRow label="Output" value={output} />}{!input && !cachedInput && !output && <DetailRow label="Pricing" value={unavailable} />}</section>
        <section className="model-detail-group"><h3>Context and licensing</h3><DetailRow label="Context window" value={contextLabel(model.contextLength) ?? unavailable} /><DetailRow label="License review" value={model.licenseStatus || unavailable} /><DetailRow label="Provider terms" value={model.providerTermsStatus || unavailable} /></section>
        <section className="model-detail-group"><h3>Capabilities</h3><DetailRow label="Input modalities" value={model.architecture?.inputModalities?.length ? model.architecture.inputModalities.join(" · ") : unavailable} /><DetailRow label="Output modalities" value={model.architecture?.outputModalities?.length ? model.architecture.outputModalities.join(" · ") : unavailable} /><DetailRow label="Supported parameters" value={model.supportedParameters?.length ? model.supportedParameters.join(" · ") : unavailable} /></section></div>
      <section className="model-quickstart" aria-labelledby="model-endpoint-heading"><h3 id="model-endpoint-heading">Openweight chat-completions API</h3><p>Supported first-party OpenAI-compatible endpoint. Authenticate with an Openweight API key; use the curated model identifier shown above.</p><div className="model-endpoint-row"><code>POST {endpoint}</code><CopyButton value={endpoint} label="chat-completions endpoint path" onCopied={onCopied} /></div><div className="model-code-heading"><span>QUICKSTART · cURL</span><CopyButton value={quickstart} label="chat-completions example" onCopied={onCopied} /></div><pre className="model-code"><code>{quickstart}</code></pre></section>
      <div className="model-modal-footer">{!canUse ? <p className="model-modal-note">Verified holder access and a positive compute allowance are required before using the Playground.</p> : !operational(model) ? <p className="model-modal-note">This model is {status.toLowerCase()}. It cannot be used in the Playground right now.</p> : <button type="button" className="model-use-button" onClick={onUse}>Try in Playground <span aria-hidden="true">→</span></button>}</div>
    </div></section></div>;
}

export default function DashboardPage() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const router = useRouter();
  const [eligibility, setEligibility] = useState<Eligibility>("loading");
  const [wallet, setWallet] = useState("");
  const [balanceMicroUsd, setBalanceMicroUsd] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [computeState, setComputeState] = useState<LoadState>("idle");
  const [modelsState, setModelsState] = useState<LoadState>("idle");
  const [notice, setNotice] = useState("");
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const invokingControl = useRef<HTMLButtonElement | null>(null);
  const verificationInProgress = useRef(false);
  const authHeaders = useCallback(async () => { const token = await getAccessToken(); if (!token) throw new Error("No authenticated token"); return { Authorization: `Bearer ${token}` }; }, [getAccessToken]);
  const clearWorkspace = useCallback(() => { setComputeState("idle"); setActivity([]); setBalanceMicroUsd(null); }, []);
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
  const loadData = useCallback(async (verifyAccess = false) => {
    if (!authenticated || verificationInProgress.current) return;
    verificationInProgress.current = true;
    if (verifyAccess) { setEligibility("loading"); clearWorkspace(); void loadRegistry(); }
    setNotice("");
    try {
      const headers = await authHeaders();
      const accountResponse = await fetch("/api/account", { headers, cache: "no-store" });
      if (!accountResponse.ok) throw new Error("ACCOUNT_UNAVAILABLE");
      const account = await accountResponse.json() as AccountResponse;
      setWallet(account.account.walletAddress);
      if (!verifyAccess) { setEligibility("verification_required"); clearWorkspace(); return; }
      const verificationResponse = await fetch("/api/holder/verify?force=true", { method: "POST", headers, cache: "no-store" });
      if (!verificationResponse.ok) {
        setEligibility(verificationResponse.status === 401 ? "unauthenticated" : "verification_error");
        clearWorkspace();
        setNotice(verificationResponse.status === 429 ? "Please wait briefly before trying holder verification again." : "Verification could not be completed. Access remains unverified; retry when the service is available.");
        return;
      }
      const verification = await verificationResponse.json() as { eligibility?: { state?: string } };
      const holderState = verification.eligibility?.state;
      if (holderState !== "eligible") {
        setEligibility(holderState === "insufficient_balance" ? "insufficient_balance" : holderState === "wrong_wallet" || holderState === "wrong_network" ? "wrong_network" : "verification_error");
        clearWorkspace();
        return;
      }
      setEligibility("eligible");
      setComputeState("loading");
      const [allowanceResponse, activityResponse] = await Promise.all([fetch("/api/allowance", { headers, cache: "no-store" }), fetch("/api/activity", { headers, cache: "no-store" })]);
      if (!allowanceResponse.ok || !activityResponse.ok) setComputeState("error");
      else { const allowance = await allowanceResponse.json() as { balance?: { available?: string } }; const activityData = await activityResponse.json() as { activity?: Activity[] }; setBalanceMicroUsd(allowance.balance?.available ?? null); setActivity(activityData.activity ?? []); setComputeState("ready"); }
    } catch {
      clearWorkspace();
      setEligibility("verification_error");
      setNotice("The access or verification service is temporarily unavailable. Access remains unverified; retry to request fresh data.");
    } finally { verificationInProgress.current = false; }
  }, [authenticated, authHeaders, clearWorkspace, loadRegistry]);
  const closeModelDetails = useCallback(() => { setSelectedModel(null); window.setTimeout(() => invokingControl.current?.focus(), 0); }, []);
  const openModelDetails = useCallback((model: Model, control: HTMLButtonElement) => { invokingControl.current = control; setSelectedModel(model); }, []);
  const useSelectedModel = useCallback(async () => {
    if (!selectedModel || eligibility !== "eligible" || clampMicroUsd(balanceMicroUsd) <= 0n) return;
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
      router.push(`/chat?model=${encodeURIComponent(latest.id)}`);
    } catch { setNotice("Model availability could not be confirmed. No billable request was started."); }
  }, [balanceMicroUsd, closeModelDetails, eligibility, router, selectedModel]);
  useEffect(() => { if (ready && !authenticated) router.replace("/signup"); }, [ready, authenticated, router]);
  useEffect(() => { if (ready && authenticated) { void loadData(false); void loadRegistry(); } }, [ready, authenticated, loadData, loadRegistry]);
  useEffect(() => { if (!selectedModel) return; const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeModelDetails(); }; window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown); }, [closeModelDetails, selectedModel]);
  useEffect(() => { if (!copyNotice) return; const timer = window.setTimeout(() => setCopyNotice(""), 3000); return () => window.clearTimeout(timer); }, [copyNotice]);

  if (!ready || !authenticated) return <main className="dashboard-gate"><div className="gate-inner"><span className="mark large">\b</span><p>{ready ? "Redirecting to sign in…" : "Verifying your session…"}</p></div></main>;
  const statusLabels: Record<Eligibility, string> = { loading: "CHECKING", verification_required: "NOT VERIFIED", eligible: "ELIGIBLE", insufficient_balance: "NOT ELIGIBLE", wrong_network: "WRONG NETWORK", verification_error: "RETRY CHECK", unauthenticated: "AUTH REQUIRED" };
  const gated = eligibility !== "eligible";
  const balanceAvailable = balanceMicroUsd !== null && clampMicroUsd(balanceMicroUsd) > 0n;
  const checking = eligibility === "loading";
  const verifyAction = <button className="compute-retry" onClick={() => void loadData(true)} disabled={checking || verificationInProgress.current}>{checking ? "Checking holder access…" : eligibility === "verification_error" ? "Retry holder check ↻" : "Verify holder access ↗"}</button>;
  const registry = <section className="compute-section models-primary"><div className="compute-section-head"><div><div className="compute-card-label">CURATED OPEN-WEIGHT MODELS</div><h2>Discover a model for the work.</h2>{!balanceAvailable && eligibility === "eligible" && <p className="compute-insufficient-note">Registry is for discovery; the Playground requires available compute.</p>}</div><a href="/chat">Open Playground ↗</a></div>
    {modelsState === "loading" || modelsState === "idle" ? <StatusPanel title="Loading the curated registry" body="Fetching the current public model catalog and provider availability. No cached availability is shown." /> : modelsState === "error" ? <div className="models-error" role="alert">The model registry could not be loaded. No previous availability data is shown.<br/><button onClick={() => void loadRegistry()}>Retry registry ↻</button></div> : models.length === 0 ? <div className="compute-empty" role="status">The curated registry currently has no public models.</div> : <div className="compute-model-grid">{models.map((model) => <ModelCard key={model.id} model={model} canUse={balanceAvailable && eligibility === "eligible"} onOpen={openModelDetails} />)}</div>}
  </section>;
  const accessNotice = gated && <div className="overview-access-note"><span className={`compute-access ${eligibility === "verification_error" || eligibility === "insufficient_balance" || eligibility === "wrong_network" ? "degraded" : ""}`}><i /> {statusLabels[eligibility]}</span><p>{eligibility === "insufficient_balance" ? "This wallet does not meet the configured holding requirement. Inference remains unavailable." : eligibility === "wrong_network" ? "Switch to the configured wallet and network, then verify holder access." : eligibility === "loading" ? "Holder access is being checked; model discovery remains available." : eligibility === "verification_required" ? "Browse the public catalog. Verify holder access to unlock compute and inference." : eligibility === "unauthenticated" ? "Sign in again to request holder verification." : "Access remains unverified. Retry when the verification service is available."}</p>{verifyAction}</div>;
  return <main className="compute-dashboard"><aside className="compute-sidebar"><div className="compute-brand"><span className="mark">✦</span><span>OPENWEIGHT</span></div><div className="compute-eyebrow">OPEN-WEIGHT FRONTIER</div><nav><a className="active" href="#overview">◉ <span>Overview</span></a><a href="/chat">◌ <span>Playground</span></a><a href="/settings">◇ <span>API Keys</span></a></nav><div className="compute-sidebar-foot"><div><span className={`compute-dot ${gated ? "muted" : ""}`} /> {statusLabels[eligibility]}</div><small>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Canonical wallet pending"}</small><button onClick={() => void logout()}>Sign out ↗</button></div></aside>
    <section className="compute-main" id="overview"><header className="compute-header"><div><div className="compute-eyebrow">WORKSPACE / COMPUTE LAYER</div><h1>Compute, kept<br/><em>in view.</em></h1><p>Your allowance and a deliberate set of open-weight models, ready when verified access is active.</p></div><div className="compute-header-actions"><span className={`compute-access ${gated ? "degraded" : ""}`}><i /> {statusLabels[eligibility]}</span><button onClick={() => void loadData(true)} disabled={checking || verificationInProgress.current}>{checking ? "Checking…" : eligibility === "eligible" ? "Refresh access ↻" : "Verify access ↗"}</button></div></header>
      {registry}
      {accessNotice}
      {gated ? <section className="compute-support-row"><article className="compute-balance-card is-unavailable"><div className="compute-card-label">COMPUTE ALLOWANCE</div><strong>Not verified</strong><p>Allowance is shown only after a successful holder check.</p><div className="compute-balance-rule"><span /><small>No verification is initiated automatically</small></div></article><article className="compute-note-card"><div className="compute-card-label">HOLDER ACCESS</div><h2>Ownership unlocks access.<br/><em>Not model ownership.</em></h2><p>Available compute and operational model status are required to start inference.</p></article></section> : computeState === "loading" ? <StatusPanel title="Loading workspace allowance" body="Fetching your current server ledger balance and recent compute activity." /> : computeState === "error" ? <StatusPanel title="Compute data is unavailable" body="The current server ledger balance and activity could not be loaded. No previous balance is presented." action={<button className="compute-retry" onClick={() => void loadData(true)}>Refresh access ↻</button>} /> : <>
        <section className="compute-support-row"><article className={`compute-balance-card ${!balanceAvailable ? "is-unavailable" : ""}`}><div className="compute-card-label">REMAINING COMPUTE ALLOWANCE</div><strong>{balanceMicroUsd === null ? "Unavailable" : formatMicroUsd(balanceMicroUsd)}</strong><p>{balanceMicroUsd === null ? "Current server ledger balance is unavailable" : balanceAvailable ? "Available internal USD compute · actual cost" : "Zero / insufficient compute · inference is not authorized"}</p><div className="compute-balance-rule"><span /><small>{balanceMicroUsd === null ? "Refresh to request an authoritative balance" : balanceAvailable ? "Server ledger balance · reservations reflected" : "Add available allowance before starting inference"}</small></div></article><article className="compute-note-card"><div className="compute-card-label">HOLDER ACCESS</div><h2>Ownership unlocks access.<br/><em>Not model ownership.</em></h2><p>Eligibility is confirmed by an explicit holder check. Allowance and operational model state govern Playground use.</p></article></section>
        <section className="compute-section activity-section"><div className="compute-section-head"><div><div className="compute-card-label">RECENT USAGE</div><h2>Compute activity</h2></div><a href="/settings">Manage API keys ↗</a></div>{activity.length === 0 ? <p className="compute-empty">No settled compute activity yet.</p> : <div className="compute-activity-list">{activity.slice(0, 4).map((item) => <div className="compute-activity-row" key={item.operation_key}><span className="activity-status"><i /></span><span><b>{item.model}</b><small>{relativeTime(item.created_at)} · {item.input_tokens ?? "—"} in / {item.output_tokens ?? "—"} out</small></span><strong>{compactUsd(item.user_debit_micro_usd)}</strong></div>)}</div>}</section>
      </>}
      {notice && <p className="compute-notice" role="status">{notice}</p>}
    </section>{selectedModel && <ModelDetails model={selectedModel} canUse={balanceAvailable && eligibility === "eligible"} onClose={closeModelDetails} onUse={() => void useSelectedModel()} onCopied={setCopyNotice} />}{copyNotice && <div className="model-copy-feedback" role="status">{copyNotice}</div>}</main>;
}
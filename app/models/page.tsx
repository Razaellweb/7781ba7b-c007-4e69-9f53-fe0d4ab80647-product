"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import WorkspaceShell from "../../components/WorkspaceShell";
import ModelLogo from "../../components/ModelLogo";
import "../dashboard/dashboard.css";
import "../dashboard/dashboard-overview.css";

type Model = { id: string; displayName: string; description?: string | null; family: string | null; featured: boolean; registryStatus: string; provider: string; providerLabel?: string | null; providerModelSlug: string; contextLength: number | null; pricing: Record<string, string> | null; architecture: { inputModalities: string[]; outputModalities: string[] } | null; supportedParameters: string[] | null; availability: "available" | "unavailable" | "stale"; syncStatus: string };
type LoadState = "loading" | "ready" | "error";

const operational = (model: Model) => model.registryStatus === "active" && model.syncStatus === "current" && model.availability === "available";
const contextLabel = (value: number | null) => { if (value == null || value <= 0) return null; return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M tokens` : `${Math.round(value / 1000)}K tokens`; };
const pricingValue = (pricing: Record<string, string> | null, keys: string[]) => { const key = keys.find((candidate) => pricing?.[candidate] != null); const numeric = key ? Number(pricing?.[key]) : NaN; return Number.isFinite(numeric) && numeric >= 0 ? `$${(numeric * 1_000_000).toFixed(2)}` : null; };
const statusLabel = (model: Model) => model.registryStatus === "paused" ? "Paused" : model.availability === "stale" || model.syncStatus === "stale" ? "Metadata stale" : model.availability === "unavailable" || model.syncStatus === "unavailable" || model.syncStatus === "never" ? "Unavailable" : operational(model) ? "Available" : model.registryStatus.replaceAll("_", " ");
const creatorLabel = (model: Model) => model.providerLabel?.trim() || model.family?.trim() || model.provider;
const dedupeModels = (models: Model[]) => { const seen = new Set<string>(); const unique: Model[] = []; for (const model of models) { const key = (model.id || "").trim().toLowerCase(); if (!key || seen.has(key)) continue; seen.add(key); unique.push(model); } return unique; };

export default function ModelsPage() {
  const { ready, authenticated } = usePrivy();
  const router = useRouter();
  const [models, setModels] = useState<Model[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [query, setQuery] = useState("");

  // The registry is public and identity-independent: it is fetched without a
  // session token and never filtered by ownership state.
  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/models", { cache: "no-store" });
      if (!response.ok) throw new Error("MODELS_UNAVAILABLE");
      const data = await response.json() as { models?: Model[] };
      setModels(Array.isArray(data.models) ? dedupeModels(data.models) : []);
      setState("ready");
    } catch { setModels([]); setState("error"); }
  }, []);

  useEffect(() => { if (ready && !authenticated) router.replace("/signup"); }, [ready, authenticated, router]);
  useEffect(() => { if (ready && authenticated) void load(); }, [ready, authenticated, load]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return models;
    return models.filter((model) => `${model.displayName} ${model.family ?? ""} ${creatorLabel(model)}`.toLowerCase().includes(term));
  }, [models, query]);

  if (!ready || !authenticated) return <main className="dashboard-gate"><div className="gate-inner"><span className="mark large"><img src="/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png" alt="favicon" /></span><p>{ready ? "Redirecting to sign in\u2026" : "Restoring your session\u2026"}</p></div></main>;

  return <WorkspaceShell section="models" dashboardClassName="models-dashboard">
    <header className="compute-header">
      <div className="compute-header-copy">
        <div className="compute-eyebrow">WORKSPACE</div>
        <h1>Every model, in one place.</h1>
        <p>The available open-weight models, with live provider availability.</p>
      </div>
      <div className="compute-header-actions"><button type="button" onClick={() => void load()} disabled={state === "loading"}>{state === "loading" ? "Loading\u2026" : "Refresh \u21bb"}</button></div>
    </header>
    <section className="compute-section models-primary">
      <div className="compute-section-head">
        <div><div className="compute-card-label">MODELS</div><h2>{filtered.length} {filtered.length === 1 ? "model" : "models"}</h2></div>
        <input className="models-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models or providers" aria-label="Search models" />
      </div>
      {state === "loading" ? <div className="compute-status-panel"><span className="compute-status-mark">\u25cb</span><div><h2>Loading models</h2><p>Fetching current provider availability. No cached availability is shown.</p></div></div>
        : state === "error" ? <div className="models-error" role="alert">Models could not be loaded.<br/><button onClick={() => void load()}>Retry models \u21bb</button></div>
        : filtered.length === 0 ? <div className="compute-empty" role="status">{models.length === 0 ? "No models are available right now." : "No models match that search."}</div>
        : <div className="compute-model-grid models-quad">{filtered.map((model) => {
          const isOperational = operational(model);
          const input = pricingValue(model.pricing, ["prompt", "input"]);
          const output = pricingValue(model.pricing, ["completion", "output"]);
          const priceNote = input || output ? `${input ?? "\u2014"} in \u00b7 ${output ?? "\u2014"} out per 1M` : "Pricing unavailable";
          const context = contextLabel(model.contextLength);
          return <article key={model.id} className={`compute-model-card ${isOperational ? "" : "is-gated"}`}>
            <div className="model-card-top"><span className="model-glyph"><ModelLogo model={model} /></span><span className={`model-status ${isOperational ? "" : model.registryStatus === "paused" ? "paused" : "unavailable"}`}><i /> {statusLabel(model)}</span></div>
            <h3>{model.displayName}</h3>
            <p className="model-card-by">by {creatorLabel(model)}</p>
            <p className="model-card-summary">{model.description?.trim() || "Ready to use through your compute allowance."}</p>
            <p className="model-card-by">{context ? `${context} context` : "Context window unavailable"} \u00b7 {priceNote}</p>
            {isOperational
              ? <Link className="model-list-action" href={`/playground?model=${encodeURIComponent(model.id)}`}>Open in Playground <span aria-hidden="true">\u2192</span></Link>
              : <span className="model-list-action is-disabled">Unavailable</span>}
          </article>;
        })}</div>}
    </section>
  </WorkspaceShell>;
}
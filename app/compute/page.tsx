"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import WorkspaceShell from "../../components/WorkspaceShell";
import "../dashboard/dashboard.css";
import "../dashboard/dashboard-overview.css";

type Activity = { operation_key: string; model: string; status: string; input_tokens: number | null; output_tokens: number | null; user_debit_micro_usd: string | null; created_at: string };

const clampMicroUsd = (micro: string | null | undefined) => { try { const value = BigInt(micro ?? "0"); return value > 0n ? value : 0n; } catch { return 0n; } };
// Cents for normal amounts ("$100.00"), rounded down so a balance is never
// overstated; sub-cent amounts (a single request) keep micro-dollar precision.
const formatMicroUsd = (micro: string | null | undefined) => { const value = clampMicroUsd(micro); if (value > 0n && value < 10_000n) return `$0.${value.toString().padStart(6, "0").replace(/0+$/, "")}`; const cents = value / 10_000n; return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, "0")}`; };
const relativeTime = (iso: string) => { const timestamp = new Date(iso).getTime(); if (Number.isNaN(timestamp)) return ""; const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago`; };

export default function UsagePage() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const router = useRouter();
  const [available, setAvailable] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!authenticated) return;
    setState("loading");
    setNotice("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("AUTH_REQUIRED");
      const headers = { Authorization: `Bearer ${token}` };
      const [allowanceResponse, activityResponse] = await Promise.all([fetch("/api/allowance", { headers, cache: "no-store" }), fetch("/api/activity", { headers, cache: "no-store" })]);
      if (allowanceResponse.status === 401) { setNotice("Your session has expired. Sign in again to view usage."); setState("error"); return; }
      if (!allowanceResponse.ok || !activityResponse.ok) throw new Error("USAGE_UNAVAILABLE");
      const allowanceData = await allowanceResponse.json() as { balance?: { available?: string }; allowance?: { amount_micro_usd?: string } | null };
      const activityData = await activityResponse.json() as { activity?: Activity[] };
      setAvailable(allowanceData.balance?.available ?? null);
      setAllowance(allowanceData.allowance?.amount_micro_usd ?? null);
      setActivity(activityData.activity ?? []);
      setState("ready");
    } catch {
      setAvailable(null);
      setAllowance(null);
      setActivity([]);
      setState("error");
      setNotice("Usage data could not be loaded. Retry to request fresh values.");
    }
  }, [authenticated, getAccessToken]);

  useEffect(() => { if (ready && !authenticated) router.replace("/signup"); }, [ready, authenticated, router]);
  useEffect(() => { if (ready && authenticated) void load(); }, [ready, authenticated, load]);

  const summary = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = activity.filter((item) => { const time = new Date(item.created_at).getTime(); return Number.isFinite(time) && time >= cutoff; });
    const spend = recent.reduce((total, item) => total + clampMicroUsd(item.user_debit_micro_usd), 0n);
    const inputTokens = activity.reduce((total, item) => total + (item.input_tokens ?? 0), 0);
    const outputTokens = activity.reduce((total, item) => total + (item.output_tokens ?? 0), 0);
    return { spendMicroUsd: spend.toString(), requests: activity.length, tokens: inputTokens + outputTokens };
  }, [activity]);

  if (!ready || !authenticated) return <main className="dashboard-gate"><div className="gate-inner"><span className="mark large"><img src="/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png" alt="favicon" /></span><p>{ready ? "Redirecting to sign in…" : "Restoring your session…"}</p></div></main>;

  return <WorkspaceShell section="usage" dashboardClassName="usage-dashboard">
    <header className="compute-header">
      <div className="compute-header-copy">
        <div className="compute-eyebrow">WORKSPACE</div>
        <h1>Usage, clearly measured.</h1>
        <p>Every settled request, charged from your compute allowance at actual provider cost.</p>
      </div>
      <div className="compute-header-actions"><button type="button" onClick={() => void load()} disabled={state === "loading"}>{state === "loading" ? "Loading…" : "Refresh ↻"}</button></div>
    </header>
    {state === "error" ? <div className="compute-status-panel"><span className="compute-status-mark">!</span><div><h2>Usage is unavailable</h2><p>{notice || "Usage data could not be loaded. No previous values are presented."}</p><button className="compute-retry" onClick={() => void load()}>Retry usage ↻</button></div></div>
      : <section className="compute-allowance" aria-label="Usage summary">
        <div className="compute-allowance-main">
          <div className="compute-card-label">COMPUTE ALLOWANCE</div>
          <div className="compute-allowance-figure">
            <strong>{state === "ready" && available !== null ? formatMicroUsd(available) : "—"}</strong>
            {allowance && <span className="compute-allowance-total">/ {formatMicroUsd(allowance)}</span>}
          </div>
          <div className="compute-progress"><span style={{ width: `${state === "ready" && clampMicroUsd(available) > 0n ? 100 : 0}%` }} /></div>
        </div>
        <dl className="compute-stats">
          <div><dt>USAGE (30D)</dt><dd>{state === "ready" ? formatMicroUsd(summary.spendMicroUsd) : "—"}</dd></div>
          <div><dt>REQUESTS</dt><dd>{state === "ready" ? summary.requests : "—"}</dd></div>
          <div><dt>TOKENS</dt><dd>{state === "ready" ? summary.tokens.toLocaleString() : "—"}</dd></div>
        </dl>
      </section>}
    <section className="compute-section activity-section">
      <div className="compute-section-head"><div><div className="compute-card-label">RECENT ACTIVITY</div><h2>Compute activity</h2></div></div>
      {state === "loading" ? <div className="compute-status-panel"><span className="compute-status-mark">○</span><div><h2>Loading usage</h2><p>Fetching your current ledger balance and settled requests.</p></div></div>
        : state === "ready" && activity.length === 0 ? <p className="compute-empty">No settled compute activity yet.</p>
        : state === "ready" ? <div className="compute-activity-list">{activity.map((item) => <div className="compute-activity-row" key={item.operation_key}><span className="activity-status"><i /></span><span><b>{item.model}</b><small>{relativeTime(item.created_at)} · {item.input_tokens ?? "—"} in / {item.output_tokens ?? "—"} out</small></span><strong>{formatMicroUsd(item.user_debit_micro_usd)}</strong></div>)}</div>
        : null}
    </section>
  </WorkspaceShell>;
}

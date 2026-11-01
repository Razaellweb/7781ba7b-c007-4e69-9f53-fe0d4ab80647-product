"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import Link from "next/link";
import "../globals.css";
import "../dashboard/dashboard.css";
import "./api-keys.css";

type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  rate_limit_per_minute: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};
type PendingAction = { type: "revoke" | "rotate"; key: ApiKey };
type ApiKeyResult = { key: ApiKey; secret: string };
type ApiError = { error?: string };

const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString() : "Never";

export default function SettingsPage() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const actionInProgress = useRef(false);

  const headers = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("Your session has expired. Sign in again to manage API keys.");
    return { Authorization: `Bearer ${token}` };
  }, [getAccessToken]);

  const load = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/api-keys", { headers: await headers(), cache: "no-store" });
      const data = await response.json() as { keys?: ApiKey[] } & ApiError;
      if (!response.ok) throw new Error(data.error ?? "Unable to load API keys.");
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load API keys.");
    } finally {
      setLoading(false);
    }
  }, [authenticated, headers]);

  useEffect(() => {
    if (ready && authenticated) void load();
    else if (ready) setLoading(false);
  }, [ready, authenticated, load]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || actionInProgress.current) return;
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80) {
      setSecret("");
      setMessage({ tone: "error", text: "Enter a key name between 1 and 80 characters." });
      return;
    }
    actionInProgress.current = true;
    setBusy(true);
    setMessage(null);
    setSecret("");
    try {
      const response = await fetch("/api/api-keys", {
        method: "POST",
        headers: { ...(await headers()), "Content-Type": "application/json" },
        body: JSON.stringify({ name: normalizedName }),
      });
      const data = await response.json() as ApiKeyResult & ApiError;
      if (!response.ok) throw new Error(data.error ?? "Unable to create API key. Please try again.");
      if (!data.key?.id || data.key.name !== normalizedName || data.key.revoked_at || !/^ow_live_[A-Za-z0-9_-]{43}$/.test(data.secret)) {
        throw new Error("The API key could not be confirmed. Refresh the key list before retrying.");
      }
      setKeys((current) => [data.key, ...current.filter((key) => key.id !== data.key.id)]);
      setSecret(data.secret);
      setMessage({ tone: "success", text: "API key created. Copy the secret now; it will only be shown once." });
      setName("");
      await load();
    } catch (error) {
      const retryableMessage = error instanceof TypeError || error instanceof SyntaxError
        ? "The API key service could not be reached. Please refresh your keys and try again."
        : error instanceof Error
          ? error.message
          : "Unable to create API key. Please try again.";
      setMessage({ tone: "error", text: retryableMessage });
    } finally {
      actionInProgress.current = false;
      setBusy(false);
    }
  };

  const performAction = async () => {
    if (!pendingAction || busy || actionInProgress.current) return;
    const action = pendingAction;
    actionInProgress.current = true;
    setBusy(true);
    setPendingAction(null);
    setMessage(null);
    setSecret("");
    try {
      const actionUrl = action.type === "rotate" ? `/api/api-keys/${action.key.id}/rotate` : `/api/api-keys/${action.key.id}`;
      const replacementName = `${action.key.name.slice(0, 52)} replacement ${Date.now()}`;
      const response = await fetch(actionUrl, {
        method: "POST",
        headers: action.type === "rotate"
          ? { ...(await headers()), "Content-Type": "application/json" }
          : await headers(),
        ...(action.type === "rotate"
          ? { body: JSON.stringify({ name: replacementName, scopes: action.key.scopes, rateLimitPerMinute: action.key.rate_limit_per_minute }) }
          : {}),
      });
      const data = await response.json() as (ApiKeyResult & ApiError) | ApiError;
      if (!response.ok) throw new Error(data.error ?? `Unable to ${action.type} API key.`);
      if (action.type === "rotate" && "secret" in data) {
        setSecret(data.secret);
        setMessage({ tone: "success", text: "Key rotated. The old key has been revoked. Copy this replacement secret now; it will only be shown once." });
      } else {
        setMessage({ tone: "success", text: "API key revoked. It can no longer be used." });
      }
      await load();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : `Unable to ${action.type} API key.` });
    } finally {
      actionInProgress.current = false;
      setBusy(false);
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Select the secret text to copy it.");
      await navigator.clipboard.writeText(secret);
      setMessage({ tone: "success", text: "Secret copied. Keep it somewhere secure; it cannot be retrieved later." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Unable to copy secret." });
    }
  };

  const dismissSecret = () => {
    setSecret("");
    setMessage({ tone: "success", text: "One-time secret dismissed. It cannot be retrieved; use Rotate on this key to create a replacement." });
  };

  if (!ready) return <main className="compute-dashboard"><div className="compute-status-panel"><div><h2>Checking your session</h2><p>Preparing secure API key access.</p></div></div></main>;
  if (!authenticated) return <main className="compute-dashboard"><div className="compute-status-panel"><div><h2>Sign in to manage API keys</h2><p>First-party keys belong to your authenticated Openweight account.</p><Link className="key-link-button" href="/signup">Sign in</Link></div></div></main>;

  return (
    <main className="compute-dashboard api-keys-dashboard">
      <aside className="compute-sidebar">
        <Link className="compute-brand key-brand" href="/"><span className="mark"><img src="/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png" alt="favicon" /></span><span>OPENWEIGHT</span></Link>
        <div className="compute-eyebrow">OPEN-WEIGHT FRONTIER</div>
        <nav aria-label="Workspace navigation">
          <Link href="/dashboard">Overview</Link>
          <Link href="/playground">Playground</Link>
          <Link className="active" href="/settings" aria-current="page">API Keys</Link>
          <Link href="/gpu">GPU</Link>
        </nav>
        <div className="compute-sidebar-foot"><div>ACCOUNT / API ACCESS</div><small>First-party credentials</small></div>
      </aside>
      <section className="compute-main api-keys-main">
        <header className="compute-header api-keys-header">
          <div>
            <div className="compute-eyebrow">WORKSPACE / DEVELOPER ACCESS</div>
            <h1>Keys, kept<br/><em>in your control.</em></h1>
            <p>Create credentials for your own integrations. Secrets are shown once at creation and are never included in the key list.</p>
          </div>
          <div className="compute-header-actions">
            <span className="compute-access"><i /> PRIVATE TO YOUR ACCOUNT</span>
            <button type="button" onClick={() => void load()} disabled={loading || busy}>{loading ? "Refreshing..." : "Refresh"}</button>
          </div>
        </header>
        <section className="chat-api-guide" aria-labelledby="chat-api-guide-title">
          <div className="chat-api-guide-heading">
            <div className="compute-card-label">CHAT COMPLETIONS API</div>
            <h2 id="chat-api-guide-title">Your key, your integration.</h2>
            <div className="chat-api-base"><span>BASE URL</span><a href="https://openweight.systems" target="_blank" rel="noreferrer">https://openweight.systems</a></div>
          </div>
          <div className="chat-api-endpoint"><span className="chat-api-method">POST</span><code>/api/v1/chat/completions</code><span className="chat-api-auth">Bearer API key</span></div>
          <div className="chat-api-details">
            <pre className="chat-api-example"><code>{`{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Hello" }]
}`}</code></pre>
            <div className="chat-api-notes"><p>Send a JSON request with <code>Authorization: Bearer &lt;your key&gt;</code>.</p><span><strong>model</strong> accepts <code>auto</code> or a curated model ID.</span><span><strong>messages</strong> use system, user, or assistant roles with text content.</span><span><strong>stream</strong> may be set to <code>true</code> for streamed event responses.</span></div>
          </div>
        </section>
        <div className="api-keys-layout">
          <section className="key-panel create-key-panel">
            <div className="compute-card-label">CREATE A KEY</div>
            <h2>A credential for your integration.</h2>
            <p className="key-panel-copy">Choose a recognizable name. Keys stay active until you revoke them.</p>
            <form onSubmit={(event) => void create(event)}>
              <label htmlFor="api-key-name">Key name</label>
              <input id="api-key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production integration" required maxLength={80} disabled={busy} />
              <button className="key-primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? "Working..." : "Create API key"}</button>
            </form>
            {secret && <div className="one-time-secret" aria-live="polite"><div className="one-time-label">ONE-TIME SECRET</div><strong>Copy it now. This secret will only be shown once.</strong><p>If dismissed or lost, it cannot be retrieved. Rotate this key to obtain a replacement.</p><code>{secret}</code><div className="secret-actions"><button className="key-primary-button" type="button" onClick={() => void copySecret()}>Copy secret</button><button className="key-quiet-button" type="button" onClick={dismissSecret}>Dismiss</button></div></div>}
          </section>
          <section className="key-panel key-list-panel">
            <div className="key-list-heading"><div><div className="compute-card-label">YOUR API KEYS</div><h2>Active and past credentials</h2></div><span className="key-count">{keys.filter((key) => !key.revoked_at).length} active</span></div>
            {loading ? <div className="key-state" role="status"><span className="key-state-indicator" />Loading your keys...</div> : loadError && keys.length === 0 ? <div className="key-state key-state-error" role="alert"><strong>Keys could not be loaded</strong><p>{loadError}</p><button className="key-quiet-button" type="button" onClick={() => void load()}>Try again</button></div> : keys.length === 0 ? <div className="key-state key-empty"><span className="key-empty-mark">*</span><strong>No API keys yet.</strong><p>Create a key when you are ready to connect your own integration. Your secret will be displayed only once.</p></div> : <div className="key-list">{loadError && <div className="key-state key-state-error" role="status"><strong>Could not refresh the key list</strong><p>{loadError} Your latest confirmed keys are still shown.</p><button className="key-quiet-button" type="button" onClick={() => void load()}>Try again</button></div>}{keys.map((key) => <article className={`key-row ${key.revoked_at ? "is-revoked" : ""}`} key={key.id}><div className="key-row-main"><div className="key-row-title"><h3>{key.name}</h3><span className={`key-status ${key.revoked_at ? "revoked" : "active"}`}><i />{key.revoked_at ? "Revoked" : "Active"}</span></div><code className="key-prefix">{key.key_prefix}_.............</code><p>{key.scopes.join(" / ")} / {key.rate_limit_per_minute} requests per minute</p><small>Created {dateLabel(key.created_at)} / Last used {dateLabel(key.last_used_at)}</small></div>{!key.revoked_at && <div className="key-row-actions"><button className="key-quiet-button" type="button" disabled={busy} onClick={() => { setMessage(null); setPendingAction({ type: "rotate", key }); }}>Rotate</button><button className="key-danger-button" type="button" disabled={busy} onClick={() => { setMessage(null); setPendingAction({ type: "revoke", key }); }}>Revoke</button></div>}</article>)}</div>}
          </section>
        </div>
        {message && <div className={`key-feedback ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</div>}
      </section>
      {pendingAction && <div className="key-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPendingAction(null); }}><section className="key-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="key-confirm-title" aria-describedby="key-confirm-description"><div className="compute-card-label">CONFIRM KEY {pendingAction.type === "rotate" ? "ROTATION" : "REVOCATION"}</div><h2 id="key-confirm-title">{pendingAction.type === "rotate" ? "Replace this key?" : "Revoke this key?"}</h2><p id="key-confirm-description">{pendingAction.type === "rotate" ? <>A new secret will be issued for <strong>{pendingAction.key.name}</strong>, and this key will be revoked. The replacement secret is shown once.</> : <><strong>{pendingAction.key.name}</strong> will stop working immediately. This action cannot be undone.</>}</p><div className="key-confirm-actions"><button type="button" className="key-quiet-button" disabled={busy} onClick={() => setPendingAction(null)}>Cancel</button><button type="button" className={pendingAction.type === "rotate" ? "key-primary-button" : "key-danger-button"} disabled={busy} onClick={() => void performAction()}>{busy ? "Working..." : pendingAction.type === "rotate" ? "Rotate key" : "Revoke key"}</button></div></section></div>}
    </main>
  );
}

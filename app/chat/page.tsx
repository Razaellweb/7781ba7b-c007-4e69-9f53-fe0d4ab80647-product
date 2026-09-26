"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter, useSearchParams } from "next/navigation";

type Model = { id: string; displayName: string; family: string | null; contextLength: number | null; availability: "available" | "unavailable" | "stale"; syncStatus: string; registryStatus: string; supportedParameters: string[] | null };
type Message = { role: "user" | "assistant"; content: string; partial?: boolean };
type Conversation = { id: string; title: string | null; updated_at: string; message_count?: number };
type Status = "loading" | "ready" | "streaming" | "stopped" | "failed" | "unavailable";
type AccessStatus = "checking" | "unverified" | "eligible" | "ineligible" | "error";
type Parameters = { systemPrompt: string; temperature: string; topP: string; maxTokens: string; seed: string; stop: string };
const emptyParameters: Parameters = { systemPrompt: "", temperature: "", topP: "", maxTokens: "", seed: "", stop: "" };
const supported = (model: Model | null, name: string) => Boolean(model?.supportedParameters?.some((item) => item.toLowerCase() === name.toLowerCase()));
const isOperational = (model: Model | null) => Boolean(model && model.availability === "available" && model.syncStatus === "current" && model.registryStatus === "active");

function formatBalance(value: string) { try { const amount = BigInt(value || "0"); return `$${(amount / 1000000n).toString()}.${(amount % 1000000n).toString().padStart(6, "0")}`; } catch { return "Unavailable"; } }
function isPositive(value: string) { try { return BigInt(value || "0") > 0n; } catch { return false; } }
function relativeTime(value: string) { const time = new Date(value).getTime(); if (!Number.isFinite(time)) return ""; const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000); if (minutes < 1) return "just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`; }

function PlaygroundContent() {
  const { ready: authReady, authenticated, getAccessToken } = usePrivy();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedModel = searchParams.get("model");
  const requestedConversation = searchParams.get("conversation");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState<Model | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [parameters, setParameters] = useState<Parameters>(emptyParameters);
  const [balance, setBalance] = useState("0");
  const [balanceAvailable, setBalanceAvailable] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [access, setAccess] = useState<AccessStatus>("checking");
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showParameters, setShowParameters] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const operationRef = useRef<string | null>(null);
  const conversationLoadRef = useRef(0);

  const authHeaders = useCallback(async () => { const token = await getAccessToken(); if (!token) throw new Error("AUTH_REQUIRED"); return { Authorization: `Bearer ${token}` }; }, [getAccessToken]);
  const operational = isOperational(model);
  const canSubmit = authenticated && access === "eligible" && balanceAvailable && operational && status !== "streaming" && status !== "loading" && draft.trim().length > 0;
  const capability = useMemo(() => ({ temperature: supported(model, "temperature"), topP: supported(model, "top_p") || supported(model, "topP"), maxTokens: supported(model, "max_tokens") || supported(model, "max_completion_tokens"), seed: supported(model, "seed"), stop: supported(model, "stop") }), [model]);
  const availableModels = useMemo(() => models.filter(isOperational), [models]);
  const filteredConversations = useMemo(() => conversations.filter((item) => (item.title || "New conversation").toLowerCase().includes(historySearch.toLowerCase())), [conversations, historySearch]);

  const refreshHistory = useCallback(async (headers?: HeadersInit) => {
    const requestHeaders = headers ?? await authHeaders();
    const response = await fetch("/api/conversations", { headers: requestHeaders, cache: "no-store" });
    if (!response.ok) throw new Error("CONVERSATION_HISTORY_UNAVAILABLE");
    const data = await response.json() as { conversations?: Conversation[] };
    setConversations(Array.isArray(data.conversations) ? data.conversations : []);
  }, [authHeaders]);

  const load = useCallback(async () => {
    if (!authenticated) return;
    setStatus("loading"); setAccess("checking"); setError(""); setBalance("0"); setBalanceAvailable(false);
    try {
      const headers = await authHeaders();
      const [modelsResponse, allowanceResponse] = await Promise.all([fetch("/api/models", { headers, cache: "no-store" }), fetch("/api/allowance", { headers, cache: "no-store" }), refreshHistory(headers)]).then(([modelsResult, allowanceResult]) => [modelsResult, allowanceResult] as const);
      if (!modelsResponse.ok) throw new Error("MODEL_REGISTRY_UNAVAILABLE");
      const modelData = await modelsResponse.json() as { models?: Model[] };
      const nextModels = Array.isArray(modelData.models) ? modelData.models : [];
      setModels(nextModels);
      const requested = requestedModel ? nextModels.find((item) => item.id === requestedModel) : undefined;
      const selected = requestedModel ? requested ?? null : nextModels.find(isOperational) ?? null;
      setModel(selected);
      if (requestedModel && !requested) {
        setStatus("unavailable"); setError("The selected model is no longer in the curated registry. Choose an available model before starting inference.");
      } else if (selected && !isOperational(selected)) {
        setStatus("unavailable"); setError("The selected model is currently unavailable. Choose another operational curated model.");
      } else if (!nextModels.some(isOperational)) {
        setStatus("unavailable"); setError(nextModels.length ? "No curated models are operational right now. No inference request can be started." : "There are no available curated models right now. The registry may be empty or temporarily unavailable.");
      } else setStatus("ready");
      if (allowanceResponse.ok) {
        const allowance = await allowanceResponse.json() as { balance?: { available?: string } };
        const available = allowance.balance?.available;
        if (typeof available === "string") { setBalance(available); setBalanceAvailable(true); setAccess("eligible"); }
        else { setAccess("error"); setError((current) => current || "The compute allowance response did not include an authoritative balance."); }
      } else if (allowanceResponse.status === 403) {
        setAccess("unverified");
      } else if (allowanceResponse.status === 401) {
        setAccess("error"); setStatus("unavailable"); setError("Your authenticated session has expired. Sign in again before using the Playground.");
      } else {
        setAccess("error"); setStatus("unavailable"); setError("Compute allowance could not be loaded. No billable request can start.");
      }
      if (requestedConversation) await openConversation(requestedConversation, headers, false);
    } catch (caught) {
      setModels([]); setModel(null); setBalanceAvailable(false); setAccess("error"); setStatus("unavailable");
      setError(caught instanceof Error && caught.message === "CONVERSATION_HISTORY_UNAVAILABLE" ? "Conversation history could not be loaded. Refresh to retry; no inference was started." : "The Playground could not load its curated registry, access, or compute data. Retry without starting a request.");
    }
  }, [authenticated, authHeaders, refreshHistory, requestedConversation, requestedModel]);

  const openConversation = useCallback(async (id: string, headers?: HeadersInit, updateUrl = true) => {
    const loadId = ++conversationLoadRef.current;
    try {
      const requestHeaders = headers ?? await authHeaders();
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { headers: requestHeaders, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "This conversation is unavailable or no longer accessible." : "Conversation messages could not be loaded.");
      const data = await response.json() as { conversation?: Conversation; messages?: Array<{ role: string; content: string; partial?: boolean; model_slug?: string | null }> };
      if (loadId !== conversationLoadRef.current) return;
      setConversationId(id);
      setMessages((data.messages ?? []).filter((item): item is typeof item & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant").map((item) => ({ role: item.role, content: item.content, partial: Boolean(item.partial) })));
      if (updateUrl) router.replace(`/chat?${new URLSearchParams({ ...(model ? { model: model.id } : {}), conversation: id }).toString()}`);
      setError("");
      if (status !== "streaming") setStatus("ready");
    } catch (caught) {
      if (loadId !== conversationLoadRef.current) return;
      setError(caught instanceof Error ? caught.message : "Conversation messages could not be loaded."); setStatus("failed");
    }
  }, [authHeaders, model, router, status]);

  useEffect(() => { if (authReady && !authenticated) router.replace("/signup"); }, [authReady, authenticated, router]);
  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [load]);

  const changeModel = (next: Model) => {
    if (!isOperational(next) || status === "streaming") return;
    setModel(next); setError("");
    router.replace(`/chat?${new URLSearchParams({ model: next.id, ...(conversationId ? { conversation: conversationId } : {}) }).toString()}`);
  };
  const updateParameter = (key: keyof Parameters, value: string) => setParameters((current) => ({ ...current, [key]: value }));
  const newConversation = () => { if (status === "streaming") return; conversationLoadRef.current += 1; setConversationId(undefined); setMessages([]); setDraft(""); setError(""); setStatus("ready"); router.replace(`/chat${model ? `?model=${encodeURIComponent(model.id)}` : ""}`); };

  const verifyAccess = async () => {
    if (access === "checking") return;
    setAccess("checking"); setError(""); setStatus((current) => current === "streaming" ? current : "loading");
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/holder/verify?force=true", { method: "POST", headers, cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 429 ? "Please wait briefly before checking holder access again." : "Holder verification could not be completed. Access remains unverified.");
      const result = await response.json() as { eligibility?: { state?: string } };
      if (result.eligibility?.state !== "eligible") {
        setAccess("ineligible"); setBalance("0"); setBalanceAvailable(false); setStatus("ready");
        setError(result.eligibility?.state === "insufficient_balance" ? "This wallet does not currently meet the configured holding requirement. Inference remains unavailable." : "Holder access could not be confirmed for this wallet or network. Inference remains unavailable.");
        return;
      }
      const allowanceResponse = await fetch("/api/allowance", { headers, cache: "no-store" });
      if (!allowanceResponse.ok) throw new Error("Holder access was confirmed, but the current compute allowance could not be loaded.");
      const allowance = await allowanceResponse.json() as { balance?: { available?: string } };
      if (typeof allowance.balance?.available !== "string") throw new Error("The allowance service did not return an authoritative balance.");
      setBalance(allowance.balance.available); setBalanceAvailable(true); setAccess("eligible"); setStatus("ready"); setError("");
    } catch (caught) {
      setAccess("error"); setBalance("0"); setBalanceAvailable(false); setStatus("unavailable"); setError(caught instanceof Error ? caught.message : "Holder verification failed. Access remains unverified.");
    }
  };

  const stop = async () => {
    const current = operationRef.current;
    abortRef.current?.abort();
    setStatus("stopped");
    setError("Generation stopped. Any received text is partial; the response was not marked complete.");
    if (current) {
      try { const headers = await authHeaders(); await fetch("/api/inference/stop", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operationKey: current }) }); }
      catch { /* Client cancellation remains active; the server safely finalizes any received usage. */ }
    }
  };

  const submit = async (event?: FormEvent<HTMLFormElement>, retryText?: string) => {
    event?.preventDefault();
    const text = (retryText ?? draft).trim();
    if (!text || !model || !canSubmit || !isOperational(model)) return;
    const requestId = crypto.randomUUID(); const requestModel = model; const controller = new AbortController(); abortRef.current = controller; operationRef.current = requestId;
    setDraft(""); setError(""); setStatus("streaming");
    setMessages((current) => {
      const next = [...current];
      if (retryText && next.at(-1)?.role === "assistant" && next.at(-2)?.role === "user" && next.at(-2)?.content === text) next.pop();
      else next.push({ role: "user", content: text });
      next.push({ role: "assistant", content: "", partial: true });
      return next;
    });
    let terminalEvent = false;
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/chat", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ conversationId, message: text, model: requestModel.id, operationKey: requestId, clientRequestId: requestId, parameters: { systemPrompt: parameters.systemPrompt || undefined, temperature: parameters.temperature === "" ? undefined : Number(parameters.temperature), topP: parameters.topP === "" ? undefined : Number(parameters.topP), maxTokens: parameters.maxTokens === "" ? undefined : Number(parameters.maxTokens), seed: parameters.seed === "" ? undefined : Number(parameters.seed), stop: parameters.stop ? parameters.stop.split("\n") : undefined } }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (response.status === 402 || body.code === "INSUFFICIENT_COMPUTE" || body.code === "ALLOWANCE_MISSING" || body.code === "ALLOWANCE_EXPIRED") { setBalance("0"); setBalanceAvailable(false); throw new Error(body.error || "Insufficient compute allowance. No inference response was completed."); }
        if (response.status === 403 && body.code !== "INSUFFICIENT_SCOPE") { setAccess("unverified"); throw new Error(body.error || "Server-side holder eligibility is required. Run an explicit holder check before retrying."); }
        throw new Error(body.error || "The Playground request was rejected before provider work began.");
      }
      if (!response.body) throw new Error("The Playground returned no response stream. Inference was not confirmed complete.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const processEvent = (event: string) => {
        const line = event.split("\n").find((item) => item.startsWith("data: "));
        if (!line) return;
        const payload = JSON.parse(line.slice(6)) as { type?: string; text?: string; conversationId?: string; error?: string; code?: string };
        if (payload.type === "delta" && payload.text) setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: item.content + payload.text } : item));
        else if (payload.type === "complete") {
          terminalEvent = true;
          if (payload.conversationId) { setConversationId(payload.conversationId); router.replace(`/chat?${new URLSearchParams({ model: requestModel.id, conversation: payload.conversationId }).toString()}`); }
          setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, partial: false } : item)); setStatus("ready");
        } else if (payload.type === "cancelled") {
          terminalEvent = true; setStatus("stopped"); setError("Generation stopped. Any received text is partial; the response was not marked complete.");
        } else if (payload.type === "error") throw new Error(payload.error || "Inference failed before completion.");
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
        for (const item of events) processEvent(item);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer);
      if (!terminalEvent) throw new Error("The response stream ended before a completion event arrived. The response is incomplete; retry to continue.");
      if (terminalEvent && !controller.signal.aborted) { setStatus((current) => current === "streaming" ? "ready" : current); void refreshHistory().catch(() => undefined); }
    } catch (caught) {
      if (controller.signal.aborted) {
        setStatus("stopped"); setError("Generation stopped. Any received text is partial; the response was not marked complete.");
      } else {
        setStatus("failed"); setError(caught instanceof Error ? caught.message : "The Playground request failed. The response is not marked complete.");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (operationRef.current === requestId) operationRef.current = null;
    }
  };

  if (!authReady || !authenticated) return <main className="playground-gate">Verifying your session…</main>;
  const lastUserMessage = [...messages].reverse().find((item) => item.role === "user")?.content;
  const zeroCompute = access === "eligible" && balanceAvailable && !isPositive(balance);
  const stateCopy = status === "loading" ? "Loading the current curated registry and workspace data…" : status === "unavailable" ? error : status === "streaming" ? `Generating with ${model?.displayName ?? "the selected model"}…` : status === "stopped" ? error || "Generation stopped. The visible response is partial." : status === "failed" ? error : !model ? error || "Choose an available curated model to begin." : !operational ? error || "This model is unavailable. No provider request can be made." : zeroCompute ? "No compute allowance is available. Inference is not authorized." : access === "unverified" ? "Holder access has not been confirmed. Run a deliberate holder check before inference." : access === "ineligible" || access === "error" ? error || "Holder access or compute could not be confirmed." : "";
  const stateTone = status === "failed" || status === "unavailable" || zeroCompute || access === "unverified" || access === "ineligible" || access === "error" || !model || !operational ? "error" : status === "stopped" ? "stopped" : status === "streaming" ? "streaming" : "";
  const accessLabel = access === "eligible" ? "HOLDER VERIFIED" : access === "checking" ? "CHECKING ACCESS" : access === "unverified" ? "VERIFY ACCESS" : access === "ineligible" ? "NOT ELIGIBLE" : "ACCESS UNAVAILABLE";
  const send = (event: FormEvent<HTMLFormElement>) => { void submit(event); };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (canSubmit) void submit(undefined); } };

  return <main className="playground-shell"><header className="playground-topbar"><button className="playground-back" onClick={() => router.push("/dashboard")}><span aria-hidden="true">←</span> Overview</button><span className="topbar-current">PLAYGROUND</span><div className="topbar-status"><span className={`access-pill ${access === "eligible" ? "good" : "attention"}`}><i />{accessLabel}</span><span className={`playground-balance ${zeroCompute ? "zero" : ""}`}>{balanceAvailable ? formatBalance(balance) : "—"}<small>available compute</small></span></div></header>
    <section className={`playground-layout ${showParameters ? "with-parameters" : ""}`}><div className="playground-main">
      <div className="playground-heading"><div><span className="playground-kicker">WORKSPACE / COMPUTE LAYER</span><h1>Playground<span>.</span></h1><p>One considered space to think with approved open-weight models. Responses use your verified holder access and available compute.</p></div><button className="parameter-toggle" onClick={() => setShowParameters((value) => !value)} aria-expanded={showParameters} aria-controls="playground-parameters">Parameters <span aria-hidden="true">{showParameters ? "−" : "+"}</span></button></div>
      <div className="playground-controls"><div className="playground-model-row"><label htmlFor="curated-model"><span className="playground-kicker">CURATED MODEL</span><select id="curated-model" value={model?.id ?? ""} onChange={(event) => { const next = availableModels.find((item) => item.id === event.target.value); if (next) changeModel(next); }} disabled={status === "streaming" || availableModels.length === 0}><option value="" disabled>{models.length ? "No available models" : "Registry unavailable"}</option>{model && !isOperational(model) && <option value={model.id} disabled>{model.displayName} · unavailable</option>}{availableModels.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><span className={`model-status ${operational ? "operational" : "unavailable"}`}><i />{operational ? "Operational" : model ? "Unavailable" : "No model selected"}</span><span className="selected-model-name">{model ? `${model.displayName}${model.contextLength ? ` · ${model.contextLength.toLocaleString()} context` : ""}` : models.length ? "No operational curated models" : "Curated registry unavailable"}</span></div>
        <div className="access-context"><div className="access-summary"><span className={`access-indicator ${access === "eligible" ? "good" : ""}`} /><div><b>{access === "eligible" ? "Holder access verified" : access === "checking" ? "Checking workspace status" : access === "ineligible" ? "Holder access not confirmed" : "Holder access needs a check"}</b><small>{access === "eligible" ? "Inference still requires an operational model and available compute." : "Eligibility is checked only when you ask. It is never triggered automatically at sign-in."}</small></div></div>{access !== "eligible" && <button className="verify-button" onClick={() => void verifyAccess()} disabled={access === "checking" || status === "streaming"}>{access === "checking" ? "Checking…" : access === "error" ? "Retry holder check ↻" : "Check holder access →"}</button>}{access === "eligible" && <span className="access-verified-note">Server-verified gate remains active</span>}</div>
      </div>
      <div className="conversation-toolbar"><div><span className="playground-kicker">YOUR CONVERSATION</span><span className="conversation-model">{model?.displayName ?? "Select a curated model"}</span></div><div className="conversation-actions"><button type="button" className="history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((value) => !value)}>History{conversations.length ? <span>{conversations.length}</span> : null}</button><button type="button" className="new-conversation" onClick={newConversation} disabled={status === "streaming"}>＋ New chat</button></div></div>
      {showHistory && <section className="history-panel" aria-label="Conversation history"><div className="history-search-wrap"><input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search conversations…" aria-label="Search conversations" /><button type="button" onClick={() => void refreshHistory().catch(() => setError("Conversation history could not be refreshed."))}>Refresh</button></div>{filteredConversations.length ? <div className="history-list">{filteredConversations.map((item) => <button type="button" key={item.id} className={conversationId === item.id ? "active" : ""} onClick={() => void openConversation(item.id)}><span>{item.title || "New conversation"}</span><small>{relativeTime(item.updated_at)}{item.message_count != null ? ` · ${item.message_count} messages` : ""}</small></button>)}</div> : <p className="history-empty">{conversations.length ? "No conversations match that search." : "Your conversations will appear here."}</p>}</section>}
      <div className="playground-messages" aria-live="polite">{messages.length === 0 ? <div className="playground-empty"><div className="empty-mark" aria-hidden="true">✦</div><span className="empty-overline">A QUIET SPACE FOR GOOD QUESTIONS</span><h2>What would you like to work through?</h2><p>Choose an available curated model, add a prompt, and receive its streamed response. Your conversation stays in your workspace history.</p></div> : messages.map((message, index) => <article className={`playground-message ${message.role} ${message.partial ? "partial" : ""}`} key={`${index}-${message.role}`}><span>{message.role === "user" ? "YOU" : model?.displayName?.toUpperCase() || "ASSISTANT"}</span><p>{message.content || (message.partial ? "Waiting for the first response…" : "")}</p>{message.partial && <span className="stream-indicator"><i />{status === "streaming" ? "STREAMING" : "PARTIAL · NOT COMPLETE"}</span>}</article>)}</div>
      {stateCopy && <div className={`playground-state ${stateTone}`} role="status"><span className="state-indicator" />{stateCopy}{status === "failed" && lastUserMessage && access === "eligible" && balanceAvailable && operational && <button onClick={() => { void submit(undefined, lastUserMessage); }}>Retry last prompt</button>}{zeroCompute && <span className="compute-state-label">INSUFFICIENT COMPUTE</span>}</div>}
      <form className="playground-composer" onSubmit={send}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={access !== "eligible" ? "Verify holder access to enable inference…" : !balanceAvailable || zeroCompute ? "No available compute allowance…" : !operational ? "Choose an operational curated model…" : "Message your selected model…"} aria-label="Prompt" disabled={!canSubmit} onKeyDown={onComposerKeyDown} /><div className="composer-footer"><span>Enter to send <b>·</b> Shift + Enter for a new line</span>{status === "streaming" ? <button className="stop-button" type="button" onClick={() => void stop()}>Stop generation <span aria-hidden="true">■</span></button> : <button type="submit" disabled={!canSubmit}>Send <span aria-hidden="true">↗</span></button>}</div></form><p className="playground-footnote">Compute is reserved and settled by the server from actual provider usage. Your allowance is never bypassed.</p>
    </div>{showParameters && <aside className="playground-parameters" id="playground-parameters"><div className="parameters-heading"><div><span className="playground-kicker">SESSION CONTROLS</span><h2>Parameters</h2><p>Only settings supported by the selected model are sent.</p></div><button className="parameters-close" onClick={() => setShowParameters(false)} aria-label="Close parameters">×</button></div><label>System prompt<textarea value={parameters.systemPrompt} onChange={(event) => updateParameter("systemPrompt", event.target.value)} placeholder="Optional. Sets assistant behavior." /></label><ParameterRange label="Temperature" value={parameters.temperature} onChange={(value) => updateParameter("temperature", value)} min="0" max="2" step="0.1" enabled={capability.temperature} /><ParameterRange label="Top P" value={parameters.topP} onChange={(value) => updateParameter("topP", value)} min="0" max="1" step="0.05" enabled={capability.topP} /><ParameterRange label="Max tokens" value={parameters.maxTokens} onChange={(value) => updateParameter("maxTokens", value)} min="1" max="32768" step="1" enabled={capability.maxTokens} /><label>Seed <input inputMode="numeric" value={parameters.seed} onChange={(event) => updateParameter("seed", event.target.value)} placeholder={capability.seed ? "Random" : "Not supported by this model"} disabled={!capability.seed} /></label><label>Stop sequences<textarea value={parameters.stop} onChange={(event) => updateParameter("stop", event.target.value)} placeholder={capability.stop ? "One per line" : "Not supported by this model"} disabled={!capability.stop} /></label><button className="parameters-reset" onClick={() => setParameters(emptyParameters)}><span aria-hidden="true">↶</span> Reset parameters</button></aside>}</section><style>{styles}</style></main>;
}
function ParameterRange({ label, value, onChange, min, max, step, enabled }: { label: string; value: string; onChange: (value: string) => void; min: string; max: string; step: string; enabled: boolean }) { return <label className={!enabled ? "parameter-disabled" : ""}>{label}<span>{enabled ? value || "Model default" : "Not supported"}</span><input type="range" min={min} max={max} step={step} value={value || min} onChange={(event) => onChange(event.target.value)} disabled={!enabled} /></label>; }
const styles = `.playground-shell{--play-paper:#f2f1ed;--play-surface:#faf9f6;--play-line:#dedbd5;--play-ink:#20201f;--play-muted:#716e69;--play-accent:#52795f;--play-warm:#a96b51;min-height:100vh;background:var(--play-paper);color:var(--play-ink);font-family:var(--font-geist-sans),Arial,Helvetica,sans-serif}.playground-topbar{min-height:64px;border-bottom:1px solid var(--play-line);display:flex;align-items:center;gap:28px;padding:10px clamp(18px,4vw,60px);background:#eeede8;font:11px var(--font-geist-mono),monospace;letter-spacing:.09em}.playground-back{display:inline-flex;align-items:center;gap:11px;border:0;background:none;color:#57544f;font:inherit;cursor:pointer;padding:10px 0}.playground-back:hover{color:var(--play-ink)}.playground-back span{font-size:16px}.topbar-current{color:#85817a}.topbar-status{margin-left:auto;display:flex;align-items:center;gap:25px}.access-pill{display:inline-flex;align-items:center;gap:7px;font-size:10px;white-space:nowrap}.access-pill i,.access-indicator{width:7px;height:7px;border-radius:50%;background:#a96b51;display:inline-block;flex:0 0 7px}.access-pill.good i,.access-indicator.good{background:#5b816b}.access-pill.good{color:#52795f}.access-pill.attention{color:#9a614a}.playground-balance{display:flex;align-items:baseline;gap:8px;color:#52795f;font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}.playground-balance small{color:#77736e;font-size:10px}.playground-balance.zero{color:#9a614a}.playground-layout{width:min(100%,1300px);margin:0 auto;min-height:calc(100vh - 64px);padding:clamp(38px,5.7vw,78px) clamp(20px,5vw,70px) 56px}.playground-layout.with-parameters{width:min(100%,1550px);display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,345px);gap:clamp(25px,4vw,58px);align-items:start}.playground-main{min-width:0}.playground-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:26px;padding-bottom:clamp(34px,4.5vw,60px)}.playground-heading>div{min-width:0}.playground-kicker{font:10px var(--font-geist-mono),monospace;color:#77736e;letter-spacing:.13em}.playground-heading h1{font-size:clamp(52px,7vw,94px);font-weight:400;letter-spacing:-.085em;line-height:.95;margin:22px 0 18px}.playground-heading h1 span{color:#a96b51}.playground-heading p{max-width:650px;color:var(--play-muted);font-size:clamp(14px,1.45vw,17px);line-height:1.65;margin:0}.parameter-toggle{flex:0 0 auto;display:inline-flex;align-items:center;gap:14px;border:1px solid #cbc6bd;border-radius:999px;background:#faf9f6;color:#34322f;padding:12px 16px;cursor:pointer;font-size:12px;transition:background .18s,border-color .18s}.parameter-toggle:hover{background:#fff;border-color:#a69f95}.parameter-toggle span{color:#77736e;font-size:16px}.playground-controls{border-top:1px solid var(--play-line)}.playground-model-row{display:grid;grid-template-columns:minmax(200px,410px) auto minmax(0,1fr);align-items:end;gap:20px;padding:18px 0 20px;border-bottom:1px solid var(--play-line)}.playground-model-row label{min-width:0;color:#6d6963;font:10px var(--font-geist-mono),monospace;letter-spacing:.11em;display:flex;flex-direction:column;gap:9px}.playground-model-row select{appearance:none;width:100%;min-width:0;border:1px solid #cbc6bd;border-radius:8px;background:#faf9f6;color:#20201f;padding:12px 38px 12px 13px;font:14px var(--font-geist-sans),Arial,sans-serif;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,#777 50%),linear-gradient(135deg,#777 50%,transparent 50%);background-position:calc(100% - 17px) 18px,calc(100% - 12px) 18px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}.playground-model-row select:focus-visible,.parameter-toggle:focus-visible,.playground-back:focus-visible,.composer-footer button:focus-visible,.parameters-close:focus-visible,.verify-button:focus-visible,.history-toggle:focus-visible,.new-conversation:focus-visible,.history-search-wrap button:focus-visible,.history-list button:focus-visible{outline:2px solid #a96b51;outline-offset:3px}.playground-model-row select:disabled{opacity:.7;cursor:not-allowed}.model-status{display:inline-flex;align-items:center;gap:8px;padding-bottom:13px;color:#9a614a;font:10px var(--font-geist-mono),monospace;white-space:nowrap}.model-status i{width:7px;height:7px;border-radius:50%;background:currentColor}.model-status.operational{color:#52795f}.selected-model-name{min-width:0;justify-self:end;padding-bottom:13px;color:#77736e;font:10px var(--font-geist-mono),monospace;text-align:right;overflow-wrap:anywhere}.access-context{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:15px 0;border-bottom:1px solid var(--play-line)}.access-summary{display:flex;align-items:flex-start;gap:10px;min-width:0}.access-indicator{margin-top:5px;background:#a96b51}.access-summary div{min-width:0;display:flex;flex-direction:column;gap:4px}.access-summary b{font-size:12px;font-weight:500;color:#37342f}.access-summary small{font-size:10px;line-height:1.5;color:#77736e}.verify-button{flex:0 0 auto;border:1px solid #bdb6ac;border-radius:999px;background:#faf9f6;color:#49453f;padding:9px 12px;font:10px var(--font-geist-mono),monospace;cursor:pointer}.verify-button:hover{background:white;border-color:#a96b51}.verify-button:disabled{opacity:.6;cursor:wait}.access-verified-note{flex:0 0 auto;color:#52795f;font:9px var(--font-geist-mono),monospace}.conversation-toolbar{display:flex;justify-content:space-between;align-items:center;gap:15px;padding:21px 0 0}.conversation-toolbar>div:first-child{display:flex;align-items:baseline;gap:13px;flex-wrap:wrap}.conversation-model{color:#37342f;font-size:13px}.conversation-actions{display:flex;align-items:center;gap:8px}.history-toggle,.new-conversation{border:1px solid #d3cec5;border-radius:999px;background:transparent;color:#57534d;padding:8px 11px;font:10px var(--font-geist-mono),monospace;cursor:pointer}.history-toggle:hover,.new-conversation:hover{background:#faf9f6}.history-toggle span{margin-left:7px;color:#8c6652}.new-conversation{border-color:#b9afa3;background:#242321;color:#f8f6f2}.new-conversation:hover{background:#393631}.new-conversation:disabled{opacity:.5;cursor:not-allowed}.history-panel{margin-top:13px;border:1px solid var(--play-line);background:#faf9f6;border-radius:9px;padding:12px}.history-search-wrap{display:flex;gap:8px}.history-search-wrap input{width:100%;min-width:0;border:1px solid #ddd8d0;border-radius:7px;background:#fff;color:#302e2a;padding:10px 11px;font:12px var(--font-geist-sans),Arial,sans-serif}.history-search-wrap button{flex:0 0 auto;border:1px solid #d3cec5;border-radius:7px;background:#f5f3ef;color:#57534d;padding:0 12px;font-size:11px;cursor:pointer}.history-list{max-height:230px;overflow:auto;margin-top:8px}.history-list button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px;border:0;border-radius:6px;background:transparent;color:#37342f;text-align:left;cursor:pointer}.history-list button:hover,.history-list button.active{background:#efede8}.history-list button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.history-list button small{flex:0 0 auto;color:#827d75;font:9px var(--font-geist-mono),monospace}.history-empty{margin:13px 4px 3px;color:#77736e;font-size:12px}.playground-messages{min-height:clamp(290px,38vh,440px);padding:26px 0 15px}.playground-empty{max-width:640px;margin:35px auto 10px;text-align:center;padding:20px;color:#716e69}.empty-mark{margin:0 auto 19px;width:53px;height:53px;border-radius:16px;background:#ece5dc;color:#9b654e;display:grid;place-items:center;font-size:23px}.empty-overline{font:9px var(--font-geist-mono),monospace;letter-spacing:.13em;color:#77736e}.playground-empty h2{color:#292724;font-size:clamp(22px,3vw,29px);font-weight:400;letter-spacing:-.045em;margin:14px 0 9px}.playground-empty p{max-width:570px;margin:0 auto;color:#716e69;font-size:14px;line-height:1.7}.playground-message{position:relative;max-width:900px;margin:0 auto 13px;padding:17px 19px;border:1px solid var(--play-line);border-radius:9px;background:#faf9f6;min-width:0}.playground-message.user{background:#f4eee8;border-color:#e1d2c5}.playground-message>span:first-child{display:block;color:#8d5e49;font:9px var(--font-geist-mono),monospace;letter-spacing:.12em;overflow-wrap:anywhere}.playground-message p{white-space:pre-wrap;line-height:1.75;margin:10px 0 0;color:#282724;font-size:14px;overflow-wrap:anywhere;word-break:break-word}.playground-message.partial{border-style:dashed}.stream-indicator{display:inline-flex!important;align-items:center;gap:7px;margin-top:10px;color:#9a614a!important;font:9px var(--font-geist-mono),monospace!important;letter-spacing:.1em}.stream-indicator i,.state-indicator{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}.playground-message.partial:has(.stream-indicator) .stream-indicator:has(i){color:#8d6549!important}.playground-message.partial .stream-indicator i{animation:play-pulse 1s ease-in-out infinite}.playground-state{display:flex;align-items:center;gap:9px;color:#716e69;font-size:11px;line-height:1.55;margin:0 auto 11px;max-width:900px}.playground-state .state-indicator{flex:0 0 7px;color:#8a8379}.playground-state.streaming{color:#52795f}.playground-state.streaming .state-indicator{color:#52795f;animation:play-pulse 1s ease-in-out infinite}.playground-state.stopped{color:#956344}.playground-state.stopped .state-indicator{color:#956344}.playground-state.error{color:#965b45}.playground-state.error .state-indicator{color:#a96b51}.playground-state button{margin-left:auto;flex:0 0 auto;border:1px solid #c8b6a8;background:#f4eee8;color:#81583f;border-radius:999px;padding:8px 11px;cursor:pointer;font-size:10px}.compute-state-label{margin-left:auto;flex:0 0 auto;border:1px solid #ddc8bb;border-radius:99px;padding:5px 8px;color:#965b45;font:9px var(--font-geist-mono),monospace;letter-spacing:.05em}.playground-composer{max-width:960px;margin:0 auto;border:1px solid #d7d2ca;border-radius:10px;background:#faf9f6;overflow:hidden;transition:border-color .18s}.playground-composer:focus-within{border-color:#a69f95}.playground-composer textarea{display:block;box-sizing:border-box;width:100%;min-height:100px;max-height:35vh;resize:vertical;background:transparent;border:0;outline:0;color:#20201f;padding:16px 18px;font:14px/1.6 var(--font-geist-sans),Arial,sans-serif}.playground-composer textarea::placeholder{color:#89847d}.playground-composer textarea:disabled{opacity:.62;cursor:not-allowed}.composer-footer{border-top:1px solid var(--play-line);padding:9px 11px 9px 16px;min-height:48px;display:flex;align-items:center;gap:12px;color:#77736e;font:9px var(--font-geist-mono),monospace}.composer-footer b{font-weight:400;color:#aaa49b;padding:0 3px}.composer-footer button{margin-left:auto;display:inline-flex;align-items:center;gap:9px;border:1px solid #a96b51;border-radius:7px;background:#a96b51;color:#fffaf5;padding:9px 14px;font:10px var(--font-geist-mono),monospace;cursor:pointer;transition:opacity .18s,background .18s}.composer-footer button:hover:not(:disabled){background:#935a43}.composer-footer button:disabled{opacity:.35;cursor:not-allowed}.composer-footer button.stop-button{border-color:#c9b5a6;background:#eee7df;color:#6e4d3e}.playground-footnote{max-width:960px;margin:11px auto 0;color:#77736e;font:9px/1.6 var(--font-geist-mono),monospace}.playground-parameters{position:sticky;top:24px;min-width:0;border:1px solid var(--play-line);border-radius:10px;background:#faf9f6;padding:21px}.parameters-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--play-line);padding-bottom:16px;margin-bottom:16px}.parameters-heading h2{font-size:23px;font-weight:400;letter-spacing:-.05em;margin:11px 0 5px}.parameters-heading p{color:#77736e;font-size:11px;line-height:1.5;margin:0}.parameters-close{flex:0 0 auto;width:32px;height:32px;border:1px solid #cbc6bd;border-radius:7px;background:#f2f1ed;color:#292724;font-size:19px;cursor:pointer}.playground-parameters label{display:block;color:#292724;font-size:12px;margin:19px 0}.playground-parameters label>span{float:right;margin-left:8px;color:#77736e;font-size:9px;text-align:right}.playground-parameters textarea,.playground-parameters input:not([type=range]){display:block;box-sizing:border-box;width:100%;margin-top:8px;border:1px solid #d7d2ca;border-radius:7px;background:#fff;color:#292724;padding:10px 11px;font:12px/1.5 var(--font-geist-sans),Arial,sans-serif;resize:vertical}.playground-parameters textarea{min-height:70px}.playground-parameters input[type=range]{display:block;width:100%;margin-top:13px;accent-color:#a96b51}.playground-parameters input:disabled,.playground-parameters textarea:disabled{opacity:.48}.parameter-disabled{color:#827e78!important}.parameters-reset{border:0;border-top:1px solid var(--play-line);width:100%;background:none;color:#716e69;text-align:left;padding:15px 0 2px;cursor:pointer;font-size:11px}.parameters-reset:hover{color:#292724}.playground-gate{min-height:100vh;display:grid;place-items:center;background:#f2f1ed;color:#77736e;font:11px var(--font-geist-mono),monospace}@keyframes play-pulse{50%{opacity:.35}}@media(max-width:900px){.playground-layout.with-parameters{grid-template-columns:minmax(0,1fr) minmax(245px,285px);gap:22px;padding-inline:24px}.playground-model-row{grid-template-columns:minmax(180px,1fr) auto}.selected-model-name{grid-column:1/-1;justify-self:start;padding:0;text-align:left}.playground-messages{min-height:300px}}@media(max-width:700px){.playground-topbar{gap:13px;padding:9px 16px;align-items:flex-start;flex-wrap:wrap}.topbar-current{padding-top:11px}.topbar-status{gap:12px}.access-pill{display:none}.playground-balance{font-size:11px;gap:5px}.playground-balance small{font-size:9px}.playground-layout,.playground-layout.with-parameters{width:100%;display:flex;flex-direction:column;gap:22px;min-height:calc(100vh - 64px);padding:35px 17px 32px}.playground-heading{display:block;padding-bottom:30px}.playground-heading h1{font-size:clamp(49px,13vw,76px);margin:19px 0 13px}.playground-heading p{font-size:14px}.parameter-toggle{margin-top:18px;padding:10px 12px}.playground-model-row{grid-template-columns:minmax(0,1fr);gap:12px;padding:16px 0;align-items:start}.playground-model-row select{font-size:14px}.model-status{padding:0}.selected-model-name{grid-column:auto;justify-self:start;padding:0;max-width:100%;text-align:left}.access-context{align-items:flex-start;flex-direction:column;gap:12px}.access-summary small{max-width:440px}.verify-button{min-height:38px}.access-verified-note{padding-left:17px}.conversation-toolbar{align-items:flex-start;flex-direction:column;padding-top:17px}.conversation-actions{width:100%;justify-content:flex-end}.conversation-toolbar>div:first-child{align-items:flex-start;flex-direction:column;gap:6px}.history-list button{align-items:flex-start;flex-direction:column;gap:5px}.playground-messages{min-height:235px;padding:20px 0 12px}.playground-empty{margin:24px auto 13px;padding:13px 3px}.playground-empty p{font-size:13px}.playground-message{padding:15px 14px;margin-bottom:11px}.playground-message p{font-size:13px}.playground-composer textarea{min-height:90px;padding:14px}.composer-footer{padding:9px 9px 9px 12px;flex-wrap:wrap}.composer-footer span{font-size:8px;line-height:1.5}.composer-footer button{padding:9px 11px;font-size:9px}.playground-parameters{position:static;width:100%;padding:19px 16px}.playground-footnote{font-size:8px}.playground-state{align-items:flex-start}.playground-state button{white-space:nowrap}}@media(max-width:390px){.playground-topbar{gap:9px;padding-inline:12px}.playground-back{gap:7px}.topbar-current{font-size:9px}.playground-balance{font-size:10px}.playground-layout,.playground-layout.with-parameters{padding-inline:13px}.playground-heading h1{font-size:49px}.conversation-actions{gap:6px}.history-toggle,.new-conversation{padding:8px 9px;font-size:9px}.composer-footer{gap:7px}.composer-footer>span{max-width:56%}.composer-footer button{gap:5px;padding-inline:9px}.compute-state-label{font-size:8px}}@media(prefers-reduced-motion:reduce){.playground-composer,.composer-footer button{transition:none}.stream-indicator i,.playground-state.streaming .state-indicator{animation:none}}`;

export default function PlaygroundPage() {
  return <Suspense fallback={<main className="playground-gate">Loading Playground…</main>}><PlaygroundContent /></Suspense>;
}

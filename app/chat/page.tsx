"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter, useSearchParams } from "next/navigation";

type Model = { id: string; displayName: string; family: string | null; contextLength: number | null; availability: "available" | "unavailable" | "stale"; syncStatus: string; registryStatus: string; supportedParameters: string[] | null };
type Message = { role: "user" | "assistant"; content: string; partial?: boolean };
type Conversation = { id: string; title: string | null; updated_at: string; message_count?: number };
type Status = "loading" | "ready" | "streaming" | "stopped" | "failed" | "unavailable";
type Parameters = { systemPrompt: string; temperature: string; topP: string; maxTokens: string; seed: string; stop: string };
const initialParameters: Parameters = { systemPrompt: "", temperature: "", topP: "", maxTokens: "", seed: "", stop: "" };
const operational = (model: Model | null) => Boolean(model && model.availability === "available" && model.syncStatus === "current" && model.registryStatus === "active");
const supports = (model: Model | null, parameter: string) => Boolean(model?.supportedParameters?.some((item) => item.toLowerCase() === parameter.toLowerCase()));
const balanceLabel = (value: string) => { try { const micro = BigInt(value || "0"); return `$${micro / 1000000n}.${(micro % 1000000n).toString().padStart(6, "0")}`; } catch { return "Unavailable"; } };
const positiveBalance = (value: string) => { try { return BigInt(value || "0") > 0n; } catch { return false; } };
const timeLabel = (value: string) => { const time = new Date(value).getTime(); if (!Number.isFinite(time)) return ""; const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000); return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`; };

function PlaygroundContent() {
  const { ready: authReady, authenticated, getAccessToken } = usePrivy();
  const router = useRouter();
  const search = useSearchParams();
  const requestedModel = search.get("model");
  const requestedConversation = search.get("conversation");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState<Model | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [parameters, setParameters] = useState<Parameters>(initialParameters);
  const [balance, setBalance] = useState("0");
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showParameters, setShowParameters] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const operationRef = useRef<string | null>(null);
  const loadIdRef = useRef(0);

  const authHeaders = useCallback(async () => { const token = await getAccessToken(); if (!token) throw new Error("AUTH_REQUIRED"); return { Authorization: `Bearer ${token}` }; }, [getAccessToken]);
  const availableModels = useMemo(() => models.filter(operational), [models]);
  // Authorization is identity-based: a verified Privy session, an operational
  // model, and the separately handled compute allowance are the only inputs.
  // There is no ownership or holder verification step in this path.
  const canSubmit = authenticated && balanceLoaded && positiveBalance(balance) && operational(model) && status !== "streaming" && status !== "loading" && Boolean(draft.trim());
  // The composer itself is usable as soon as a session exists: typing is never
  // blocked by a verification state, only by an in-flight generation.
  const composerDisabled = !authenticated || status === "streaming";
  const composerPlaceholder = status === "streaming" ? `Generating with ${model?.displayName ?? "the selected model"}...` : "Send a message...";
  const capabilities = useMemo(() => ({ temperature: supports(model, "temperature"), topP: supports(model, "top_p") || supports(model, "topP"), maxTokens: supports(model, "max_tokens") || supports(model, "max_completion_tokens"), seed: supports(model, "seed"), stop: supports(model, "stop") }), [model]);
  const filteredHistory = useMemo(() => conversations.filter((item) => (item.title || "New conversation").toLowerCase().includes(historySearch.toLowerCase())), [conversations, historySearch]);
  const refreshHistory = useCallback(async (headers?: HeadersInit) => {
    const response = await fetch("/api/conversations", { headers: headers ?? await authHeaders(), cache: "no-store" });
    if (!response.ok) throw new Error("Conversation history could not be loaded.");
    const data = await response.json() as { conversations?: Conversation[] };
    setConversations(Array.isArray(data.conversations) ? data.conversations : []);
  }, [authHeaders]);
  const openConversation = useCallback(async (id: string, headers?: HeadersInit, updateUrl = true) => {
    const loadId = ++loadIdRef.current;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { headers: headers ?? await authHeaders(), cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "This conversation is unavailable." : "Conversation messages could not be loaded.");
      const data = await response.json() as { messages?: Array<{ role: string; content: string; partial?: boolean }> };
      if (loadId !== loadIdRef.current) return;
      setConversationId(id);
      setMessages((data.messages ?? []).filter((item): item is typeof item & { role: "user" | "assistant" } => item.role === "user" || item.role === "assistant").map((item) => ({ role: item.role, content: item.content, partial: Boolean(item.partial) })));
      if (updateUrl) router.replace(`/chat?${new URLSearchParams({ ...(requestedModel ? { model: requestedModel } : {}), conversation: id })}`);
      setError("");
      if (!updateUrl) setStatus("ready");
    } catch (caught) {
      if (loadId !== loadIdRef.current) return;
      setError(caught instanceof Error ? caught.message : "Conversation messages could not be loaded."); setStatus("failed");
    }
  }, [authHeaders, requestedModel, router]);
  const load = useCallback(async () => {
    if (!authenticated) return;
    setStatus("loading"); setError(""); setBalance("0"); setBalanceLoaded(false);
    try {
      const headers = await authHeaders();
      // The registry is fetched with the identity only, so every authenticated
      // account sees the full public curated registry.
      const [modelsResponse, allowanceResponse] = await Promise.all([fetch("/api/models", { headers, cache: "no-store" }), fetch("/api/allowance", { headers, cache: "no-store" }), refreshHistory(headers)]).then(([modelsResult, allowanceResult]) => [modelsResult, allowanceResult] as const);
      if (!modelsResponse.ok) throw new Error("The model list is unavailable.");
      const data = await modelsResponse.json() as { models?: Model[] };
      const nextModels = Array.isArray(data.models) ? data.models : [];
      setModels(nextModels);
      const selected = requestedModel ? nextModels.find((item) => item.id === requestedModel) ?? null : nextModels.find(operational) ?? null;
      setModel(selected);
      if (!selected || !operational(selected)) { setStatus("unavailable"); setError(selected ? "The selected model is unavailable. Choose an operational model." : requestedModel ? "The selected model is no longer available." : "No models are available right now."); }
      else setStatus("ready");
      // The compute allowance is a separately handled mechanism. It is provisioned
      // for the signed-in account server-side and is entirely independent of any
      // ownership or verification state.
      if (allowanceResponse.ok) {
        const allowance = await allowanceResponse.json() as { balance?: { available?: string } };
        if (typeof allowance.balance?.available !== "string") throw new Error("The allowance response did not include an authoritative balance.");
        setBalance(allowance.balance.available); setBalanceLoaded(true);
      } else if (allowanceResponse.status === 401) { setStatus("unavailable"); setError("Your session has expired. Sign in again."); }
      else { setStatus("unavailable"); setError("Compute allowance could not be loaded. Retry to request a fresh balance."); }
      if (requestedConversation) await openConversation(requestedConversation, headers, false);
    } catch (caught) { setModels([]); setModel(null); setBalanceLoaded(false); setStatus("unavailable"); setError(caught instanceof Error ? caught.message : "The Playground could not load workspace data."); }
  }, [authenticated, authHeaders, openConversation, refreshHistory, requestedConversation, requestedModel]);

  useEffect(() => { if (authReady && !authenticated) router.replace("/signup"); }, [authReady, authenticated, router]);
  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [load]);
  const changeModel = (next: Model) => { if (!operational(next) || status === "streaming") return; setModel(next); setError(""); setStatus("ready"); router.replace(`/chat?${new URLSearchParams({ model: next.id, ...(conversationId ? { conversation: conversationId } : {}) })}`); };
  const changeParameter = (key: keyof Parameters, value: string) => setParameters((current) => ({ ...current, [key]: value }));
  const newConversation = () => { if (status === "streaming") return; loadIdRef.current += 1; setConversationId(undefined); setMessages([]); setDraft(""); setError(""); setStatus(model ? "ready" : "unavailable"); router.replace(`/chat${model ? `?model=${encodeURIComponent(model.id)}` : ""}`); };
  // Refreshes the compute allowance for the current session.
  const refreshAllowance = async () => {
    if (status === "streaming") return;
    setError(""); setStatus("loading");
    try {
      const headers = await authHeaders();
      const allowanceResponse = await fetch("/api/allowance", { headers, cache: "no-store" });
      if (!allowanceResponse.ok) throw new Error(allowanceResponse.status === 401 ? "Your session has expired. Sign in again." : "Compute allowance could not be loaded. Retry to request a fresh balance.");
      const allowance = await allowanceResponse.json() as { balance?: { available?: string } };
      if (typeof allowance.balance?.available !== "string") throw new Error("The allowance service did not return an authoritative balance.");
      setBalance(allowance.balance.available); setBalanceLoaded(true); setStatus(model ? "ready" : "unavailable"); setError("");
    } catch (caught) { setBalance("0"); setBalanceLoaded(false); setStatus("unavailable"); setError(caught instanceof Error ? caught.message : "Compute allowance could not be loaded."); }
  };
  const stop = async () => {
    const operationKey = operationRef.current; abortRef.current?.abort(); setStatus("stopped"); setError("Generation stopped. The visible response is partial and was not marked complete.");
    if (operationKey) { try { const headers = await authHeaders(); await fetch("/api/inference/stop", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operationKey }) }); } catch { /* Client cancellation remains active; server accounting handles received usage. */ } }
  };
  const submit = async (event?: FormEvent<HTMLFormElement>, retryText?: string) => {
    event?.preventDefault();
    const text = (retryText ?? draft).trim();
    if (!text || !model || !canSubmit || !operational(model)) return;
    const requestId = crypto.randomUUID(); const requestModel = model; const controller = new AbortController(); abortRef.current = controller; operationRef.current = requestId; setDraft(""); setError(""); setStatus("streaming");
    setMessages((current) => { const next = [...current]; if (retryText && next.at(-1)?.role === "assistant" && next.at(-2)?.role === "user" && next.at(-2)?.content === text) next.pop(); else next.push({ role: "user", content: text }); next.push({ role: "assistant", content: "", partial: true }); return next; });
    let terminal = false;
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/chat", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ conversationId, message: text, model: requestModel.id, operationKey: requestId, clientRequestId: requestId, parameters: { systemPrompt: parameters.systemPrompt || undefined, temperature: parameters.temperature === "" ? undefined : Number(parameters.temperature), topP: parameters.topP === "" ? undefined : Number(parameters.topP), maxTokens: parameters.maxTokens === "" ? undefined : Number(parameters.maxTokens), seed: parameters.seed === "" ? undefined : Number(parameters.seed), stop: parameters.stop ? parameters.stop.split(String.fromCharCode(10)) : undefined } }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (response.status === 402 || body.code === "INSUFFICIENT_COMPUTE" || body.code === "ALLOWANCE_MISSING" || body.code === "ALLOWANCE_EXPIRED") { setBalance("0"); setBalanceLoaded(false); throw new Error(body.error || "Insufficient compute allowance."); }
        if (response.status === 401) { throw new Error(body.error || "Your session has expired. Sign in again."); }
        throw new Error(body.error || "The Playground request was rejected.");
      }
      if (!response.body) throw new Error("The response stream was unavailable; completion was not confirmed.");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      const processEvent = (event: string) => {
        const line = event.split(String.fromCharCode(10)).find((item) => item.startsWith("data: "));
        if (!line) return;
        const payload = JSON.parse(line.slice(6)) as { type?: string; text?: string; conversationId?: string; error?: string };
        if (payload.type === "delta" && payload.text) setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: item.content + payload.text } : item));
        else if (payload.type === "complete") { terminal = true; if (payload.conversationId) { setConversationId(payload.conversationId); router.replace(`/chat?${new URLSearchParams({ model: requestModel.id, conversation: payload.conversationId })}`); } setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, partial: false } : item)); setStatus("ready"); }
        else if (payload.type === "cancelled") { terminal = true; setStatus("stopped"); setError("Generation stopped. The visible response is partial."); }
        else if (payload.type === "error") throw new Error(payload.error || "Inference failed before completion.");
      };
      const eventDelimiter = String.fromCharCode(10, 10);
      while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const events = buffer.split(eventDelimiter); buffer = events.pop() ?? ""; for (const item of events) processEvent(item); }
      buffer += decoder.decode(); if (buffer.trim()) processEvent(buffer);
      if (!terminal) throw new Error("The response stream ended before a completion event arrived.");
      if (!controller.signal.aborted) void refreshHistory().catch(() => undefined);
    } catch (caught) { if (controller.signal.aborted) { setStatus("stopped"); setError("Generation stopped. The visible response is partial."); } else { setStatus("failed"); setError(caught instanceof Error ? caught.message : "The Playground request failed."); } }
    finally { if (abortRef.current === controller) abortRef.current = null; if (operationRef.current === requestId) operationRef.current = null; }
  };

  if (!authReady || !authenticated) return <main className="playground-gate">Verifying your session...</main>;
  const zeroCompute = balanceLoaded && !positiveBalance(balance);
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content;
  const statusCopy = status === "loading" ? "Loading models and workspace data..." : status === "unavailable" || status === "failed" || status === "stopped" ? error : status === "streaming" ? `Generating with ${model?.displayName ?? "the selected model"}...` : !model ? error || "Choose an available model to begin." : !operational(model) ? "This model is unavailable. No provider request can be made." : zeroCompute ? "No compute allowance is available. Refresh the allowance to continue." : "";
  const statusTone = status === "failed" || status === "unavailable" || zeroCompute || !model || !operational(model) ? "error" : status === "stopped" ? "stopped" : status === "streaming" ? "streaming" : "";
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (canSubmit) void submit(); } };

  return <main className="playground-shell"><header className="playground-topbar"><button className="playground-back" onClick={() => router.push("/dashboard")}><span aria-hidden="true">←</span> Overview</button><span className="topbar-current">PLAYGROUND</span><div className="topbar-status"><span className={`playground-balance ${zeroCompute ? "zero" : ""}`}>{balanceLoaded ? balanceLabel(balance) : "—"}<small>available compute</small></span></div></header>
    <section className={`playground-layout ${showParameters ? "with-parameters" : ""}`}><div className="playground-main"><div className="playground-heading"><div><span className="playground-kicker">WORKSPACE / COMPUTE LAYER</span><h1>Playground<span>.</span></h1></div><button className="parameter-toggle" onClick={() => setShowParameters((current) => !current)} aria-expanded={showParameters} aria-controls="playground-parameters">Parameters <span aria-hidden="true">{showParameters ? "−" : "+"}</span></button></div>
      <div className="playground-controls"><div className="playground-model-row"><label htmlFor="curated-model"><span className="playground-kicker">MODEL</span><select id="curated-model" value={model?.id ?? ""} onChange={(event) => { const next = availableModels.find((item) => item.id === event.target.value); if (next) changeModel(next); }} disabled={status === "streaming" || availableModels.length === 0}><option value="" disabled>{models.length ? "No available models" : "Registry unavailable"}</option>{model && !operational(model) && <option value={model.id} disabled>{model.displayName} - unavailable</option>}{availableModels.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label><span className={`model-status ${operational(model) ? "operational" : "unavailable"}`}><i />{operational(model) ? "Operational" : model ? "Unavailable" : "No model selected"}</span><span className="selected-model-name">{model ? `${model.displayName}${model.contextLength ? ` · ${model.contextLength.toLocaleString()} context` : ""}` : "No models available"}</span></div></div>
      <div className="conversation-toolbar"><div><span className="playground-kicker">YOUR CONVERSATION</span><span className="conversation-model">{model?.displayName ?? "Select a model"}</span></div><div className="conversation-actions"><button type="button" className="history-toggle" aria-expanded={showHistory} onClick={() => setShowHistory((current) => !current)}>History{conversations.length ? <span>{conversations.length}</span> : null}</button><button type="button" className="new-conversation" onClick={newConversation} disabled={status === "streaming"}>+ New chat</button></div></div>
      {showHistory && <section className="history-panel" aria-label="Conversation history"><div className="history-search-wrap"><input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search conversations..." aria-label="Search conversations" /><button type="button" onClick={() => void refreshHistory().catch((caught) => setError(caught instanceof Error ? caught.message : "History could not be refreshed."))}>Refresh</button></div>{filteredHistory.length ? <div className="history-list">{filteredHistory.map((item) => <button type="button" key={item.id} className={conversationId === item.id ? "active" : ""} onClick={() => void openConversation(item.id)}><span>{item.title || "New conversation"}</span><small>{timeLabel(item.updated_at)}{item.message_count != null ? ` · ${item.message_count} messages` : ""}</small></button>)}</div> : <p className="history-empty">{conversations.length ? "No conversations match that search." : "Your conversations will appear here."}</p>}</section>}
      <div className="playground-messages" aria-live="polite">{messages.length === 0 ? <div className="playground-empty"><div className="empty-mark" aria-hidden="true">✦</div><span className="empty-overline">A QUIET SPACE FOR GOOD QUESTIONS</span><h2>What would you like to work through?</h2><p>Choose a model and send a prompt. Responses stream into your conversation history.</p></div> : messages.map((message, index) => <article className={`playground-message ${message.role} ${message.partial ? "partial" : ""}`} key={`${index}-${message.role}`}><span>{message.role === "user" ? "YOU" : model?.displayName?.toUpperCase() || "ASSISTANT"}</span><p>{message.content || (message.partial ? "Waiting for the first response..." : "")}</p>{message.partial && <span className="stream-indicator"><i />{status === "streaming" ? "STREAMING" : "PARTIAL · NOT COMPLETE"}</span>}</article>)}</div>
      {statusCopy && <div className={`playground-state ${statusTone}`} role="status"><span className="state-indicator" />{statusCopy}{status === "failed" && lastUser && balanceLoaded && positiveBalance(balance) && operational(model) && <button onClick={() => void submit(undefined, lastUser)}>Retry last prompt</button>}{zeroCompute && <button onClick={() => void refreshAllowance()}>Refresh allowance ↻</button>}</div>}
      <form className="playground-composer" onSubmit={(event) => void submit(event)}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={composerPlaceholder} aria-label="Prompt" disabled={composerDisabled} onKeyDown={onKeyDown} /><div className="composer-footer"><span>Enter to send <b>·</b> Shift + Enter for a new line</span>{status === "streaming" ? <button className="stop-button" type="button" onClick={() => void stop()}>Stop generation <span aria-hidden="true">■</span></button> : <button type="submit" disabled={!canSubmit}>Send <span aria-hidden="true">↗</span></button>}</div></form><p className="playground-footnote">Compute is reserved and settled by the server from actual provider usage.</p>
    </div>{showParameters && <aside className="playground-parameters" id="playground-parameters"><div className="parameters-heading"><div><span className="playground-kicker">SESSION CONTROLS</span><h2>Parameters</h2><p>Only settings supported by this model are sent.</p></div><button type="button" className="parameters-close" onClick={() => setShowParameters(false)} aria-label="Close parameters">×</button></div><label>System prompt<textarea value={parameters.systemPrompt} onChange={(event) => changeParameter("systemPrompt", event.target.value)} placeholder="Optional. Sets assistant behavior." /></label><ParameterRange label="Temperature" value={parameters.temperature} onChange={(value) => changeParameter("temperature", value)} min="0" max="2" step="0.1" enabled={capabilities.temperature} /><ParameterRange label="Top P" value={parameters.topP} onChange={(value) => changeParameter("topP", value)} min="0" max="1" step="0.05" enabled={capabilities.topP} /><ParameterRange label="Max tokens" value={parameters.maxTokens} onChange={(value) => changeParameter("maxTokens", value)} min="1" max="32768" step="1" enabled={capabilities.maxTokens} /><label>Seed <input inputMode="numeric" value={parameters.seed} onChange={(event) => changeParameter("seed", event.target.value)} placeholder={capabilities.seed ? "Random" : "Not supported by this model"} disabled={!capabilities.seed} /></label><label>Stop sequences<textarea value={parameters.stop} onChange={(event) => changeParameter("stop", event.target.value)} placeholder={capabilities.stop ? "One per line" : "Not supported by this model"} disabled={!capabilities.stop} /></label><button type="button" className="parameters-reset" onClick={() => setParameters(initialParameters)}>↶ Reset parameters</button></aside>}</section>
    <style>{`.playground-shell{height:100%;min-height:0;background:#090a0a;color:#e8eef6;font-family:var(--font-geist-sans),Arial,sans-serif}.playground-topbar{min-height:52px;flex:0 0 auto;display:flex;align-items:center;gap:22px;padding:8px clamp(16px,3vw,42px);border-bottom:1px solid #292c2b;background:#0b0c0c;font:10px var(--font-geist-mono),monospace;letter-spacing:.08em}.playground-back{display:inline-flex;gap:9px;align-items:center;border:0;background:none;color:#bac8d7;font:inherit;cursor:pointer}.topbar-current,.playground-kicker,.empty-overline{color:#91a1b2;font:9px var(--font-geist-mono),monospace;letter-spacing:.12em}.topbar-status{display:flex;align-items:center;gap:18px;margin-left:auto}.state-indicator,.model-status i{width:7px;height:7px;border-radius:50%;background:currentColor}.playground-balance{display:flex;gap:7px;align-items:baseline;color:#91d8aa;font:12px var(--font-geist-mono),monospace}.playground-balance small{color:#aab8c8;font-size:9px}.playground-balance.zero{color:#f2c27f}.playground-layout{width:min(100%,1600px);height:100%;min-height:0;margin:auto;padding:18px clamp(18px,3vw,48px) 16px;overflow:hidden}.playground-layout.with-parameters{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,310px);gap:22px}.playground-main{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}.playground-heading{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:16px;padding-bottom:13px}.playground-heading h1{margin:7px 0 0;font-size:clamp(34px,4vw,52px);font-weight:400;letter-spacing:-.07em;line-height:1}.playground-heading h1 span{color:#c58a70}.parameter-toggle,.history-toggle,.new-conversation{border:1px solid #3a4d63;border-radius:99px;background:#152131;color:#d8e5f2;padding:8px 12px;font-size:10px;cursor:pointer}.playground-controls,.conversation-toolbar,.playground-state,.playground-composer,.playground-footnote{flex:0 0 auto}.playground-controls{border-top:1px solid #303232}.playground-model-row{display:grid;grid-template-columns:minmax(180px,360px) auto minmax(0,1fr);align-items:end;gap:13px;padding:10px 0 12px;border-bottom:1px solid #303232}.playground-model-row label{display:flex;flex-direction:column;gap:7px;min-width:0;color:#afbdcc}.playground-model-row select{width:100%;min-width:0;border:1px solid #4b4e4d;border-radius:7px;background:#141515;color:#edf4fb;padding:9px 12px;font-size:12px}.model-status{display:flex;align-items:center;gap:7px;padding-bottom:10px;color:#f2c27f;font:9px var(--font-geist-mono),monospace}.model-status.operational{color:#91d8aa}.selected-model-name{justify-self:end;max-width:100%;padding-bottom:10px;color:#aab8c8;font:9px var(--font-geist-mono),monospace;text-align:right;overflow-wrap:anywhere}.conversation-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:11px}.conversation-toolbar>div:first-child{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.conversation-model{font-size:11px;color:#e5edf6}.conversation-actions{display:flex;gap:7px}.history-toggle,.new-conversation{padding:7px 10px;font:9px var(--font-geist-mono),monospace}.new-conversation{background:#ad7057;border-color:#bd8165;color:white}.new-conversation:disabled{opacity:.5;cursor:not-allowed}.history-toggle span{margin-left:6px}.history-panel{flex:0 0 auto;margin-top:8px;padding:9px;border:1px solid #303232;background:#141515;border-radius:8px}.history-search-wrap{display:flex;gap:7px}.history-search-wrap input{flex:1;min-width:0;border:1px solid #4b4e4d;border-radius:6px;background:#0b0c0c;color:#edf4fb;padding:8px}.history-search-wrap button{border:1px solid #4b4e4d;border-radius:6px;background:#1c1d1d;color:#d8e5f2;padding:0 10px}.history-list{max-height:160px;overflow:auto}.history-list button{display:flex;width:100%;justify-content:space-between;gap:8px;border:0;border-radius:5px;background:none;color:#dce6f0;padding:8px;text-align:left}.history-list button:hover,.history-list button.active{background:#252727}.history-list button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-list small,.history-empty{color:#9eacbd;font-size:9px}.playground-messages{flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:13px 8px 10px}.playground-empty{max-width:600px;margin:auto;padding:15px;text-align:center}.empty-mark{display:grid;place-items:center;width:42px;height:42px;margin:0 auto 12px;border-radius:13px;background:#211915;color:#e39a7a;font-size:20px}.playground-empty h2{margin:9px 0 6px;font-size:clamp(20px,2.4vw,25px);font-weight:400;letter-spacing:-.04em}.playground-empty p{margin:0 auto;color:#aab8c8;font-size:12px;line-height:1.5}.playground-message{max-width:900px;margin:0 auto 10px;padding:13px 15px;border:1px solid #303232;border-radius:8px;background:#141515;overflow-wrap:anywhere}.playground-message.user{border-color:#41352f;background:#1a1715}.playground-message>span:first-child{color:#c59b83;font:9px var(--font-geist-mono),monospace;letter-spacing:.1em}.playground-message p{margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;font-size:13px}.playground-message.partial{border-style:dashed}.stream-indicator{display:flex;align-items:center;gap:7px;margin-top:9px;color:#9bd7fa;font:9px var(--font-geist-mono),monospace}.playground-state{display:flex;align-items:center;gap:8px;margin:0 0 8px;color:#b1becc;font-size:10px;line-height:1.4}.playground-state.streaming{color:#91d8aa}.playground-state.error{color:#f0b3a3}.playground-state.stopped{color:#f2c27f}.playground-state button{margin-left:auto;border:1px solid #735d3f;border-radius:99px;background:#292315;color:#f4d39c;padding:6px 9px}.playground-composer{max-width:960px;width:100%;margin:0 auto;border:1px solid #4b4e4d;border-radius:9px;background:#141515;overflow:hidden}.playground-composer:focus-within{border-color:#9a785f}.playground-composer textarea{display:block;box-sizing:border-box;width:100%;min-height:72px;max-height:24dvh;resize:vertical;border:0;outline:0;background:transparent;color:#edf4fb;padding:12px 15px;font:13px/1.5 var(--font-geist-sans),Arial,sans-serif}.playground-composer textarea::placeholder{color:#91a2b5}.playground-composer textarea:disabled{opacity:.6;cursor:not-allowed}.composer-footer{display:flex;align-items:center;gap:10px;min-height:42px;padding:6px 9px 6px 14px;border-top:1px solid #303232;color:#aab8c8;font:8px var(--font-geist-mono),monospace}.composer-footer b{padding:0 3px;color:#8294a8;font-weight:400}.composer-footer button{display:flex;align-items:center;gap:8px;margin-left:auto;border:1px solid #bd8165;border-radius:6px;background:#ad7057;color:#fff7f2;padding:8px 12px;font:9px var(--font-geist-mono),monospace;cursor:pointer}.composer-footer button:disabled{opacity:.45;cursor:not-allowed}.composer-footer button.stop-button{border-color:#625043;background:#29221e;color:#ead4c5}.playground-footnote{max-width:960px;margin:6px auto 0;color:#91a1b2;font:8px var(--font-geist-mono),monospace}.playground-parameters{position:sticky;top:12px;max-height:100%;overflow:auto;padding:18px;border:1px solid #303232;border-radius:9px;background:#141515}.parameters-heading{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #303232;padding-bottom:13px}.parameters-heading h2{margin:9px 0 4px;font-size:22px;font-weight:400}.parameters-heading p{margin:0;color:#aab8c8;font-size:10px}.parameters-close{width:30px;height:30px;border:1px solid #4b4e4d;border-radius:6px;background:#1c1d1d;color:#eff6fd;font-size:18px}.playground-parameters label{display:block;margin:17px 0;color:#e5edf6;font-size:11px}.playground-parameters label>span{float:right;color:#aab8c8;font-size:9px}.playground-parameters textarea,.playground-parameters input:not([type=range]){display:block;box-sizing:border-box;width:100%;margin-top:7px;border:1px solid #4b4e4d;border-radius:6px;background:#0b0c0c;color:#edf4fb;padding:9px;font:11px/1.5 Arial,sans-serif}.playground-parameters textarea{min-height:60px;resize:vertical}.playground-parameters input[type=range]{display:block;width:100%;margin-top:11px;accent-color:#ad7057}.playground-parameters input:disabled,.playground-parameters textarea:disabled{opacity:.5}.parameters-reset{width:100%;border:0;border-top:1px solid #303232;background:none;color:#b3c0cf;text-align:left;padding:13px 0 0}.playground-gate{min-height:100vh;display:grid;place-items:center;background:#090a0a;color:#b0bdcc;font:11px var(--font-geist-mono),monospace}.playground-shell :is(button,input,select,textarea):focus-visible{outline:2px solid #d3a27f;outline-offset:3px}@media(max-width:700px){.playground-topbar{min-height:42px;padding:6px 12px;gap:12px}.topbar-status{gap:8px}.playground-balance{font-size:10px}.playground-balance small{font-size:8px}.playground-layout,.playground-layout.with-parameters{display:flex;flex-direction:column;gap:8px;padding:10px 12px max(8px,env(safe-area-inset-bottom))}.playground-heading{padding-bottom:7px}.playground-heading h1{font-size:clamp(29px,8vw,40px);margin-top:5px}.playground-kicker,.empty-overline{font-size:8px}.parameter-toggle{padding:7px 9px;font-size:9px}.playground-model-row{grid-template-columns:minmax(0,1fr) auto;gap:7px 10px;padding:7px 0}.playground-model-row label{gap:5px}.playground-model-row select{padding:7px 9px;font-size:11px}.model-status{align-self:end;padding-bottom:8px;font-size:8px}.selected-model-name{grid-column:1/-1;justify-self:start;padding:0;font-size:8px}.conversation-toolbar{padding-top:6px}.conversation-toolbar>div:first-child{gap:5px}.conversation-model{font-size:10px}.conversation-actions{gap:4px}.history-toggle,.new-conversation{padding:6px 7px;font-size:8px}.playground-messages{flex:1 1 0;min-height:30px;padding:6px 2px}.playground-empty{padding:6px 3px}.empty-mark{width:32px;height:32px;margin-bottom:6px;font-size:15px}.empty-overline{font-size:7px}.playground-empty h2{margin:5px 0 3px;font-size:16px}.playground-empty p{font-size:9px;line-height:1.4}.playground-message{padding:9px 10px}.playground-message p{font-size:11px}.playground-state{max-height:45px;overflow:auto;font-size:8px;margin:0}.playground-composer textarea{min-height:52px;max-height:16dvh;padding:9px 10px;font-size:11px}.composer-footer{min-height:35px;padding:4px 6px 4px 8px}.composer-footer>span{max-width:65%;font-size:7px}.composer-footer button{padding:6px 8px;font-size:8px}.playground-footnote{display:none}.playground-parameters{position:fixed;z-index:8;inset:10px 10px max(10px,env(safe-area-inset-bottom));width:auto;max-height:none;box-shadow:0 18px 60px #0008}}@media(max-height:620px)and(min-width:701px){.playground-layout,.playground-layout.with-parameters{padding-top:7px;padding-bottom:7px}.playground-heading{padding-bottom:6px}.playground-heading h1{font-size:32px}.playground-model-row{padding-block:5px}.playground-composer textarea{min-height:48px}.playground-footnote{display:none}}@media(prefers-reduced-motion:reduce){.playground-shell *{scroll-behavior:auto}}`}</style>
  </main>;
}

function ParameterRange({ label, value, onChange, min, max, step, enabled }: { label: string; value: string; onChange: (value: string) => void; min: string; max: string; step: string; enabled: boolean }) { return <label className={!enabled ? "parameter-disabled" : ""}>{label}<span>{enabled ? value || "Model default" : "Not supported"}</span><input type="range" min={min} max={max} step={step} value={value || min} onChange={(event) => onChange(event.target.value)} disabled={!enabled} /></label>; }

export default function PlaygroundPage() { return <Suspense fallback={<main className="playground-gate">Loading Playground...</main>}><PlaygroundContent /></Suspense>; }

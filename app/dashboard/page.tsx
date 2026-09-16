"use client";

import { CSSProperties, FormEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = { role: "user" | "assistant"; text: string; partial?: boolean; model?: string };
type Conversation = { id?: string; title: string; date: string; messages: Message[]; loaded?: boolean };
type Activity = { operation_key: string; model: string; provider_model: string | null; status: string; input_tokens: number | null; output_tokens: number | null; provider_cost_micro_usd: string | null; user_debit_micro_usd: string | null; created_at: string; completed_at: string | null };
type Eligibility = "loading" | "eligible" | "insufficient_balance" | "wrong_network" | "verification_error" | "unauthenticated";
const models = ["glm-4.5", "qwen3-235b-a22b", "deepseek-v3.1", "kimi-k2"];
const labels: Record<string, string> = { "glm-4.5": "GLM-4.5", "qwen3-235b-a22b": "Qwen3 235B A22B", "deepseek-v3.1": "DeepSeek-V3.1", "kimi-k2": "Kimi K2" };
const draft = (): Conversation => ({ title: "New conversation", date: "Just now", messages: [], loaded: true });

// Assistant output is markdown; render it richly. Memoized so streaming re-renders
// of the parent don't re-parse settled messages.
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
});

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const usd = (micro: string | null | undefined) => micro == null ? "—" : `$${(Number(micro) / 1_000_000).toFixed(4)}`;

export default function DashboardPage() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const [eligibility, setEligibility] = useState<Eligibility>("loading");
  const [wallet, setWallet] = useState("");
  const [balance, setBalance] = useState("0.00");
  const [notice, setNotice] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([draft()]);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [model, setModel] = useState(models[0]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activeOp, setActiveOp] = useState<string | undefined>(undefined);
  const [view, setView] = useState<"chat" | "compute">("chat");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [activity, setActivity] = useState<Activity[] | null>(null);
  const [activityState, setActivityState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const messagesRef = useRef<HTMLDivElement>(null);
  const current = conversations[selected] ?? conversations[0];
  const filtered = useMemo(() => conversations.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [conversations, query]);

  const authHeaders = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("no token");
    return { Authorization: `Bearer ${token}` };
  }, [getAccessToken]);

  const refresh = useCallback(async () => {
    if (!authenticated) { setEligibility("unauthenticated"); return; }
    setEligibility("loading"); setNotice("");
    try {
      const headers = await authHeaders();
      const account = await fetch("/api/account", { headers, cache: "no-store" });
      if (!account.ok) throw new Error();
      const accountData = await account.json() as { account: { walletAddress: string }; eligibility?: { state: string } | null; compute?: { available: string } };
      setWallet(accountData.account.walletAddress);
      const verification = await fetch("/api/holder/verify", { method: "POST", headers });
      if (!verification.ok) { setEligibility(verification.status === 401 ? "unauthenticated" : "verification_error"); return; }
      const result = await verification.json() as { eligibility: { state: string; chain_id?: number } };
      if (result.eligibility.state === "eligible") {
        setEligibility("eligible");
        const allowance = await fetch("/api/allowance", { headers });
        if (allowance.ok) { const data = await allowance.json() as { balance?: { available: string } }; setBalance((Number(data.balance?.available ?? 0) / 1_000_000).toFixed(2)); }
      } else if (result.eligibility.state === "insufficient_balance") setEligibility("insufficient_balance");
      else if (result.eligibility.state === "wrong_wallet") setEligibility("wrong_network");
      else setEligibility("verification_error");
    } catch { setEligibility("verification_error"); setNotice("Verification is temporarily unavailable. Retry without billable access."); }
  }, [authenticated, authHeaders]);

  // Load persisted conversations so history survives reloads (PRD §16.3, §28.6).
  const loadConversations = useCallback(async () => {
    if (!authenticated) return;
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/conversations", { headers, cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as { conversations: Array<{ id: string; title: string | null; updated_at: string; message_count: number }> };
      const loaded: Conversation[] = data.conversations.map((c) => ({ id: c.id, title: c.title || "New conversation", date: relativeTime(c.updated_at), messages: [], loaded: false }));
      setConversations(loaded.length ? loaded : [draft()]);
      setSelected(0);
    } catch { /* keep current state on failure */ }
  }, [authenticated, authHeaders]);

  const loadMessages = useCallback(async (conversationId: string, index: number) => {
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/conversations/${conversationId}`, { headers, cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as { messages: Array<{ role: "user" | "assistant"; content: string; partial: boolean; model_slug: string | null }> };
      const messages: Message[] = data.messages.map((m) => ({ role: m.role, text: m.content, partial: m.partial, model: m.model_slug ?? undefined }));
      setConversations((items) => items.map((item, i) => i === index ? { ...item, messages, loaded: true } : item));
    } catch { /* leave unloaded; will retry on next select */ }
  }, [authHeaders]);

  useEffect(() => { if (ready) void refresh(); }, [ready, authenticated, refresh]);
  useEffect(() => { if (ready && authenticated) void loadConversations(); }, [ready, authenticated, loadConversations]);
  // Lazily fetch messages for the selected conversation the first time it opens.
  useEffect(() => {
    const c = conversations[selected];
    if (c?.id && !c.loaded) void loadMessages(c.id, selected);
  }, [selected, conversations, loadMessages]);
  // Keep the newest message / streaming tokens in view.
  useEffect(() => { messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight }); }, [streamingText, current?.messages.length, selected]);
  // Dismiss the delete confirmation on Escape.
  useEffect(() => {
    if (confirmDelete === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirmDelete(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete]);

  async function selectConversation(index: number) { setSelected(index); setView("chat"); }

  async function performDelete(index: number) {
    const target = conversations[index];
    setConfirmDelete(null);
    setConversations((items) => { const next = items.filter((_, i) => i !== index); return next.length ? next : [draft()]; });
    setSelected((s) => (index < s ? s - 1 : Math.max(0, index === s ? index - 1 : s)));
    if (!target?.id) return;
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/conversations/${target.id}`, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) { setNotice("Could not delete the conversation on the server. It may reappear on reload."); return; }
      setNotice("Conversation deleted.");
    } catch { setNotice("Could not reach the server to delete the conversation."); }
  }

  const loadActivity = useCallback(async () => {
    setActivityState("loading");
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/activity", { headers, cache: "no-store" });
      if (!res.ok) { setActivityState("error"); return; }
      const data = await res.json() as { activity: Activity[] };
      setActivity(data.activity); setActivityState("ready");
    } catch { setActivityState("error"); }
  }, [authHeaders]);

  function openCompute() { setView("compute"); void loadActivity(); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || streaming) { if (!prompt.trim()) setNotice("Enter a message before submitting."); return; }
    if (eligibility !== "eligible") { setNotice(eligibility === "insufficient_balance" ? "Holder eligibility is required before inference." : "Verification must complete before inference is enabled."); return; }
    setStreaming(true); setStreamingText(""); setNotice(""); const text = prompt.trim(); setPrompt("");
    const conversationId = current?.id;
    setConversations((items) => items.map((item, index) => index === selected ? { ...item, title: item.messages.length ? item.title : text.slice(0, 42), messages: [...item.messages, { role: "user", text }] } : item));
    const opKey = crypto.randomUUID(); setActiveOp(opKey);
    try {
      const headers = await authHeaders();
      const response = await fetch("/api/chat", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ message: text, model, conversationId, operationKey: opKey }) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let output = ""; let buffer = ""; let newId: string | undefined; let lastPaint = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw) continue;
          const event = JSON.parse(raw) as { type: string; text?: string; error?: string; conversationId?: string };
          if (event.type === "delta") {
            output += event.text ?? "";
            // Throttle repaints so long responses stay smooth (~20fps).
            const now = Date.now();
            if (now - lastPaint > 50) { lastPaint = now; setStreamingText(output); }
          }
          if ((event.type === "complete" || event.type === "cancelled") && event.conversationId) newId = event.conversationId;
          if (event.type === "error") throw new Error(event.error);
        }
      }
      // Commit the finished message and tear down the streaming bubble in the
      // same render so the two never show at once (avoids a visible duplicate
      // while the balance refresh below is in flight).
      setConversations((items) => items.map((item, index) => index === selected ? { ...item, id: item.id ?? newId, loaded: true, date: "Just now", messages: [...item.messages, { role: "assistant", text: output || "No response content was returned.", model }] } : item));
      setStreaming(false); setStreamingText("");
      void refresh();
    } catch { setNotice("The response could not be completed. Retry with a new request; no unsafe client-side charge was applied."); }
    finally { setStreaming(false); setStreamingText(""); }
  }
  async function stop() { setNotice("Stop requested · any persisted partial output remains in conversation history."); const op = activeOp; if (op) { try { const headers = await authHeaders(); await fetch("/api/inference/stop", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ operationKey: op }) }); } catch { /* best effort */ } } }
  const statusText = { loading: "VERIFYING", eligible: "ELIGIBLE", insufficient_balance: "NOT ELIGIBLE", wrong_network: "WRONG NETWORK", verification_error: "VERIFICATION ERROR", unauthenticated: "AUTHENTICATION REQUIRED" }[eligibility];

  function newConversation() { setConversations((items) => [draft(), ...items]); setSelected(0); setView("chat"); }

  return <main className="dashboard"><aside className="sidebar"><div className="brand"><span className="mark">✦</span> OPENWEIGHT</div><div className="eyebrow">WORKSPACE</div><nav><a className={view === "chat" ? "active" : ""} href="#chat" onClick={(e) => { e.preventDefault(); setView("chat"); }}>◌ <span>Workspace</span></a><a className={view === "compute" ? "active" : ""} href="#compute" onClick={(e) => { e.preventDefault(); openCompute(); }}>◉ <span>Compute activity</span></a></nav><div className="side-status"><span className="dot" /> {statusText}<br/><small>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "No canonical wallet"}</small></div><button className="exit" onClick={() => void logout()}>Sign out ↗</button></aside><section className="main"><header className="mobile-head"><span className="brand">OPENWEIGHT</span><span className="dot" /></header><header className="topbar"><div><div className="eyebrow">WORKSPACE / SERVER-VERIFIED</div><h1>Think with curated<br/><em>open-weight models.</em></h1><p>Eligibility, wallet identity, allowance, and inference are verified server-side before billable work begins.</p></div><div className="balance"><span>AVAILABLE COMPUTE</span><b>${balance}</b><button onClick={() => { void refresh(); if (view === "compute") void loadActivity(); }}>Refresh status ↻</button></div></header><div className="workspace"><section className="history panel"><button className="new-chat" onClick={newConversation}>＋ New conversation</button><label className="search">⌕ <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search history"/></label><div className="history-list">{filtered.map((item) => { const index = conversations.indexOf(item); return <div key={(item.id ?? item.title) + index} className={`history-item ${item === current && view === "chat" ? "selected" : ""}`}><button className="history-open" onClick={() => void selectConversation(index)}><span>{item.title}</span><small>{item.date}</small></button><button className="history-delete" aria-label={`Delete ${item.title}`} title="Delete conversation" onClick={() => setConfirmDelete(index)}>🗑</button></div>; })}</div></section>{view === "compute" ? <section className="chat panel" id="compute"><div className="chat-head"><span>OPENWEIGHT / COMPUTE ACTIVITY</span><button className="ghost" onClick={() => void loadActivity()}>Reload ↻</button></div><div className="activity">{activityState === "loading" ? <p className="muted">Loading compute activity…</p> : activityState === "error" ? <div className="welcome"><span className="mark large">⚠</span><h2>Couldn’t load compute activity</h2><p>The activity service didn’t respond. This is usually transient.</p><div className="suggestions"><button onClick={() => void loadActivity()}>Retry ↻</button></div></div> : !activity || activity.length === 0 ? <div className="welcome"><span className="mark large">◉</span><h2>No compute activity yet</h2><p>Metered inference runs will appear here with token counts and settled cost.</p></div> : <table className="activity-table"><thead><tr><th>When</th><th>Model</th><th>Status</th><th>In / Out</th><th>Provider cost</th><th>Your debit</th></tr></thead><tbody>{activity.map((a) => <tr key={a.operation_key}><td>{relativeTime(a.created_at)}</td><td>{labels[a.model] ?? a.model}</td><td><span className={`pill ${a.status}`}>{a.status}</span></td><td>{a.input_tokens ?? "—"} / {a.output_tokens ?? "—"}</td><td>{usd(a.provider_cost_micro_usd)}</td><td>{usd(a.user_debit_micro_usd)}</td></tr>)}</tbody></table>}</div></section> : <section className="chat panel" id="chat"><div className="chat-head"><span>OPENWEIGHT / CHAT</span><span className={`eligible ${eligibility !== "eligible" ? "degraded" : ""}`}><i/> {statusText}</span></div><div className="messages" ref={messagesRef}>{current.messages.length === 0 && !streaming ? <div className="welcome"><span className="mark large">✦</span><h2>What are you working on?</h2><p>{eligibility === "eligible" ? "Choose an approved model, then send a prompt to begin." : eligibility === "loading" ? "Checking your authenticated account and holder status…" : "Chat remains locked until server verification confirms eligibility."}</p><div className="suggestions"><button onClick={() => setPrompt("Compare the trade-offs in my current plan")}>Compare a plan ↗</button><button onClick={() => setPrompt("Summarize research on open models")}>Summarize research ↗</button></div></div> : current.messages.map((message, index) => <article className={message.role} key={index}><span>{message.role === "user" ? "YOU" : `OPENWEIGHT · ${(labels[message.model ?? model] ?? "MODEL").toUpperCase()}`}</span>{message.role === "assistant" ? <>{<Markdown text={message.text} />}{message.partial && <small className="partial"> · partial</small>}</> : <p>{message.text}</p>}</article>)}{streaming && <article className="assistant streaming"><span>OPENWEIGHT · {(labels[model] ?? "MODEL").toUpperCase()}</span>{streamingText ? <Markdown text={streamingText} /> : <p className="typing">● ● ●</p>}<button onClick={stop}>■ Stop response</button></article>}</div><form className="composer" onSubmit={submit}><select aria-label="Select approved model" value={model} onChange={(e) => setModel(e.target.value)}><option value="auto">Auto routing</option>{models.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select><input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Message Openweight..." aria-label="Message Openweight"/><button type="submit" disabled={!prompt.trim() || streaming || eligibility !== "eligible"}>↑</button><small>{labels[model] ?? "Auto routing"} · metered inference</small></form>{notice && <div className="notice" role="status">{notice}</div>}</section>}</div></section>{confirmDelete !== null && (() => {
  const target = conversations[confirmDelete]; if (!target) return null;
  const scrim: CSSProperties = { position: "fixed", inset: 0, background: "rgba(20,20,24,.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 };
  const card: CSSProperties = { background: "#fff", border: "1px solid #e4e4e7", borderRadius: 14, width: "100%", maxWidth: 380, padding: 24, boxShadow: "0 20px 50px rgba(0,0,0,.28)", fontFamily: "inherit" };
  const btn: CSSProperties = { minHeight: 38, padding: "0 16px", borderRadius: 999, fontSize: 13, cursor: "pointer", fontFamily: "inherit" };
  return <div role="dialog" aria-modal="true" style={scrim} onClick={() => setConfirmDelete(null)}>
    <div style={card} onClick={(e) => e.stopPropagation()}>
      <h3 style={{ fontSize: 17, fontWeight: 600, margin: "0 0 8px", color: "#171719" }}>Delete conversation?</h3>
      <p style={{ color: "#73757b", fontSize: 13.5, lineHeight: 1.5, margin: 0 }}>“{target.title}” and all its messages will be permanently removed.</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 22 }}>
        <button style={{ ...btn, border: "1px solid #dedfe2", background: "#fff", color: "#171719" }} onClick={() => setConfirmDelete(null)}>Cancel</button>
        <button style={{ ...btn, border: "1px solid #c14a3b", background: "#c14a3b", color: "#fff" }} onClick={() => void performDelete(confirmDelete)}>Delete</button>
      </div>
    </div>
  </div>;
})()}</main>;
}

"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type Message = { role: "user" | "assistant"; text: string; partial?: boolean };
type Conversation = { title: string; date: string; messages: Message[] };
type Eligibility = "loading" | "eligible" | "insufficient_balance" | "wrong_network" | "verification_error" | "unauthenticated";
const models = ["glm-4.5", "qwen3-235b-a22b", "deepseek-v3.1", "kimi-k2"];
const labels: Record<string, string> = { "glm-4.5": "GLM-4.5", "qwen3-235b-a22b": "Qwen3 235B A22B", "deepseek-v3.1": "DeepSeek-V3.1", "kimi-k2": "Kimi K2" };
const seed: Conversation[] = [{ title: "New conversation", date: "Just now", messages: [] }];

export default function DashboardPage() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const [eligibility, setEligibility] = useState<Eligibility>("loading");
  const [wallet, setWallet] = useState("");
  const [balance, setBalance] = useState("0.00");
  const [notice, setNotice] = useState("");
  const [conversations, setConversations] = useState(seed);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [model, setModel] = useState(models[0]);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const current = conversations[selected];
  const filtered = useMemo(() => conversations.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [conversations, query]);

  async function refresh() {
    if (!authenticated) { setEligibility("unauthenticated"); return; }
    setEligibility("loading"); setNotice("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error();
      const headers = { Authorization: `Bearer ${token}` };
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
  }
  useEffect(() => { if (ready) void refresh(); }, [ready, authenticated]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || streaming) { if (!prompt.trim()) setNotice("Enter a message before submitting."); return; }
    if (eligibility !== "eligible") { setNotice(eligibility === "insufficient_balance" ? "Holder eligibility is required before inference." : "Verification must complete before inference is enabled."); return; }
    setStreaming(true); setNotice("Reserving compute · streaming response"); const text = prompt.trim(); setPrompt("");
    setConversations((items) => items.map((item, index) => index === selected ? { ...item, title: item.messages.length ? item.title : text.slice(0, 42), messages: [...item.messages, { role: "user", text }] } : item));
    try {
      const token = await getAccessToken();
      const response = await fetch("/api/chat", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ message: text, model }) });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let output = "";
      while (true) { const { done, value } = await reader.read(); if (done) break; for (const line of decoder.decode(value).split("\n")) { if (!line.startsWith("data: ")) continue; const event = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string }; if (event.type === "delta") { output += event.text ?? ""; setNotice("Streaming response · usage will settle on completion"); } if (event.type === "error") throw new Error(event.error); } }
      setConversations((items) => items.map((item, index) => index === selected ? { ...item, messages: [...item.messages, { role: "assistant", text: output || "No response content was returned." }] } : item)); await refresh(); setNotice("");
    } catch { setNotice("The response could not be completed. Retry with a new request; no unsafe client-side charge was applied."); }
    finally { setStreaming(false); }
  }
  function stop() { setStreaming(false); setNotice("Stop requested · any persisted partial output remains in conversation history."); }
  const statusText = { loading: "VERIFYING", eligible: "ELIGIBLE", insufficient_balance: "NOT ELIGIBLE", wrong_network: "WRONG NETWORK", verification_error: "VERIFICATION ERROR", unauthenticated: "AUTHENTICATION REQUIRED" }[eligibility];
  return <main className="dashboard"><aside className="sidebar"><div className="brand"><span className="mark">✦</span> OPENWEIGHT</div><div className="eyebrow">WORKSPACE</div><nav><a className="active" href="#chat">◌ <span>Workspace</span></a><a href="#compute">◉ <span>Compute activity</span></a></nav><div className="side-status"><span className="dot" /> {statusText}<br/><small>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "No canonical wallet"}</small></div><button className="exit" onClick={() => void logout()}>Sign out ↗</button></aside><section className="main"><header className="mobile-head"><span className="brand">OPENWEIGHT</span><span className="dot" /></header><header className="topbar"><div><div className="eyebrow">WORKSPACE / SERVER-VERIFIED</div><h1>Think with curated<br/><em>open-weight models.</em></h1><p>Eligibility, wallet identity, allowance, and inference are verified server-side before billable work begins.</p></div><div className="balance"><span>AVAILABLE COMPUTE</span><b>${balance}</b><button onClick={() => void refresh()}>Refresh status ↻</button></div></header><div className="workspace"><section className="history panel"><button className="new-chat" onClick={() => { setConversations((items) => [{ title: "New conversation", date: "Just now", messages: [] }, ...items]); setSelected(0); }}>＋ New conversation</button><label className="search">⌕ <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search history"/></label><div className="history-list">{filtered.map((item) => <button key={item.title + item.date} className={item === current ? "selected" : ""} onClick={() => setSelected(conversations.indexOf(item))}><span>{item.title}</span><small>{item.date}</small></button>)}</div></section><section className="chat panel" id="chat"><div className="chat-head"><span>OPENWEIGHT / CHAT</span><span className={`eligible ${eligibility !== "eligible" ? "degraded" : ""}`}><i/> {statusText}</span></div><div className="messages">{current.messages.length === 0 && !streaming ? <div className="welcome"><span className="mark large">✦</span><h2>What are you working on?</h2><p>{eligibility === "eligible" ? "Choose an approved model, then send a prompt to begin." : eligibility === "loading" ? "Checking your authenticated account and holder status…" : "Chat remains locked until server verification confirms eligibility."}</p><div className="suggestions"><button onClick={() => setPrompt("Compare the trade-offs in my current plan")}>Compare a plan ↗</button><button onClick={() => setPrompt("Summarize research on open models")}>Summarize research ↗</button></div></div> : current.messages.map((message, index) => <article className={message.role} key={index}><span>{message.role === "user" ? "YOU" : `OPENWEIGHT · ${labels[model].toUpperCase()}`}</span><p>{message.text}{message.partial && <small className="partial"> · partial</small>}</p></article>)}{streaming && <article className="assistant streaming"><span>OPENWEIGHT · STREAMING</span><p className="typing">● ● ●</p><button onClick={stop}>■ Stop response</button></article>}</div><form className="composer" onSubmit={submit}><select aria-label="Select approved model" value={model} onChange={(e) => setModel(e.target.value)}><option value="auto">Auto routing</option>{models.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select><input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Message Openweight..." aria-label="Message Openweight"/><button type="submit" disabled={!prompt.trim() || streaming || eligibility !== "eligible"}>↑</button><small>{labels[model] ?? "Auto routing"} · metered inference</small></form>{notice && <div className="notice" role="status">{notice}</div>}</section></div></section></main>;
}

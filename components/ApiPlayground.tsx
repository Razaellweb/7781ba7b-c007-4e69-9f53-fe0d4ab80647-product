"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type RegistryModel = { id: string; displayName: string; providerModelSlug: string; availability: string; syncStatus: string };
type RequestState = "idle" | "loading" | "success" | "error";

const fallbackNotes: Record<string, string> = {
  "glm-5-3-flash": "Fast, direct synthesis for everyday work.",
  "qwen-3-8-27b": "Structured output for practical workflows.",
  "deepseek-v4-1-flash": "Careful reasoning for layered questions.",
  "kimi-k3": "Clear long-form thinking with a calm voice.",
  "gemma-4-31b": "Balanced open-weight assistance for general work.",
};

const simulatedResponses: Record<string, string> = {
  "glm-5-3-flash": "A useful first pass starts with the decision, then keeps the next action small. This local demo response is tuned for clarity and momentum.",
  "qwen-3-8-27b": "1. Define the desired outcome.\n2. Name the constraints.\n3. Choose the smallest test that can teach you something.\n\nThis structured example is simulated locally for demonstration.",
  "deepseek-v4-1-flash": "Separate the question into constraints, evidence, and trade-offs. Compare the options against the same criteria before choosing a path. This is a locally simulated reasoning trace.",
  "kimi-k3": "The strongest answer is often the one that makes room for the next question. Here is a considered, illustrative response generated inside this page—not by a live provider.",
  "gemma-4-31b": "Start with the desired outcome, make the constraints explicit, and use the smallest useful experiment to learn what comes next. This response is simulated locally.",
};

const initialPayload = "{\n  \"prompt\": \"Help me think through a new idea.\",\n  \"temperature\": 0.7\n}";

export default function ApiPlayground() {
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [model, setModel] = useState<RegistryModel | null>(null);
  const [endpoint, setEndpoint] = useState("POST /v1/responses");
  const [payload, setPayload] = useState(initialPayload);
  const [state, setState] = useState<RequestState>("idle");
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/models", { cache: "no-store" }).then(async (result) => {
      if (!result.ok) throw new Error("REGISTRY_UNAVAILABLE");
      const data = await result.json() as { models?: RegistryModel[] };
      if (!cancelled) { const next = data.models ?? []; setModels(next); setModel(next[0] ?? null); }
    }).catch(() => { if (!cancelled) setError("The curated model registry is unavailable right now."); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const changeModel = (nextModel: RegistryModel) => {
    if (timer.current) clearTimeout(timer.current);
    setModel(nextModel); setState("idle"); setResponse(""); setError(""); setStartedAt(null);
  };

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setPayload(initialPayload); setState("idle"); setResponse(""); setError(""); setStartedAt(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state === "loading" || !model) return;
    let parsed: { prompt?: unknown };
    try { parsed = JSON.parse(payload) as { prompt?: unknown }; } catch { setState("error"); setResponse(""); setError("Request body must be valid JSON before it can be sent."); return; }
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) { setState("error"); setResponse(""); setError("Add a prompt to the request body before submitting."); return; }
    const requestModel = model;
    setState("loading"); setResponse(""); setError(""); setStartedAt(Date.now());
    timer.current = setTimeout(() => {
      if (requestModel.id !== model?.id) return;
      if (parsed.prompt?.toString().toLowerCase().includes("error")) { setState("error"); setError("Demo provider timeout: the simulated endpoint returned a retryable 504."); setStartedAt(null); return; }
      setState("success"); setResponse(simulatedResponses[requestModel.id] ?? "This curated model has no local simulation text configured."); setStartedAt(null);
    }, 1100);
  };

  const statusLabel = state === "loading" ? "PROCESSING" : state === "success" ? "200 OK" : state === "error" ? "SIMULATED ERROR" : "READY";
  const duration = startedAt ? `${Math.max(1, Math.round((Date.now() - startedAt) / 100)) * 100}ms` : state === "success" ? "1,100ms" : "—";

  return (
    <section id="api-interface" className="api-playground" aria-labelledby="api-playground-title">
      <style>{`\n        .api-playground{position:relative;z-index:1;margin-top:90px;border:1px solid #343438;border-radius:24px;background:#f1f1ef;color:#18181a;overflow:hidden;box-shadow:0 24px 80px #00000035}.api-playground-intro{display:flex;justify-content:space-between;align-items:flex-end;gap:30px;padding:30px 32px;border-bottom:1px solid #d7d7d4}.api-playground-kicker{font:9px var(--font-geist-mono),monospace;letter-spacing:.14em;color:#6c6d72}.api-playground h3{font-size:clamp(2rem,4vw,4rem);font-weight:400;letter-spacing:-.08em;line-height:.9;margin:17px 0 0}.api-playground-intro p{max-width:300px;color:#68696e;font-size:13px;line-height:1.55;margin:0}.api-playground-notice{padding:12px 32px;background:#e7e7e3;border-bottom:1px solid #d7d7d4;color:#68696e;font:10px var(--font-geist-mono),monospace;letter-spacing:.02em}.api-playground-layout{display:grid;grid-template-columns:220px minmax(0,1fr) minmax(260px,.85fr);min-height:470px}.api-models{padding:22px 14px;border-right:1px solid #d7d7d4}.api-models-label,.api-label{display:block;font:9px var(--font-geist-mono),monospace;letter-spacing:.12em;color:#85868b;margin-bottom:12px}.api-models button{display:block;width:100%;border:0;border-left:2px solid transparent;background:transparent;text-align:left;padding:13px 11px;color:#68696e;cursor:pointer;font:11px var(--font-geist-mono),monospace;transition:.18s}.api-models button:hover{background:#e7e7e4}.api-models button.selected{border-left-color:#e57454;background:#e7e7e4;color:#18181a}.api-models button small{display:block;color:#96979b;font:10px Arial,sans-serif;line-height:1.35;margin-top:6px}.api-models button.selected small{color:#68696e}.api-request,.api-response{min-width:0;padding:22px}.api-request{border-right:1px solid #d7d7d4}.api-endpoint{display:flex;gap:8px;margin-bottom:20px}.api-endpoint select{max-width:100%;border:1px solid #cfd0cd;border-radius:7px;background:#fff;padding:9px 10px;color:#18181a;font:10px var(--font-geist-mono),monospace}.api-code-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}.api-code-label span:last-child{color:#a0a1a4;font:9px var(--font-geist-mono),monospace}.api-code{width:100%;min-height:200px;resize:vertical;display:block;overflow:auto;border:1px solid #d1d2cf;border-radius:9px;background:#1a1a1d;color:#e6e6e3;padding:14px;font:12px/1.6 var(--font-geist-mono),monospace;outline:none}.api-code:focus{box-shadow:0 0 0 2px #e5745466}.api-helper{color:#85868b;font-size:11px;line-height:1.45;margin:9px 0 0}.api-actions{display:flex;align-items:center;gap:10px;margin-top:18px}.api-submit,.api-reset{border-radius:999px;padding:11px 16px;cursor:pointer;font:10px var(--font-geist-mono),monospace}.api-submit{border:1px solid #18181a;background:#18181a;color:#fff}.api-submit:disabled{opacity:.45;cursor:not-allowed}.api-reset{border:1px solid #cfd0cd;background:transparent;color:#68696e}.api-progress{height:3px;background:#d7d7d4;margin-top:18px;overflow:hidden}.api-progress i{display:block;width:45%;height:100%;background:#e57454;animation:api-progress 1.1s ease-in-out infinite}.api-result{border:1px solid #d1d2cf;border-radius:9px;background:#fff;min-height:200px;max-height:245px;overflow:auto;padding:14px;font:12px/1.6 var(--font-geist-mono),monospace;white-space:pre-wrap;overflow-wrap:anywhere}.api-result.empty{color:#9a9b9e}.api-result.error{background:#fbefeb;color:#a44e43}.api-result.success{color:#3b5e4c}.api-metadata{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:17px;padding-top:16px;border-top:1px solid #d7d7d4}.api-metadata b,.api-metadata span{display:block}.api-metadata span{font:9px var(--font-geist-mono),monospace;color:#929398;margin-bottom:5px}.api-metadata b{font:11px var(--font-geist-mono),monospace;font-weight:400}.api-footnote{padding:14px 32px;border-top:1px solid #d7d7d4;color:#85868b;font-size:11px;line-height:1.5}@keyframes api-progress{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}@media(max-width:950px){.api-playground-layout{grid-template-columns:190px minmax(0,1fr)}.api-response{grid-column:2;border-top:1px solid #d7d7d4}.api-models{grid-row:span 2}.api-playground-intro{display:block}.api-playground-intro p{margin-top:18px}}@media(max-width:620px){.api-playground{margin-top:60px;border-radius:18px}.api-playground-intro,.api-playground-notice,.api-footnote{padding-left:18px;padding-right:18px}.api-playground-layout{display:block}.api-models{border-right:0;border-bottom:1px solid #d7d7d4;padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:4px}.api-models-label{grid-column:1/-1}.api-request,.api-response{border-right:0;padding:18px}.api-response{border-top:1px solid #d7d7d4}.api-code{min-height:180px}.api-result{min-height:150px}}@media(prefers-reduced-motion:reduce){.api-progress i{animation:none}}\n      `}</style>
      <div className="api-playground-intro"><div><span className="api-playground-kicker">// PLAYGROUND / LOCAL SIMULATION</span><h3 id="api-playground-title">INFERENCE INFRASTRUCTURE.<br /><em>BUILT FOR The new era</em></h3></div><p>Choose a curated model, shape a request, and see how an endpoint responds. No account, wallet, key, or network call required.</p></div>
      <div className="api-playground-notice">DEMO MODE · Responses are illustrative simulations, never live provider output.</div>
      <div className="api-playground-layout">
        <aside className="api-models" aria-label="Select a curated demo model"><span className="api-models-label">MODEL / SELECT ONE</span>{models.map((item) => <button type="button" key={item.id} className={model?.id === item.id ? "selected" : ""} aria-pressed={model?.id === item.id} onClick={() => changeModel(item)}>{item.displayName}<small>{model?.id === item.id ? "selected · ready" : fallbackNotes[item.id] ?? "Curated model · metadata unavailable"}</small></button>)}</aside>
        <form className="api-request" onSubmit={submit}><div className="api-label">01 / REQUEST</div><div className="api-endpoint"><select value={endpoint} onChange={(event) => setEndpoint(event.target.value)} aria-label="Choose demo endpoint"><option>POST /v1/responses</option><option>POST /v1/structured-output</option></select></div><div className="api-code-label"><span className="api-label" style={{ margin: 0 }}>JSON PAYLOAD</span><span>editable</span></div><textarea className="api-code" value={payload} onChange={(event) => setPayload(event.target.value)} aria-label="Edit request JSON" spellCheck={false} /> <p className="api-helper">Tip: include a non-empty <code>prompt</code>. Type “error” to preview a safe simulated failure.</p><div className="api-actions"><button className="api-submit" type="submit" disabled={state === "loading" || !model}>{state === "loading" ? "PROCESSING…" : "SEND REQUEST ↗"}</button><button className="api-reset" type="button" onClick={reset}>RESET</button></div>{state === "loading" && <div className="api-progress" aria-label="Simulated request in progress"><i /></div>}</form>
        <div className="api-response"><div className="api-label">02 / RESPONSE <span style={{ float: "right", color: state === "error" ? "#a44e43" : state === "success" ? "#4d896d" : "#85868b" }}>{statusLabel}</span></div><div className={`api-result ${state === "error" ? "error" : state === "success" ? "success" : "empty"}`} aria-live="polite">{state === "idle" ? (models.length ? "Your simulated response will appear here." : error || "Loading the curated model registry…") : state === "loading" ? "Running a local demo…\n\nThe selected curated model context is being applied." : state === "error" ? error : response}</div><div className="api-metadata"><div><span>MODEL</span><b>{model?.displayName ?? "Unavailable"}</b></div><div><span>CURATED ID</span><b>{model?.id ?? "unavailable"}</b></div><div><span>ENDPOINT</span><b>{endpoint.split(" ")[1]}</b></div><div><span>MODE</span><b>LOCAL / DEMO</b></div></div></div>
      </div>
      <div className="api-footnote">Switching models while a request is processing cancels that simulation and clears its response, so results are never attributed to the wrong curated model.</div>
    </section>
  );
}
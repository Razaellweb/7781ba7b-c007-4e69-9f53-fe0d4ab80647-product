"use client";

import { useEffect, useState } from "react";

type RegistryModel = { id: string; displayName: string };

export default function AccessSystem() {
  const [models, setModels] = useState<RegistryModel[]>([]);
  const [model, setModel] = useState("auto");
  const [streaming, setStreaming] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/models", { cache: "no-store" }).then(async (result) => {
      if (!result.ok) throw new Error("REGISTRY_UNAVAILABLE");
      const data = await result.json() as { models?: RegistryModel[] };
      if (!cancelled) { const next = data.models ?? []; setModels(next); setModel(next[0]?.id ?? "auto"); }
    }).catch(() => { if (!cancelled) { setModels([]); setModel("auto"); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { setStreaming((value) => (value >= 100 ? 0 : value + 2)); }, 90);
    return () => window.clearInterval(timer);
  }, []);

  const selectedModel = models.find((item) => item.id === model);
  const response = "The useful answer is usually a clearer question. I’ll map the trade-offs, keep the reasoning visible, and stay within your current compute allowance.";
  const visibleResponse = response.slice(0, Math.max(1, Math.floor(response.length * streaming / 100)));
  const displayModel = selectedModel?.displayName ?? "Curated registry loading";

  return (
    <section className="access-system" aria-labelledby="access-system-heading">
      <style>{`\n        .access-system{margin-top:92px;background:#f7f7f4;border:1px solid #d1d1ce;border-radius:22px;overflow:hidden;box-shadow:0 24px 70px #20202a12;color:#171719}.access-system-head{display:flex;justify-content:space-between;align-items:flex-start;gap:28px;padding:24px 26px;border-bottom:1px solid #d9d9d5}.access-system-label{font:9px var(--font-geist-mono),monospace;letter-spacing:.13em;color:#74757a}.access-system-head h3{font-size:clamp(1.45rem,3vw,2.2rem);font-weight:400;letter-spacing:-.06em;margin:10px 0 0}.access-system-head h3 em{font-family:Georgia,serif;font-weight:400}.access-system-balance{text-align:right;white-space:nowrap}.access-system-balance b{display:block;font-size:22px;font-weight:400;margin:7px 0 3px}.access-system-balance small{color:#777;font:9px var(--font-geist-mono),monospace}.access-system-body{display:grid;grid-template-columns:205px minmax(0,1fr);min-height:365px}.access-system-models{padding:20px 14px;border-right:1px solid #d9d9d5;background:#efefec}.access-system-models label{display:block;margin:0 10px 10px}.access-model{width:100%;border:0;background:transparent;border-radius:10px;padding:12px 10px;text-align:left;color:#6e7076;cursor:pointer;font-size:12px}.access-model:hover,.access-model.active{background:#fff;color:#171719;box-shadow:0 2px 8px #20202a0d}.access-model.active{font-weight:500}.access-model span{display:block;font:9px var(--font-geist-mono),monospace;color:#e27451;margin-bottom:5px}.access-model.active span{color:#4f8c72}.access-conversation{display:flex;flex-direction:column;min-width:0}.access-conversation-top{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid #d9d9d5;font:9px var(--font-geist-mono),monospace;color:#888;letter-spacing:.08em}.access-live{color:#4c8d70}.access-live i{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:6px}.access-messages{padding:22px 26px;flex:1}.access-message{max-width:620px;padding:14px 0;border-bottom:1px solid #dededb}.access-message>span{font:9px var(--font-geist-mono),monospace;color:#8b8c91;letter-spacing:.08em}.access-message p{font-size:14px;line-height:1.65;margin:8px 0 0}.access-message.assistant{border-left:2px solid #e57454;padding-left:16px}.access-message.assistant p:after{content:"▍";color:#e57454;margin-left:3px;animation:access-blink 1s steps(2,end) infinite}.access-composer{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:5px;margin:0 20px 20px;padding:7px;border:1px solid #cfcfcd;border-radius:13px;background:#fff}.access-composer select,.access-composer input{border:0;outline:0;background:transparent;padding:11px;font-size:12px;color:#34353a}.access-composer select{font:9px var(--font-geist-mono),monospace;border-right:1px solid #dededb}.access-composer button{width:37px;height:37px;border:0;border-radius:9px;background:#171719;color:#fff;cursor:pointer}.access-composer small{grid-column:2;color:#8b8c91;font:9px var(--font-geist-mono),monospace;padding:0 11px 4px}.access-system-foot{display:flex;justify-content:space-between;gap:20px;padding:14px 20px;border-top:1px solid #d9d9d5;background:#ecece9;color:#73747a;font:9px var(--font-geist-mono),monospace;letter-spacing:.08em}.access-system-foot strong{color:#171719;font-weight:400}.access-system-foot i{display:inline-block;width:6px;height:6px;background:#5a9b79;border-radius:50%;margin-right:6px}@keyframes access-blink{50%{opacity:0}}@media(max-width:700px){.access-system{margin-top:58px}.access-system-head{display:block}.access-system-balance{text-align:left;margin-top:20px}.access-system-body{display:block}.access-system-models{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;border-right:0;border-bottom:1px solid #d9d9d5}.access-system-models label{grid-column:1/-1}.access-messages{padding:18px}.access-composer{margin:0 12px 12px}.access-system-foot{display:block;line-height:2}.access-system-foot span{display:block}}\n      `}</style>
      <div className="access-system-head"><div><div className="access-system-label">// OPENWEIGHT.SYSTEMS / ACCESS + COMPUTE</div><h3 id="access-system-heading">One system. Many <em>frontier</em> open-weight models.</h3></div><div className="access-system-balance"><span className="access-system-label">AVAILABLE COMPUTE</span><b>$18.42</b><small>of $25.00 allowance</small></div></div>
      <div className="access-system-body"><aside className="access-system-models"><label className="access-system-label">MODEL SELECTION</label>{models.map((item) => <button key={item.id} className={`access-model ${model === item.id ? "active" : ""}`} onClick={() => setModel(item.id)}><span>{model === item.id ? "SELECTED" : "OPEN-WEIGHT"}</span>{item.displayName}</button>)}</aside><div className="access-conversation"><div className="access-conversation-top"><span>CONVERSATION / NEW THREAD</span><span className="access-live"><i/>INFERENCE LIVE</span></div><div className="access-messages"><div className="access-message"><span>YOU</span><p>Help me think through the shape of a better open model workflow.</p></div><div className="access-message assistant"><span>OPENWEIGHT · {displayModel.toUpperCase()}</span><p>{visibleResponse}</p></div></div><form className="access-composer" onSubmit={(event) => event.preventDefault()}><select aria-label="Choose a model" value={model} onChange={(event) => setModel(event.target.value)}><option value="auto">Auto</option>{models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select><input aria-label="Message Openweight" placeholder="Continue the conversation..."/><button aria-label="Send message" type="submit">↑</button><small>{displayModel} · streamed response · compute tracked</small></form></div></div>
      <div className="access-system-foot"><span><i/>HOLDER VERIFIED · ACCESS UNLOCKED</span><span>RECURRING COMPUTE ALLOWANCE <strong>$18.42 REMAINING</strong></span><span>PROVIDER COMPLEXITY HIDDEN</span></div>
    </section>
  );
}
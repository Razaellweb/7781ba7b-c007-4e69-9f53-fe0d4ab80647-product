"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import AccessSystem from "@/components/AccessSystem";

const families = ["DeepSeek", "GLM", "Kimi", "Qwen"];
const evaluations = [
  { name: "Intelligence Index", focus: "Broad capability across reasoning, knowledge, and problem solving", source: "Artificial Analysis" },
  { name: "SWE-bench Verified", focus: "Software issue resolution in real repositories", source: "SWE-bench" },
  { name: "LiveCodeBench", focus: "Fresh competitive programming problems", source: "LiveCodeBench" },
  { name: "GPQA Diamond", focus: "Expert-level science questions", source: "GPQA" },
  { name: "Humanity's Last Exam", focus: "Broad expert knowledge and reasoning", source: "HLE" },
];

const dimensions = [
  { label: "General intelligence", deepseek: "Intelligence Index", gpt: "Intelligence Index" },
  { label: "Software work", deepseek: "SWE-bench Verified", gpt: "SWE-bench Verified" },
  { label: "Fresh coding", deepseek: "LiveCodeBench", gpt: "LiveCodeBench" },
  { label: "Expert reasoning", deepseek: "GPQA Diamond", gpt: "GPQA Diamond" },
  { label: "Knowledge breadth", deepseek: "Humanity's Last Exam", gpt: "Humanity's Last Exam" },
];

const benchmarkComparisons = [
  {
    proprietary: { name: "Claude Opus 4.8", scores: { Intelligence: "42.0", Coding: "74.3", Agentic: "42.6" } },
    open: { name: "GLM 5.3 Flash", scores: { Intelligence: "41.9", Coding: "71.5", Agentic: "51.2" } },
  },
  {
    proprietary: { name: "GPT-5.6 Sol", scores: { Intelligence: "47.1", Coding: "77.4", Agentic: "50.5" } },
    open: { name: "DeepSeek V4.1 Flash", scores: { Intelligence: "39.5", Coding: "74.2*", Agentic: "54.8*" } },
  },
  {
    proprietary: { name: "Grok 4.6", scores: { Intelligence: "44.4", Coding: "76.8", Agentic: "53.4" } },
    open: { name: "Qwen 3.8 2.4T", scores: { Intelligence: "40.0", Coding: "71.9", Agentic: "50.4" } },
  },
];

const metrics = ["Intelligence", "Coding", "Agentic"] as const;
type BenchmarkScores = Record<(typeof metrics)[number], string>;
type BenchmarkPair = (typeof benchmarkComparisons)[number];

function scoreSummary(model: { name: string; scores: BenchmarkScores }) {
  return `${model.name}: Intelligence ${model.scores.Intelligence}, Coding ${model.scores.Coding}, Agentic ${model.scores.Agentic}`;
}

function BenchmarkSide({ label, model, scores, tone }: { label: string; model: string; scores: BenchmarkScores; tone: "proprietary" | "open" }) {
  return (
    <div className={`benchmark-side benchmark-side-${tone}`}>
      <div className="benchmark-side-label">{label}</div>
      <h3>{model}</h3>
      <dl>
        {metrics.map((metric) => (
          <div className="benchmark-metric" key={metric}>
            <dt>{metric}</dt>
            <dd>{scores[metric]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function BenchmarkPair({ comparison, pairId, selected, onSelect }: { comparison: BenchmarkPair; pairId: string; selected: boolean; onSelect: (pairId: string) => void }) {
  const [hovered, setHovered] = useState(false);
  const label = `${comparison.proprietary.name} proprietary versus ${comparison.open.name} open-weight. ${scoreSummary(comparison.proprietary)}. ${scoreSummary(comparison.open)}.`;

  const activate = () => onSelect(pairId);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };

  return (
    <div
      className={`benchmark-pair${selected ? " is-selected" : ""}${hovered ? " is-hovered" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={label}
      onClick={activate}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <BenchmarkSide label="PROPRIETARY" model={comparison.proprietary.name} scores={comparison.proprietary.scores} tone="proprietary" />
      <BenchmarkSide label="OPEN-WEIGHT" model={comparison.open.name} scores={comparison.open.scores} tone="open" />
    </div>
  );
}

export default function Page() {
  const frontierRef = useRef<HTMLElement>(null);
  const benchmarkRef = useRef<HTMLElement>(null);
  const [frontierVisible, setFrontierVisible] = useState(false);
  const [selectedFamily, setSelectedFamily] = useState("DeepSeek");
  const [selectedPair, setSelectedPair] = useState<string | null>(null);

  useEffect(() => {
    const section = frontierRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setFrontierVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.25 });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const section = benchmarkRef.current;
    if (!section) return;
    const reveal = () => section.classList.toggle("is-visible", section.getBoundingClientRect().top < window.innerHeight * 0.78);
    reveal();
    window.addEventListener("scroll", reveal, { passive: true });
    return () => window.removeEventListener("scroll", reveal);
  }, []);

  return (
    <main className="landing">
      <style>{`
        .benchmark-proof{position:relative;overflow:hidden;background:#111113;color:#eee;padding:145px 9vw 155px;border-top:1px solid #29292c}.benchmark-proof:before{content:"";position:absolute;left:-12%;right:-12%;top:28%;height:180px;background:linear-gradient(90deg,transparent,#2d74e722 18%,#79dfff1d 37%,#f6e9d012 53%,#ff8e691c 68%,#2d74e722 88%,transparent);filter:blur(28px);transform:rotate(-4deg);pointer-events:none}.benchmark-proof-head{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:flex-end;gap:50px;margin-bottom:58px}.benchmark-proof-label{color:#85868c;font:9px var(--font-geist-mono),monospace;letter-spacing:.14em}.benchmark-proof h2{max-width:760px;font-size:clamp(3.6rem,7.2vw,8rem);font-weight:400;letter-spacing:-.1em;line-height:.84;margin:22px 0 0}.benchmark-proof-head p{max-width:390px;margin:0 0 5px;color:#a1a2a8;font-size:15px;line-height:1.6}.benchmark-comparison{position:relative;z-index:1;background:#f1f1ef;color:#18181a;border:1px solid #d7d7d4;border-radius:28px;overflow:hidden;box-shadow:0 20px 65px #0000001f}.benchmark-comparison-toolbar{display:flex;justify-content:flex-end;padding:22px 25px 0}.benchmark-copy-affordance{width:31px;height:31px;border:0;background:transparent;color:#171719;padding:0;position:relative;cursor:default}.benchmark-copy-affordance:before,.benchmark-copy-affordance:after{content:"";position:absolute;width:14px;height:14px;border:2px solid currentColor;border-radius:4px}.benchmark-copy-affordance:before{left:5px;top:9px;background:#f1f1ef}.benchmark-copy-affordance:after{left:11px;top:3px}.benchmark-pair{display:grid;grid-template-columns:1fr 1fr;gap:0;padding:26px 3.2vw 30px;cursor:pointer;outline:none;transition:background-color .18s ease,box-shadow .18s ease}.benchmark-pair+.benchmark-pair{border-top:1px solid #d7d7d4}.benchmark-pair:hover,.benchmark-pair.is-hovered,.benchmark-pair:focus-visible,.benchmark-pair.is-selected{background:#e6e6e3;box-shadow:inset 3px 0 0 #477b86}.benchmark-pair:focus-visible{outline:3px solid #111113;outline-offset:-6px}.benchmark-pair.is-selected{background:#e8e8e5}.benchmark-side{min-width:0;padding:0 2.2vw;transition:opacity .18s ease}.benchmark-side+ .benchmark-side{border-left:1px solid #d7d7d4}.benchmark-side-label{font:10px var(--font-geist-mono),monospace;letter-spacing:.11em;color:#68696d;margin-bottom:22px}.benchmark-side-open .benchmark-side-label{color:#477b86}.benchmark-side h3{font:21px var(--font-geist-mono),monospace;letter-spacing:-.04em;font-weight:400;margin:0 0 20px;overflow-wrap:anywhere}.benchmark-side dl{margin:0}.benchmark-metric{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:4px 0;font:14px var(--font-geist-mono),monospace;line-height:1.45;transition:color .18s ease,transform .18s ease}.benchmark-metric dt,.benchmark-metric dd{margin:0}.benchmark-metric dt{color:#393a3e}.benchmark-metric dd{color:#171719;text-align:right;min-width:4ch}.benchmark-side-open .benchmark-metric dd{color:#477b86}.benchmark-pair:hover .benchmark-metric,.benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair:focus-visible .benchmark-metric,.benchmark-pair.is-selected .benchmark-metric{transform:translateX(2px)}.benchmark-pair:hover .benchmark-metric dd,.benchmark-pair.is-hovered .benchmark-metric dd,.benchmark-pair:focus-visible .benchmark-metric dd,.benchmark-pair.is-selected .benchmark-metric dd{font-weight:600}.benchmark-note{position:relative;z-index:1;max-width:620px;margin:34px 0 0;padding-top:18px;border-top:1px solid #343438;color:#85868c;font-size:13px;line-height:1.6}.benchmark-note strong{color:#d8d8da;font-weight:400}
        .frontier-shift{position:relative;min-height:900px;padding:46px 9vw 130px;background:#101011;color:#eee;border-top:1px solid #29292c;overflow:hidden}.frontier-shift-top{display:flex;justify-content:space-between;color:#666;font:9px var(--font-geist-mono),monospace;letter-spacing:.13em}.frontier-shift-top span{color:#888}.frontier-shift-copy{display:flex;justify-content:space-between;align-items:flex-end;gap:40px;margin-top:105px}.frontier-shift h2{font-size:clamp(4rem,7vw,7.5rem);font-weight:400;letter-spacing:-.09em;line-height:.87;margin:0}.frontier-shift h2 em{font-family:Georgia,serif;font-weight:400}.frontier-shift-copy p{max-width:310px;margin:0 0 8px;color:#929297;font-size:15px;line-height:1.55}.frontier-map{position:relative;max-width:1080px;margin:120px auto 0;min-height:270px}.frontier-origin{position:absolute;left:0;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:14px;color:#eee;font:10px var(--font-geist-mono),monospace;letter-spacing:.1em;white-space:nowrap}.frontier-origin i{width:38px;height:38px;border:1px solid #e57454;border-radius:50%;display:block;box-shadow:0 0 0 8px #e5745414,0 0 35px #e5745466}.frontier-lines{position:absolute;left:145px;right:28%;top:0;height:100%}.frontier-lines i{position:absolute;left:0;width:100%;height:1px;background:linear-gradient(90deg,#e57454,#4a8fc4 55%,transparent);transform-origin:left center;opacity:.3;transition:transform 1s ease,opacity 1s ease}.frontier-lines i:nth-child(1){top:50%;transform:rotate(-24deg) scaleX(.2)}.frontier-lines i:nth-child(2){top:50%;transform:rotate(-8deg) scaleX(.2)}.frontier-lines i:nth-child(3){top:50%;transform:rotate(8deg) scaleX(.2)}.frontier-lines i:nth-child(4){top:50%;transform:rotate(24deg) scaleX(.2)}.frontier-map.is-visible .frontier-lines i{opacity:.8;transform:rotate(var(--frontier-angle)) scaleX(1)}.frontier-map.is-visible .frontier-lines i:nth-child(1){--frontier-angle:-24deg}.frontier-map.is-visible .frontier-lines i:nth-child(2){--frontier-angle:-8deg;transition-delay:.12s}.frontier-map.is-visible .frontier-lines i:nth-child(3){--frontier-angle:8deg;transition-delay:.24s}.frontier-map.is-visible .frontier-lines i:nth-child(4){--frontier-angle:24deg;transition-delay:.36s}.frontier-families{position:absolute;right:0;top:0;height:100%;display:flex;flex-direction:column;justify-content:space-between}.frontier-family{display:flex;align-items:baseline;gap:18px;opacity:0;transform:translateX(24px);transition:opacity .7s ease,transform .7s ease}.frontier-family span{font:9px var(--font-geist-mono),monospace;color:#e57454}.frontier-family strong{font-size:clamp(1.7rem,3vw,3.2rem);font-weight:400;letter-spacing:-.07em}.frontier-map.is-visible .frontier-family{opacity:1;transform:none}.frontier-map.is-visible .frontier-family:nth-child(1){transition-delay:.35s}.frontier-map.is-visible .frontier-family:nth-child(2){transition-delay:.5s}.frontier-map.is-visible .frontier-family:nth-child(3){transition-delay:.65s}.frontier-map.is-visible .frontier-family:nth-child(4){transition-delay:.8s}
        .proof-section{background:#e9e9e6;color:#171719;padding:130px 9vw 150px;border-top:1px solid #d0d0cd}.proof-heading{display:flex;justify-content:space-between;align-items:end;gap:40px;margin-bottom:55px}.proof-heading h2{font-size:clamp(4rem,7vw,7.5rem);font-weight:400;letter-spacing:-.09em;line-height:.87;margin:20px 0 0}.proof-heading h2 em{font-family:Georgia,serif;font-weight:400}.proof-heading p{max-width:310px;color:#696a70;font-size:15px;line-height:1.55}.proof-label{color:#6d6e73;font:9px var(--font-geist-mono),monospace;letter-spacing:.12em}.proof-section .proof-table-wrap{overflow-x:auto;opacity:0;transform:translateY(20px);transition:opacity .8s ease,transform .8s ease}.proof-section.is-visible .proof-table-wrap{opacity:1;transform:none}.proof-table{width:100%;min-width:650px;border-collapse:collapse;text-align:left;font-size:13px}.proof-table th,.proof-table td{padding:17px 13px;border-top:1px solid #c5c5c3;vertical-align:top}.proof-table th{font:9px var(--font-geist-mono),monospace;letter-spacing:.08em;color:#73747a;font-weight:400}.proof-table tbody th{font:13px Arial,sans-serif;color:#171719;letter-spacing:0}.proof-table td{color:#55565b}.proof-source{margin-top:18px;color:#777;font:9px var(--font-geist-mono),monospace;letter-spacing:.08em}.proof-note{max-width:650px;margin-top:34px;padding-top:18px;border-top:1px solid #c1c1be;color:#55565b;font-size:14px;line-height:1.6}.proof-note strong{color:#171719;font-weight:500}.family-controls{display:flex;flex-wrap:wrap;gap:8px;margin:25px 0 0}.family-controls button{border:1px solid #c5c5c3;background:transparent;border-radius:99px;padding:8px 12px;color:#55565b;font:10px var(--font-geist-mono),monospace;cursor:pointer}.family-controls button.active{background:#171719;color:#eee;border-color:#171719}
        .comparison-section{padding:125px 9vw 140px;background:#dededb;color:#171719;border-top:1px solid #c9c9c6}.comparison-heading{display:flex;justify-content:space-between;align-items:end;gap:50px;margin-bottom:58px}.comparison-heading h2{font-size:clamp(2.7rem,5.7vw,6.2rem);font-weight:400;letter-spacing:-.09em;line-height:.9;margin:18px 0 0}.comparison-heading h2 em{font-family:Georgia,serif;font-weight:400}.comparison-subtitle{margin:22px 0 0;color:#55565b;font:12px var(--font-geist-mono),monospace;letter-spacing:.05em}.comparison-table-wrap{max-width:1060px;overflow-x:auto}.comparison-table{width:100%;min-width:600px;border-collapse:collapse;text-align:left;font-size:14px}.comparison-table th,.comparison-table td{padding:16px 14px;border-top:1px solid #bdbdb9}.comparison-table thead th{color:#696a70;font:9px var(--font-geist-mono),monospace;letter-spacing:.08em;font-weight:400}.comparison-table tbody th{font-weight:400}.comparison-table td{color:#44464b}.comparison-note{max-width:650px;margin:34px 0 0;padding-top:18px;border-top:1px solid #bdbdb9;color:#55565b;font-size:14px;line-height:1.6}.comparison-note strong{color:#171719;font-weight:500}@media(max-width:800px){.benchmark-proof{padding:105px 7vw 115px}.benchmark-proof-head{display:block;margin-bottom:40px}.benchmark-proof-head p{margin-top:28px;max-width:470px}.benchmark-comparison{border-radius:22px}.benchmark-comparison-toolbar{padding:16px 18px 0}.benchmark-pair{display:block;padding:22px 0}.benchmark-side{padding:0 22px 24px}.benchmark-side+ .benchmark-side{border-left:0;border-top:1px solid #d7d7d4;padding-top:24px}.benchmark-side h3{font-size:17px}.benchmark-metric{font-size:13px}.benchmark-note{margin-top:30px}.frontier-shift{min-height:820px;padding:32px 7vw 90px}.frontier-shift-top{gap:20px}.frontier-shift-copy{display:block;margin-top:82px}.frontier-shift-copy p{margin-top:28px}.frontier-map{margin-top:105px;min-height:330px}.frontier-origin{left:0;top:0;transform:none}.frontier-lines{left:20px;right:38px;top:43px;height:115px}.frontier-families{top:185px;right:0;height:145px}.frontier-family{gap:10px}.frontier-family strong{font-size:clamp(1.55rem,8vw,2.2rem)}.proof-section,.comparison-section{padding:95px 7vw 110px}.proof-heading,.comparison-heading{display:block}.proof-heading p{margin-top:28px}.proof-table-wrap{margin-top:55px}.comparison-heading>span{display:block}.comparison-heading h2{margin-top:20px}.comparison-table-wrap{margin-right:-7vw}.comparison-table{min-width:600px}}@media(prefers-reduced-motion:reduce){.benchmark-pair,.benchmark-metric{transition:none}.frontier-lines i,.frontier-family,.proof-section .proof-table-wrap{transition:none}}
      `}</style>
      <section className="hero"><div className="ribbon" style={{ opacity: 0.52 }} /><header><Link href="/" className="brand">✦ OPENWEIGHT</Link><nav><a href="#benchmarks">BENCHMARKS</a><a href="#system">how it works</a></nav><Link href="/signup" className="pill">ENTER ↗</Link></header><div className="hero-copy" style={{ textShadow: "0 2px 18px #000, 0 1px 3px #000" }}><h1>Frontier intelligence.<br /><em>Unlocked.</em></h1><p>The best open-weight models are no longer chasing the frontier. They are running alongside it. At the same level.</p><div><Link href="/signup" className="pill light">Get Compute ↗</Link><a href="#system" className="under">HOW IT WORKS ↓</a></div></div></section>
      <section className="frontier-shift" ref={frontierRef} aria-labelledby="frontier-heading"><div className="frontier-shift-top"><small>// THE DISTRIBUTED FRONTIER</small><span>01 / THE SHIFT</span></div><div className="frontier-shift-copy"><h2 id="frontier-heading">THE FRONTIER<br />IS <em>OPEN.</em></h2><p>The frontier is opening through four model families: DeepSeek, GLM, Kimi, and Qwen.</p></div><div className={`frontier-map ${frontierVisible ? "is-visible" : ""}`} aria-label="The open frontier becoming four model families"><div className="frontier-origin"><i /><span>ONE FRONTIER</span></div><div className="frontier-lines" aria-hidden="true"><i /><i /><i /><i /></div><div className="frontier-families">{families.map((name, index) => <div className="frontier-family" key={name}><span>{String(index + 1).padStart(2, "0")}</span><strong>{name}.</strong></div>)}</div></div></section>
      <section className="benchmark-proof" id="benchmarks" aria-labelledby="benchmark-proof-heading"><div className="benchmark-proof-head"><div><span className="benchmark-proof-label">// BENCHMARKS / THE SHIFT</span><h2 id="benchmark-proof-heading">THE NUMBERS DON'T LIE.</h2></div><p>Open-weight models now match and outperform proprietary models across intelligence, coding, and agentic benchmarks.</p></div><div className="benchmark-comparison" aria-label="Proprietary and open-weight benchmark comparison"><div className="benchmark-comparison-toolbar"><span className="benchmark-copy-affordance" aria-hidden="true" /></div>{benchmarkComparisons.map((comparison) => { const pairId = `${comparison.proprietary.name}-${comparison.open.name}`; return <BenchmarkPair key={pairId} comparison={comparison} pairId={pairId} selected={selectedPair === pairId} onSelect={(id) => setSelectedPair((current) => current === id ? null : id)} />; })}</div><p className="benchmark-note"><strong>Same frontier. Different ownership.</strong> Results are shown as a directional comparison across representative dimensions; performance varies by evaluation, release, and configuration.</p></section>
      <section className="proof-section" ref={benchmarkRef} id="benchmark-proof" aria-labelledby="proof-heading"><div className="proof-heading"><div><span className="proof-label">// BENCHMARK PROOF</span><h2 id="proof-heading">MEASURE<br /><em>THE FRONTIER.</em></h2><div className="family-controls" aria-label="Select a model family">{families.map((family) => <button key={family} className={selectedFamily === family ? "active" : ""} onClick={() => setSelectedFamily(family)} aria-pressed={selectedFamily === family}>{family}</button>)}</div></div><p>One table, several dimensions. Select a model family and read the public evaluations that make comparison useful.</p></div><div className="proof-table-wrap"><table className="proof-table"><thead><tr><th scope="col">Evaluation</th><th scope="col">What it tests</th><th scope="col">Selected family</th><th scope="col">Reference</th></tr></thead><tbody>{evaluations.map((evaluation) => <tr key={evaluation.name}><th scope="row">{evaluation.name}</th><td>{evaluation.focus}</td><td>{selectedFamily} / public results</td><td>{evaluation.source}</td></tr>)}</tbody></table><p className="proof-source">Named evaluations are public references, not a universal leaderboard.</p><p className="proof-note"><strong>Capability is multidimensional.</strong> The point is not one score or a single result. It is the ability to place open-weight models in the same evaluation conversation as proprietary systems.</p></div></section>
      <section className="comparison-section" aria-labelledby="comparison-heading"><div className="comparison-heading"><div><span className="proof-label">// INDIVIDUAL EVALUATIONS</span><h2 id="comparison-heading">DEEPSEEK<br /><em>MEETS GPT.</em></h2><p className="comparison-subtitle">DeepSeek V3.1 vs GPT-4.1</p></div><span className="proof-label">CAPABILITY / DIMENSIONAL</span></div><div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th scope="col">Dimension</th><th scope="col">DeepSeek V3.1</th><th scope="col">GPT-4.1</th></tr></thead><tbody>{dimensions.map((dimension) => <tr key={dimension.label}><th scope="row">{dimension.label}</th><td>{dimension.deepseek}</td><td>{dimension.gpt}</td></tr>)}</tbody></table></div><p className="comparison-note"><strong>Different systems can show different shapes of capability.</strong> Read across reasoning, coding, expert knowledge, and fresh problems instead of reducing the frontier to one simplified result.</p></section>
      <section className="practice" id="practice"><div><span>// THE OPEN-WEIGHT LAYER</span><h2>ACCESS THE<br /><em>FRONTIER.</em></h2><p>Openweight.systems is the access and compute layer. Ownership establishes eligibility, approved models stay curated, and the conversation stays focused on the work.</p></div><div className="chat-card"><header><span>THE QUESTION</span><b>OPEN WEIGHT</b></header><p className="label">CLOSED DEFAULT</p><p className="question">Capability stays inside a single product boundary.</p><p className="label orange">OPEN-WEIGHT FRONTIER</p><p className="answer">Capability moves across models, builders, and communities. The test stays visible; the path opens wider.</p><div className="card-bottom"><span>THE FRONTIER CONVERSATION</span><b>WIDER / OPEN</b></div></div></section>
      <section className="light-section" id="system"><div><span>// OPENWEIGHT.SYSTEMS / ACCESS + COMPUTE LAYER</span><h2>THE FRONTIER<br />IS <em>OPEN.</em></h2><p className="intro-note">Openweight.systems makes approved open-weight models available through the compute infrastructure behind them. Verify eligibility, choose a model or let the system choose, and keep usage bounded by a recurring internal USD allowance.</p><Link href="/signup" className="pill" style={{ background: "#171719", color: "#eee", marginTop: 22 }}>ENTER THE SYSTEM ↗</Link></div><div className="principles"><article><b>01</b><div><h3>Verify ownership.</h3><p>Confirm eligibility and make access a clear state.</p></div></article><article><b>02</b><div><h3>Work across models.</h3><p>Use approved open-weight intelligence while compute stays out of the way.</p></div></article><article><b>03</b><div><h3>Keep usage clear.</h3><p>A recurring internal USD allowance keeps compute bounded.</p></div></article></div><AccessSystem /></section>
      <section className="closing"><h2>THE OPEN-WEIGHT ERA STARTS HERE.</h2><strong>OPENWEIGHT.SYSTEMS</strong></section>
    </main>
  );
}
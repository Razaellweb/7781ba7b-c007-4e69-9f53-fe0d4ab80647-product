"use client";

import Link from "next/link";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import ApiPlayground from "@/components/ApiPlayground";

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
    <div className={`benchmark-side benchmark-side-${tone}`} aria-label={`${label}: ${model}`}>
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
  const [selectedPair, setSelectedPair] = useState<string | null>(null);

  return (
    <main className="landing">
      <style>{`
        .benchmark-proof{position:relative;overflow:hidden;background:#111113;color:#eee;padding:145px 9vw 155px;border-top:1px solid #29292c}.benchmark-proof:before{content:"";position:absolute;left:-12%;right:-12%;top:28%;height:180px;background:linear-gradient(90deg,transparent,#2d74e722 18%,#79dfff1d 37%,#f6e9d012 53%,#ff8e691c 68%,#2d74e722 88%,transparent);filter:blur(28px);transform:rotate(-4deg);pointer-events:none}.benchmark-proof-head{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:flex-end;gap:50px;margin-bottom:58px}.benchmark-proof-label{color:#85868c;font:9px var(--font-geist-mono),monospace;letter-spacing:.14em}.benchmark-proof h2{max-width:760px;font-size:clamp(3.6rem,7.2vw,8rem);font-weight:400;letter-spacing:-.1em;line-height:.84;margin:22px 0 0;text-transform:uppercase}.benchmark-proof-head p{max-width:390px;margin:0 0 5px;color:#a1a2a8;font-size:15px;line-height:1.6}.benchmark-comparison{position:relative;z-index:1;background:#f1f1ef;color:#18181a;border:1px solid #d7d7d4;border-radius:28px;overflow:hidden;box-shadow:0 20px 65px #0000001f}.benchmark-comparison-toolbar{display:flex;justify-content:flex-end;padding:22px 25px 0}.benchmark-copy-affordance{width:31px;height:31px;border:0;background:transparent;color:#171719;padding:0;position:relative;cursor:default}.benchmark-copy-affordance:before,.benchmark-copy-affordance:after{content:"";position:absolute;width:14px;height:14px;border:2px solid currentColor;border-radius:4px}.benchmark-copy-affordance:before{left:5px;top:9px;background:#f1f1ef}.benchmark-copy-affordance:after{left:11px;top:3px}.benchmark-pair{display:grid;grid-template-columns:1fr 1fr;gap:0;padding:26px 3.2vw 30px;cursor:pointer;outline:none;transition:background-color .18s ease,box-shadow .18s ease}.benchmark-pair+.benchmark-pair{border-top:1px solid #d7d7d4}.benchmark-pair:hover,.benchmark-pair.is-hovered,.benchmark-pair:focus-visible,.benchmark-pair.is-selected{background:#e6e6e3;box-shadow:inset 3px 0 0 #477b86}.benchmark-pair:focus-visible{outline:3px solid #111113;outline-offset:-6px}.benchmark-pair.is-selected{background:#e8e8e5}.benchmark-side{min-width:0;padding:0 2.2vw;transition:opacity .18s ease}.benchmark-side+.benchmark-side{border-left:1px solid #d7d7d4}.benchmark-side-label{font:10px var(--font-geist-mono),monospace;letter-spacing:.11em;color:#68696d;margin-bottom:22px}.benchmark-side-open .benchmark-side-label{color:#477b86}.benchmark-side h3{font:21px var(--font-geist-mono),monospace;letter-spacing:-.04em;font-weight:400;margin:0 0 20px;overflow-wrap:anywhere}.benchmark-side dl{margin:0}.benchmark-metric{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:4px 0;font:14px var(--font-geist-mono),monospace;line-height:1.45;transition:color .18s ease,transform .18s ease}.benchmark-metric dt,.benchmark-metric dd{margin:0}.benchmark-metric dt{color:#393a3e}.benchmark-metric dd{color:#171719;text-align:right;min-width:4ch}.benchmark-side-open .benchmark-metric dd{color:#477b86}.benchmark-pair:hover .benchmark-metric,.benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair:focus-visible .benchmark-metric,.benchmark-pair.is-selected .benchmark-metric{transform:translateX(2px)}.benchmark-pair:hover .benchmark-metric dd,.benchmark-pair.is-hovered .benchmark-metric dd,.benchmark-pair:focus-visible .benchmark-metric dd,.benchmark-pair.is-selected .benchmark-metric dd{font-weight:600}.benchmark-note{position:relative;z-index:1;max-width:620px;margin:34px 0 0;padding-top:18px;border-top:1px solid #343438;color:#85868c;font-size:13px;line-height:1.6}.benchmark-note strong{color:#d8d8da;font-weight:400}.compute-ecosystem{position:relative;overflow:hidden;background:#0f1012;color:#eee;padding:170px 9vw 185px;border-top:1px solid #29292c}.compute-ecosystem:before{content:"";position:absolute;inset:18% -12% auto;height:280px;background:linear-gradient(90deg,transparent,#2d74e733 18%,#79dfff22 38%,#f6e9d014 53%,#ff8e6926 68%,#2d74e733 88%,transparent);filter:blur(42px);transform:rotate(-5deg);pointer-events:none}.compute-ecosystem-inner{position:relative;z-index:1}.compute-ecosystem-heading{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,390px);align-items:end;gap:55px}.compute-ecosystem-heading h2{max-width:940px;font-size:clamp(3rem,6vw,7.25rem);font-weight:800;letter-spacing:-.095em;line-height:.86;margin:0;overflow-wrap:anywhere}.compute-ecosystem-heading p{color:#a8a9af;font-size:clamp(1rem,1.6vw,1.35rem);line-height:1.65;margin:0 0 5px;overflow-wrap:anywhere}.ecosystem-flow{position:relative;display:flex;flex-direction:column;align-items:center;margin:126px auto 0;width:min(100%,760px);padding:30px 0 34px;border-block:1px solid #36363a}.ecosystem-flow:before{content:"";position:absolute;top:32px;bottom:34px;left:50%;width:1px;background:linear-gradient(180deg,#e57454aa,#79dfff66 48%,#e57454aa);transform:translateX(-50%);pointer-events:none}.ecosystem-flow-node{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;min-height:78px;width:min(100%,620px);padding:18px 28px;border:1px solid #505158;background:#151619;color:#eee;font:clamp(.72rem,1.2vw,.88rem) var(--font-geist-mono),monospace;letter-spacing:.12em;text-align:center}.ecosystem-flow-node:first-child{border-color:#e5745488}.ecosystem-flow-node:last-child{border-color:#79dfff66}.ecosystem-flow-arrow{position:relative;z-index:1;display:grid;place-items:center;width:42px;height:42px;color:#e57454;background:#0f1012;font:24px Arial,sans-serif;line-height:1}.compute-ecosystem-footer{display:flex;align-items:center;justify-content:space-between;gap:28px;margin:92px auto 0;width:min(100%,760px);padding-top:25px;border-top:1px solid #36363a}.compute-ecosystem-footer span{color:#d7d7da;font:clamp(.82rem,1.4vw,1rem) var(--font-geist-mono),monospace;letter-spacing:.06em}.compute-ecosystem-footer a{color:#eee;text-decoration:none;border-bottom:1px solid #85868c;padding-bottom:9px;font:10px var(--font-geist-mono),monospace;letter-spacing:.08em;white-space:nowrap}.compute-ecosystem-footer a:hover{border-color:#fff}@media(max-width:800px){.benchmark-proof{padding:105px 7vw 115px}.benchmark-proof-head{display:block;margin-bottom:40px}.benchmark-proof-head p{margin-top:28px;max-width:470px}.benchmark-comparison{border-radius:22px}.benchmark-comparison-toolbar{padding:16px 18px 0}.benchmark-pair{display:block;padding:22px 0}.benchmark-side{padding:0 22px 24px}.benchmark-side+.benchmark-side{border-left:0;border-top:1px solid #d7d7d4;padding-top:24px}.benchmark-side h3{font-size:17px}.benchmark-metric{font-size:13px}.benchmark-note{margin-top:30px}.compute-ecosystem{padding:110px 7vw 125px}.compute-ecosystem-heading{display:block}.compute-ecosystem-heading h2{font-size:clamp(2.65rem,9vw,5.25rem);line-height:.88}.compute-ecosystem-heading p{margin-top:34px;max-width:470px}.ecosystem-flow{margin-top:74px;padding:24px 0 28px}.ecosystem-flow-node{min-height:64px;padding:16px 18px;font-size:10px;letter-spacing:.08em}.compute-ecosystem-footer{display:block;margin-top:68px}.compute-ecosystem-footer a{display:inline-block;margin-top:24px}}@media(max-width:460px){.compute-ecosystem-heading h2{font-size:clamp(2.45rem,12vw,4.25rem)}.ecosystem-flow-node{font-size:9px}.compute-ecosystem-footer span{line-height:1.6}}@media(prefers-reduced-motion:reduce){.benchmark-pair,.benchmark-side,.benchmark-metric{transition:none}.benchmark-pair:hover .benchmark-metric,.benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair:focus-visible .benchmark-metric,.benchmark-pair.is-selected .benchmark-metric{transform:none}}
      `}</style>
      <style>{`
        .hero-copy{width:min(100%,1100px);padding-inline:12px}
        .hero h1{font-size:clamp(2.5rem,6.2vw,5rem);font-weight:400;letter-spacing:-.055em;line-height:1.02;margin:0 auto;max-width:100%;text-wrap:balance;overflow-wrap:break-word}
        .hero h1 span{display:block}
        .hero h1 .hero-title-main{line-height:1.02}
        .hero h1 .hero-title-accent{font-family:Georgia,serif;font-style:italic;font-weight:400;letter-spacing:-.045em;line-height:1.04}
        .hero-copy>p{margin:25px auto;color:#d6d7dc}
        @media(min-width:1100px){.hero h1 .hero-title-main{white-space:nowrap;font-size:clamp(3rem,5.7vw,5.3rem)}}
        @media(max-width:700px){.hero-copy{padding-inline:4px}.hero h1{font-size:clamp(1.85rem,8.2vw,3.6rem);line-height:1.12}.hero h1 .hero-title-main,.hero h1 .hero-title-accent{line-height:1.12}.hero-copy>p{margin:22px auto}}
        @media(max-width:360px){.hero h1{font-size:clamp(1.7rem,8vw,1.85rem);letter-spacing:-.06em}}
      `}</style>
      <section className="hero"><div className="ribbon" style={{ opacity: 0.52 }} /><header><Link href="/" className="brand"> OPENWEIGHT</Link><nav><Link href="/how-it-works" className="active" aria-current="page">HOW IT WORKS</Link></nav><Link href="/signup" className="pill">ENTER </Link></header><div className="hero-copy" style={{ textShadow: "0 2px 18px #000, 0 1px 3px #000" }}><h1><span className="hero-title-main">Openweight Superintelligence</span><span className="hero-title-accent">Unlocked.</span></h1><p>The gap between open and closed models is disappearing.</p><div><Link href="/signup" className="pill light">Get Compute </Link></div></div></section>
      <section className="benchmark-proof" id="benchmarks" aria-labelledby="benchmark-proof-heading"><div className="benchmark-proof-head"><div><span className="benchmark-proof-label">// BENCHMARKS / THE SHIFT</span><h2 id="benchmark-proof-heading">The Numbers Don't Lie</h2></div><p>Open-weight models now match and outperform proprietary models across intelligence, coding, and agentic benchmarks.</p></div><div className="benchmark-comparison" role="group" aria-labelledby="benchmark-proof-heading" aria-describedby="benchmark-comparison-description"><span id="benchmark-comparison-description" className="sr-only">Select a comparison with Enter or Space to highlight it. All benchmark values remain visible without interaction.</span><div className="benchmark-comparison-toolbar"><span className="benchmark-copy-affordance" aria-hidden="true" /></div>{benchmarkComparisons.map((comparison) => { const pairId = `${comparison.proprietary.name}-${comparison.open.name}`; return <BenchmarkPair key={pairId} comparison={comparison} pairId={pairId} selected={selectedPair === pairId} onSelect={(id) => setSelectedPair((current) => current === id ? null : id)} />; })}</div><p className="benchmark-note"><strong>Same frontier. Different ownership.</strong> Results are shown as a directional comparison across representative dimensions; performance varies by evaluation, release, and configuration.</p></section>
      <section className="compute-ecosystem" id="compute-access" aria-labelledby="compute-ecosystem-heading"><div className="compute-ecosystem-inner"><div className="compute-ecosystem-heading"><h2 id="compute-ecosystem-heading">OPEN-SOURCE COMPUTE AT UNPRECEDENTED SCALE.</h2><p>One API for curated open-weight modelswith providers, keys, and compute handled behind the scenes.</p></div><div className="ecosystem-flow" aria-label="OPENWEIGHT  COMPUTE ACCESS  INFERENCE  PLATFORM FEES  ECOSYSTEM"><div className="ecosystem-flow-node">OPENWEIGHT</div><div className="ecosystem-flow-arrow" aria-hidden="true"></div><div className="ecosystem-flow-node">COMPUTE ACCESS</div><div className="ecosystem-flow-arrow" aria-hidden="true"></div><div className="ecosystem-flow-node">INFERENCE</div><div className="ecosystem-flow-arrow" aria-hidden="true"></div><div className="ecosystem-flow-node">PLATFORM FEES</div><div className="ecosystem-flow-arrow" aria-hidden="true"></div><div className="ecosystem-flow-node">ECOSYSTEM</div></div><div className="compute-ecosystem-footer"><span>Buy back and growth</span><Link href="/how-it-works">HOW IT WORKS </Link></div></div></section>
      <ApiPlayground />
    </main>
  );
}
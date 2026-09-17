"use client";

import Link from "next/link";
import { useState } from "react";
import type { KeyboardEvent } from "react";

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
        .benchmark-proof{position:relative;overflow:hidden;background:#111113;color:#eee;padding:145px 9vw 155px;border-top:1px solid #29292c}.benchmark-proof:before{content:"";position:absolute;left:-12%;right:-12%;top:28%;height:180px;background:linear-gradient(90deg,transparent,#2d74e722 18%,#79dfff1d 37%,#f6e9d012 53%,#ff8e691c 68%,#2d74e722 88%,transparent);filter:blur(28px);transform:rotate(-4deg);pointer-events:none}.benchmark-proof-head{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:flex-end;gap:50px;margin-bottom:58px}.benchmark-proof-label{color:#85868c;font:9px var(--font-geist-mono),monospace;letter-spacing:.14em}.benchmark-proof h2{max-width:760px;font-size:clamp(3.6rem,7.2vw,8rem);font-weight:400;letter-spacing:-.1em;line-height:.84;margin:22px 0 0}.benchmark-proof-head p{max-width:390px;margin:0 0 5px;color:#a1a2a8;font-size:15px;line-height:1.6}.benchmark-comparison{position:relative;z-index:1;background:#f1f1ef;color:#18181a;border:1px solid #d7d7d4;border-radius:28px;overflow:hidden;box-shadow:0 20px 65px #0000001f}.benchmark-comparison-toolbar{display:flex;justify-content:flex-end;padding:22px 25px 0}.benchmark-copy-affordance{width:31px;height:31px;border:0;background:transparent;color:#171719;padding:0;position:relative;cursor:default}.benchmark-copy-affordance:before,.benchmark-copy-affordance:after{content:"";position:absolute;width:14px;height:14px;border:2px solid currentColor;border-radius:4px}.benchmark-copy-affordance:before{left:5px;top:9px;background:#f1f1ef}.benchmark-copy-affordance:after{left:11px;top:3px}.benchmark-pair{display:grid;grid-template-columns:1fr 1fr;gap:0;padding:26px 3.2vw 30px;cursor:pointer;outline:none;transition:background-color .18s ease,box-shadow .18s ease}.benchmark-pair+.benchmark-pair{border-top:1px solid #d7d7d4}.benchmark-pair:hover,.benchmark-pair.is-hovered,.benchmark-pair:focus-visible,.benchmark-pair.is-selected{background:#e6e6e3;box-shadow:inset 3px 0 0 #477b86}.benchmark-pair:focus-visible{outline:3px solid #111113;outline-offset:-6px}.benchmark-pair.is-selected{background:#e8e8e5}.benchmark-side{min-width:0;padding:0 2.2vw;transition:opacity .18s ease}.benchmark-side+ .benchmark-side{border-left:1px solid #d7d7d4}.benchmark-side-label{font:10px var(--font-geist-mono),monospace;letter-spacing:.11em;color:#68696d;margin-bottom:22px}.benchmark-side-open .benchmark-side-label{color:#477b86}.benchmark-side h3{font:21px var(--font-geist-mono),monospace;letter-spacing:-.04em;font-weight:400;margin:0 0 20px;overflow-wrap:anywhere}.benchmark-side dl{margin:0}.benchmark-metric{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:4px 0;font:14px var(--font-geist-mono),monospace;line-height:1.45;transition:color .18s ease,transform .18s ease}.benchmark-metric dt,.benchmark-metric dd{margin:0}.benchmark-metric dt{color:#393a3e}.benchmark-metric dd{color:#171719;text-align:right;min-width:4ch}.benchmark-side-open .benchmark-metric dd{color:#477b86}.benchmark-pair:hover .benchmark-metric,.benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair:focus-visible .benchmark-metric,.benchmark-pair.is-selected .benchmark-metric{transform:translateX(2px)}.benchmark-pair:hover .benchmark-metric dd,.benchmark-pair.is-hovered .benchmark-metric dd,.benchmark-pair:focus-visible .benchmark-metric dd,.benchmark-pair.is-selected .benchmark-metric dd{font-weight:600}.benchmark-note{position:relative;z-index:1;max-width:620px;margin:34px 0 0;padding-top:18px;border-top:1px solid #343438;color:#85868c;font-size:13px;line-height:1.6}.benchmark-note strong{color:#d8d8da;font-weight:400}@media(max-width:800px){.benchmark-proof{padding:105px 7vw 115px}.benchmark-proof-head{display:block;margin-bottom:40px}.benchmark-proof-head p{margin-top:28px;max-width:470px}.benchmark-comparison{border-radius:22px}.benchmark-comparison-toolbar{padding:16px 18px 0}.benchmark-pair{display:block;padding:22px 0}.benchmark-side{padding:0 22px 24px}.benchmark-side+ .benchmark-side{border-left:0;border-top:1px solid #d7d7d4;padding-top:24px}.benchmark-side h3{font-size:17px}.benchmark-metric{font-size:13px}.benchmark-note{margin-top:30px}}@media(prefers-reduced-motion:reduce){.benchmark-pair,.benchmark-side,.benchmark-metric{transition:none}.benchmark-pair:hover .benchmark-metric,.benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair:focus-visible .benchmark-metric,.benchmark-pair.is-selected .benchmark-metric{transform:none}}
      `}</style>
      <section className="hero"><div className="ribbon" style={{ opacity: 0.52 }} /><header><Link href="/" className="brand">✦ OPENWEIGHT</Link><nav><a href="#benchmarks">BENCHMARKS</a></nav><Link href="/signup" className="pill">ENTER ↗</Link></header><div className="hero-copy" style={{ textShadow: "0 2px 18px #000, 0 1px 3px #000" }}><h1>Frontier intelligence.<br /><em>Unlocked.</em></h1><p>The best open-weight models are no longer chasing the frontier. They are running alongside it. At the same level.</p><div><Link href="/signup" className="pill light">Get Compute ↗</Link></div></div></section>
      <section className="benchmark-proof" id="benchmarks" aria-labelledby="benchmark-proof-heading"><div className="benchmark-proof-head"><div><span className="benchmark-proof-label">// BENCHMARKS / THE SHIFT</span><h2 id="benchmark-proof-heading">THE NUMBERS DON'T LIE.</h2></div><p>Open-weight models now match and outperform proprietary models across intelligence, coding, and agentic benchmarks.</p></div><div className="benchmark-comparison" role="group" aria-labelledby="benchmark-proof-heading" aria-describedby="benchmark-comparison-description"><span id="benchmark-comparison-description" className="sr-only">Select a comparison with Enter or Space to highlight it. All benchmark values remain visible without interaction.</span><div className="benchmark-comparison-toolbar"><span className="benchmark-copy-affordance" aria-hidden="true" /></div>{benchmarkComparisons.map((comparison) => { const pairId = `${comparison.proprietary.name}-${comparison.open.name}`; return <BenchmarkPair key={pairId} comparison={comparison} pairId={pairId} selected={selectedPair === pairId} onSelect={(id) => setSelectedPair((current) => current === id ? null : id)} />; })}</div><p className="benchmark-note"><strong>Same frontier. Different ownership.</strong> Results are shown as a directional comparison across representative dimensions; performance varies by evaluation, release, and configuration.</p></section>
    </main>
  );
}
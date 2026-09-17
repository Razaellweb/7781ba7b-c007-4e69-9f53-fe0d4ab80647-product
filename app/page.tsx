"use client";

import Link from "next/link";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import AccessSystem from "@/components/AccessSystem";

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
        .benchmark-proof{position:relative;overflow:hidden;background:#111113;color:#eee;padding:145px 9vw 155px;border-top:1px solid #29292c}.benchmark-proof:before{content:"";position:absolute;left:-12%;right:-12%;top:28%;height:180px;background:linear-gradient(90deg,transparent,#2d74e722 18%,#79dfff1d 37%,#f6e9d012 53%,#ff8e691c 68%,#2d74e722 88%,transparent);filter:blur(28px);transform:rotate(-4deg);pointer-events:none}.benchmark-proof-head{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:flex-end;gap:50px;margin-bottom:58px}.benchmark-proof-label{color:#85868c;font:9px var(--font-geist-mono),monospace;letter-spacing:.14em}.benchmark-proof h2{max-width:760px;font-size:clamp(3.6rem,7.2vw,8rem);font-weight:400;letter-spacing:-.1em;line-height:.84;margin:22px 0 0}.benchmark-proof-head p{max-width:390px;margin:0 0 5px;color:#a1a2a8;font-size:15px;line-height:1.6}.benchmark-comparison{position:relative;z-index:1;background:#f1f1ef;color:#18181a;border:1px solid #d7d7d4;border-radius:28px;overflow:hidden;box-shadow:0 20px 65px #0000001f}.benchmark-comparison-toolbar{display:flex;justify-content:flex-end;padding:22px 25px 0}.benchmark-copy-affordance{width:31px;height:31px;border:0;background:transparent;color:#171719;padding:0;position:relative;cursor:default}.benchmark-copy-affordance:before,.benchmark-copy-affordance:after{content:"";position:absolute;width:14px;height:14px;border:2px solid currentColor;border-radius:4px}.benchmark-copy-affordance:before{left:5px;top:9px;background:#f1f1ef}.benchmark-copy-affordance:after{left:11px;top:3px}.benchmark-pair{display:grid;grid-template-columns:1fr 1fr;gap:0;padding:26px 3.2vw 30px;cursor:pointer;outline:none;transition:background-color .18s ease,box-shadow .18s ease}.benchmark-pair+.benchmark-pair{border-top:1px solid #d7d7d4}.benchmark-pair:hover,.benchmark-pair.is-hovered,.benchmark-pair:focus-visible,.benchmark-pair.is-selected{background:#e6e6e3;box-shadow:inset 3px 0 0 #477b86}.benchmark-pair:focus-visible{outline:3px solid #111113;outline-offset:-6px}.benchmark-pair.is-selected{background:#e8e8e5}.benchmark-side{min-width:0;padding:0 2.2vw;transition:opacity .18s ease}.benchmark-side+ .benchmark-side{border-left:1px solid #d7d7d4}.benchmark-side-label{font:10px var(--font-geist-mono),monospace;letter-spacing:.11em;color:#68696d;margin-bottom:22px}.benchmark-side-open .benchmark-side-label{color:#477b86}.benchmark-side h3{font:21px var(--font-geist-mono),monospace;letter-spacing:-.04em;font-weight:400;margin:0 0 20px;overflow-wrap:anywhere}.benchmark-side dl{margin:0}.benchmark-metric{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:4px 0;font:14px var(--font-geist-mono),monospace;line-height:1.45;transition:color .18s ease,transform .18s ease}.benchmark-metric dt,.benchmark-metric dd{margin:0}.benchmark-metric dt{color:#393a3e}.benchmark-metric dd{color:#171719;text-align:right;min-width:4ch}.benchmark-side-open .benchmark-metric dd{color:#477b86}.benchmark-pair:hover .benchmark-metric,.benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair:focus-visible .benchmark-metric,.benchmark-pair.is-selected .benchmark-metric{transform:translateX(2px)}.benchmark-pair:hover .benchmark-metric dd,.benchmark-pair.is-hovered .benchmark-metric dd,.benchmark-pair:focus-visible .benchmark-metric dd,.benchmark-pair.is-selected .benchmark-metric dd{font-weight:600}.benchmark-note{position:relative;z-index:1;max-width:620px;margin:34px 0 0;padding-top:18px;border-top:1px solid #343438;color:#85868c;font-size:13px;line-height:1.6}.benchmark-note strong{color:#d8d8da;font-weight:400}.compute-ecosystem{position:relative;overflow:hidden;background:#101011;color:#eee;padding:150px 9vw 170px;border-top:1px solid #29292c}.compute-ecosystem:before{content:"";position:absolute;inset:18% -12% auto;height:220px;background:linear-gradient(90deg,transparent,#2d74e722 18%,#79dfff18 38%,#f6e9d00d 53%,#ff8e6919 68%,#2d74e722 88%,transparent);filter:blur(32px);transform:rotate(-5deg);pointer-events:none}.compute-ecosystem-inner{position:relative;z-index:1}.compute-ecosystem-heading{display:grid;grid-template-columns:minmax(0,1fr) minmax(250px,390px);align-items:end;gap:50px}.compute-ecosystem-label{color:#85868c;font:9px var(--font-geist-mono),monospace;letter-spacing:.14em}.compute-ecosystem-heading h2{max-width:850px;font-size:clamp(3.4rem,7vw,7.5rem);font-weight:700;letter-spacing:-.07em;line-height:.9;margin:24px 0 0;overflow-wrap:anywhere}.compute-ecosystem-heading p{color:#d6d7dc;font-size:15px;line-height:1.65;margin:0 0 4px;overflow-wrap:anywhere}.ecosystem-flow{position:relative;display:flex;flex-direction:column;align-items:center;margin:92px auto 0;width:min(100%,760px);padding:28px 0 30px;border-block:1px solid #36363a}.ecosystem-flow:before{content:"";position:absolute;top:31px;bottom:31px;left:50%;width:1px;background:linear-gradient(180deg,#e57454aa,#79dfff66 48%,#e57454aa);transform:translateX(-50%);pointer-events:none}.ecosystem-flow-node{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;min-height:64px;width:min(100%,520px);padding:0 28px;border:1px solid #45454a;background:#151517;color:#eee;font:12px var(--font-geist-mono),monospace;letter-spacing:.12em;text-align:center}.ecosystem-flow-node:first-child{border-color:#e5745488}.ecosystem-flow-node:last-child{border-color:#79dfff66;color:#f2f2ef;letter-spacing:.04em}.ecosystem-flow-arrow{position:relative;z-index:1;display:grid;place-items:center;width:34px;height:34px;color:#e57454;background:#101011;font:20px Arial,sans-serif;line-height:1}.compute-flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:92px 0 0;border-block:1px solid #36363a}.compute-flow-step{min-height:145px;padding:20px 22px;border-right:1px solid #36363a}.compute-flow-step:last-child{border-right:0}.compute-flow-step b{display:block;color:#e57454;font:10px var(--font-geist-mono),monospace;font-weight:400}.compute-flow-step strong{display:block;margin-top:42px;font:13px var(--font-geist-mono),monospace;letter-spacing:.02em}.compute-flow-step span{display:block;color:#85868c;font-size:12px;line-height:1.45;margin-top:8px}.compute-ecosystem .access-system{margin-top:68px}.compute-cta{display:flex;align-items:center;justify-content:space-between;gap:28px;margin-top:48px;padding-top:25px;border-top:1px solid #36363a}.compute-cta p{margin:0;color:#85868c;font:10px var(--font-geist-mono),monospace;letter-spacing:.06em;line-height:1.7}.compute-cta a{white-space:nowrap;transition:color .18s ease,border-color .18s ease,transform .18s ease}.compute-cta a:hover{color:#fff;border-color:#fff;transform:translateY(-1px)}.compute-cta a:focus-visible{outline:2px solid #f0f0ed;outline-offset:6px;border-color:#f0f0ed}.compute-cta a:active{color:#e57454;transform:translateY(0)}.compute-ecosystem .pill{border:0}@media(max-width:800px){.benchmark-proof{padding:105px 7vw 115px}.benchmark-proof-head{display:block;margin-bottom:40px}.benchmark-proof-head p{margin-top:28px;max-width:470px}.benchmark-comparison{border-radius:22px}.benchmark-comparison-toolbar{padding:16px 18px 0}.benchmark-pair{display:block;padding:22px 0}.benchmark-side{padding:0 22px 24px}.benchmark-side+ .benchmark-side{border-left:0;border-top:1px solid #d7d7d4;padding-top:24px}.benchmark-side h3{font-size:17px}.benchmark-metric{font-size:13px}.benchmark-note{margin-top:30px}.compute-ecosystem{padding:105px 7vw 120px}.compute-ecosystem-heading{display:block}.compute-ecosystem-heading p{margin-top:28px;max-width:470px}.ecosystem-flow{margin-top:65px;padding:22px 0 24px}.ecosystem-flow-node{min-height:58px;padding:0 18px;font-size:11px}.compute-flow{grid-template-columns:1fr 1fr;margin-top:65px}.compute-flow-step:nth-child(2){border-right:0}.compute-flow-step:nth-child(-n+2){border-bottom:1px solid #36363a}.compute-flow-step{min-height:135px}.compute-cta{display:block}.compute-cta a{margin-top:20px}.compute-ecosystem .access-system{margin-top:55px}}@media(max-width:460px){.ecosystem-flow-node{font-size:10px;letter-spacing:.08em}.compute-flow{grid-template-columns:1fr}.compute-flow-step,.compute-flow-step:nth-child(2){border-right:0;border-bottom:1px solid #36363a}.compute-flow-step:last-child{border-bottom:0}.compute-flow-step strong{margin-top:28px}}@media(prefers-reduced-motion:reduce){.benchmark-pair,.benchmark-side,.benchmark-metric,.compute-cta a{transition:none}.benchmark-pair:hover .benchmark-metric,.benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair:focus-visible .benchmark-pair.is-hovered .benchmark-metric,.benchmark-pair.is-selected .benchmark-metric{transform:none}}
      `}</style>
      <section className="hero"><div className="ribbon" style={{ opacity: 0.52 }} /><header><Link href="/" className="brand">✦ OPENWEIGHT</Link><nav><a href="#benchmarks">BENCHMARKS</a></nav><Link href="/signup" className="pill">ENTER ↗</Link></header><div className="hero-copy" style={{ textShadow: "0 2px 18px #000, 0 1px 3px #000" }}><h1>Frontier intelligence.<br /><em>Unlocked.</em></h1><p>The best open-weight models are no longer chasing the frontier. They are running alongside it. At the same level.</p><div><Link href="/signup" className="pill light">Get Compute ↗</Link></div></div></section>
      <section className="benchmark-proof" id="benchmarks" aria-labelledby="benchmark-proof-heading"><div className="benchmark-proof-head"><div><span className="benchmark-proof-label">// BENCHMARKS / THE SHIFT</span><h2 id="benchmark-proof-heading">THE NUMBERS DON'T LIE.</h2></div><p>Open-weight models now match and outperform proprietary models across intelligence, coding, and agentic benchmarks.</p></div><div className="benchmark-comparison" role="group" aria-labelledby="benchmark-proof-heading" aria-describedby="benchmark-comparison-description"><span id="benchmark-comparison-description" className="sr-only">Select a comparison with Enter or Space to highlight it. All benchmark values remain visible without interaction.</span><div className="benchmark-comparison-toolbar"><span className="benchmark-copy-affordance" aria-hidden="true" /></div>{benchmarkComparisons.map((comparison) => { const pairId = `${comparison.proprietary.name}-${comparison.open.name}`; return <BenchmarkPair key={pairId} comparison={comparison} pairId={pairId} selected={selectedPair === pairId} onSelect={(id) => setSelectedPair((current) => current === id ? null : id)} />; })}</div><p className="benchmark-note"><strong>Same frontier. Different ownership.</strong> Results are shown as a directional comparison across representative dimensions; performance varies by evaluation, release, and configuration.</p></section>
      <section className="compute-ecosystem" id="compute-system" aria-labelledby="compute-ecosystem-heading"><div className="compute-ecosystem-inner"><div className="compute-ecosystem-heading"><div><span className="compute-ecosystem-label">// OPENWEIGHT.SYSTEMS / ACCESS + COMPUTE</span><h2 id="compute-ecosystem-heading">OPEN-SOURCE COMPUTE AT UNPRECEDENTED SCALE.</h2></div><p>Hold OPENWEIGHT. Earn frontier open-weight compute. As the network grows, platform fees flow back into the ecosystem.</p></div><div className="ecosystem-flow" aria-label="OPENWEIGHT to ecosystem flow"><div className="ecosystem-flow-node">OPENWEIGHT</div><div className="ecosystem-flow-arrow" aria-hidden="true">↓</div><div className="ecosystem-flow-node">COMPUTE ACCESS</div><div className="ecosystem-flow-arrow" aria-hidden="true">↓</div><div className="ecosystem-flow-node">INFERENCE</div><div className="ecosystem-flow-arrow" aria-hidden="true">↓</div><div className="ecosystem-flow-node">PLATFORM FEES</div><div className="ecosystem-flow-arrow" aria-hidden="true">↓</div><div className="ecosystem-flow-node">ECOSYSTEM Buy back and growth</div></div><div className="compute-flow" id="compute-flow" aria-label="The Openweight access flow"><div className="compute-flow-step"><b>01</b><strong>VERIFY OWNERSHIP</strong><span>Prove eligibility with your wallet.</span></div><div className="compute-flow-step"><b>02</b><strong>CHOOSE YOUR MODEL</strong><span>Use Auto or a reviewed open-weight model.</span></div><div className="compute-flow-step"><b>03</b><strong>TRACK COMPUTE</strong><span>Usage settles against actual provider cost.</span></div><div className="compute-flow-step"><b>04</b><strong>STAY IN THE WORK</strong><span>One clear chat, with the complexity hidden.</span></div></div><div className="compute-cta"><p>OWNERSHIP → ELIGIBILITY → CURATED INTELLIGENCE → COMPUTE<br />A considered path into a wider field of intelligence.</p><Link href="#compute-flow" className="under">HOW IT WORKS →</Link></div><AccessSystem/></div></section>
    </main>
  );
}
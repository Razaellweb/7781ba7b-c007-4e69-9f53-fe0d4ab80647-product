"use client";

import Link from "next/link";
import { useState } from "react";

const sections = [
  {
    id: "start",
    number: "01",
    title: "Enter the product",
    content: (
      <p>Start from Openweight\u2019s entry point and choose to enter the workspace. The public site remains available without an account; product access begins only after the identity flow is completed.</p>
    ),
  },
  {
    id: "identity",
    number: "02",
    title: "Authenticate with Privy",
    content: (
      <>
        <p>Privy handles authentication and establishes a verified identity. That verified identity is the access requirement: there is no separate ownership, wallet-balance, or token-holding check before the workspace opens.</p>
        <div className="how-detail">
          <div><b>IDENTITY</b><span>Privy-verified access, rather than a new Openweight password.</span></div>
          <div><b>ACCESS</b><span>A verified session is sufficient for the workspace and inference authorization.</span></div>
        </div>
      </>
    ),
  },
  {
    id: "access",
    number: "03",
    title: "Open the workspace immediately",
    content: (
      <>
        <p>Signing in is the whole gate. Openweight does not read blockchain balances, check token holdings, or hold a session back until an on-chain result arrives, so a verified identity opens the workspace and enables inference authorization right away.</p>
        <div className="how-detail">
          <div><b>NO CHAIN CALLS</b><span>Authorization never depends on an RPC request or a wallet balance.</span></div>
          <div><b>UNCHANGED SAFEGUARDS</b><span>Rate limits, provider health, model availability, and compute accounting still apply to every request.</span></div>
        </div>
      </>
    ),
  },
  {
    id: "allowance",
    number: "04",
    title: "A verified session unlocks recurring compute",
    content: (
      <p>Authenticated accounts receive a recurring internal USD compute allowance according to the product policy. Grants are recorded for the relevant period, do not silently duplicate, and do not imply unlimited or transferable compute.</p>
    ),
  },
  {
    id: "inference",
    number: "05",
    title: "Choose a model, then submit usage",
    content: (
      <>
        <p>Inside the workspace, choose a reviewed, curated open-weight model or select Auto to let the product choose from the available set. When you submit a prompt, Openweight checks account state, model availability, and available compute before forwarding the request through its server boundary.</p>
        <div className="how-detail">
          <div><b>CURATED OR AUTO</b><span>Model choice stays within the reviewed registry; there is no provider account setup.</span></div>
          <div><b>USAGE</b><span>Inference requests are metered as they run, including safely handled partial or stopped responses.</span></div>
        </div>
      </>
    ),
  },
  {
    id: "accounting",
    number: "06",
    title: "Reserve, account, and settle compute",
    content: (
      <>
        <p>Before inference begins, the system reserves an estimated amount from the available allowance so concurrent requests cannot overspend it. Afterward, actual usage is normalized and settled: the reservation is debited for what was used or released when it was not.</p>
        <div className="how-detail">
          <div><b>RESERVATION</b><span>An atomic hold protects the allowance while a request is in flight.</span></div>
          <div><b>SETTLEMENT</b><span>The ledger records actual usage, releases the remainder, and keeps the balance understandable.</span></div>
        </div>
      </>
    ),
  },
];

export default function HowItWorksPage() {
  const [activeId, setActiveId] = useState(sections[0].id);
  const activeSection = sections.find((section) => section.id === activeId) ?? sections[0];

  const selectSection = (id: string) => {
    setActiveId(id);
    window.history.replaceState(null, "", `#${id}`);
  };

  return (
    <main className="how-page">
      <style>{`
        .how-page{--how-ink:#18191c;--how-muted:#686b73;--how-line:#dedfdf;--how-paper:#f7f7f4;height:100dvh;min-height:0;background:var(--how-paper);color:var(--how-ink);font-family:Arial,Helvetica,sans-serif;overflow:hidden;display:flex;flex-direction:column}.how-page *{box-sizing:border-box}.how-topbar{height:72px;flex:0 0 72px;display:flex;align-items:center;justify-content:space-between;gap:28px;padding:12px clamp(22px,5vw,72px);border-bottom:1px solid var(--how-line);background:#f7f7f4;position:relative;z-index:5}.how-brand{color:var(--how-ink);display:inline-flex;align-items:center;gap:10px;text-decoration:none;font:11px var(--font-geist-mono),monospace;letter-spacing:.14em;white-space:nowrap}.how-brand-mark{width:27px;height:27px;border-radius:50%;background:#050505 url('/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png') center/contain no-repeat}.how-topnav{display:flex;align-items:center;gap:24px;font:10px var(--font-geist-mono),monospace;letter-spacing:.11em}.how-topnav a{color:#74767b;text-decoration:none;padding:9px 0}.how-topnav a:hover{color:var(--how-ink)}.how-topnav a.active{color:var(--how-ink);border-bottom:1px solid var(--how-ink)}.how-entry{color:#f7f7f4!important;background:var(--how-ink);padding:11px 15px!important;border-radius:999px;text-decoration:none;font:10px var(--font-geist-mono),monospace;letter-spacing:.08em;white-space:nowrap}.how-layout{display:grid;grid-template-columns:minmax(210px,260px) minmax(0,1fr);gap:clamp(35px,6vw,90px);width:100%;max-width:1440px;margin:0 auto;padding:38px clamp(22px,5vw,72px) 42px;flex:1;min-height:0}.how-aside{align-self:stretch;min-width:0;overflow-y:auto;padding:3px 4px 20px 0}.how-aside-label{color:#94969b;font:10px var(--font-geist-mono),monospace;letter-spacing:.13em;margin:0 0 17px}.how-aside nav{border-left:1px solid var(--how-line);display:flex;flex-direction:column}.how-aside button{display:block;width:100%;text-align:left;color:#777980;background:transparent;border:0;border-left:1px solid transparent;font:inherit;font-size:13px;line-height:1.4;padding:10px 10px 10px 17px;margin-left:-1px;overflow-wrap:anywhere;cursor:pointer}.how-aside button:hover,.how-aside button:focus-visible{color:var(--how-ink);border-left-color:#a7a8aa;outline:none}.how-aside button[aria-current="location"]{color:var(--how-ink);border-left:2px solid #e57454}.how-aside small{display:block;color:#a1a3a8;font:9px var(--font-geist-mono),monospace;margin-bottom:4px}.how-mobile-nav{display:none}.how-content{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:3px 4px 24px 0;scrollbar-gutter:stable}.how-kicker{color:#e16f4b;font:10px var(--font-geist-mono),monospace;letter-spacing:.14em}.how-content h1{font-size:clamp(3rem,6vw,5.8rem);font-weight:400;letter-spacing:-.09em;line-height:.92;margin:20px 0 22px;max-width:720px}.how-lede{color:var(--how-muted);font-size:17px;line-height:1.65;max-width:680px;margin:0}.how-note{border-left:2px solid #e57454;margin:30px 0 38px;padding:4px 0 4px 20px;color:#55585f;font-size:13px;line-height:1.65;max-width:680px}.how-note strong{display:block;color:var(--how-ink);font-weight:500;margin-bottom:3px}.how-section{scroll-margin-top:20px;padding:30px 0 34px;border-top:1px solid var(--how-line);max-width:820px}.how-section-heading{display:grid;grid-template-columns:48px minmax(0,1fr);gap:16px}.how-number{color:#e57454;font:11px var(--font-geist-mono),monospace;padding-top:8px}.how-section h2{font-size:clamp(1.7rem,3.7vw,2.7rem);font-weight:400;letter-spacing:-.05em;line-height:1.12;margin:0 0 19px;overflow-wrap:anywhere}.how-section p{color:var(--how-muted);font-size:16px;line-height:1.8;margin:0;max-width:700px}.how-detail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:26px 0 0 64px}.how-detail div{padding:17px 18px;background:#ededeb;border:1px solid #e2e2df;border-radius:10px;min-width:0}.how-detail b{display:block;font:10px var(--font-geist-mono),monospace;letter-spacing:.08em;margin-bottom:8px}.how-detail span{display:block;color:#707279;font-size:12px;line-height:1.5}.how-footer{border-top:1px solid var(--how-line);padding-top:25px;margin-top:8px;color:#8b8d93;font:10px/1.7 var(--font-geist-mono),monospace;letter-spacing:.05em}.how-footer a{color:var(--how-ink);text-decoration:none;border-bottom:1px solid #999;padding-bottom:3px;margin-left:9px}.how-mobile-nav summary{list-style:none;cursor:pointer}.how-mobile-nav summary::-webkit-details-marker{display:none}.how-mobile-nav summary:after{content:"+";float:right}.how-mobile-nav[open] summary:after{content:"\u2212"}@media(max-width:760px){.how-page{height:100dvh}.how-topbar{height:64px;flex-basis:64px;padding:10px 18px}.how-topnav{gap:12px}.how-topnav a:not(.active){display:none}.how-layout{display:flex;flex-direction:column;gap:0;padding:0 20px 20px}.how-aside{display:none}.how-mobile-nav{display:block;flex:0 0 auto;border-bottom:1px solid var(--how-line);padding:13px 0}.how-mobile-nav summary{color:#777980;font:10px var(--font-geist-mono),monospace;letter-spacing:.1em;padding:5px 0}.how-mobile-nav nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px;margin-top:10px}.how-mobile-nav button{min-width:0;text-align:left;padding:10px 9px;background:transparent;border:1px solid transparent;border-radius:7px;color:#777980;line-height:1.35;font:12px Arial,Helvetica,sans-serif;overflow-wrap:anywhere}.how-mobile-nav button[aria-current="location"]{background:#ededeb;color:var(--how-ink);border-color:#e1e1df}.how-mobile-nav button small{display:block;color:#a1a3a8;font:9px var(--font-geist-mono),monospace;margin-bottom:4px}.how-content{width:100%;padding:27px 2px 24px;flex:1}.how-content h1{font-size:clamp(2.8rem,12vw,4.8rem)}.how-lede{font-size:15px}.how-note{margin:24px 0 30px}.how-section{padding:25px 0 28px}.how-section-heading{grid-template-columns:34px minmax(0,1fr);gap:9px}.how-section h2{font-size:clamp(1.55rem,7vw,2.3rem)}.how-section p{font-size:14px}.how-detail{grid-template-columns:1fr;margin:22px 0 0 43px}.how-topnav{margin-left:auto}}@media(max-width:420px){.how-brand{font-size:9px}.how-entry{padding:9px 10px!important;font-size:9px}.how-layout{padding-inline:15px}.how-mobile-nav nav{grid-template-columns:1fr 1fr}.how-detail{margin-left:0}.how-footer a{display:inline-block;margin:10px 0 0}}
      `}</style>
      <header className="how-topbar">
        <Link href="/" className="how-brand"><span className="how-brand-mark" />OPENWEIGHT</Link>
        <nav className="how-topnav" aria-label="Primary navigation">
          <Link href="/how-it-works" className="active" aria-current="page">HOW IT WORKS</Link>
          <Link href="/signup" className="how-entry">ENTER OPENWEIGHT \u2197</Link>
        </nav>
      </header>
      <div className="how-layout">
        <aside className="how-aside" aria-label="How it works sections">
          <div className="how-aside-label">ON THIS PAGE</div>
          <nav aria-label="Guide sections">
            {sections.map((section) => (
              <button type="button" key={section.id} aria-current={activeId === section.id ? "location" : undefined} onClick={() => selectSection(section.id)}>
                <small>{section.number}</small>{section.title}
              </button>
            ))}
          </nav>
        </aside>
        <details className="how-mobile-nav">
          <summary>ON THIS PAGE \u00b7 {activeSection.number} / {sections.length.toString().padStart(2, "0")}</summary>
          <nav aria-label="Guide sections">
            {sections.map((section) => (
              <button type="button" key={section.id} aria-current={activeId === section.id ? "location" : undefined} onClick={() => selectSection(section.id)}>
                <small>{section.number}</small>{section.title}
              </button>
            ))}
          </nav>
        </details>
        <article className="how-content" aria-live="polite">
          <div className="how-kicker">OPENWEIGHT / A SHORT GUIDE</div>
          <h1>Intelligence, with a clear path.</h1>
          <p className="how-lede">Openweight turns a verified identity into a simple way to access curated open-weight intelligence. This guide explains the product sequence at a high level\u2014from entry and authentication to usage accounting.</p>
          <div className="how-note"><strong>A public orientation, not a live workspace.</strong>This page describes how the system is designed to work. It does not sign in, run inference, or expose provider accounts, credentials, or infrastructure.</div>
          <section className="how-section" id={activeSection.id} aria-labelledby={`${activeSection.id}-heading`}>
            <div className="how-section-heading">
              <div className="how-number">{activeSection.number}</div>
              <div>
                <h2 id={`${activeSection.id}-heading`}>{activeSection.title}</h2>
                {activeSection.content}
              </div>
            </div>
          </section>
          <div className="how-footer">The short version: identity \u2192 authenticated workspace \u2192 allowance \u2192 curated inference \u2192 accountable settlement.<Link href="/privacy">Read the privacy boundary \u2197</Link></div>
        </article>
      </div>
    </main>
  );
}

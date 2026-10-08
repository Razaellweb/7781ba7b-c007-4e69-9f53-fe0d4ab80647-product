"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLogin, usePrivy } from "@privy-io/react-auth";

export default function PrivyEntry() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();
  const { login } = useLogin({ onComplete: () => undefined });

  function enter() {
    if (!ready) return;
    if (!authenticated) {
      login();
      return;
    }
    router.push("/dashboard");
  }

  return <div className="entry-page"><div className="entry-field"><div className="entry-glow" /></div><div className="entry-panel"><Link href="/" className="entry-brand"><span className="ow-mark">✦</span> OPENWEIGHT</Link><div className="entry-copy"><h1 className="entry-headline">Hold a minimum of 10,000 Openweight tokens to gain access to free compute</h1><button className="ow-button primary entry-button" onClick={enter} disabled={!ready}>{!ready ? "Loading Privy…" : authenticated ? "Continue to workspace" : "Continue with Privy"}<span>↗</span></button></div></div><style jsx global>{`
      .entry-copy .entry-headline { color: #171719; font-size: clamp(2rem, 3.1vw, 3rem); line-height: 1.04; letter-spacing: -.055em; overflow-wrap: normal; word-break: normal; }
      @media (max-width: 900px) { .entry-page { grid-template-columns: 1fr; } .entry-field { display: none; } .entry-panel { min-height: 100vh; padding: 30px clamp(22px, 7vw, 72px); } .entry-copy { width: 100%; max-width: 620px; } .entry-copy .entry-headline { font-size: clamp(2rem, 7vw, 3rem); line-height: 1.04; letter-spacing: -.055em; } }
    `}</style></div>;
}

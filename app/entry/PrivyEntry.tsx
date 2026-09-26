"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { useEffect, useState } from "react";

export default function PrivyEntry() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();
  const { login } = useLogin({ onComplete: () => undefined });
  const [status, setStatus] = useState("Visitor · not authenticated");

  useEffect(() => {
    if (!ready) {
      setStatus("Loading Privy session…");
      return;
    }
    setStatus(authenticated ? "Authenticated · holder access has not been checked" : "Visitor · not authenticated");
  }, [authenticated, ready]);

  function enter() {
    if (!ready) return;
    if (!authenticated) {
      login();
      return;
    }
    router.push("/dashboard");
  }

  return <div className="entry-page"><div className="entry-field"><div className="entry-glow" /></div><div className="entry-panel"><Link href="/" className="entry-brand"><span className="ow-mark">✦</span> OPENWEIGHT</Link><div className="entry-copy"><h1 className="entry-headline">Hold a minimum of 10,000 Openweight tokens to gain access to free compute</h1><p>Sign in with Privy to enter your workspace. Holder access is checked separately when you choose to verify it.</p><button className="ow-button primary entry-button" onClick={enter} disabled={!ready}>{!ready ? "Loading Privy…" : authenticated ? "Continue to workspace" : "Continue with Privy"}<span>↗</span></button><p aria-live="polite" className="entry-status">{status}</p></div></div><style jsx global>{`
      .entry-headline { color: #171719; overflow-wrap: anywhere; word-break: normal; }
      @media (max-width: 900px) { .entry-page { grid-template-columns: 1fr; } .entry-field { display: none; } .entry-panel { min-height: 100vh; padding: 30px clamp(22px, 7vw, 72px); } .entry-copy { width: 100%; max-width: 620px; } .entry-headline { font-size: clamp(2.65rem, 9vw, 4.5rem); line-height: .96; letter-spacing: -.065em; } }
    `}</style></div>;
}

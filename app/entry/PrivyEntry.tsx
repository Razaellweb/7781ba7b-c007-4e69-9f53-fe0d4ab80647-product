"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";

// The existing workspace entry destination. Overview is the first workspace
// screen and exposes the curated models, chat (Playground), and compute ledger.
const WORKSPACE_HREF = "/dashboard";

export default function PrivyEntry() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();
  const forwarded = useRef(false);

  // Authentication ends at the workspace. A completed Privy login and an already
  // restored Privy session both continue straight to Overview: there is no
  // secondary holder/token check, no intermediate verification screen, no gate
  // route, and no blocking modal between identity and the product.
  const continueToWorkspace = useCallback(() => {
    if (forwarded.current) return;
    forwarded.current = true;
    router.replace(WORKSPACE_HREF);
  }, [router]);

  const { login } = useLogin({ onComplete: () => continueToWorkspace() });

  // Returning users with a live Privy session (including a page refresh) skip the
  // entry screen entirely and land back in the workspace.
  useEffect(() => {
    if (ready && authenticated) continueToWorkspace();
  }, [ready, authenticated, continueToWorkspace]);

  function enter() {
    if (!ready) return;
    if (authenticated) {
      continueToWorkspace();
      return;
    }
    login();
  }

  // A restored/existing session never sees a sign-in prompt or a verification
  // step: it only sees the short hand-off into the workspace.
  const signingIn = ready && !authenticated;
  const showSignIn = ready && !authenticated;
  const headline = signingIn
    ? "Sign in with Privy to enter your workspace"
    : authenticated
      ? "Opening your workspace"
      : "Restoring your session";
  const support = signingIn
    ? "Signing in is the whole entry step. A verified identity opens Overview with the curated models, chat, and your compute allowance\u2014no token holding, provider account, or API key stands between you and the workspace."
    : "Checking your Privy session. A verified identity is the only access requirement, and an active session continues directly to Overview.";
  const status = signingIn
    ? "Identity verified by Privy \u00b7 no holdings required"
    : "Authenticated \u00b7 loading Overview and Playground";

  // Access is identity-based: a verified Privy session is sufficient for a
  // session, the model registry, chat, and inference authorization. No token
  // holding, wallet balance, or holder-eligibility check exists anywhere here.
  return <div className="entry-page"><div className="entry-field"><div className="entry-glow" /></div><div className="entry-panel"><Link href="/" className="entry-brand"><span className="ow-mark">\u2726</span> OPENWEIGHT</Link><div className="entry-copy"><h1 className="entry-headline">{headline}</h1><p className="entry-support">{support}</p>{showSignIn ? <button className="ow-button primary entry-button" onClick={enter}>Continue with Privy<span>\u2197</span></button> : null}<p className="entry-status" role="status">{status}</p></div></div><style jsx global>{`
      .entry-copy .entry-headline { color: #171719; font-size: clamp(2rem, 3.1vw, 3rem); line-height: 1.04; letter-spacing: -.055em; overflow-wrap: normal; word-break: normal; }
      .entry-copy .entry-support { margin: 22px 0 0; color: #7a7b80; font-size: 14px; line-height: 1.6; max-width: 400px; }
      .entry-copy .entry-status { margin: 16px 0 0; color: #9a9b9f; font: 10px var(--font-geist-mono), monospace; letter-spacing: .06em; }
      @media (max-width: 900px) { .entry-page { grid-template-columns: 1fr; } .entry-field { display: none; } .entry-panel { min-height: 100vh; padding: 30px clamp(22px, 7vw, 72px); } .entry-copy { width: 100%; max-width: 620px; } .entry-copy .entry-headline { font-size: clamp(2rem, 7vw, 3rem); line-height: 1.04; letter-spacing: -.055em; } }
    `}</style></div>;
}

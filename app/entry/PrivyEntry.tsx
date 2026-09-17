"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import { useEffect, useState } from "react";

export default function PrivyEntry() {
  const router = useRouter();
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { login } = useLogin({ onComplete: () => undefined });
  const { wallets } = useWallets();
  const [status, setStatus] = useState("Visitor · not authenticated");
  const [error, setError] = useState("");
  const wallet = wallets.find((item) => item.walletClientType) ?? wallets[0];

  useEffect(() => {
    if (!ready) setStatus("Loading Privy session…");
    else if (authenticated) setStatus(wallet ? `Authenticated · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : "Authenticated · connect an EVM wallet");
    else setStatus("Visitor · not authenticated");
  }, [ready, authenticated, wallet]);

  async function enter() {
    setError("");
    if (!ready) return;
    if (!authenticated) { login(); return; }
    if (!wallet) { setError("No active EVM wallet is available. Connect or select one in Privy, then retry."); return; }
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Session missing");
      const response = await fetch("/api/account", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!response.ok) throw new Error("Account verification failed");
      router.push("/dashboard");
    } catch { setError("We could not verify this session. Retry authentication to continue into the frontier."); }
  }

  return <div className="entry-page"><div className="entry-field"><div className="entry-glow"/></div><div className="entry-panel"><Link href="/" className="entry-brand"><span className="ow-mark">✦</span> OPENWEIGHT</Link><div className="entry-copy"><div className="ow-eyebrow">PRIVY VERIFIED ACCESS</div><h1>Bring your wallet.<br/><em>Keep the weight.</em></h1><p>Connect a wallet to verify your OPENWEIGHT holding and enter the open-weight frontier workspace.</p><button className="ow-button primary entry-button" onClick={enter} disabled={!ready}>{!ready ? "Loading Privy…" : authenticated ? "Verify and enter" : "Continue with Privy"}<span>↗</span></button><p aria-live="polite" className="entry-status">{status}</p>{error && <div className="inline-error" role="alert">{error}</div>}<div className="entry-note"><span aria-hidden="true">◇</span><span>Ownership remains your canonical identity.<br/>Access opens after wallet verification.</span></div></div><div className="entry-footer"><Link href="/privacy">Privacy</Link><span>·</span><span>Chain 4663 · server verified</span></div></div></div>;
}
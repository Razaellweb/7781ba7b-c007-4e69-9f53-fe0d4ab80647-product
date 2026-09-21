"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";

type GateState = "idle" | "pending" | "success" | "ineligible" | "error";
type StoredGate = { wallet: string; state: Exclude<GateState, "idle" | "pending" | "error">; verifiedAt: string };
const storageKey = "openweight:eligibility";

function EligibilityModal({ state, wallet, error, onRetry, onContinue }: { state: GateState; wallet: string; error: string; onRetry: () => void; onContinue: () => void }) {
  if (state === "idle") return null;
  const pending = state === "pending";
  const success = state === "success";
  const title = pending ? "Verifying holder access" : success ? "Access unlocked" : state === "ineligible" ? "Holder access is not available" : "Verification needs a retry";
  const body = pending ? "Checking your active OPENWEIGHT balance on Robinhood Chain. Your workspace stays locked until this completes." : success ? "Your wallet meets the configured holding requirement. Continue to the Openweight workspace." : state === "ineligible" ? "This wallet does not meet the configured OPENWEIGHT holding requirement. No billable inference is available." : error;
  return <div className="eligibility-backdrop" role="presentation"><section className={`eligibility-modal ${success ? "is-success" : state === "ineligible" ? "is-failure" : state === "error" ? "is-error" : ""}`} role="dialog" aria-modal="true" aria-labelledby="eligibility-title"><div className="eligibility-kicker">OPENWEIGHT / HOLDER CHECK</div><div className="eligibility-orb" aria-hidden="true">{pending ? "…" : success ? "✓" : "×"}</div><h2 id="eligibility-title">{title}</h2><p>{body}</p>{wallet && <small>Canonical wallet · {wallet.slice(0, 6)}…{wallet.slice(-4)}</small>}{pending && <div className="eligibility-progress" aria-label="Verification in progress"><span /></div>}{state === "error" && <button type="button" className="ow-button primary eligibility-action" onClick={onRetry}>Retry verification ↻</button>}{success && <button type="button" className="ow-button primary eligibility-action" onClick={onContinue}>Continue to workspace ↗</button>}{state === "ineligible" && <Link className="eligibility-link" href="/">Return to landing page</Link>}</section></div>;
}

export default function PrivyEntry() {
  const router = useRouter();
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { login } = useLogin({ onComplete: () => undefined });
  const { wallets } = useWallets();
  const [status, setStatus] = useState("Visitor · not authenticated");
  const [error, setError] = useState("");
  const [gateState, setGateState] = useState<GateState>("idle");
  const [walletAddress, setWalletAddress] = useState("");
  const running = useRef(false);
  const activeWallet = useRef("");
  const wallet = wallets.find((item) => item.walletClientType) ?? wallets[0];

  const verify = useCallback(async (force = false) => {
    if (running.current || !authenticated || !wallet) return;
    running.current = true;
    const address = wallet.address.toLowerCase();
    activeWallet.current = address;
    setWalletAddress(address);
    setGateState("pending");
    setError("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Session missing");
      const response = await fetch(`/api/holder/verify${force ? "?force=true" : ""}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (activeWallet.current !== address) return;
      if (!response.ok) throw new Error(response.status === 429 ? "Too many attempts. Please wait briefly, then retry." : "The holder verification service is temporarily unavailable.");
      const payload = await response.json() as { eligibility?: { state?: string } };
      if (activeWallet.current !== address) return;
      const result = payload.eligibility?.state;
      if (result === "eligible" || result === "insufficient_balance") {
        const nextState = result === "eligible" ? "success" : "ineligible";
        const stored: StoredGate = { wallet: address, state: nextState, verifiedAt: new Date().toISOString() };
        sessionStorage.setItem(storageKey, JSON.stringify(stored));
        setGateState(nextState);
      } else throw new Error("The network or token configuration could not be verified.");
    } catch (verificationError) {
      if (activeWallet.current !== address) return;
      setError(verificationError instanceof Error ? verificationError.message : "Verification could not be completed.");
      setGateState("error");
    } finally { if (activeWallet.current === address) running.current = false; }
  }, [authenticated, getAccessToken, wallet]);

  useEffect(() => {
    if (!ready) { setStatus("Loading Privy session…"); return; }
    if (!authenticated) { activeWallet.current = ""; running.current = false; sessionStorage.removeItem(storageKey); setStatus("Visitor · not authenticated"); setGateState("idle"); return; }
    if (!wallet) { activeWallet.current = ""; running.current = false; setStatus("Authenticated · connect an EVM wallet"); setWalletAddress(""); setError("No active canonical EVM wallet is available. Connect or select one in Privy, then retry."); setGateState("error"); return; }
    const address = wallet.address.toLowerCase();
    activeWallet.current = address;
    setStatus(`Authenticated · ${address.slice(0, 6)}…${address.slice(-4)}`);
    let stored: StoredGate | null = null;
    try { stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as StoredGate | null; } catch { stored = null; }
    if (stored?.wallet === address && (stored.state === "success" || stored.state === "ineligible")) { setWalletAddress(address); setGateState(stored.state); return; }
    void verify(true);
  }, [authenticated, ready, verify, wallet]);

  async function enter() {
    setError("");
    if (!ready) return;
    if (!authenticated) { login(); return; }
    if (!wallet) { setGateState("error"); setError("No active canonical EVM wallet is available. Connect or select one in Privy, then retry."); return; }
    await verify(false);
  }

  return <>
    <div className="entry-page"><div className="entry-field"><div className="entry-glow" /></div><div className="entry-panel"><Link href="/" className="entry-brand"><span className="ow-mark">✦</span> OPENWEIGHT</Link><div className="entry-copy"><h1 className="entry-headline">Hold a minimum of 10,000 Openweight tokens to gain access to free compute</h1><p>Connect a wallet to verify your OPENWEIGHT holding and enter the open-weight frontier workspace.</p><button className="ow-button primary entry-button" onClick={() => void enter()} disabled={!ready || gateState === "pending"}>{!ready ? "Loading Privy…" : authenticated ? "Verify and enter" : "Continue with Privy"}<span>↗</span></button><p aria-live="polite" className="entry-status">{status}</p>{error && gateState !== "error" && <div className="inline-error" role="alert">{error}</div>}</div></div></div>
    <EligibilityModal state={gateState} wallet={walletAddress} error={error} onRetry={() => void verify(true)} onContinue={() => router.push("/dashboard")} />
    <style jsx global>{`
      .entry-headline { color: #171719; overflow-wrap: anywhere; word-break: normal; }
      .eligibility-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 24px; background: rgba(10, 10, 11, .72); backdrop-filter: blur(10px); }
      .eligibility-modal { width: min(100%, 520px); padding: clamp(30px, 6vw, 58px); border-radius: 28px; background: #f4f1eb; color: #171719; box-shadow: 0 30px 100px rgba(0,0,0,.35); text-align: center; }
      .eligibility-modal.is-success { background: #eef7f1; } .eligibility-modal.is-failure { background: #f8f0ed; } .eligibility-modal.is-error { background: #f5f1e9; }
      .eligibility-kicker { font-size: 10px; letter-spacing: .16em; font-weight: 700; opacity: .58; } .eligibility-orb { display: grid; place-items: center; width: 64px; height: 64px; margin: 26px auto 22px; border-radius: 50%; background: #171719; color: #fff; font-size: 28px; } .is-success .eligibility-orb { background: #2d7650; } .is-failure .eligibility-orb { background: #9b4b3c; } .is-error .eligibility-orb { background: #9a7133; }
      .eligibility-modal h2 { margin: 0; font-size: clamp(1.8rem, 5vw, 2.5rem); letter-spacing: -.05em; } .eligibility-modal p { max-width: 380px; margin: 14px auto 0; line-height: 1.6; color: rgba(23,23,25,.7); } .eligibility-modal small { display: block; margin-top: 20px; opacity: .55; font-family: var(--font-geist-mono); font-size: 11px; }
      .eligibility-progress { height: 3px; margin: 28px auto 0; max-width: 240px; overflow: hidden; background: rgba(23,23,25,.12); } .eligibility-progress span { display: block; width: 45%; height: 100%; background: #171719; animation: eligibility-progress 1.2s ease-in-out infinite alternate; } @keyframes eligibility-progress { to { transform: translateX(125%); } }
      .eligibility-action { margin-top: 28px; } .eligibility-link { display: inline-block; margin-top: 26px; color: #171719; font-size: 13px; text-decoration: underline; text-underline-offset: 4px; }
      @media (max-width: 900px) { .entry-page { grid-template-columns: 1fr; } .entry-field { display: none; } .entry-panel { min-height: 100vh; padding: 30px clamp(22px, 7vw, 72px); } .entry-copy { width: 100%; max-width: 620px; } .entry-headline { font-size: clamp(2.65rem, 9vw, 4.5rem); line-height: .96; letter-spacing: -.065em; } }
    `}</style>
  </>;
}
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isEvmAddress } from "../../lib/wallet/canonical";
import "./fund-dialog.css";

// The deposit surface opened by Overview's Fund button. The address is the
// account's USDG deposit wallet from POST /api/funding, which the backend
// monitors; USDG sent to it is credited to the compute balance once confirmed.
//
// The address is shown as soon as the backend has provisioned it. Alchemy
// monitoring registration is reported alongside the address (`monitoring`) rather
// than gating it: the address is the account's own wallet, so the dialog displays
// it and says plainly when deposit detection is still being registered.
//
// The dialog owns no wallet state of its own: it renders whatever phase the page
// reports, so it can never display an address the backend did not return.
export type FundDeposit = {
  id: string;
  status: "pending" | "confirmed" | "rejected";
  amountToken: string;
  assetSymbol: string;
  confirmations: number;
  requiredConfirmations: number;
};

export type FundAddressState =
  | { phase: "loading" }
  | {
      phase: "ready";
      address: string;
      network: string;
      token: string;
      requiredConfirmations: number;
      minimumDeposit: string | null;
      deposits: FundDeposit[];
      /** True once Alchemy address-activity monitoring is registered. */
      monitoring: boolean;
    }
  | { phase: "unavailable"; message: string }
  | { phase: "error"; message: string };

const depositStatus = (deposit: FundDeposit) =>
  deposit.status === "confirmed"
    ? "Credited"
    : deposit.status === "rejected"
      ? "Not credited"
      : `Confirming ${Math.min(deposit.confirmations, deposit.requiredConfirmations)}/${deposit.requiredConfirmations}`;

const COPY_FEEDBACK_MS = 2400;

export default function FundWalletDialog({
  state,
  onClose,
  onRetry,
  onCopied,
}: {
  /** Phase reported by the page's Fund flow. Never a guessed address. */
  state: FundAddressState;
  onClose: () => void;
  onRetry: () => void;
  onCopied: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const addressRef = useRef<HTMLElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const focusables = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex=\"-1\"])"))
        .filter((item) => !item.hasAttribute("disabled"));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const current = document.activeElement;
      const index = items.indexOf(current as HTMLElement);
      if (event.shiftKey && (index <= 0 || current === dialog)) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && index === items.length - 1) {
        event.preventDefault();
        items[0].focus();
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // A new phase (or a retried fetch) starts with a clean copy affordance, so a
  // "Copied" confirmation can never describe a previous address.
  useEffect(() => {
    setCopyStatus("idle");
  }, [state]);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const address = state.phase === "ready" && isEvmAddress(state.address) ? state.address : null;

  const copy = useCallback(async () => {
    if (!address) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(address);
      setCopyStatus("copied");
      onCopied("Deposit address copied");
    } catch {
      // Non-blocking: select the address in place so it can be copied by hand.
      setCopyStatus("failed");
      const node = addressRef.current;
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (node && selection) {
        const range = window.document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      onCopied("Copy unavailable — the address is selected, press Ctrl/Cmd + C.");
    }
  }, [address, onCopied]);

  const copyLabel = copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Select" : "Copy";
  const copyMark = copyStatus === "copied" ? "✓" : "▣";

  return (
    <div
      className="fund-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="fund-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fund-modal-title"
        aria-describedby="fund-modal-description"
        tabIndex={-1}
      >
        <header className="fund-modal-header">
          <div>
            <div className="compute-card-label">FUND · DEPOSIT</div>
            <h2 id="fund-modal-title">Add compute.</h2>
            <p id="fund-modal-description">Your personal deposit address for adding compute to this workspace.</p>
          </div>
          <button ref={closeRef} type="button" className="fund-modal-close" onClick={onClose} aria-label="Close fund dialog">
            ×
          </button>
        </header>

        <div className="fund-modal-body">
          {state.phase === "loading" && (
            <div className="fund-modal-loading" role="status" aria-live="polite">
              <span className="fund-address-label">DEPOSIT ADDRESS</span>
              <span className="fund-address-skeleton" aria-hidden="true" />
              <span className="fund-loading-line">
                <span className="fund-loading-spinner" aria-hidden="true" />
                Fetching your deposit address…
              </span>
            </div>
          )}

          {state.phase === "ready" && (
            <div className="fund-address-block">
              <span className="fund-address-label">
                {state.token} DEPOSIT ADDRESS · {state.network.toUpperCase()}
              </span>
              <div className="fund-address-row">
                <code
                  ref={addressRef}
                  className="fund-address-value"
                  title={state.address}
                  aria-label={`Deposit address ${state.address}`}
                >
                  {state.address}
                </code>
                <button
                  type="button"
                  className={`fund-copy-button is-${copyStatus}`}
                  onClick={() => void copy()}
                  aria-label="Copy full deposit address"
                >
                  <span aria-hidden="true">{copyMark}</span> {copyLabel}
                </button>
              </div>
              <p className={`fund-copy-status ${copyStatus === "failed" ? "is-failed" : ""}`} role="status" aria-live="polite">
                {copyStatus === "copied"
                  ? "Copied to clipboard."
                  : copyStatus === "failed"
                    ? "Clipboard unavailable — the address is selected, press Ctrl/Cmd + C."
                    : ""}
              </p>
              {!state.monitoring && (
                <p className="fund-address-pending">
                  Deposit detection for this address is still being registered. Check again before sending; USDG is
                  credited once detection is active.
                </p>
              )}
              <p className="fund-address-note">
                Only send {state.token} on {state.network}; other tokens or networks are not credited.
                {state.minimumDeposit && Number(state.minimumDeposit) > 0
                  ? ` Minimum deposit ${state.minimumDeposit} ${state.token}.`
                  : ""}
              </p>
              {state.deposits.length > 0 && (
                <ul className="fund-deposit-list" aria-label="Recent deposits">
                  {state.deposits.slice(0, 3).map((deposit) => (
                    <li key={deposit.id}>
                      <span>{deposit.amountToken} {deposit.assetSymbol}</span>
                      <span className={`fund-deposit-status is-${deposit.status}`}>{depositStatus(deposit)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {state.phase === "unavailable" && (
            <div className="fund-modal-error" role="status" aria-live="polite">
              <span className="fund-address-label">NO DEPOSIT ADDRESS YET</span>
              <p>{state.message}</p>
              <div className="fund-modal-error-actions">
                <button type="button" className="fund-modal-retry" onClick={onRetry}>
                  Retry ↻
                </button>
                <button type="button" className="fund-modal-dismiss" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {state.phase === "error" && (
            <div className="fund-modal-error" role="alert">
              <span className="fund-address-label">ADDRESS UNAVAILABLE</span>
              <p>{state.message}</p>
              <div className="fund-modal-error-actions">
                <button type="button" className="fund-modal-retry" onClick={onRetry}>
                  Retry ↻
                </button>
                <button type="button" className="fund-modal-dismiss" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

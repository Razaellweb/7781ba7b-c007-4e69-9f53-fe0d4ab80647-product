"use client";

import { useEffect, useRef } from "react";
import { shortenAddress } from "../../lib/wallet/canonical";

// The address surface opened by Overview's Fund button, once the account's
// canonical EVM wallet has been resolved and confirmed by the backend session.
//
// Scope is deliberately narrow: show one read-only address. There is no payment,
// checkout, top-up, or funding transaction anywhere on this surface — viewing an
// address cannot move value or claim a balance was topped up.
//
// The dialog owns no wallet state of its own. It renders whatever phase the page
// reports, so a late-arriving or replaced canonical address simply repaints, and
// an unavailable address surfaces a retryable error rather than a stale value.
export type FundAddressState =
  | { phase: "loading" }
  | { phase: "ready"; address: string }
  | { phase: "error"; message: string };

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

  const address = state.phase === "ready" ? state.address : null;

  const copy = async () => {
    if (!address) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(address);
      onCopied("Wallet address copied");
    } catch {
      onCopied("Copy unavailable — select the address text to copy it.");
    }
  };

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
            <div className="compute-card-label">WALLET · FUND</div>
            <h2 id="fund-modal-title">Your active wallet.</h2>
            <p id="fund-modal-description">
              The canonical wallet this workspace resolved for your signed-in account. It is read-only, and nothing is
              charged or funded from this screen.
            </p>
          </div>
          <button ref={closeRef} type="button" className="fund-modal-close" onClick={onClose} aria-label="Close wallet address">
            ×
          </button>
        </header>

        <div className="fund-modal-body">
          {state.phase === "loading" && (
            <div className="fund-modal-loading" role="status">
              <span className="fund-address-label">WALLET ADDRESS</span>
              <span className="fund-address-skeleton" aria-hidden="true" />
              <p>Resolving your active wallet from the signed-in session…</p>
            </div>
          )}

          {state.phase === "ready" && (
            <div className="fund-address-block">
              <span className="fund-address-label">EVM WALLET ADDRESS</span>
              <div className="fund-address-row">
                <code
                  className="fund-address-value"
                  title={state.address}
                  aria-label={`Active wallet address ${state.address}`}
                >
                  {shortenAddress(state.address, 6, 4)}
                </code>
                <button type="button" className="fund-copy-button" onClick={() => void copy()} aria-label="Copy full wallet address">
                  <span aria-hidden="true">▣</span> Copy
                </button>
              </div>
              <p className="fund-address-note">Read-only · confirmed by your session and reused on every visit.</p>
            </div>
          )}

          {state.phase === "error" && (
            <div className="fund-modal-error" role="alert">
              <span className="fund-address-label">WALLET UNAVAILABLE</span>
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

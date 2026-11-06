"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isEvmAddress } from "../../lib/wallet/canonical";
import "./fund-dialog.css";

// The deposit surface opened by Overview's Fund button. The address is the
// account's USDG deposit wallet from POST /api/funding, which the backend
// monitors; USDG sent to it is credited to the compute balance once confirmed.
//
// Deposits are NOT a single static line. Every deposit the backend knows about is
// listed with its own amount and its own state, read from funding_deposits through
// the funding API:
//   * pending  -> live confirmation progress against FUNDING_CONFIRMATIONS (3),
//                 e.g. "1 of 3 confirmations", so it can visibly advance;
//   * confirmed-> "Credited";
//   * rejected -> a human-readable reason (wrong token, not the configured token,
//                 below the minimum, unknown recipient, ...). A wrong-token
//                 deposit names the USDG contract that IS credited.
//
// Amounts come from the backend already scaled with USDG's six decimals and are
// rendered as the exact decimal string it returns — no parseFloat, no rounding.
//
// Configuration is reported, never guessed. When deposit monitoring is inactive the
// dialog shows the backend's reason and the environment variable NAMES still
// missing (ALCHEMY_API_KEY / ALCHEMY_RPC_URL / ALCHEMY_NETWORK), which keeps a
// missing endpoint, a missing/unparseable network, and a generic setup failure as
// three distinct states. When the scheduled sweep cannot run, CRON_SECRET is named
// as the missing variable (the secret itself is never sent to the browser).
//
// The dialog owns no wallet state of its own: it renders whatever phase the page
// reports, so it can never display an address the backend did not return.

/** The confirmation count a deposit must reach before it is credited. */
export const FUNDING_CONFIRMATIONS = 3;

/** The USDG contract on Robinhood Chain mainnet that deposits must arrive in. */
export const USDG_MAINNET_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/** The one transfer rule, stated verbatim in the dialog. */
export const FUNDING_NOTE = "Only send USDG on Robinhood Chain Mainnet; other tokens or networks are not credited.";

export type FundDeposit = {
  id: string;
  txHash?: string | null;
  status: "pending" | "confirmed" | "rejected";
  amountToken: string;
  amountMicroUsd?: string | null;
  assetSymbol: string;
  confirmations: number;
  requiredConfirmations: number;
  rejectionReason?: string | null;
  reorgFlagged?: boolean;
  blockNumber?: string | null;
  creditedAt?: string | null;
};

/** Alchemy monitoring configuration, as the backend reports it. Never a secret. */
export type FundMonitoringConfig = {
  enabled: boolean;
  reason: string | null;
  message: string | null;
  missing: string[];
};

/** Whether the scheduled reconciliation sweep can run (CRON_SECRET present). */
export type FundSchedulerState = {
  configured: boolean;
  missing: string[];
  detail: string;
};

/** State of the in-place "Check again" recheck. */
export type FundRecheckState = {
  busy: boolean;
  /** Non-destructive failure: the last known deposits stay on screen. */
  error: string | null;
  message: string | null;
};

export type FundAddressState =
  | { phase: "loading" }
  | {
      phase: "ready";
      address: string;
      network: string;
      token: string;
      /** Configured USDG contract address, shown when a wrong token arrives. */
      tokenAddress: string | null;
      requiredConfirmations: number;
      minimumDeposit: string | null;
      deposits: FundDeposit[];
      /** True once Alchemy address-activity monitoring is registered. */
      monitoring: boolean;
      /** Machine-readable reason detection is not active (e.g. alchemy_network_not_configured). */
      monitoringReason: string | null;
      /** Human-readable explanation of `monitoringReason`. */
      monitoringMessage: string | null;
      /** Environment variable names still missing for monitoring. */
      monitoringMissing: string[];
      scheduler: FundSchedulerState | null;
      recheck: FundRecheckState;
    }
  | {
      phase: "unprovisioned";
      /** Provisioning = the address is still being created; misconfigured = a setting is missing. */
      kind: "provisioning" | "misconfigured";
      message: string;
      /** Specific configuration problems reported by the backend, if any. */
      issues: string[];
      /** Environment variable names that must be set before deposits can work. */
      missing: string[];
      scheduler: FundSchedulerState | null;
    }
  | { phase: "error"; message: string };

const COPY_FEEDBACK_MS = 2400;

/** The exact amount string the backend computed from the on-chain integer. */
const amountLabel = (deposit: FundDeposit) => {
  const amount = (deposit.amountToken ?? "").trim();
  const symbol = deposit.assetSymbol?.trim() || "USDG";
  return `${amount === "" ? "0" : amount} ${symbol}`;
};

/** "1 of 3 confirmations" — progress toward FUNDING_CONFIRMATIONS. */
const confirmationLabel = (deposit: FundDeposit) => {
  const required = deposit.requiredConfirmations > 0 ? deposit.requiredConfirmations : FUNDING_CONFIRMATIONS;
  const current = Math.max(0, Math.min(deposit.confirmations, required));
  return `${current} of ${required} confirmations`;
};

/** Short state word: Credited / Not credited / progress toward confirmation. */
const depositStatusLabel = (deposit: FundDeposit) => {
  if (deposit.status === "confirmed") return "Credited";
  if (deposit.status === "rejected") return "Not credited";
  return confirmationLabel(deposit);
};

/**
 * A rejected deposit always explains itself. The four reasons the funding pipeline
 * emits for a wrong transfer each read differently, and every wrong-asset case names
 * the USDG contract that IS credited instead of leaving the user guessing.
 */
const rejectionCopy = (deposit: FundDeposit, expectedTokenAddress: string): { title: string; body: string } | null => {
  switch (deposit.rejectionReason) {
    case "wrong_token":
      return {
        title: "Wrong token",
        body: `This transfer was a different token. Only USDG at ${expectedTokenAddress} is credited.`,
      };
    case "not_the_configured_token":
      return {
        title: "Wrong asset",
        body: `This transfer carried no USDG contract (for example a native transfer). Only USDG at ${expectedTokenAddress} is credited.`,
      };
    case "below_minimum_amount":
      return {
        title: "Below the minimum",
        body: "The amount sent was below the minimum this workspace credits. Send a larger USDG amount.",
      };
    case "unknown_recipient":
      return {
        title: "Wrong recipient",
        body: "This transfer was not sent to this workspace's deposit address, so it cannot be credited here.",
      };
    case "wrong_chain":
      return {
        title: "Wrong network",
        body: "This transfer was not on Robinhood Chain Mainnet. Only USDG on Robinhood Chain Mainnet is credited.",
      };
    case "zero_value":
      return { title: "No value sent",
        body: "The transfer carried a zero amount, so there was nothing to credit." };
    case "malformed_amount":
      return { title: "Unreadable amount",
        body: "The transfer's amount could not be read on chain, so it was not credited." };
    case "transaction_reverted":
      return { title: "Transaction reverted",
        body: "The transfer reverted on chain, so no USDG moved and nothing was credited." };
    default:
      return deposit.rejectionReason
        ? { title: "Not credited", body: `The transfer was not credited. Reason: ${deposit.rejectionReason}.` }
        : null;
  }
};

/**
 * Monitoring configuration copy. A missing/unparseable ALCHEMY_NETWORK is stated as
 * such — it is never folded into "setup failed" — and the exact variable names are
 * shown so the fix is unambiguous.
 */
const monitoringCopy = (config: FundMonitoringConfig | null): { headline: string; body: string; variables: string[] } | null => {
  if (!config || config.enabled) return null;
  switch (config.reason) {
    case "alchemy_network_not_configured":
      return {
        headline: "ALCHEMY_NETWORK is missing",
        body: "ALCHEMY_API_KEY is set, but ALCHEMY_NETWORK is not, so no chain endpoint can be built. Set ALCHEMY_NETWORK (for example robinhood-mainnet) or a full ALCHEMY_RPC_URL.",
        variables: ["ALCHEMY_NETWORK"],
      };
    case "alchemy_network_invalid":
      return {
        headline: "ALCHEMY_NETWORK cannot be parsed",
        body: "ALCHEMY_NETWORK is set but is not a usable network name or endpoint. Use robinhood-mainnet, ROBINHOOD_MAINNET, or the full https://<network>.g.alchemy.com/v2/<key> URL.",
        variables: ["ALCHEMY_NETWORK"],
      };
    case "alchemy_rpc_url_invalid":
      return {
        headline: "ALCHEMY_RPC_URL is not a usable URL",
        body: "ALCHEMY_RPC_URL is set but is not an http(s) endpoint. Paste the complete endpoint from the Alchemy dashboard.",
        variables: ["ALCHEMY_RPC_URL"],
      };
    default:
      return {
        headline: "Deposit monitoring is not configured",
        body: config.message ?? "Set ALCHEMY_RPC_URL, or ALCHEMY_API_KEY together with ALCHEMY_NETWORK, so transfers to this address can be detected.",
        variables: config.missing.length > 0 ? config.missing : ["ALCHEMY_API_KEY", "ALCHEMY_RPC_URL"],
      };
  }
};

/** The variable list, rendered as separate mono tokens. */
function VariableList({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span className="fund-missing-vars">
      {names.map((name, index) => (
        <span key={name}>
          <code>{name}</code>
          {index < names.length - 1 ? " / " : ""}
        </span>
      ))}
    </span>
  );
}

export default function FundWalletDialog({
  state,
  monitoringConfig,
  onClose,
  onRetry,
  onRecheck,
  onCopied,
}: {
  /** Phase reported by the page's Fund flow. Never a guessed address. */
  state: FundAddressState;
  /** Alchemy configuration reported alongside the state (names only, no secrets). */
  monitoringConfig: FundMonitoringConfig | null;
  onClose: () => void;
  /** Re-attempts provisioning (used when no address exists yet). */
  onRetry: () => void;
  /** Rechecks watches + reconciliation for this wallet, then refreshes in place. */
  onRecheck: () => void;
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

  const address = state.phase === "ready" && isEvmAddress(state.address) ? state.address : null;

  // A new address (or a retried fetch) starts with a clean copy affordance, so a
  // "Copied" confirmation can never describe a previous address. A recheck that only
  // refreshes deposit progress leaves the confirmation alone.
  useEffect(() => {
    setCopyStatus("idle");
  }, [address]);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

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

  const expectedTokenAddress = (state.phase === "ready" && state.tokenAddress) || USDG_MAINNET_ADDRESS;
  const monitoring = monitoringCopy(monitoringConfig);
  const scheduler = state.phase === "ready" || state.phase === "unprovisioned" ? state.scheduler : null;

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

              {monitoring && (
                <div className="fund-address-pending">
                  <p className="fund-monitoring-headline">{monitoring.headline}</p>
                  <p>{monitoring.body}</p>
                  <p className="fund-missing-line">
                    Set <VariableList names={monitoring.variables} /> to activate deposit detection for this address.
                  </p>
                  {state.monitoringReason && (
                    <p className="fund-address-reason">
                      Reason: <code>{state.monitoringReason}</code>
                    </p>
                  )}
                </div>
              )}

              {!monitoring && !state.monitoring && (
                <div className="fund-address-pending">
                  <p className="fund-monitoring-headline">Deposit detection is still being registered</p>
                  <p>Transfers to this address are detected on the next check; USDG is credited once detection is active.</p>
                  {state.monitoringMessage && <p>{state.monitoringMessage}</p>}
                  {state.monitoringReason && (
                    <p className="fund-address-reason">
                      Reason: <code>{state.monitoringReason}</code>
                    </p>
                  )}
                </div>
              )}

              {scheduler && !scheduler.configured && (
                <p className="fund-scheduler-note">
                  Background reconciliation is not configured: <code>{scheduler.missing[0] ?? "CRON_SECRET"}</code> is
                  not set, so deposits only advance when this dialog checks. {scheduler.detail}
                </p>
              )}

              <p className="fund-address-note">
                {FUNDING_NOTE}
                {state.minimumDeposit && Number(state.minimumDeposit) > 0
                  ? ` Minimum deposit ${state.minimumDeposit} ${state.token}.`
                  : ""}
              </p>

              <section className="fund-deposits" aria-label="Deposits to this address">
                <div className="fund-deposits-head">
                  <span className="fund-address-label">
                    DEPOSITS{state.deposits.length > 0 ? ` · ${state.deposits.length}` : ""}
                  </span>
                  <button
                    type="button"
                    className="fund-recheck-button"
                    onClick={onRecheck}
                    disabled={state.recheck.busy}
                  >
                    {state.recheck.busy ? "Checking…" : "Check again ↻"}
                  </button>
                </div>

                {state.deposits.length === 0 ? (
                  <p className="fund-deposit-empty">
                    No deposits yet. Send USDG to the address above; each transfer appears here with its own amount and
                    confirmation progress.
                  </p>
                ) : (
                  <ul className="fund-deposit-list">
                    {state.deposits.map((deposit) => {
                      const rejection = deposit.status === "rejected" ? rejectionCopy(deposit, expectedTokenAddress) : null;
                      return (
                        <li key={deposit.id}>
                          <div className="fund-deposit-row">
                            <span className="fund-deposit-amount">{amountLabel(deposit)}</span>
                            <span className={`fund-deposit-status is-${deposit.status}`}>{depositStatusLabel(deposit)}</span>
                          </div>
                          {rejection && (
                            <p className="fund-deposit-reason">
                              <strong>{rejection.title}.</strong> {rejection.body}
                            </p>
                          )}
                          {deposit.status === "confirmed" && deposit.reorgFlagged && (
                            <p className="fund-deposit-reason">
                              <strong>Under review.</strong> This credit was reorged out of the canonical chain and is
                              being verified before any adjustment.
                            </p>
                          )}
                          {deposit.status === "pending" && (
                            <p className="fund-deposit-reason is-pending">
                              Credited automatically at {deposit.requiredConfirmations > 0 ? deposit.requiredConfirmations : FUNDING_CONFIRMATIONS} confirmations.
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {state.recheck.error && (
                  <p className="fund-recheck-error" role="status" aria-live="polite">
                    {state.recheck.error} The deposits above are unchanged.
                  </p>
                )}
                {!state.recheck.error && state.recheck.message && (
                  <p className="fund-recheck-note" role="status" aria-live="polite">{state.recheck.message}</p>
                )}
              </section>
            </div>
          )}

          {state.phase === "unprovisioned" && (
            <div className="fund-modal-error fund-not-ready" role="status" aria-live="polite">
              <span className="fund-address-label">DEPOSITS NOT READY</span>
              <p className="fund-not-ready-headline">
                {state.kind === "misconfigured" ? "Deposit monitoring is not configured" : "Your deposit address is being set up"}
              </p>
              <p>{state.message}</p>
              {state.missing.length > 0 && (
                <p className="fund-missing-line">
                  Missing configuration: <VariableList names={state.missing} />
                </p>
              )}
              {state.issues.length > 0 && (
                <ul className="fund-config-issues">
                  {state.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}
              {state.scheduler && !state.scheduler.configured && (
                <p className="fund-missing-line">
                  Background reconciliation is not configured: <code>{state.scheduler.missing[0] ?? "CRON_SECRET"}</code> is not set.
                </p>
              )}
              <div className="fund-modal-error-actions">
                <button type="button" className="fund-modal-retry" onClick={onRetry}>
                  Check again ↻
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

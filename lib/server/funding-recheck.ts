import { fundingReconcileConfig } from "./config";
import { query } from "./db";
import { alchemyMonitoringStatus, type AlchemyMonitoringStatus } from "./alchemy";
import {
  processDeposit,
  reconcileWallet,
  retryPendingWatches,
  type FundingWalletRow,
  type ReconcileWalletSummary,
} from "./funding";

// Signed-in funding recheck.
//
// The Fund dialog's "Check again" button must be able to make real progress:
// retry address registrations, scan the chain for transfers the webhook never
// delivered, and re-read the depth of deposits that are still short of
// FUNDING_CONFIRMATIONS. That work already exists in `lib/server/funding.ts`
// (`retryPendingWatches`, `reconcileWallet`, `processDeposit`), so this module only
// composes it for ONE authenticated account.
//
// Deliberate boundaries:
//   * CRON_SECRET is never read here and never returned. The scheduled sweep stays
//     behind its own constant-time bearer check in app/api/funding/reconcile;
//     this path authorizes with the caller's verified Privy session instead.
//   * Only the caller's own funding wallet is swept. There is no way to ask this
//     module to reconcile somebody else's address.
//   * Crediting still happens exclusively through `creditDeposit` inside
//     funding.ts, keyed by the deposit's idempotency key, so a repeated recheck can
//     never credit a transfer twice.
//
// Configuration states are reported as VARIABLE NAMES, never values, so the UI can
// say exactly what an operator still has to set (ALCHEMY_API_KEY /
// ALCHEMY_RPC_URL / ALCHEMY_NETWORK / CRON_SECRET).

export type PublicAlchemyConfig = AlchemyMonitoringStatus & {
  /** Environment variable names that must be set before monitoring works. */
  missing: string[];
};

/**
 * The variables an operator still has to set, derived from WHY monitoring is
 * unusable. A bare key with no network and an unparseable network are both
 * reported as ALCHEMY_NETWORK (a *missing/unusable network*), which is a different
 * state from having no endpoint at all.
 */
export function alchemyMissingVariables(status: AlchemyMonitoringStatus): string[] {
  if (status.enabled) return [];
  switch (status.reason) {
    case "alchemy_network_not_configured":
    case "alchemy_network_invalid":
      return ["ALCHEMY_NETWORK"];
    case "alchemy_rpc_url_invalid":
      return ["ALCHEMY_RPC_URL"];
    default:
      return ["ALCHEMY_API_KEY", "ALCHEMY_RPC_URL"];
  }
}

/** Browser-safe Alchemy monitoring state: no credentials, plus the missing names. */
export function publicAlchemyConfig(): PublicAlchemyConfig {
  const status = alchemyMonitoringStatus();
  return { ...status, missing: alchemyMissingVariables(status) };
}

/**
 * Whether the scheduled reconciliation sweep can run at all. Only WHETHER the
 * secret is set is reported — the value never leaves the server.
 */
export function fundingSchedulerStatus(): { configured: boolean; missing: string[]; detail: string } {
  const { cronSecret } = fundingReconcileConfig();
  if (cronSecret) {
    return {
      configured: true,
      missing: [],
      detail: "Scheduled reconciliation is active, so pending deposits advance without the dialog being open.",
    };
  }
  return {
    configured: false,
    missing: ["CRON_SECRET"],
    detail:
      "Scheduled reconciliation is not configured: CRON_SECRET is not set, so background sweeps cannot run. Check again still reconciles this workspace using your signed-in session.",
  };
}

/** Outcome of one signed-in recheck. Every field is safe to return to the browser. */
export type FundingRecheckResult = {
  /** Address registrations retried, and how many became watched. */
  watches: { attempted: number; watched: number };
  /** Per-wallet scan summary for THIS account, or null when there is no wallet yet. */
  reconciliation: ReconcileWalletSummary | null;
  /** Set when the scan itself failed (provider unreachable etc.); deposits are kept. */
  reconcileError: string | null;
  /** True when no chain endpoint is configured, so nothing could be scanned. */
  skipped: boolean;
  /** Machine-readable reason the scan did not run/incomplete; null when it did. */
  reason: string | null;
  /** Pending deposits re-checked for confirmation depth. */
  pendingChecked: number;
  /** Deposits credited by this recheck. */
  credited: number;
};

/**
 * Reconciles the authenticated account's deposit address once.
 *
 * Order matters: registrations are retried first (an unwatched address cannot be
 * swept), the wallet row is re-read so the scan sees the new state, then the chain
 * is scanned, then every pending deposit gets an immediate depth re-check so a
 * "1 of 3" can visibly become "2 of 3" or "Credited" on this click.
 */
export async function recheckFunding(
  accountId: string,
  options: { maxChunks?: number } = {},
): Promise<FundingRecheckResult> {
  const result: FundingRecheckResult = {
    watches: { attempted: 0, watched: 0 },
    reconciliation: null,
    reconcileError: null,
    skipped: false,
    reason: null,
    pendingChecked: 0,
    credited: 0,
  };

  try {
    result.watches = await retryPendingWatches(5);
  } catch {
    result.watches = { attempted: 0, watched: 0 };
  }

  const wallet = (await query<FundingWalletRow>(`SELECT * FROM funding_wallets WHERE account_id=$1`, [accountId]))[0] ?? null;

  if (!wallet) {
    result.skipped = true;
    result.reason = "no_deposit_address";
  } else {
    try {
      result.reconciliation = await reconcileWallet(wallet, { maxChunks: Math.max(1, options.maxChunks ?? 3) });
      if (result.reconciliation.status === "skipped") {
        result.skipped = true;
        result.reason = result.reconciliation.reason ?? "scan_skipped";
      } else if (result.reconciliation.status !== "ok") {
        result.reason = result.reconciliation.reason ?? "scan_incomplete";
      }
    } catch (error) {
      result.reconcileError = error instanceof Error ? error.message.slice(0, 200) : "reconcile_failed";
      result.reason = "reconcile_failed";
    }

    // Pending deposits are re-checked against the chain head, which is what moves a
    // deposit from "1 of 3" to "2 of 3" to credited. `processDeposit` credits at
    // FUNDING_CONFIRMATIONS only, and is idempotent.
    const pending = await query<{ id: string }>(
      `SELECT id FROM funding_deposits WHERE account_id=$1 AND status='pending' ORDER BY first_seen_at LIMIT 10`,
      [accountId],
    ).catch(() => [] as Array<{ id: string }>);
    result.pendingChecked = pending.length;
    for (const row of pending) {
      const processed = await processDeposit(row.id).catch(() => null);
      if (processed?.credited) result.credited += 1;
    }
  }

  return result;
}

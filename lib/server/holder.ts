import { query } from "./db";
import { ensureDefaultAllowance } from "./accounting";
import type { AuthenticatedAccount } from "./auth";

// Access policy: a verified Privy identity is sufficient to grant an
// application session, workspace access, model registry visibility, model
// selection, and inference authorization.
//
// Nothing in this module (or anywhere in the authorization path) reads chain
// state, token balances, wallet holdings, or eligibility derived from ownership.
// Wallet linkage is retained only as optional identity metadata.
//
// Historical `holder_eligibility` rows are preserved untouched so existing
// records stay readable, but their state is reported as history only: a missing,
// stale, or legacy non-eligible value can never disable the product surface.

export type EligibilityState = "eligible" | "insufficient_balance" | "wrong_wallet" | "wrong_network" | "rpc_failure" | "token_misconfiguration";

export type HolderEligibilityResult = {
  state: "eligible";
  authorized: true;
  chain_id: null;
  balance_raw: null;
  threshold_raw: null;
  wallet_address: string | null;
  verified_at: string | null;
  method: "privy_identity";
  legacy_state: EligibilityState | null;
};

function identityAccess(account: AuthenticatedAccount, verifiedAt: string | null, legacyState: EligibilityState | null): HolderEligibilityResult {
  return {
    state: "eligible",
    authorized: true,
    chain_id: null,
    balance_raw: null,
    threshold_raw: null,
    wallet_address: account.walletAddress ?? null,
    verified_at: verifiedAt,
    method: "privy_identity",
    legacy_state: legacyState,
  };
}

async function latestLegacyState(accountId: string): Promise<{ state: EligibilityState | null; wallet_address: string | null }> {
  try {
    const rows = await query<{ state: EligibilityState; wallet_address: string | null }>(
      `SELECT state, wallet_address FROM holder_eligibility WHERE account_id=$1 ORDER BY verified_at DESC LIMIT 1`,
      [accountId]
    );
    return { state: rows[0]?.state ?? null, wallet_address: rows[0]?.wallet_address ?? null };
  } catch {
    return { state: null, wallet_address: null };
  }
}

// Resolves access from the authenticated identity and records a durable,
// idempotent audit marker so downstream reporting keeps working. Also provisions
// the account's default compute allowance for the current period (the allowance
// is a separately handled mechanism, decoupled from any holding status).
//
// Both the audit write and the allowance grant are best-effort: an identity that
// has already been verified by Privy must never be blocked by a bookkeeping
// hiccup in this step.
export async function resolveIdentityAccess(account: AuthenticatedAccount): Promise<HolderEligibilityResult> {
  const legacy = await latestLegacyState(account.accountId);
  const walletForAudit = account.walletAddress ?? legacy.wallet_address ?? null;
  try {
    const existing = await query<{ verified_at: string }>(
      `SELECT verified_at
         FROM holder_eligibility
        WHERE account_id=$1 AND state='eligible' AND chain_id IS NULL AND token_address IS NULL
        ORDER BY verified_at DESC
        LIMIT 1`,
      [account.accountId]
    );
    if (existing[0]) return identityAccess(account, existing[0].verified_at, legacy.state);
    const inserted = await query<{ verified_at: string }>(
      `INSERT INTO holder_eligibility (account_id, wallet_address, state, chain_id, token_address, balance_raw, token_decimals, threshold_raw, verified_at)
       VALUES ($1, $2, 'eligible', NULL, NULL, NULL, NULL, NULL, now())
       RETURNING verified_at`,
      [account.accountId, walletForAudit]
    );
    return identityAccess(account, inserted[0]?.verified_at ?? null, legacy.state);
  } catch {
    return identityAccess(account, null, legacy.state);
  }
}

// Provisions the authenticated account's default allowance. Never throws: the
// caller must not lose access because allowance bookkeeping was unavailable.
export async function provisionDefaultAllowance(account: AuthenticatedAccount): Promise<boolean> {
  try {
    await ensureDefaultAllowance(account.accountId);
    return true;
  } catch {
    return false;
  }
}

// Backwards-compatible alias for existing server call sites. It is identity-based
// now and can only return eligible. The `force` option is accepted for legacy
// callers but no longer performs any external verification.
export function verifyHolder(account: AuthenticatedAccount, _options: { force?: boolean } = {}): Promise<HolderEligibilityResult> {
  return resolveIdentityAccess(account);
}

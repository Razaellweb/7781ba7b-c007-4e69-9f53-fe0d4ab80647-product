import { createPublicClient, http, isAddress, erc20Abi } from "viem";
import { holderConfig } from "./config";
import { query } from "./db";
import type { AuthenticatedAccount } from "./auth";

export type EligibilityState = "eligible" | "insufficient_balance" | "wrong_wallet" | "wrong_network" | "rpc_failure" | "token_misconfiguration";

export type HolderEligibilityResult = {
  state: EligibilityState;
  chain_id: number | null;
  balance_raw: string | null;
  threshold_raw: string | null;
};

type Config = ReturnType<typeof holderConfig>;

type PersistedEligibility = HolderEligibilityResult;

// Inference callers intentionally use the persisted result by default. Only
// the sign-in gate's explicit retry passes force:true, so normal inference
// authorization remains server-enforced without triggering another RPC check.
export async function verifyHolder(account: AuthenticatedAccount, options: { force?: boolean } = {}): Promise<HolderEligibilityResult> {
  if (!options.force) {
    const cached = await query<PersistedEligibility>(
      `SELECT state, chain_id, balance_raw, threshold_raw
         FROM holder_eligibility
        WHERE account_id=$1 AND lower(wallet_address)=lower($2)
        ORDER BY verified_at DESC
        LIMIT 1`,
      [account.accountId, account.walletAddress]
    );
    if (cached[0]) return cached[0];
  }

  const config = (() => { try { return holderConfig(); } catch { return null; } })();
  const walletAddress = account.walletAddress;
  if (!config || !isAddress(walletAddress) || !isAddress(config.tokenAddress)) {
    return persist(account.accountId, walletAddress, "token_misconfiguration", null, null, config);
  }
  try {
    const client = createPublicClient({
      chain: { id: config.chainId, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } },
      transport: http(config.rpcUrl),
    });
    const chain = await client.getChainId();
    if (chain !== config.chainId) return persist(account.accountId, walletAddress, "wrong_network", null, null, config);

    // Authoritative ERC-20 verification: read decimals on-chain (PRD §3.3),
    // then compare integer token units only (PRD §5.1).
    const decimals = config.tokenDecimalsOverride ?? Number(await client.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "decimals" }));
    const thresholdRaw = config.thresholdWholeTokens * (10n ** BigInt(decimals));
    const balance = await client.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] });
    const state: EligibilityState = balance >= thresholdRaw ? "eligible" : "insufficient_balance";
    return persist(account.accountId, walletAddress, state, balance, { decimals, thresholdRaw }, config);
  } catch {
    return persist(account.accountId, walletAddress, "rpc_failure", null, null, config);
  }
}

async function persist(
  accountId: string,
  wallet: string,
  state: EligibilityState,
  balance: bigint | null,
  derived: { decimals: number; thresholdRaw: bigint } | null,
  config: Config | null,
): Promise<HolderEligibilityResult> {
  const rows = await query(
    `INSERT INTO holder_eligibility (account_id, wallet_address, state, chain_id, token_address, balance_raw, token_decimals, threshold_raw, verified_at)
     VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, now()) RETURNING *`,
    [accountId, wallet, state, config?.chainId ?? null, config?.tokenAddress ?? null, balance?.toString() ?? null, derived?.decimals ?? null, derived?.thresholdRaw?.toString() ?? null]
  );
  return rows[0] as HolderEligibilityResult;
} 
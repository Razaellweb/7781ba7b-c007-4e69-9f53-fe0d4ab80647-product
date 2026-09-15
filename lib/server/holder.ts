import { createPublicClient, http, isAddress, erc20Abi } from "viem";
import { holderConfig } from "./config";
import { query } from "./db";
import type { AuthenticatedAccount } from "./auth";

export type EligibilityState = "eligible" | "insufficient_balance" | "wrong_wallet" | "rpc_failure" | "token_misconfiguration";
export async function verifyHolder(account: AuthenticatedAccount, walletAddress = account.walletAddress) {
  const config = (() => { try { return holderConfig(); } catch { return null; } })();
  if (!config || !isAddress(walletAddress) || walletAddress.toLowerCase() !== account.walletAddress.toLowerCase()) return persist(account.accountId, walletAddress, "token_misconfiguration", null, config);
  try {
    const client = createPublicClient({ chain: { id: config.chainId, name: "Robinhood Chain", nativeCurrency: { name: "Robinhood", symbol: "RBN", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } }, transport: http(config.rpcUrl) });
    const balance = await client.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] });
    const state: EligibilityState = balance >= BigInt(config.thresholdRaw) ? "eligible" : "insufficient_balance";
    return persist(account.accountId, walletAddress, state, balance, config);
  } catch { return persist(account.accountId, walletAddress, "rpc_failure", null, config); }
}
async function persist(accountId: string, wallet: string, state: EligibilityState, balance: bigint | null, config: ReturnType<typeof holderConfig> | null) {
  const rows = await query(`INSERT INTO holder_eligibility (account_id, wallet_address, state, chain_id, token_address, balance_raw, token_decimals, threshold_raw, verified_at) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, now()) RETURNING *`, [accountId, wallet, state, config?.chainId ?? null, config?.tokenAddress ?? null, balance?.toString() ?? null, config?.tokenDecimals ?? null, config?.thresholdRaw ?? null]);
  return rows[0];
}

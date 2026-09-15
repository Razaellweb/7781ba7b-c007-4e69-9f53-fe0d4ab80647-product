import { PrivyClient } from "@privy-io/server-auth";
import { privyConfig } from "./config";
import { transaction } from "./db";

export type AuthenticatedAccount = { accountId: string; privyUserId: string; walletAddress: `0x${string}` };
export class AuthenticationError extends Error { readonly code = "UNAUTHORIZED"; }
let privy: PrivyClient | undefined;
function client() { if (!privy) { const c = privyConfig(); privy = new PrivyClient(c.appId, c.appSecret); } return privy; }
type VerifiedUser = { id: string; linkedAccounts?: Array<{ type: string; chainType?: string; address?: string }> };

export async function authenticatePrivyRequest(authorization: string | null): Promise<AuthenticatedAccount> {
  if (!authorization?.startsWith("Bearer ")) throw new AuthenticationError("Authentication required");
  let user: VerifiedUser;
  try {
    const claims = await client().verifyAuthToken(authorization.slice(7));
    user = await client().getUser(claims.userId) as VerifiedUser;
  } catch { throw new AuthenticationError("Invalid or expired authentication session"); }
  const wallet = (user.linkedAccounts ?? []).find(a => a.type === "wallet" && a.chainType === "ethereum" && /^0x[a-fA-F0-9]{40}$/.test(a.address ?? ""));
  const walletAddress = wallet?.address;
  const walletCount = (user.linkedAccounts ?? []).filter(a => a.type === "wallet" && a.chainType === "ethereum" && /^0x[a-fA-F0-9]{40}$/.test(a.address ?? "")).length;
  if (walletCount !== 1 || !walletAddress) throw new AuthenticationError("A single verified EVM wallet is required");
  return transaction(async db => {
    const account = await db.query<{ id: string }>(`INSERT INTO user_accounts (privy_user_id) VALUES ($1) ON CONFLICT (privy_user_id) DO UPDATE SET updated_at = now() RETURNING id`, [user.id]);
    const accountId = account.rows[0].id;
    await db.query(`UPDATE wallets SET is_canonical = false WHERE account_id = $1`, [accountId]);
    await db.query(`INSERT INTO wallets (account_id, address, is_canonical) VALUES ($1, lower($2), true) ON CONFLICT (account_id, address) DO UPDATE SET is_canonical = true, updated_at = now()`, [accountId, walletAddress]);
    return { accountId, privyUserId: user.id, walletAddress: walletAddress.toLowerCase() as `0x${string}` };
  });
}

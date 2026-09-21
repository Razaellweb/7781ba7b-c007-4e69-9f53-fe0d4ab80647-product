import { PrivyClient } from "@privy-io/server-auth";
import { privyConfig } from "./config";
import { transaction, query } from "./db";
import { authenticateApiKey, ApiKeyError } from "./api-keys";
export type AuthenticatedAccount = { accountId: string; privyUserId: string; walletAddress: `0x${string}`; apiKeyId?: string; scopes?: string[]; rateLimitPerMinute?: number };
export class AuthenticationError extends Error { readonly code: string; constructor(message: string, code = "UNAUTHORIZED") { super(message); this.code = code; } }
let privy: PrivyClient | undefined;
function client() { if (!privy) { const c = privyConfig(); privy = new PrivyClient(c.appId, c.appSecret); } return privy; }
type LinkedWallet = { type: string; chainType?: string; address?: string; walletClientType?: string; connectorType?: string };
type VerifiedUser = { id: string; linkedAccounts?: LinkedWallet[] };
const isEvmWallet = (a: LinkedWallet) => a.type === "wallet" && a.chainType === "ethereum" && /^0x[a-fA-F0-9]{40}$/.test(a.address ?? "");
function selectWallet(wallets: LinkedWallet[], preferred?: string | null): LinkedWallet | undefined { if (!wallets.length) return undefined; if (preferred) { const match = wallets.find(w => (w.address ?? "").toLowerCase() === preferred.toLowerCase()); if (match) return match; } return wallets.find(w => w.walletClientType && w.walletClientType !== "privy") ?? wallets[0]; }
export async function authenticatePrivyRequest(authorization: string | null, preferredWallet?: string | null): Promise<AuthenticatedAccount> {
  if (!authorization?.startsWith("Bearer ")) throw new AuthenticationError("Authentication required"); let user: VerifiedUser;
  try { const claims = await client().verifyAuthToken(authorization.slice(7)); user = await client().getUser(claims.userId) as VerifiedUser; } catch { throw new AuthenticationError("Invalid or expired authentication session"); }
  const evmWallets = (user.linkedAccounts ?? []).filter(isEvmWallet); const wallet = selectWallet(evmWallets, preferredWallet); if (!wallet?.address) throw new AuthenticationError("A verified EVM wallet is required"); const walletAddress = wallet.address.toLowerCase() as `0x${string}`;
  return transaction(async db => { const account = await db.query<{ id: string }>(`INSERT INTO user_accounts (privy_user_id) VALUES ($1) ON CONFLICT (privy_user_id) DO UPDATE SET updated_at = now() RETURNING id`, [user.id]); const accountId = account.rows[0].id; await db.query(`UPDATE wallets SET is_canonical = false WHERE account_id = $1`, [accountId]); await db.query(`INSERT INTO wallets (account_id, address, is_canonical) VALUES ($1, $2, true) ON CONFLICT (account_id, address) DO UPDATE SET is_canonical = true, updated_at = now()`, [accountId, walletAddress]); return { accountId, privyUserId: user.id, walletAddress }; });
}
export async function authenticateRequest(authorization: string | null, requiredScope?: string): Promise<AuthenticatedAccount> { if (authorization?.startsWith("Bearer ow_live_")) { try { const key = await authenticateApiKey(authorization, requiredScope); const account = await queryAccount(key.accountId); return { ...account, apiKeyId: key.apiKeyId, scopes: key.scopes, rateLimitPerMinute: key.rateLimitPerMinute }; } catch (error) { if (error instanceof ApiKeyError) throw new AuthenticationError(error.message, error.code); throw error; } } return authenticatePrivyRequest(authorization); }
async function queryAccount(accountId: string): Promise<AuthenticatedAccount> { const rows = await query<{ privy_user_id: string; address: `0x${string}` }>(`SELECT a.privy_user_id, w.address FROM user_accounts a LEFT JOIN wallets w ON w.account_id=a.id AND w.is_canonical=true WHERE a.id=$1 LIMIT 1`, [accountId]); if (!rows[0]?.address) throw new AuthenticationError("A verified EVM wallet is required"); return { accountId, privyUserId: rows[0].privy_user_id, walletAddress: rows[0].address }; }

import { PrivyClient } from "@privy-io/server-auth";
import { privyConfig } from "./config";
import { transaction } from "./db";

export type AuthenticatedAccount = { accountId: string; privyUserId: string; walletAddress: `0x${string}` };
export class AuthenticationError extends Error { readonly code = "UNAUTHORIZED"; }
let privy: PrivyClient | undefined;
function client() { if (!privy) { const c = privyConfig(); privy = new PrivyClient(c.appId, c.appSecret); } return privy; }
type LinkedWallet = { type: string; chainType?: string; address?: string; walletClientType?: string; connectorType?: string };
type VerifiedUser = { id: string; linkedAccounts?: LinkedWallet[] };

const isEvmWallet = (a: LinkedWallet) => a.type === "wallet" && a.chainType === "ethereum" && /^0x[a-fA-F0-9]{40}$/.test(a.address ?? "");

// Selects the account's canonical eligibility wallet. When a user has both an
// embedded Privy wallet and an external wallet (e.g. MetaMask), the external
// wallet is the one that holds OPENWEIGHT, so it is preferred. Balances are
// never aggregated (PRD §4.4): exactly one canonical wallet is chosen.
function selectWallet(wallets: LinkedWallet[], preferred?: string | null): LinkedWallet | undefined {
  if (!wallets.length) return undefined;
  if (preferred) {
    const match = wallets.find(w => (w.address ?? "").toLowerCase() === preferred.toLowerCase());
    if (match) return match;
  }
  return wallets.find(w => w.walletClientType && w.walletClientType !== "privy") ?? wallets[0];
}

export async function authenticatePrivyRequest(authorization: string | null, preferredWallet?: string | null): Promise<AuthenticatedAccount> {
  if (!authorization?.startsWith("Bearer ")) throw new AuthenticationError("Authentication required");
  let user: VerifiedUser;
  try {
    const claims = await client().verifyAuthToken(authorization.slice(7));
    user = await client().getUser(claims.userId) as VerifiedUser;
  } catch (e) {
    console.error("[auth] token verification failed:", e instanceof Error ? e.message : e);
    throw new AuthenticationError("Invalid or expired authentication session");
  }

  const evmWallets = (user.linkedAccounts ?? []).filter(isEvmWallet);
  console.error("[auth] evm wallets:", evmWallets.map(w => ({ client: w.walletClientType, connector: w.connectorType, addr: (w.address ?? "").slice(0, 6) })));
  const wallet = selectWallet(evmWallets, preferredWallet);
  if (!wallet?.address) throw new AuthenticationError("A verified EVM wallet is required");
  const walletAddress = wallet.address;

  return transaction(async db => {
    const account = await db.query<{ id: string }>(`INSERT INTO user_accounts (privy_user_id) VALUES ($1) ON CONFLICT (privy_user_id) DO UPDATE SET updated_at = now() RETURNING id`, [user.id]);
    const accountId = account.rows[0].id;
    await db.query(`UPDATE wallets SET is_canonical = false WHERE account_id = $1`, [accountId]);
    await db.query(`INSERT INTO wallets (account_id, address, is_canonical) VALUES ($1, lower($2), true) ON CONFLICT (account_id, address) DO UPDATE SET is_canonical = true, updated_at = now()`, [accountId, walletAddress]);
    return { accountId, privyUserId: user.id, walletAddress: walletAddress.toLowerCase() as `0x${string}` };
  });
}

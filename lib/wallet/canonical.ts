// Canonical EVM wallet selection, shared by the Overview Fund flow.
//
// This mirrors the server rule in lib/server/auth.ts (selectWallet) exactly, so
// the wallet the browser resolves is the same wallet the backend records in
// `wallets.is_canonical`:
//   * only wallet accounts on the ethereum chain with a 0x address qualify;
//   * a linked external wallet outranks an embedded Privy wallet;
//   * otherwise the first linked EVM wallet wins.
//
// Nothing here creates, signs, or transacts. It only selects from wallets Privy
// has already verified for the signed-in identity.

export type CanonicalWalletCandidate = {
  type?: unknown;
  chainType?: unknown;
  address?: unknown;
  walletClientType?: unknown;
};

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** True for a 0x-prefixed 20-byte EVM address in either case. */
export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && EVM_ADDRESS.test(value);
}

/** True when the account is a linked ethereum wallet with a usable address. */
export function isCanonicalEvmWallet(account: CanonicalWalletCandidate | null | undefined): boolean {
  if (!account) return false;
  return account.type === "wallet" && account.chainType === "ethereum" && isEvmAddress(account.address);
}

/** Every linked wallet eligible to be canonical. Order is Privy's order. */
export function linkedEvmWallets(
  accounts: readonly CanonicalWalletCandidate[] | null | undefined,
): CanonicalWalletCandidate[] {
  return (accounts ?? []).filter(isCanonicalEvmWallet);
}

/**
 * Selects the canonical EVM wallet, optionally preferring an address the caller
 * already knows. A preferred address that is not linked is ignored rather than
 * trusted, exactly like the backend.
 */
export function selectCanonicalWallet(
  accounts: readonly CanonicalWalletCandidate[] | null | undefined,
  preferred?: string | null,
): CanonicalWalletCandidate | null {
  const wallets = linkedEvmWallets(accounts);
  if (wallets.length === 0) return null;

  if (isEvmAddress(preferred)) {
    const wanted = preferred.toLowerCase();
    const match = wallets.find((wallet) => String(wallet.address).toLowerCase() === wanted);
    if (match) return match;
  }

  const external = wallets.find((wallet) => typeof wallet.walletClientType === "string" && wallet.walletClientType !== "privy");
  return external ?? wallets[0];
}

/** Lowercased canonical address, or null when the identity has no EVM wallet. */
export function canonicalAddress(
  accounts: readonly CanonicalWalletCandidate[] | null | undefined,
  preferred?: string | null,
): string | null {
  const wallet = selectCanonicalWallet(accounts, preferred);
  const address = wallet?.address;
  return isEvmAddress(address) ? address.toLowerCase() : null;
}

/** `0x1234…abcd` — display only; the full address is always available. */
export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (!isEvmAddress(address) || address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}\u2026${address.slice(-tail)}`;
}

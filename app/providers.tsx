"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { useEffect, useState } from "react";

// Robinhood Chain (EVM). Testnet by default; mainnet when configured.
const chainId = Number(process.env.NEXT_PUBLIC_ROBINHOOD_CHAIN_ID ?? "46630");
const isMainnet = chainId === 4663;
const robinhoodChain = defineChain({
  id: chainId,
  name: isMainnet ? "Robinhood Chain" : "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [isMainnet ? "https://rpc.mainnet.chain.robinhood.com" : "https://rpc.testnet.chain.robinhood.com"] } },
});

export default function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!mounted || !appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["wallet", "email"],
        defaultChain: robinhoodChain,
        supportedChains: [robinhoodChain],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

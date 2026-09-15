"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { useEffect, useState } from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!mounted || !appId) return <>{children}</>;
  return <PrivyProvider appId={appId}>{children}</PrivyProvider>;
}

"use client";

import type { ReactNode } from "react";

/**
 * Compatibility wrapper for legacy callers.
 *
 * Dashboard navigation is owned by the authenticated dashboard workspace in
 * app/dashboard/page.tsx. Keeping navigation here would create a second,
 * conflicting sidebar, so this shell intentionally provides layout only.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

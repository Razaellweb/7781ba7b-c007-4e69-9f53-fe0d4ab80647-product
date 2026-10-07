"use client";

import Link from "next/link";

type WorkspaceSection = "overview" | "playground" | "api-keys";

type WorkspaceSidebarProps = {
  active: WorkspaceSection;
  footerLabel: string;
  footerDetail: string;
  footerHref?: string;
  footerActionLabel?: string;
  onSignOut?: () => void;
};

const navigation: { section: WorkspaceSection; href: string; symbol: string; label: string }[] = [
  { section: "overview", href: "/dashboard", symbol: "◉", label: "Overview" },
  { section: "playground", href: "/chat", symbol: "◌", label: "Playground" },
  { section: "api-keys", href: "/settings", symbol: "◇", label: "API Keys" },
];

export default function WorkspaceSidebar({
  active,
  footerLabel,
  footerDetail,
  footerHref,
  footerActionLabel,
  onSignOut,
}: WorkspaceSidebarProps) {
  return (
    <aside className="compute-sidebar">
      <Link className="compute-brand" href="/dashboard">
        <span className="mark">✦</span>
        <span>OPENWEIGHT</span>
      </Link>
      <div className="compute-eyebrow">OPEN-WEIGHT FRONTIER</div>
      <nav aria-label="Workspace navigation">
        {navigation.map((item) => (
          <Link
            key={item.section}
            className={active === item.section ? "active" : undefined}
            href={item.href}
            aria-current={active === item.section ? "page" : undefined}
          >
            {item.symbol} <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className="compute-sidebar-foot">
        <div>{footerLabel}</div>
        <small>{footerDetail}</small>
        {onSignOut ? (
          <button type="button" onClick={onSignOut}>Sign out →</button>
        ) : footerHref && footerActionLabel ? (
          <Link className="playground-signout-link" href={footerHref}>{footerActionLabel}</Link>
        ) : null}
      </div>
    </aside>
  );
}

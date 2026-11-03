"use client";

import type { ReactNode } from "react";
import Link from "next/link";

const brandIcon = "/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png";

export type WorkspaceSection = "overview" | "playground" | "models" | "usage" | "api-keys" | "gpu";

type NavItem = { section: WorkspaceSection; label: string; href: string; icon: ReactNode };

/* 16px hairline icons. Inline so the shell has no icon-font or image dependency. */
const icons = {
  home: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20H4z" /><path d="M9.5 20v-5.5h5V20" /></svg>,
  play: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5 18.5 12 8 18.5z" /></svg>,
  layers: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3.5 8.5 12 13l8.5-4.5z" /><path d="M3.5 14.5 12 19l8.5-4.5" /></svg>,
  bars: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V11" /><path d="M12 19V5" /><path d="M19 19v-5" /></svg>,
  key: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="9" r="4" /><path d="M12 12l7 7" /><path d="M16.5 14.5 19 12" /></svg>,
  gpu: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M9 9h6v6H9z" /></svg>,
};

/** Primary workspace navigation, mirroring the dashboard reference. */
const WORKSPACE_ITEMS: ReadonlyArray<NavItem> = [
  { section: "overview", label: "Overview", href: "/dashboard", icon: icons.home },
  { section: "playground", label: "Playground", href: "/playground", icon: icons.play },
  { section: "models", label: "Models", href: "/models", icon: icons.layers },
  { section: "usage", label: "Usage", href: "/compute", icon: icons.bars },
];

/** Developer surfaces stay reachable without crowding the primary nav. */
const DEVELOPER_ITEMS: ReadonlyArray<NavItem> = [
  { section: "api-keys", label: "API Keys", href: "/settings", icon: icons.key },
  { section: "gpu", label: "GPU", href: "/gpu", icon: icons.gpu },
];

type WorkspaceShellProps = {
  children: ReactNode;
  /** Which workspace route is rendering, used for the active navigation state. */
  section: WorkspaceSection;
  /** Extra classes for the outer `compute-dashboard` element (route theming only). */
  dashboardClassName?: string;
  /** Extra classes for the `compute-main` content column. */
  mainClassName?: string;
  /** Optional id for the `compute-main` content column (e.g. the Overview anchor). */
  mainId?: string;
  /** Sidebar footer contents; falls back to the generic workspace footer. */
  asideFooter?: ReactNode;
  /** Child-of-shell overlays such as modals, which live outside the content column. */
  overlays?: ReactNode;
};

function DefaultAsideFooter() {
  return (
    <>
      <div className="compute-sidebar-state">
        <span className="compute-dot" /> WORKSPACE
      </div>
      <small className="compute-sidebar-note">Open-weight model access</small>
    </>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link href={item.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
      <span className="compute-nav-icon" aria-hidden="true">{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  );
}

export default function WorkspaceShell({
  children,
  section,
  dashboardClassName,
  mainClassName,
  mainId,
  asideFooter,
  overlays,
}: WorkspaceShellProps) {
  return (
    <main className={`compute-dashboard${dashboardClassName ? ` ${dashboardClassName}` : ""}`}>
      <aside className="compute-sidebar">
        <Link className="compute-brand" href="/">
          <span className="mark">
            <img src={brandIcon} alt="favicon" />
          </span>
          <span>OPENWEIGHT</span>
        </Link>
        <div className="compute-eyebrow compute-nav-label">WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          {WORKSPACE_ITEMS.map((item) => (
            <NavLink key={item.section} item={item} active={item.section === section} />
          ))}
        </nav>
        <div className="compute-eyebrow compute-nav-label compute-nav-label-secondary">DEVELOPER</div>
        <nav className="compute-nav-secondary" aria-label="Developer navigation">
          {DEVELOPER_ITEMS.map((item) => (
            <NavLink key={item.section} item={item} active={item.section === section} />
          ))}
        </nav>
        <div className="compute-sidebar-foot">
          {asideFooter ?? <DefaultAsideFooter />}
          <div className="compute-sidebar-version">
            <span>Openweight v1.0</span>
            <span className="compute-mainnet"><i aria-hidden="true" />Mainnet</span>
          </div>
        </div>
      </aside>
      <section className={`compute-main${mainClassName ? ` ${mainClassName}` : ""}`} id={mainId}>
        {children}
      </section>
      {overlays}
    </main>
  );
}

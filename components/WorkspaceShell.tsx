"use client";

import type { ReactNode } from "react";
import Link from "next/link";

const brandIcon = "/assets/uploads/favicon-46bce9c075ad43a381f3d77bd6ca099b.png";

export type WorkspaceSection = "overview" | "playground" | "gpu" | "api-keys";

type NavItem = { section: WorkspaceSection; label: string; href: string; glyph: string };

/** The one and only workspace navigation. Every dashboard route renders this. */
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { section: "overview", label: "Overview", href: "/dashboard", glyph: "\u25c9" },
  { section: "playground", label: "Playground", href: "/playground", glyph: "\u25cc" },
  { section: "api-keys", label: "API Keys", href: "/settings", glyph: "\u25c7" },
  // GPU offers live on their own authenticated workspace route; the chip glyph
  // matches the geometric mark used by the other workspace sections.
  { section: "gpu", label: "GPU", href: "/gpu", glyph: "\u25a3" },
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
      <div>
        <span className="compute-dot" /> WORKSPACE
      </div>
      <small>Curated model access</small>
    </>
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
        <div className="compute-eyebrow">OPEN-WEIGHT FRONTIER</div>
        <nav aria-label="Workspace navigation">
          {NAV_ITEMS.map((item) => {
            const active = item.section === section;
            return (
              <Link
                key={item.section}
                href={item.href}
                className={active ? "active" : undefined}
                aria-current={active ? "page" : undefined}
              >
                {item.glyph} <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="compute-sidebar-foot">{asideFooter ?? <DefaultAsideFooter />}</div>
      </aside>
      <section className={`compute-main${mainClassName ? ` ${mainClassName}` : ""}`} id={mainId}>
        {children}
      </section>
      {overlays}
    </main>
  );
}

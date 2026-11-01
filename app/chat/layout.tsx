import WorkspaceShell from "../../components/WorkspaceShell";
import "../dashboard/dashboard.css";
import "../dashboard-dark.css";
import "./playground-shell.css";
import "./playground-cleanup.css";

/**
 * Chat and Playground share this layout (see app/playground/layout.tsx).
 * The sidebar itself is owned by the shared workspace shell, so no route can
 * drift onto a second navigation surface.
 */
export default function PlaygroundLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <WorkspaceShell section="playground" dashboardClassName="playground-dashboard" mainClassName="playground-dashboard-main">
      {children}
    </WorkspaceShell>
  );
}

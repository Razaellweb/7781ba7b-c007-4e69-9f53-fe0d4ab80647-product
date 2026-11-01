import type { Metadata } from "next";
import WorkspaceShell from "../../components/WorkspaceShell";
import "../dashboard/dashboard.css";
import "../dashboard-dark.css";
import "./gpu.css";

export const metadata: Metadata = {
  title: "GPU offers · Openweight",
  description: "Browse live GPU marketplace availability: model, VRAM, hourly price, reliability, and location.",
};

/**
 * The GPU page is a workspace route, so it renders inside the same shared shell
 * (and therefore the same navigation, spacing, and type scale) as Overview and
 * Playground. It is a scrolling page rather than a fixed-height console.
 */
export default function GpuLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <WorkspaceShell section="gpu" dashboardClassName="gpu-dashboard" mainClassName="gpu-dashboard-main">
      {children}
    </WorkspaceShell>
  );
}

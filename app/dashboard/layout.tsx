import WorkspaceSidebar from "../../components/WorkspaceSidebar";
import "./dashboard-route.css";

export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="dashboard-route-shell">
      <WorkspaceSidebar active="overview" footerLabel="WORKSPACE" footerDetail="Curated model access" />
      <div className="dashboard-route-content">{children}</div>
    </div>
  );
}

import WorkspaceSidebar from "../../components/WorkspaceSidebar";
import "../dashboard/dashboard.css";
import "../dashboard-dark.css";
import "./playground-shell.css";

export default function PlaygroundLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="compute-dashboard playground-dashboard"><WorkspaceSidebar active="playground" footerLabel="WORKSPACE" footerDetail="Curated model access" footerHref="/dashboard" footerActionLabel="Back to overview ↗" /><section className="compute-main playground-dashboard-main">{children}</section></div>;
}

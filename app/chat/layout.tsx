import Link from "next/link";
import "../dashboard/dashboard.css";
import "../dashboard-dark.css";
import "./playground-shell.css";

export default function PlaygroundLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="compute-dashboard playground-dashboard"><aside className="compute-sidebar"><Link className="compute-brand" href="/dashboard"><span className="mark">✦</span><span>OPENWEIGHT</span></Link><div className="compute-eyebrow">OPEN-WEIGHT FRONTIER</div><nav aria-label="Workspace navigation"><Link href="/dashboard">◉ <span>Overview</span></Link><Link className="active" href="/chat" aria-current="page">◌ <span>Playground</span></Link><Link href="/settings">◇ <span>API Keys</span></Link></nav><div className="compute-sidebar-foot"><div><span className="compute-dot" /> WORKSPACE</div><small>Curated model access</small><Link className="playground-signout-link" href="/dashboard">Back to overview ↗</Link></div></aside><section className="compute-main playground-dashboard-main">{children}</section></div>;
}

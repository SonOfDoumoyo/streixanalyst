import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page page-bg" style={{ display: "grid", placeItems: "center", minHeight: "100vh", textAlign: "center", padding: 20 }}>
      <div>
        <div className="h-display gradient-text" style={{ fontSize: "5rem" }}>404</div>
        <p className="muted">This page took a stop loss. Let's get you back to the charts.</p>
        <Link className="btn primary" href="/terminal">Open the terminal</Link>
      </div>
    </div>
  );
}

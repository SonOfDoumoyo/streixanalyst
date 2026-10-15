"use client";

export default function Error({ error, reset }) {
  return (
    <div className="page page-bg" style={{ display: "grid", placeItems: "center", minHeight: "100vh", textAlign: "center", padding: 20 }}>
      <div className="card" style={{ maxWidth: 460 }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
        <p className="muted">{(error && error.message) || "An unexpected error happened."}</p>
        <button className="btn primary" onClick={() => reset()}>Try again</button>
      </div>
    </div>
  );
}

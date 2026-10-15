"use client";
import Link from "next/link";
import Brand from "@/components/Brand";

/** Shared layout for the Terms, Privacy and Contact pages. */
export default function LegalPage({ title, updated, children }) {
  return (
    <div className="page page-bg">
      <nav className="nav">
        <Brand />
        <div className="grow" />
        <Link className="btn" href="/pricing">Pricing</Link>
        <Link className="btn" href="/contact">Contact</Link>
      </nav>
      <main className="legal">
        <div className="eyebrow">{updated ? `Last updated ${updated}` : "StreixAnalyst"}</div>
        <h1 className="h-display" style={{ fontSize: "clamp(1.8rem, 4vw, 2.6rem)", margin: "10px 0 6px" }}>{title}</h1>
        {children}
        <p className="faint" style={{ marginTop: 40 }}>
          StreixAnalyst is a product of Streixcorp. Questions? <Link href="/contact">Contact us</Link>.
        </p>
      </main>
    </div>
  );
}

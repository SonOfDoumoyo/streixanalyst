"use client";
// The page Paystack returns to after a donation. It asks our server, which asks Paystack, before it says thank you.
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import SubNav from "@/components/SubNav";
import { Spinner } from "@/components/ui";
import { get } from "@/lib/api";
import { fmtNaira } from "@/lib/format";

function ThanksInner() {
  const params = useSearchParams();
  const ref = params.get("reference") || params.get("trxref") || "";
  const [res, setRes] = useState(null);

  useEffect(() => {
    if (!ref) {
      setRes({ ok: false, status: "unknown", message: "No donation reference was given." });
      return undefined;
    }
    let alive = true;
    let tries = 0;
    const check = () => {
      get(`/donate/verify/${encodeURIComponent(ref)}`)
        .then((d) => {
          if (!alive) return;
          setRes(d);
          // Paystack can take a moment to confirm, so look again a few times while it is still pending.
          if (!d.ok && d.status === "pending" && tries < 4) {
            tries += 1;
            setTimeout(check, 3000);
          }
        })
        .catch(() => alive && setRes({ ok: false, status: "error", message: "We could not check the payment just now." }));
    };
    check();
    return () => {
      alive = false;
    };
  }, [ref]);

  return (
    <main className="container" style={{ paddingTop: 40, paddingBottom: 60, maxWidth: 560 }}>
      {!res ? (
        <div className="card row" style={{ padding: 20, gap: 12 }}><Spinner /> Checking your donation</div>
      ) : res.ok ? (
        <div className="card stack" style={{ padding: 22, gap: 12 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)" }}>Thank you</h1>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            Your gift of {fmtNaira(res.amount)} has arrived. It helps keep StreixAnalyst running. A receipt is on its way from Paystack.
          </p>
          <div className="row" style={{ gap: 8 }}><Link className="btn primary" href="/terminal">Back to the terminal</Link></div>
        </div>
      ) : (
        <div className="card stack" style={{ padding: 22, gap: 12 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)" }}>{res.status === "pending" ? "Still confirming" : "Not confirmed"}</h1>
          <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
            {res.status === "pending"
              ? "Paystack has not confirmed this payment yet. If money left your account, it will be confirmed shortly. Refresh this page in a minute."
              : (res.message || "This donation was not completed. You have not been charged a donation we know of.")}
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Link className="btn" href="/donate">Try again</Link>
            <Link className="btn ghost" href="/support">Contact support</Link>
          </div>
        </div>
      )}
    </main>
  );
}

export default function DonateThanksPage() {
  return (
    <div className="page page-bg">
      <SubNav />
      <Suspense fallback={<main className="container" style={{ paddingTop: 40 }}><Spinner /></main>}>
        <ThanksInner />
      </Suspense>
    </div>
  );
}

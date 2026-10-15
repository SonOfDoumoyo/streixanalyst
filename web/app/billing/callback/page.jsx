"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthShell } from "@/components/AuthForms";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { RequireAuth } from "@/components/ui";
import { get } from "@/lib/api";
import { fmtNaira } from "@/lib/format";

function Inner() {
  const sp = useSearchParams();
  const { setUser } = useAuth();
  const ref = sp.get("reference") || sp.get("trxref") || "";
  const [state, setState] = useState({ phase: "checking" });
  useEffect(() => {
    if (!ref) {
      setState({ phase: "error", message: "No payment reference in the link." });
      return undefined;
    }
    let tries = 0;
    let alive = true;
    const check = async () => {
      tries += 1;
      try {
        const d = await get(`/billing/verify?reference=${encodeURIComponent(ref)}`);
        if (!alive) return;
        if (d.user) setUser(d.user);
        if (d.payment.status === "success") return setState({ phase: "ok", payment: d.payment });
        if (["failed", "abandoned", "cancelled", "rejected"].includes(d.payment.status)) return setState({ phase: "failed", payment: d.payment });
        if (d.payment.status === "review") return setState({ phase: "review", payment: d.payment });
        if (tries < 8) setTimeout(check, 2500);
        else setState({ phase: "pending", payment: d.payment });
      } catch (e) {
        if (alive) setState({ phase: "error", message: e.message });
      }
    };
    check();
    return () => { alive = false; };
  }, [ref, setUser]);
  const p = state.payment;
  return (
    <div className="auth-card card" style={{ textAlign: "center" }}>
      {state.phase === "checking" ? (
        <>
          <span className="spinner dark" style={{ width: 34, height: 34, margin: "8px auto 14px" }} />
          <h1>Confirming your payment…</h1>
          <p className="muted">We're checking with the payment provider. This takes a few seconds.</p>
        </>
      ) : state.phase === "ok" ? (
        <>
          <div style={{ width: 64, height: 64, borderRadius: 20, margin: "4px auto 14px", display: "grid", placeItems: "center", background: "rgba(38,166,154,.16)", color: "#4fd1c1" }}><Icon name="check" size={34} /></div>
          <h1>You're all set!</h1>
          <p className="muted">{fmtNaira(p.paid || p.amount)} received and verified. {p.plan === "org" ? "Your organization" : "Pro"} is active for {p.months} month{p.months > 1 ? "s" : ""}.</p>
          <Link className="btn primary lg block" href="/terminal"><Icon name="zap" size={18} /> Back to the charts</Link>
        </>
      ) : state.phase === "review" ? (
        <>
          <h1>We're double-checking this one</h1>
          <p className="muted">The payment arrived but something didn't match (for example the amount). Our team will sort it out — usually within a few hours. Reference <b>{p.reference}</b>.</p>
          <Link className="btn block" href="/billing">Go to billing</Link>
        </>
      ) : state.phase === "pending" ? (
        <>
          <h1>Still waiting for confirmation</h1>
          <p className="muted">Some banks take a little longer. Your plan unlocks automatically once the payment is confirmed. Reference <b>{p.reference}</b>.</p>
          <Link className="btn block" href="/billing">Go to billing</Link>
        </>
      ) : state.phase === "failed" ? (
        <>
          <h1>The payment didn't go through</h1>
          <p className="muted">Nothing was unlocked{p ? ` (status: ${p.status})` : ""}. You can try again or choose another way to pay.</p>
          <Link className="btn primary block" href="/billing">Try again</Link>
        </>
      ) : (
        <>
          <h1>Something went wrong</h1>
          <p className="muted">{state.message}</p>
          <Link className="btn block" href="/billing">Go to billing</Link>
        </>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <RequireAuth>
      <AuthShell>
        <Suspense fallback={null}><Inner /></Suspense>
      </AuthShell>
    </RequireAuth>
  );
}

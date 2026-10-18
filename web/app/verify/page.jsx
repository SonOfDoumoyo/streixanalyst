"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Icon from "@/components/Icons";
import { AuthShell } from "@/components/AuthForms";
import { useAuth } from "@/components/Providers";
import { post } from "@/lib/api";

function VerifyCard() {
  const params = useSearchParams();
  const { refresh } = useAuth();
  const token = params.get("token") || "";
  const [state, setState] = useState(token ? "working" : "missing");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    post("/auth/verify-email", { token })
      .then(async () => {
        await refresh();
        if (alive) setState("done");
      })
      .catch((e) => {
        if (alive) { setMessage(e.message); setState("error"); }
      });
    return () => { alive = false; };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card stack" style={{ padding: 28, maxWidth: 440, width: "100%", margin: "40px auto", textAlign: "center", alignItems: "center" }}>
      {state === "working" ? (
        <>
          <span className="spinner" />
          <h2 style={{ margin: 0 }}>Confirming your email…</h2>
        </>
      ) : null}
      {state === "done" ? (
        <>
          <Icon name="check" size={36} style={{ color: "var(--up, #2fd3a6)" }} />
          <h2 style={{ margin: 0 }}>Email confirmed</h2>
          <p className="muted" style={{ margin: 0 }}>Thanks. Your account is verified and you can pay for a plan now.</p>
          <Link className="btn primary" href="/terminal">Open StreixAnalyst</Link>
        </>
      ) : null}
      {state === "error" ? (
        <>
          <h2 style={{ margin: 0 }}>This link didn't work</h2>
          <p className="muted" style={{ margin: 0 }}>{message}</p>
          <Link className="btn" href="/login">Sign in and ask for a new link</Link>
        </>
      ) : null}
      {state === "missing" ? (
        <>
          <h2 style={{ margin: 0 }}>Open the link from your email</h2>
          <p className="muted" style={{ margin: 0 }}>The confirmation link carries a code. Use the button in the email, or sign in and ask for a new link.</p>
          <Link className="btn" href="/login">Sign in</Link>
        </>
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <VerifyCard />
      </Suspense>
    </AuthShell>
  );
}

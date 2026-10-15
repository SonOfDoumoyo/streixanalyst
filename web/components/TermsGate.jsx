"use client";
// The Terms gate. When the Terms change, or an account was made before they existed, the app waits for one tick.
// The server decides (user.terms_ok, read from /auth/me). This component only shows the form and posts the answer.
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { get, post } from "@/lib/api";

// The legal pages stay open, so a person can read the Terms before they tick.
const OPEN_PATHS = ["/terms", "/privacy", "/contact"];

export default function TermsGate() {
  const { user, refresh, logout, toast } = useAuth();
  const path = usePathname() || "/";
  const [agree, setAgree] = useState(false);
  const [learn, setLearn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(null);
  const needed = !!user && user.terms_ok === false && !OPEN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  useEffect(() => {
    if (!needed) return;
    setLearn(!!user.learn_consent);
    get("/site").then((s) => setVersion(s.terms_version)).catch(() => {});
  }, [needed, user]);

  if (!needed) return null;

  const accept = async () => {
    if (!agree || busy) return;
    setBusy(true);
    try {
      await post("/auth/accept-terms", { accept_terms: true, learn });
      await refresh();
      toast("Thank you. You are all set.", "success");
    } catch (e) {
      toast(e.message || "That did not save. Please try again.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="terms-gate" role="dialog" aria-modal="true" aria-labelledby="terms-gate-title">
      <div className="terms-gate-card stack">
        <span className="badge brand" style={{ alignSelf: "flex-start" }}><Icon name="shield" size={14} /> Updated terms</span>
        <h2 id="terms-gate-title" style={{ margin: 0, fontFamily: "var(--font-display)" }}>Please read and accept</h2>
        <p className="muted" style={{ margin: 0, fontSize: "0.92rem", lineHeight: 1.6 }}>
          {version ? `Our Terms of Service and Privacy Policy (version ${version}) have changed, or you have not accepted them yet.` : "Our Terms of Service and Privacy Policy have changed, or you have not accepted them yet."}
          {" "}StreixAnalyst is for analysis and education. It is not financial advice, and trading can lose you all of your money.
        </p>
        <div className="row wrap" style={{ gap: 14, fontSize: "0.9rem" }}>
          <Link href="/terms" target="_blank">Terms of Service</Link>
          <Link href="/privacy" target="_blank">Privacy Policy</Link>
        </div>
        <label className="check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          I have read and accept the Terms of Service and the Privacy Policy.
        </label>
        <label className="check">
          <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} />
          Optional: let StreixAnalyst use my charts and practice to improve the model. You can change this in Settings.
        </label>
        <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <button className="btn ghost" onClick={logout}>Sign out</button>
          <button className="btn primary" disabled={!agree || busy} onClick={accept}>{busy ? "Saving" : "Accept and continue"}</button>
        </div>
      </div>
    </div>
  );
}

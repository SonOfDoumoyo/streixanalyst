"use client";
// Donate: an optional gift in naira through Paystack. A donation never changes a plan or unlocks a feature.
import { useEffect, useState } from "react";
import Link from "next/link";
import SubNav from "@/components/SubNav";
import { useAuth } from "@/components/Providers";
import { get, post } from "@/lib/api";
import { fmtNaira } from "@/lib/format";

function DonateInner() {
  const { user, toast } = useAuth();
  const [cfg, setCfg] = useState(null);
  const [amount, setAmount] = useState(2500);
  const [custom, setCustom] = useState("");
  const [f, setF] = useState({ name: "", email: "", message: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get("/donate/config").then(setCfg).catch(() => setCfg({ enabled: false }));
  }, []);

  useEffect(() => {
    if (user) setF((x) => ({ ...x, name: x.name || user.name, email: x.email || user.email }));
  }, [user]);

  const value = custom ? Number(custom) : amount;
  const min = (cfg && cfg.min) || 500;
  const max = (cfg && cfg.max) || 5000000;
  const valid = Number.isInteger(value) && value >= min && value <= max;

  const give = async (e) => {
    e.preventDefault();
    if (!valid || busy || !cfg || !cfg.enabled) return;
    setBusy(true);
    try {
      const r = await post("/donate", { amount: value, name: f.name, email: user ? undefined : f.email, message: f.message });
      window.location.href = r.url;
    } catch (err) {
      toast(err.message || "The donation could not start. Please try again.", "error");
      setBusy(false);
    }
  };

  return (
    <div className="page page-bg">
      <SubNav />
      <main className="container" style={{ paddingTop: 24, paddingBottom: 60, maxWidth: 620 }}>
        <div className="stack" style={{ gap: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)" }}>Support StreixAnalyst</h1>
            <p className="muted" style={{ margin: "6px 0 0", lineHeight: 1.6 }}>
              A donation is a gift, not a purchase. It does not change your plan or unlock features. It helps keep the
              analysis running and the model improving. Payments run through Paystack, in naira.
            </p>
          </div>

          {cfg && !cfg.enabled ? (
            <div className="card" style={{ padding: 18 }}>
              Donations are not open yet. Thank you for wanting to give. <Link href="/support">Get in touch</Link> in the meantime.
            </div>
          ) : null}

          <form className="card stack" style={{ padding: 18 }} onSubmit={give}>
            <div className="label">Amount</div>
            <div className="row wrap" style={{ gap: 8 }}>
              {((cfg && cfg.presets) || [1000, 2500, 5000, 10000]).map((p) => (
                <button key={p} type="button" className={`chip ${!custom && amount === p ? "on" : ""}`}
                  onClick={() => { setAmount(p); setCustom(""); }} aria-pressed={!custom && amount === p}>
                  {fmtNaira(p)}
                </button>
              ))}
            </div>
            <div className="field"><label htmlFor="dn-custom">Or another amount (at least {fmtNaira(min)})</label>
              <input id="dn-custom" className="input num" type="number" inputMode="numeric" min={min} max={max} step={1}
                value={custom} placeholder={String(amount)} onChange={(e) => setCustom(e.target.value)} /></div>
            <div className="grid-2" style={{ gap: 10 }}>
              <div className="field"><label htmlFor="dn-name">Name (optional)</label>
                <input id="dn-name" className="input" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              {!user ? (
                <div className="field"><label htmlFor="dn-email">Email for your receipt</label>
                  <input id="dn-email" className="input" type="email" required value={f.email} maxLength={255} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
              ) : (
                <div className="field"><label>Receipt goes to</label><div className="input faint" style={{ display: "flex", alignItems: "center" }}>{user.email}</div></div>
              )}
            </div>
            <div className="field"><label htmlFor="dn-msg">A note (optional)</label>
              <textarea id="dn-msg" className="input" rows={2} maxLength={500} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></div>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span className="faint" style={{ fontSize: "0.8rem" }}>Paid securely on Paystack. We never see your card details.</span>
              <button className="btn primary" disabled={!valid || busy || !cfg || !cfg.enabled}>
                {busy ? "Opening Paystack" : valid ? `Donate ${fmtNaira(value)}` : "Enter an amount"}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

export default function DonatePage() {
  return <DonateInner />;
}

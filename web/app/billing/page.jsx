"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Brand from "@/components/Brand";
import Icon from "@/components/Icons";
import PricingCards, { MonthsToggle, usePlans } from "@/components/Pricing";
import { useAuth } from "@/components/Providers";
import { Field, Modal, RequireAuth, Spinner } from "@/components/ui";
import { api, get, patch, post } from "@/lib/api";
import { fmtDate, fmtDateTime, fmtNaira } from "@/lib/format";

const STATUS = {
  success: ["up", "Paid"], pending: ["", "Pending"], awaiting_transfer: ["warn", "Waiting for transfer"], review: ["violet", "Being verified"],
  rejected: ["down", "Rejected"], failed: ["down", "Failed"], abandoned: ["", "Not completed"], cancelled: ["", "Cancelled"], expired: ["", "Expired"],
};

function Copy({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label="Copy" onClick={() => {
      navigator.clipboard && navigator.clipboard.writeText(String(text)).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); });
    }}>
      <Icon name={ok ? "check" : "copy"} size={15} />
    </button>
  );
}

function AccountBox({ bank, number, name, amount, reference }) {
  return (
    <div className="card" style={{ padding: 16, background: "var(--bg-3)" }}>
      <div className="faint" style={{ fontSize: "0.78rem", fontWeight: 700, letterSpacing: "0.08em" }}>{bank}</div>
      <div className="row" style={{ gap: 6 }}><b className="num" style={{ fontSize: "1.6rem", letterSpacing: "0.04em" }}>{number}</b><Copy text={number} /></div>
      <div className="muted" style={{ fontSize: "0.9rem" }}>{name}</div>
      {amount ? <div className="row" style={{ gap: 6, marginTop: 10 }}><span className="muted">Amount</span> <b className="num">{fmtNaira(amount)}</b><Copy text={amount} /></div> : null}
      {reference ? <div className="row" style={{ gap: 6 }}><span className="muted">Narration / remark</span> <b className="num">{reference}</b><Copy text={reference} /></div> : null}
    </div>
  );
}

function Checkout({ open, onClose, plan, months, plans, user, onDone, toast }) {
  const [method, setMethod] = useState(null);
  const [channel, setChannel] = useState("any");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [manual, setManual] = useState(null);
  const [acct, setAcct] = useState(0);
  const [dva, setDva] = useState(null);
  const [phone, setPhone] = useState((user && user.phone) || "");
  const [proof, setProof] = useState({ name: user ? user.name : "", file: null });
  useEffect(() => {
    if (open) {
      setMethod(null); setErr(null); setManual(null); setDva(null); setBusy(false);
    }
  }, [open]);
  if (!open || !plans) return null;
  // the server quotes the price; the client only shows it. Organization is one flat price for the whole team.
  const q = plans.quotes[plan === "org" ? "org" : "pro"][String(months)];
  const disc = Number(q.discount || 0);
  const naira = q.naira;
  const methods = plans.methods;
  const body = { plan, months };
  const go = async (provider) => {
    setBusy(true); setErr(null);
    try {
      const d = await post("/billing/checkout", { ...body, provider, channel });
      window.location.href = d.url;
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const startManual = async () => {
    setBusy(true); setErr(null);
    try { setManual(await post("/billing/manual/start", { ...body, account: acct })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const sendProof = async (e) => {
    e.preventDefault();
    if (!proof.file) return setErr("Attach your transfer receipt (screenshot or PDF).");
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append("payer_name", proof.name);
      fd.append("file", proof.file);
      const d = await api(`/billing/manual/${manual.payment.reference}/proof`, { method: "POST", form: fd });
      toast(d.message, "success", 7000);
      onDone();
      onClose();
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  const startDva = async () => {
    setBusy(true); setErr(null);
    try {
      if (phone && phone !== (user && user.phone)) await patch("/auth/me", { phone });
      await post("/billing/dva");
      setDva(await post("/billing/dva/intent", body));
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const title = plan === "org" ? "StreixAnalyst Organization" : "StreixAnalyst Pro";
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={`${months === 1 ? "1 month" : `${months} months`} · $${q.usd} (${fmtNaira(naira)})${disc ? ` · save ${Math.round(disc * 100)}%` : ""}`} wide>
      {!method ? (
        <div className="stack" style={{ marginTop: 14 }}>
          <div className="label">How would you like to pay?</div>
          {methods.paystack ? (
            <button className="card row" style={{ textAlign: "left", cursor: "pointer", padding: 14 }} onClick={() => setMethod("paystack")}>
              <Icon name="card" size={24} style={{ color: "var(--brand-2)" }} />
              <div className="grow"><b>Card, bank or USSD</b><div className="faint" style={{ fontSize: "0.85rem" }}>Visa, Mastercard, Verve, bank app, *USSD# — secured by Paystack</div></div>
              <Icon name="chevronRight" size={18} />
            </button>
          ) : null}
          {methods.opay ? (
            <button className="card row" style={{ textAlign: "left", cursor: "pointer", padding: 14 }} onClick={() => go("opay")} disabled={busy}>
              <Icon name="phone" size={24} style={{ color: "#2fd3a6" }} />
              <div className="grow"><b>OPay</b><div className="faint" style={{ fontSize: "0.85rem" }}>Pay with your OPay wallet or card on OPay's checkout</div></div>
              <Icon name="chevronRight" size={18} />
            </button>
          ) : null}
          {methods.dedicated_account ? (
            <button className="card row" style={{ textAlign: "left", cursor: "pointer", padding: 14 }} onClick={() => setMethod("dva")}>
              <Icon name="bank" size={24} style={{ color: "#ffc766" }} />
              <div className="grow"><b>My own account number</b><div className="faint" style={{ fontSize: "0.85rem" }}>Get a personal account number — transfer from any bank, confirmed automatically</div></div>
              <Icon name="chevronRight" size={18} />
            </button>
          ) : null}
          {methods.manual ? (
            <button className="card row" style={{ textAlign: "left", cursor: "pointer", padding: 14 }} onClick={() => setMethod("manual")}>
              <Icon name="upload" size={24} style={{ color: "#c4b3ff" }} />
              <div className="grow"><b>Transfer to our OPay or UBA account</b><div className="faint" style={{ fontSize: "0.85rem" }}>Send the money, upload your receipt, we confirm it (usually within a few hours)</div></div>
              <Icon name="chevronRight" size={18} />
            </button>
          ) : null}
          {!methods.paystack && !methods.opay && !methods.manual && !methods.dedicated_account ? <div className="hint">Payments aren't set up on this server yet.</div> : null}
        </div>
      ) : null}
      {method === "paystack" ? (
        <div className="stack" style={{ marginTop: 6 }}>
          <div className="label">Pay with</div>
          <div className="seg brand" style={{ flexWrap: "wrap" }}>
            {[["any", "Any method"], ["card", "Card"], ["ussd", "USSD"], ["bank_transfer", "Bank transfer"], ["bank", "Bank account"]].map(([c, l]) => (
              <button key={c} className={channel === c ? "on" : ""} onClick={() => setChannel(c)}>{l}</button>
            ))}
          </div>
          <div className="hint">You'll finish on Paystack's secure page, then come straight back here. We confirm the payment with Paystack before unlocking your plan.</div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={() => setMethod(null)}>Back</button>
            <button className="btn primary" disabled={busy} onClick={() => go("paystack")}>{busy ? <span className="spinner" /> : <Icon name="shield" size={16} />} Pay {fmtNaira(naira)}</button>
          </div>
        </div>
      ) : null}
      {method === "dva" ? (
        <div className="stack" style={{ marginTop: 6 }}>
          {!dva ? (
            <>
              <Field label="Phone number" hint="The bank needs it to open your account number.">
                <input className="input" type="tel" placeholder="+2348012345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="btn ghost" onClick={() => setMethod(null)}>Back</button>
                <button className="btn primary" disabled={busy || !phone} onClick={startDva}>{busy ? <span className="spinner" /> : null} Get my account number</button>
              </div>
            </>
          ) : (
            <>
              <div className="muted">Transfer exactly <b>{fmtNaira(dva.amount)}</b> from any bank app to your personal account below. Your plan unlocks automatically once the bank confirms it — usually within minutes.</div>
              {dva.account && dva.account.account_number ? (
                <AccountBox bank={dva.account.bank_name} number={dva.account.account_number} name={dva.account.account_name} amount={dva.amount} />
              ) : <div className="badge warn" style={{ height: "auto", padding: 10, whiteSpace: "normal" }}>Your account number is being created. Refresh this page in a minute.</div>}
              <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={() => { onDone(); onClose(); }}>I've sent it</button></div>
            </>
          )}
        </div>
      ) : null}
      {method === "manual" ? (
        <div className="stack" style={{ marginTop: 6 }}>
          {!manual ? (
            <>
              <div className="label">Choose the account you'll send to</div>
              <div className="stack" style={{ gap: 8 }}>
                {plans.manual_accounts.map((a, i) => (
                  <label key={i} className="card row" style={{ padding: 12, cursor: "pointer", borderColor: acct === i ? "var(--brand)" : undefined }}>
                    <input type="radio" name="acct" checked={acct === i} onChange={() => setAcct(i)} style={{ accentColor: "var(--brand)" }} />
                    <div className="grow"><b>{a.bank}</b> · <span className="num">{a.number}</span><div className="faint" style={{ fontSize: "0.82rem" }}>{a.name}</div></div>
                  </label>
                ))}
              </div>
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="btn ghost" onClick={() => setMethod(null)}>Back</button>
                <button className="btn primary" disabled={busy} onClick={startManual}>{busy ? <span className="spinner" /> : null} Continue</button>
              </div>
            </>
          ) : (
            <form className="stack" onSubmit={sendProof}>
              <div className="muted">{manual.instructions}</div>
              <AccountBox bank={manual.account.bank} number={manual.account.number} name={manual.account.name} amount={manual.amount} reference={manual.payment.reference} />
              <div className="grid-2">
                <Field label="Name on the sending account"><input className="input" required value={proof.name} onChange={(e) => setProof({ ...proof, name: e.target.value })} /></Field>
                <Field label="Receipt (screenshot or PDF)"><input className="input" style={{ paddingTop: 9 }} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setProof({ ...proof, file: e.target.files && e.target.files[0] })} /></Field>
              </div>
              <div className="hint">You can also upload the receipt later from your payment history below.</div>
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn ghost" onClick={() => { onDone(); onClose(); }}>Upload later</button>
                <button className="btn primary" disabled={busy}>{busy ? <span className="spinner" /> : <Icon name="upload" size={16} />} Send receipt</button>
              </div>
            </form>
          )}
        </div>
      ) : null}
      {err ? <div className="error-text" style={{ marginTop: 10 }}>{err}</div> : null}
    </Modal>
  );
}

function ProofUpload({ payment, onDone }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState(payment.payer_name || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const send = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append("payer_name", name);
      fd.append("file", file);
      await api(`/billing/manual/${payment.reference}/proof`, { method: "POST", form: fd });
      onDone();
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  return (
    <form onSubmit={send} className="row wrap" style={{ gap: 8, marginTop: 8 }}>
      <input className="input sm" style={{ maxWidth: 200 }} required placeholder="Sender's name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input sm" style={{ maxWidth: 240, paddingTop: 5 }} required type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files && e.target.files[0])} />
      <button className="btn sm primary" disabled={busy || !file}>Upload receipt</button>
      {err ? <span className="error-text">{err}</span> : null}
    </form>
  );
}

function OrgCard({ refreshUser, toast }) {
  const [org, setOrg] = useState(undefined);
  const [code, setCode] = useState("");
  const load = useCallback(() => get("/user/org").then(setOrg).catch(() => setOrg(null)), []);
  useEffect(() => { load(); }, [load]);
  if (org === undefined) return null;
  if (!org || !org.org) {
    return (
      <div className="card">
        <b>Have an invite code?</b>
        <div className="muted" style={{ fontSize: "0.9rem", margin: "4px 0 10px" }}>Join your academy or team's organization to get Pro features on their seat.</div>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); try { await post("/user/org/join", { code }); toast("You've joined the organization.", "success"); refreshUser(); load(); } catch (ex) { toast(ex.message, "error"); } }}>
          <input className="input" placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ maxWidth: 220 }} />
          <button className="btn primary" disabled={!code}>Join</button>
        </form>
      </div>
    );
  }
  const o = org.org;
  const link = typeof window !== "undefined" && o.invite_code ? `${window.location.origin}/signup?invite=${o.invite_code}` : "";
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><b style={{ fontSize: "1.05rem" }}>{o.name}</b><div className="faint" style={{ fontSize: "0.85rem" }}>{o.used} member{o.used === 1 ? "" : "s"} · renews {fmtDate(o.expires_at)} · you are {o.role}</div></div>
        <span className="badge violet">Organization</span>
      </div>
      {o.invite_code ? (
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="muted">Invite code</span><b className="num">{o.invite_code}</b><Copy text={o.invite_code} />
          <span className="muted">or link</span><Copy text={link} />
          {o.role === "owner" ? <button className="btn sm ghost" onClick={async () => { await post("/user/org/invite-code"); load(); }}>New code</button> : null}
        </div>
      ) : null}
      {org.members && org.members.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Member</th><th>Level</th><th>Role</th><th>Last seen</th><th /></tr></thead>
            <tbody>
              {org.members.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.name}</b><div className="faint">{m.email}</div></td>
                  <td style={{ textTransform: "capitalize" }}>{m.experience || "—"}</td>
                  <td>{o.role === "owner" && m.role !== "owner" ? (
                    <select className="select sm" value={m.role} onChange={async (e) => { await api(`/user/org/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }); load(); }}>
                      <option value="member">Student / member</option><option value="teacher">Teacher</option>
                    </select>
                  ) : <span style={{ textTransform: "capitalize" }}>{m.role}</span>}</td>
                  <td>{m.last_seen_at ? fmtDateTime(m.last_seen_at) : "—"}</td>
                  <td>{o.role === "owner" && m.role !== "owner" ? (
                    <button className="btn sm danger" onClick={async () => { if (window.confirm(`Remove ${m.name}?`)) { await api(`/user/org/members/${m.id}`, { method: "DELETE" }); load(); } }}>Remove</button>
                  ) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function BillingInner() {
  const { user, refresh, toast } = useAuth();
  const sp = useSearchParams();
  const { plans } = usePlans();
  const [months, setMonths] = useState(1);
  const [checkout, setCheckout] = useState(null);
  const [pays, setPays] = useState(null);
  const loadPays = useCallback(() => get("/billing/payments").then((d) => setPays(d.payments)).catch(() => setPays([])), []);
  useEffect(() => { loadPays(); }, [loadPays]);
  useEffect(() => { if (sp.get("cancelled")) toast("Payment cancelled — nothing was charged.", "info"); }, [sp, toast]);
  const e = user.entitlements;
  const status = e.tier === "trial" ? `Free trial — ${e.trial_days_left} day${e.trial_days_left === 1 ? "" : "s"} left (ends ${fmtDate(e.trial_ends_at)})`
    : e.tier === "pro" ? `Pro — active until ${fmtDate(e.plan_expires_at)}`
    : e.tier === "org" ? `Organization seat — active until ${fmtDate(e.org_expires_at)}`
    : e.tier === "admin" ? "Admin — everything unlocked" : "Free plan";
  return (
    <div className="page page-bg">
      <nav className="nav">
        <Brand />
        <div className="grow" />
        <Link className="btn" href="/terminal"><Icon name="candles" size={16} /> Terminal</Link>
      </nav>
      <main className="container stack" style={{ gap: 22, paddingBottom: 60 }}>
        <div>
          <div className="eyebrow">Plan & billing</div>
          <h1 className="h-display" style={{ fontSize: "clamp(1.8rem, 3.6vw, 2.6rem)", margin: "8px 0 4px" }}>{status}</h1>
          <div className="muted">Today: {e.usage.analysis || 0}{e.limits.analysis !== null ? `/${e.limits.analysis}` : ""} analyses · {e.usage.ai || 0}{e.limits.ai !== null ? `/${e.limits.ai}` : ""} StreixAI messages</div>
        </div>
        <div className="row wrap" style={{ justifyContent: "space-between", gap: 12 }}>
          <b>Choose a plan</b>
          <MonthsToggle months={months} setMonths={setMonths} plans={plans} />
        </div>
        <PricingCards plans={plans} months={months} current={e.tier} onChoose={(plan) => setCheckout(plan)} />
        <OrgCard refreshUser={refresh} toast={toast} />
        <div>
          <div className="section-title">Payment history</div>
          {!pays ? <Spinner /> : !pays.length ? <div className="hint">No payments yet.</div> : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Date</th><th>Reference</th><th>Plan</th><th>Method</th><th>Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {pays.map((p) => {
                    const [tone, label] = STATUS[p.status] || ["", p.status];
                    return (
                      <tr key={p.id}>
                        <td>{fmtDateTime(p.created_at)}</td>
                        <td className="num">{p.reference}</td>
                        <td>{p.plan === "org" ? "Organization" : "Pro"} · {p.months} mo</td>
                        <td style={{ textTransform: "capitalize" }}>{p.provider === "manual" ? `Transfer (${(p.account_label || "").split(" · ")[0]})` : p.provider === "paystack_dva" ? "Account number" : p.provider}</td>
                        <td className="num">{fmtNaira(p.amount)}</td>
                        <td>
                          <span className={`badge ${tone}`}>{label}</span>
                          {p.note && p.status === "rejected" ? <div className="hint">{p.note}</div> : null}
                          {p.provider === "manual" && ["awaiting_transfer", "rejected"].includes(p.status) ? <ProofUpload payment={p} onDone={() => { toast("Receipt received — we'll confirm shortly.", "success"); loadPays(); }} /> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="hint" style={{ marginTop: 10 }}><Icon name="shield" size={14} style={{ display: "inline", verticalAlign: "-2px" }} /> Every payment is verified with the payment provider (or checked by our team for direct transfers) before your plan unlocks.</div>
        </div>
      </main>
      <Checkout open={!!checkout} onClose={() => setCheckout(null)} plan={checkout} months={months} plans={plans} user={user} toast={toast}
        onDone={() => { loadPays(); refresh(); }} />
    </div>
  );
}

export default function BillingPage() {
  return (
    <RequireAuth>
      <Suspense fallback={null}>
        <BillingInner />
      </Suspense>
    </RequireAuth>
  );
}

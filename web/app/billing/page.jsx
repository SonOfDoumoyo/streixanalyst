"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import SubNav from "@/components/SubNav";
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

const ts = (s) => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).getTime();

function Checkout({ open, onClose, plan, months, plans, user, onDone, toast }) {
  const [method, setMethod] = useState(null);
  const [seats, setSeats] = useState(5);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [dva, setDva] = useState(null);
  const [crypto, setCrypto] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [phone, setPhone] = useState((user && user.phone) || "");
  const isOrg = plan === "org";
  const seatCount = isOrg ? Math.max(1, Math.min(500, Number(seats) || 1)) : 1;
  const methods = (plans && plans.methods) || {};
  const unconfirmed = !!user && user.email_verified === false;

  useEffect(() => {
    if (open) { setMethod(null); setErr(null); setDva(null); setCrypto(null); setBusy(false); }
  }, [open]);

  // the server quotes every price; the page only shows what it returns
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const q = new URLSearchParams({ plan, months: String(months), seats: String(seatCount) });
    get(`/billing/quote?${q}`).then((d) => { if (alive) setQuote(d); }).catch(() => {});
    return () => { alive = false; };
  }, [open, plan, months, seatCount]);

  // a crypto payment is confirmed by the server, which checks the blockchain; this page only asks until it's paid
  useEffect(() => {
    if (!open || !crypto) return undefined;
    let alive = true;
    const check = async () => {
      try {
        const d = await get(`/billing/verify?reference=${encodeURIComponent(crypto.reference)}`);
        if (!alive) return;
        if (d.result && d.result.ok) {
          toast("Payment received. Your plan is active.", "success", 7000);
          onDone(); onClose();
        } else if (d.result && d.result.status === "expired") {
          setCrypto((c) => (c ? { ...c, expired: true } : c));
        }
      } catch (e) { /* keep waiting; the next check will try again */ }
    };
    check();
    const poll = setInterval(check, 20000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(poll); clearInterval(clock); };
  }, [open, crypto && crypto.reference]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !plans) return null;

  const title = isOrg ? "StreixAnalyst Organization" : "StreixAnalyst Pro";
  const summary = quote
    ? `${months === 1 ? "1 month" : `${months} months`}${isOrg ? ` · ${seatCount} ${seatCount === 1 ? "person" : "people"}` : ""} · $${quote.usd}${quote.discount ? ` · save ${Math.round(quote.discount * 100)}%` : ""}`
    : "Calculating your price…";
  const perPerson = plans.pricing.org_seat_monthly;
  const body = { plan, months, seats: seatCount };

  const go = async (provider, channel = "any") => {
    setBusy(true); setErr(null);
    try {
      const d = await post("/billing/checkout", { ...body, provider, channel });
      window.location.href = d.url;
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const startCrypto = async () => {
    setBusy(true); setErr(null);
    try { setCrypto(await post("/billing/checkout", { ...body, provider: "crypto" })); } catch (e) { setErr(e.message); }
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

  const option = (icon, color, name, desc, onClick, disabled) => (
    <button className="card row" style={{ textAlign: "left", cursor: "pointer", padding: 14 }} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={24} style={{ color }} />
      <div className="grow"><b>{name}</b><div className="faint" style={{ fontSize: "0.85rem" }}>{desc}</div></div>
      <Icon name="chevronRight" size={18} />
    </button>
  );

  const secondsLeft = crypto && crypto.expires_at ? Math.max(0, Math.floor((ts(crypto.expires_at) - now) / 1000)) : 0;
  const clock = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`;

  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={summary} wide>
      {unconfirmed ? <div className="badge warn" style={{ height: "auto", padding: 10, whiteSpace: "normal", marginTop: 12 }}>Confirm your email before you pay. Check your inbox for the link.</div> : null}

      {!method && !crypto ? (
        <div className="stack" style={{ marginTop: 14 }}>
          {isOrg ? (
            <Field label="How many people?" hint={`$${perPerson} per person a month. You can add more people later.`}>
              <input className="input num" type="number" min="1" max="500" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </Field>
          ) : null}
          <div className="label">How would you like to pay?</div>
          {methods.paystack ? option("card", "var(--brand-2)", "Debit or credit card", "Visa, Mastercard, Verve. Confirmed automatically.", () => setMethod("card"), busy) : null}
          {methods.dedicated_account ? option("bank", "#ffc766", "Bank transfer", "Send from any bank app to your personal account number. Confirmed automatically.", () => setMethod("dva"), busy) : null}
          {methods.opay ? option("phone", "#2fd3a6", "OPay", "Pay with your OPay wallet or card on OPay's checkout. Confirmed automatically.", () => go("opay"), busy) : null}
          {methods.crypto ? option("shield", "var(--brand-2)", "USDT (crypto)", "Send USDT to our wallet. Confirmed on the blockchain automatically.", () => setMethod("crypto"), busy) : null}
          {!methods.paystack && !methods.opay && !methods.dedicated_account && !methods.crypto ? <div className="hint">Payments aren't set up on this server yet.</div> : null}
        </div>
      ) : null}

      {method === "card" ? (
        <div className="stack" style={{ marginTop: 6 }}>
          <div className="hint">You'll finish on Paystack's secure page, then come straight back here. We confirm the payment with Paystack before unlocking your plan.</div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={() => setMethod(null)}>Back</button>
            <button className="btn primary" disabled={busy || unconfirmed} onClick={() => go("paystack")}>{busy ? <span className="spinner" /> : <Icon name="shield" size={16} />} Pay {quote ? fmtNaira(quote.naira) : ""}</button>
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
                <button className="btn primary" disabled={busy || !phone || unconfirmed} onClick={startDva}>{busy ? <span className="spinner" /> : null} Get my account number</button>
              </div>
            </>
          ) : (
            <>
              <div className="muted">Transfer exactly <b>{fmtNaira(dva.amount)}</b> from any bank app to your personal account below. Your plan unlocks automatically once the bank confirms it, usually within minutes.</div>
              {dva.account && dva.account.account_number ? (
                <AccountBox bank={dva.account.bank_name} number={dva.account.account_number} name={dva.account.account_name} amount={dva.amount} />
              ) : <div className="badge warn" style={{ height: "auto", padding: 10, whiteSpace: "normal" }}>Your account number is being created. Refresh this page in a minute.</div>}
              <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" onClick={() => { onDone(); onClose(); }}>I've sent it</button></div>
            </>
          )}
        </div>
      ) : null}

      {method === "crypto" && !crypto ? (
        <div className="stack" style={{ marginTop: 6 }}>
          <div className="hint">You'll get one wallet address and an exact USDT amount for this payment. Send exactly that amount on the network we show. Your plan activates automatically once the transfer is confirmed on the blockchain.</div>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button className="btn ghost" onClick={() => setMethod(null)}>Back</button>
            <button className="btn primary" disabled={busy || unconfirmed} onClick={startCrypto}>{busy ? <span className="spinner" /> : null} Create payment</button>
          </div>
        </div>
      ) : null}

      {crypto ? (
        <div className="stack" style={{ marginTop: 6 }}>
          {crypto.expired ? (
            <>
              <div className="badge warn" style={{ height: "auto", padding: 10, whiteSpace: "normal" }}>This payment window has closed. If you already sent the transfer, contact support with the reference below.</div>
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button className="btn ghost" onClick={onClose}>Close</button>
                <button className="btn primary" onClick={() => { setCrypto(null); setMethod("crypto"); }}>Start a new payment</button>
              </div>
            </>
          ) : (
            <>
              <div className="card" style={{ padding: 16, background: "var(--bg-3)" }}>
                <div className="faint" style={{ fontSize: "0.78rem", fontWeight: 700, letterSpacing: "0.08em" }}>{crypto.label}</div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <b className="num" style={{ fontSize: "1.7rem" }}>{crypto.amount} USDT</b>
                  <Copy text={crypto.amount} />
                </div>
                <div className="muted" style={{ fontSize: "0.85rem" }}>About ${crypto.usd} (the few extra cents identify your payment)</div>
              </div>
              <div className="card" style={{ padding: 16 }}>
                <div className="faint" style={{ fontSize: "0.78rem", fontWeight: 700, letterSpacing: "0.08em" }}>WALLET ADDRESS</div>
                <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "flex-start" }}>
                  <span className="num" style={{ wordBreak: "break-all", fontSize: "0.92rem" }}>{crypto.address}</span>
                  <Copy text={crypto.address} />
                </div>
              </div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="muted">Window closes in</span>
                <b className="num">{clock}</b>
              </div>
              <div className="hint">Send exactly {crypto.amount} USDT on {crypto.label.split(" on ")[1] || "the network above"}. Sending on another network, or a different amount, means we can't match your payment. If you send from an exchange, check the amount that will arrive before you confirm.</div>
              <div className="row" style={{ gap: 8, alignItems: "center" }}><span className="spinner" /> <span className="muted">Waiting for your transfer…</span></div>
            </>
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
      <SubNav />
      <main className="container stack tv-flat" style={{ gap: 22, paddingTop: 28, paddingBottom: 60 }}>
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

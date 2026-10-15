"use client";
// Support: send the team a message, read the quick answers, or find the contact details. Signed-out people can write too.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Icon from "@/components/Icons";
import SubNav from "@/components/SubNav";
import { useAuth } from "@/components/Providers";
import { get, post } from "@/lib/api";

const CATEGORIES = [
  ["account", "Account and sign-in"],
  ["payments", "Payments and plans"],
  ["trading", "Analysis and charts"],
  ["classroom", "Classroom"],
  ["bug", "Something is broken"],
  ["other", "Something else"],
];

const HELP = [
  ["How do I pay?", "Choose a plan on Plan and billing. You can pay by card, USSD, OPay or bank transfer, in naira at the rate shown. Your plan starts once the payment is confirmed."],
  ["I paid but my plan is not active", "If it still shows as waiting a few minutes after you paid, send us your payment reference using the form below."],
  ["What does the free trial include?", "The first 30 days give you everything in Pro. After that, the free plan keeps a few analyses and StreixAI messages each day."],
  ["Why are the exact odds hidden?", "The bull and bear bar shows the lean, not a promise. Exact odds stay hidden until the model's calibration has been verified on fresh data."],
  ["Is this financial advice?", "No. StreixAnalyst is for analysis and education. Read the Terms, and paper-trade before you risk any money."],
  ["How do I delete my data?", "Send us a message below. We handle requests as set out in the Privacy Policy."],
];

function SupportInner() {
  const { user, updateSettings, toast } = useAuth();
  const router = useRouter();
  const [contact, setContact] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [f, setF] = useState({ name: "", email: "", category: "other", subject: "", message: "", website: "" });

  useEffect(() => {
    get("/site").then((s) => setContact(s.contact || {})).catch(() => setContact({}));
  }, []);

  useEffect(() => {
    if (user) setF((x) => ({ ...x, name: x.name || user.name, email: x.email || user.email }));
  }, [user]);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post("/support", f);
      setSent(r);
      setF((x) => ({ ...x, subject: "", message: "" }));
      toast("Message sent. Thank you.", "success");
    } catch (err) {
      toast(err.message || "That did not send. Please try again.", "error");
    } finally {
      setBusy(false);
    }
  };

  const rows = contact
    ? [
        ["Phone", contact.phone && `tel:${contact.phone}`, contact.phone],
        ["Email", contact.email && `mailto:${contact.email}`, contact.email],
        ["Company email", contact.company_email && `mailto:${contact.company_email}`, contact.company_email],
        ["GitHub", contact.github && `https://github.com/${contact.github.replace(/^@/, "")}`, contact.github],
        ["LinkedIn", contact.linkedin && (contact.linkedin.startsWith("http") ? contact.linkedin : `https://linkedin.com/in/${contact.linkedin}`), contact.linkedin],
      ].filter((r) => r[2])
    : [];

  return (
    <div className="page page-bg">
      <SubNav />
      <main className="container" style={{ paddingTop: 24, paddingBottom: 60, maxWidth: 980 }}>
        <div className="stack" style={{ gap: 18 }}>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)" }}>Support</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>Answers first, then a message to the team. We reply by email.</p>
          </div>

          <div className="card stack" style={{ padding: 18 }}>
            <b>Quick answers</b>
            {HELP.map(([q, a]) => (
              <details key={q} className="fold">
                <summary>{q}</summary>
                <div className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.6, padding: "6px 2px 2px" }}>{a}</div>
              </details>
            ))}
            <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
              {user ? (
                <button className="btn" onClick={() => { updateSettings({ tourDone: false }); router.push("/terminal"); }}>
                  <Icon name="sparkles" size={15} /> Replay the tour
                </button>
              ) : null}
              <Link className="btn ghost" href="/terms">Terms</Link>
              <Link className="btn ghost" href="/privacy">Privacy</Link>
              <Link className="btn ghost" href="/donate">Donate</Link>
            </div>
          </div>

          <div className="grid-2" style={{ gap: 18, alignItems: "start" }}>
            <form className="card stack" style={{ padding: 18 }} onSubmit={send}>
              <b>Send us a message</b>
              {sent ? (
                <div className="badge up" style={{ height: "auto", padding: "8px 10px", whiteSpace: "normal" }}>
                  <Icon name="check" size={14} /> {sent.message}{sent.id ? ` Reference #${sent.id}.` : ""}
                </div>
              ) : null}
              <div className="grid-2" style={{ gap: 10 }}>
                <div className="field"><label htmlFor="sp-name">Name</label>
                  <input id="sp-name" className="input" value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
                <div className="field"><label htmlFor="sp-email">Email (we reply here)</label>
                  <input id="sp-email" className="input" type="email" required value={f.email} maxLength={255} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
              </div>
              <div className="field"><label htmlFor="sp-cat">What is it about?</label>
                <select id="sp-cat" className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                  {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
              <div className="field"><label htmlFor="sp-subject">Subject</label>
                <input id="sp-subject" className="input" required minLength={3} maxLength={160} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></div>
              <div className="field"><label htmlFor="sp-msg">Message</label>
                <textarea id="sp-msg" className="input" required minLength={10} maxLength={4000} rows={5} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></div>
              {/* Honeypot: hidden from people, filled in only by bots. */}
              <input name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} style={{ display: "none" }} aria-hidden="true" />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn primary" disabled={busy}>{busy ? "Sending" : "Send message"}</button>
              </div>
            </form>

            <div className="card stack" style={{ padding: 18 }}>
              <b>Contact</b>
              {rows.length ? rows.map(([label, href, value]) => (
                <div key={label} className="row" style={{ justifyContent: "space-between", gap: 10, fontSize: "0.92rem" }}>
                  <span className="muted">{label}</span>
                  {href ? <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="num">{value}</a> : <span className="num">{value}</span>}
                </div>
              )) : <div className="muted" style={{ fontSize: "0.9rem" }}>Contact details will appear here once they are added.</div>}
              <div className="divider" />
              <div className="muted" style={{ fontSize: "0.86rem", lineHeight: 1.6 }}>
                Please do not send passwords or full card numbers. We will never ask for them.
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function SupportPage() {
  return <SupportInner />;
}

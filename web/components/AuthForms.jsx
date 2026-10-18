"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Brand from "@/components/Brand";
import Icon from "@/components/Icons";
import { useAuth } from "@/components/Providers";
import { Field } from "@/components/ui";
import { get, patch, post } from "@/lib/api";

export const EXPERIENCE = [
  ["beginner", "Beginner", "New to trading or still learning the basics"],
  ["intermediate", "Intermediate", "I trade and know support, resistance, risk"],
  ["advanced", "Advanced", "Structure, liquidity, ICT/SMC, statistics"],
];

export function AuthShell({ children }) {
  return (
    <div className="page page-bg">
      <header className="topbar">
        <Brand href="/" size={34} />
        <span className="sep" />
        <nav className="topnav">
          <Link href="/pricing" className="tv-tab">Pricing</Link>
        </nav>
        <div className="grow" />
      </header>
      <div className="auth-wrap">{children}</div>
    </div>
  );
}

function safeNext(n) {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/terminal";
}

// On the sign-up page, `terms` (the Terms box) must be ticked before Google or LinkedIn can create an account.
function OAuthButtons({ providers, next, invite, terms, learn, onBlocked }) {
  if (!providers || (!providers.google && !providers.linkedin)) return null;
  const gated = terms !== undefined;
  const q = `?next=${encodeURIComponent(next)}${invite ? `&invite=${encodeURIComponent(invite)}` : ""}` +
    (gated && terms ? `&terms=1${learn ? "&learn=1" : ""}` : "");
  const block = (e) => { if (gated && !terms) { e.preventDefault(); onBlocked && onBlocked(); } };
  return (
    <>
      <div className="oauth">
        {providers.google ? (
          <a className="btn lg block" href={`/api/auth/oauth/google/start${q}`} onClick={block} aria-disabled={gated && !terms}>
            <Icon name="google" size={20} /> Continue with Google
          </a>
        ) : null}
        {providers.linkedin ? (
          <a className="btn lg block" href={`/api/auth/oauth/linkedin/start${q}`} onClick={block} aria-disabled={gated && !terms}>
            <Icon name="linkedin" size={20} /> Continue with LinkedIn
          </a>
        ) : null}
      </div>
      <div className="or">or with email</div>
    </>
  );
}

export function ExperiencePicker({ value, onChange }) {
  return (
    <div className="exp-pick" role="radiogroup" aria-label="Trading experience">
      {EXPERIENCE.map(([id, label, desc]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>
          <b>{label}</b>
          <span>{desc}</span>
        </button>
      ))}
    </div>
  );
}

export function LoginForm() {
  const { setUser, user, loading } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const next = safeNext(sp.get("next"));
  const [providers, setProviders] = useState(null);
  const [f, setF] = useState({ email: "", password: "" });
  const [err, setErr] = useState(sp.get("error"));
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => { get("/auth/providers").then(setProviders).catch(() => setProviders({})); }, []);
  useEffect(() => { if (!loading && user) router.replace(next); }, [user, loading, next, router]);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const d = await post("/auth/login", f);
      setUser(d.user);
      router.replace(d.user.needs_onboarding ? `/onboarding?next=${encodeURIComponent(next)}` : next);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  return (
    <div className="auth-card card">
      <div className="eyebrow">Welcome back</div>
      <h1>Sign in to StreixAnalyst</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Your charts, drawings and analyses are waiting.</p>
      <OAuthButtons providers={providers} next={next} />
      <form onSubmit={submit} className="stack">
        <Field label="Email" htmlFor="email">
          <input id="email" className="input" type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Password" htmlFor="password">
          <div style={{ position: "relative" }}>
            <input id="password" className="input" type={show ? "text" : "password"} autoComplete="current-password" required value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })} style={{ paddingRight: 44 }} />
            <button type="button" className="icon-btn" style={{ position: "absolute", right: 4, top: 4 }} onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
              <Icon name={show ? "eyeOff" : "eye"} size={18} />
            </button>
          </div>
        </Field>
        {err ? <div className="error-text" role="alert">{err}</div> : null}
        <button className="btn primary lg block" disabled={busy}>{busy ? <span className="spinner" /> : null} Sign in</button>
        <div className="row" style={{ justifyContent: "space-between", fontSize: "0.9rem" }}>
          <Link href="/forgot">Forgot password?</Link>
          <span className="muted">New here? <Link href={`/signup${next !== "/terminal" ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link></span>
        </div>
      </form>
    </div>
  );
}

export function SignupForm() {
  const { setUser, user, loading, config } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const next = safeNext(sp.get("next"));
  const invite = sp.get("invite") || "";
  const [providers, setProviders] = useState(null);
  const [f, setF] = useState({ first_name: "", last_name: "", email: "", password: "", experience: "", invite_code: invite });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [terms, setTerms] = useState(false);
  const [learn, setLearn] = useState(false);
  useEffect(() => { get("/auth/providers").then(setProviders).catch(() => setProviders({})); }, []);
  useEffect(() => { if (!loading && user) router.replace(next); }, [user, loading, next, router]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (!f.experience) return setErr("Choose your trading experience — it changes how StreixAI explains things.");
    if (!terms) return setErr("Tick the box to accept the Terms of Service and Privacy Policy to create your account.");
    setBusy(true);
    setErr(null);
    try {
      const body = { ...f, accept_terms: true, learn };
      if (!body.invite_code) delete body.invite_code;
      const d = await post("/auth/signup", body);
      setUser(d.user);
      router.replace(next + (next.includes("?") ? "&" : "?") + "welcome=1");
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  const days = (config && config.trial_days) || 30;
  return (
    <div className="auth-card card" style={{ width: "min(520px, 100%)" }}>
      <div className="eyebrow">{days} days free · everything unlocked</div>
      <h1>Create your account</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>No card needed. Every feature is yours for {days} days.</p>
      <OAuthButtons providers={providers} next={next} invite={invite} terms={terms} learn={learn}
        onBlocked={() => setErr("Tick the box below to accept the Terms of Service and Privacy Policy first.")} />
      <form onSubmit={submit} className="stack">
        <div className="grid-2">
          <Field label="First name" htmlFor="fn"><input id="fn" className="input" autoComplete="given-name" required maxLength={80} value={f.first_name} onChange={set("first_name")} /></Field>
          <Field label="Last name" htmlFor="ln"><input id="ln" className="input" autoComplete="family-name" required maxLength={80} value={f.last_name} onChange={set("last_name")} /></Field>
        </div>
        <Field label="Email" htmlFor="em"><input id="em" className="input" type="email" autoComplete="email" required value={f.email} onChange={set("email")} /></Field>
        <Field label="Password" htmlFor="pw" hint="At least 8 characters, with a number or symbol.">
          <div style={{ position: "relative" }}>
            <input id="pw" className="input" type={show ? "text" : "password"} autoComplete="new-password" required minLength={8} value={f.password} onChange={set("password")} style={{ paddingRight: 44 }} />
            <button type="button" className="icon-btn" style={{ position: "absolute", right: 4, top: 4 }} onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
              <Icon name={show ? "eyeOff" : "eye"} size={18} />
            </button>
          </div>
        </Field>
        <div className="field">
          <label>Your trading experience</label>
          <ExperiencePicker value={f.experience} onChange={(v) => setF({ ...f, experience: v })} />
        </div>
        {invite ? <div className="badge brand" style={{ alignSelf: "flex-start" }}><Icon name="building" size={14} /> Joining with invite {invite}</div> : null}
        <label className="check">
          <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <span>I have read and agree to the <Link href="/terms" target="_blank">Terms of Service</Link> and the <Link href="/privacy" target="_blank">Privacy Policy</Link>. I understand StreixAnalyst is an analysis tool, not financial advice.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} />
          <span>Optional: let StreixAnalyst learn from my chart analyses and practice attempts to improve the model. You can ask us to stop at any time.</span>
        </label>
        {err ? <div className="error-text" role="alert">{err}</div> : null}
        <button className="btn primary lg block" disabled={busy || !terms}>{busy ? <span className="spinner" /> : null} Start my free {days} days</button>
        <div className="hint" style={{ textAlign: "center" }}>
          Already have an account? <Link href="/login">Sign in</Link>
        </div>
      </form>
    </div>
  );
}

export function OnboardingForm() {
  const { user, setUser } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const next = safeNext(sp.get("next"));
  const [exp, setExp] = useState((user && user.experience) || "");
  const [first, setFirst] = useState((user && user.first_name) || "");
  const [last, setLast] = useState((user && user.last_name) || "");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!exp) return setErr("Pick one — you can change it later in Settings.");
    setBusy(true);
    try {
      const d = await patch("/auth/me", { experience: exp, first_name: first, last_name: last });
      setUser(d.user);
      router.replace(next);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  return (
    <div className="auth-card card" style={{ width: "min(520px, 100%)" }}>
      <div className="eyebrow">One last thing</div>
      <h1>Welcome{user && user.first_name ? `, ${user.first_name}` : ""}!</h1>
      <p className="muted" style={{ marginTop: 0 }}>How much trading experience do you have? StreixAI uses this to explain things at the right level.</p>
      <form onSubmit={submit} className="stack">
        <div className="grid-2">
          <Field label="First name"><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} maxLength={80} /></Field>
          <Field label="Last name"><input className="input" value={last} onChange={(e) => setLast(e.target.value)} maxLength={80} /></Field>
        </div>
        <ExperiencePicker value={exp} onChange={setExp} />
        {err ? <div className="error-text">{err}</div> : null}
        <button className="btn primary lg block" disabled={busy}>{busy ? <span className="spinner" /> : null} Open my terminal</button>
      </form>
    </div>
  );
}

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await post("/auth/forgot", { email });
      setMsg(d.message);
    } catch (ex) {
      setMsg(ex.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-card card">
      <h1>Reset your password</h1>
      <p className="muted" style={{ marginTop: 0 }}>We'll email you a link to choose a new password.</p>
      {msg ? <div className="badge brand" style={{ height: "auto", padding: 12, whiteSpace: "normal", marginBottom: 14 }}>{msg}</div> : null}
      <form onSubmit={submit} className="stack">
        <Field label="Email"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <button className="btn primary lg block" disabled={busy}>Send reset link</button>
        <Link href="/login" style={{ textAlign: "center" }}>Back to sign in</Link>
      </form>
    </div>
  );
}

export function ResetForm() {
  const { setUser } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const d = await post("/auth/reset", { token: sp.get("token") || "", new_password: pw });
      setUser(d.user);
      router.replace("/terminal");
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  return (
    <div className="auth-card card">
      <h1>Choose a new password</h1>
      <form onSubmit={submit} className="stack" style={{ marginTop: 14 }}>
        <Field label="New password" hint="At least 8 characters, with a number or symbol.">
          <input className="input" type="password" autoComplete="new-password" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        {err ? <div className="error-text">{err}</div> : null}
        <button className="btn primary lg block" disabled={busy}>Save and sign in</button>
      </form>
    </div>
  );
}

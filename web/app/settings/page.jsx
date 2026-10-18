"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SubNav from "@/components/SubNav";
import Icon from "@/components/Icons";
import { ExperiencePicker } from "@/components/AuthForms";
import { useAuth } from "@/components/Providers";
import { Field, RequireAuth } from "@/components/ui";
import { AnalysisOptions } from "@/components/terminal/AnalysisPanel";
import { DIRECTION_VIEWS } from "@/components/DirectionBar";
import { get, patch, post } from "@/lib/api";
import { currentPushState, disablePush, enablePush, pushSupported } from "@/lib/push";
import { CANDLE_PRESETS, CHART_BACKGROUNDS, DEFAULT_SETTINGS } from "@/lib/settings";
import { bgSuitsMode, chartThemeFor } from "@/lib/chartTheme";

const SECTIONS = [["profile", "Profile", "user"], ["chart", "Chart & candles", "palette"], ["analysis", "Analysis", "zap"], ["alerts", "Phone alerts", "bell"], ["security", "Password", "lock"], ["help", "Learning & tour", "shield"]];

function ColorRow({ label, value, onChange }) {
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      <span className="muted" style={{ fontSize: "0.9rem" }}>{label}</span>
      <div className="row" style={{ gap: 8 }}>
        <span className="num faint" style={{ fontSize: "0.8rem" }}>{value}</span>
        <input type="color" className="color-input" value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#26a69a"} onChange={(e) => onChange(e.target.value)} aria-label={label} />
      </div>
    </div>
  );
}

function Preview({ s }) {
  const c = s.candles;
  const t = chartThemeFor(s.theme, s.chart, s.candles);
  const bars = [[40, 70, 30, 60], [60, 66, 44, 48], [48, 80, 46, 76], [76, 90, 70, 72], [72, 74, 52, 56], [56, 84, 54, 82], [82, 96, 78, 94], [94, 98, 70, 74]];
  return (
    <svg viewBox="0 0 260 120" style={{ width: "100%", height: 140, borderRadius: 12, background: t.bg, border: "1px solid var(--line)" }}>
      {s.chart.grid ? [30, 60, 90].map((y) => <line key={y} x1="0" x2="260" y1={y} y2={y} stroke={t.grid} />) : null}
      {bars.map(([o, h, l, cl], i) => {
        const up = cl >= o;
        const x = 20 + i * 30;
        const y = (v) => 115 - v;
        const top = y(Math.max(o, cl));
        const hgt = Math.max(2, Math.abs(cl - o));
        const hollow = c.style === "hollow" && up;
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(h)} y2={y(l)} stroke={up ? c.wickUp : c.wickDown} strokeWidth="1.5" />
            <rect x={x - 8} y={top} width="16" height={hgt} fill={hollow ? t.bg : up ? c.up : c.down} stroke={up ? c.borderUp : c.borderDown} strokeWidth="1.2" />
          </g>
        );
      })}
    </svg>
  );
}

function PhoneAlerts({ toast }) {
  const [st, setSt] = useState("checking"); // checking | on | off | unsupported | unavailable
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pushSupported()) { setSt("unsupported"); return; }
    get("/push")
      .then(async (info) => setSt(info.available ? await currentPushState() : "unavailable"))
      .catch(() => setSt("unavailable"));
  }, []);
  const turnOn = async () => {
    setBusy(true);
    try { await enablePush(); setSt("on"); toast("Phone alerts are on for this device.", "success"); }
    catch (ex) { toast(ex.message, "error"); }
    setBusy(false);
  };
  const turnOff = async () => {
    setBusy(true);
    try { await disablePush(); setSt("off"); toast("Phone alerts are off for this device.", "success"); }
    catch (ex) { toast(ex.message, "error"); }
    setBusy(false);
  };
  const sendTest = async () => {
    setBusy(true);
    try {
      const d = await post("/push/test");
      if (d.sent) toast(`Test sent to ${d.sent} device${d.sent === 1 ? "" : "s"}.`, "success");
      else toast(d.error || "No device is set up for phone alerts yet. Turn them on first.", "error");
    } catch (ex) { toast(ex.message, "error"); }
    setBusy(false);
  };
  const text = {
    checking: "Checking this device…",
    unsupported: "This browser can't show phone alerts. On an iPhone, add StreixAnalyst to your Home Screen (iOS 16.4 or newer) and open it from there.",
    unavailable: "Phone alerts aren't switched on for this server yet.",
    off: "Get your price and strategy alerts on this device, even when the site is closed.",
    on: "Phone alerts are on for this device.",
  }[st];
  return (
    <div className="card stack">
      <b>Phone alerts</b>
      <div className="hint" style={{ lineHeight: 1.5 }}>{text}</div>
      <div className="hint">Your alerts stay the same. This only decides which devices receive them, so turn it on for each device you use.</div>
      {st === "off" ? (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" disabled={busy} onClick={turnOn}>Turn on for this device</button>
        </div>
      ) : null}
      {st === "on" ? (
        <div className="row wrap" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" disabled={busy} onClick={sendTest}>Send a test</button>
          <button className="btn ghost" disabled={busy} onClick={turnOff}>Turn off for this device</button>
        </div>
      ) : null}
    </div>
  );
}

function SettingsInner() {
  const { user, setUser, settings, updateSettings, toast } = useAuth();
  const modeKey = settings.theme === "light" ? "light" : "dark";
  const skinBg = (settings.chart.skins && settings.chart.skins[modeKey] && settings.chart.skins[modeKey].bg) || null;
  const router = useRouter();
  const [sec, setSec] = useState("profile");
  const [p, setP] = useState({ first_name: user.first_name, last_name: user.last_name, experience: user.experience, phone: user.phone || "" });
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  const [busy, setBusy] = useState(false);
  // Learning is the person's choice, saved on their account (the server only uses consenting accounts).
  const setLearn = async (v) => {
    setBusy(true);
    try {
      const d = await patch("/auth/me", { learn_consent: v });
      setUser(d.user);
      toast(v ? "Learning is on. Thank you." : "Learning is off. New charts and practice will not be used.", "success");
    } catch (ex) { toast(ex.message, "error"); }
    setBusy(false);
  };
  const replayTour = () => {
    updateSettings({ tourDone: false });
    router.push("/terminal");
  };
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (SECTIONS.some((s) => s[0] === h)) setSec(h);
  }, []);
  const saveProfile = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await patch("/auth/me", p);
      setUser(d.user);
      toast("Profile saved", "success");
    } catch (ex) { toast(ex.message, "error"); }
    setBusy(false);
  };
  const savePw = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await post("/auth/password", pw);
      setUser(d.user);
      setPw({ current_password: "", new_password: "" });
      toast("Password updated. Other devices were signed out.", "success");
    } catch (ex) { toast(ex.message, "error"); }
    setBusy(false);
  };
  const C = settings.candles;
  const setC = (k, v) => updateSettings({ candles: { [k]: v } });
  return (
    <div className="page page-bg">
      <SubNav />
      <main className="container tv-flat" style={{ paddingBottom: 60 }}>
        <h1 className="h-display" style={{ fontSize: "clamp(1.8rem, 3.4vw, 2.4rem)", margin: "10px 0 22px" }}>Settings</h1>
        <div className="shell">
          <div className="side-nav">
            {SECTIONS.map(([id, label, ic]) => (
              <button key={id} className={sec === id ? "on" : ""} onClick={() => { setSec(id); window.history.replaceState(null, "", `#${id}`); }}><Icon name={ic} size={17} /> {label}</button>
            ))}
            <Link href="/billing" className="side-link"><Icon name="card" size={17} /> Plan & billing</Link>
          </div>
          <div className="stack">
            {sec === "profile" ? (
              <form className="card stack" onSubmit={saveProfile}>
                <b>Profile</b>
                <div className="grid-2">
                  <Field label="First name"><input className="input" value={p.first_name} onChange={(e) => setP({ ...p, first_name: e.target.value })} /></Field>
                  <Field label="Last name"><input className="input" value={p.last_name} onChange={(e) => setP({ ...p, last_name: e.target.value })} /></Field>
                </div>
                <Field label="Email"><input className="input" value={user.email} disabled /></Field>
                <Field label="Phone (needed for a personal payment account number)"><input className="input" type="tel" placeholder="+2348012345678" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field>
                <div className="field"><label>Trading experience</label><ExperiencePicker value={p.experience} onChange={(v) => setP({ ...p, experience: v })} /></div>
                <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" disabled={busy}>Save profile</button></div>
              </form>
            ) : null}
            {sec === "chart" ? (
              <div className="card stack">
                <b>Candles</b>
                <Preview s={settings} />
                <div className="label">Presets</div>
                <div className="row wrap" style={{ gap: 8 }}>
                  {CANDLE_PRESETS.map((pr) => (
                    <button key={pr.name} className="chip" onClick={() => updateSettings({ candles: { up: pr.up, down: pr.down, wickUp: pr.up, wickDown: pr.down, borderUp: pr.up, borderDown: pr.down } })}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: pr.up, marginRight: 4 }} />
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: pr.down, marginRight: 6 }} />{pr.name}
                    </button>
                  ))}
                </div>
                <div className="grid-2" style={{ gap: 10 }}>
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="label">Buy (up) candles</div>
                    <ColorRow label="Body" value={C.up} onChange={(v) => setC("up", v)} />
                    <ColorRow label="Wick" value={C.wickUp} onChange={(v) => setC("wickUp", v)} />
                    <ColorRow label="Border" value={C.borderUp} onChange={(v) => setC("borderUp", v)} />
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="label">Sell (down) candles</div>
                    <ColorRow label="Body" value={C.down} onChange={(v) => setC("down", v)} />
                    <ColorRow label="Wick" value={C.wickDown} onChange={(v) => setC("wickDown", v)} />
                    <ColorRow label="Border" value={C.borderDown} onChange={(v) => setC("borderDown", v)} />
                  </div>
                </div>
                <Field label="Chart type">
                  <select className="select" value={C.style} onChange={(e) => setC("style", e.target.value)}>
                    {[["candles", "Candles"], ["hollow", "Hollow candles"], ["heikin", "Heikin Ashi"], ["bars", "OHLC bars"], ["line", "Line"], ["area", "Area"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </Field>
                <div className="divider" />
                <b>Chart</b>
                <div className="label">Background · {modeKey === "light" ? "light" : "dark"} mode</div>
                <div className="row wrap" style={{ gap: 8 }}>
                  {CHART_BACKGROUNDS.filter((b) => b.mode === modeKey).map((b) => (
                    <button key={b.name} className="chip" onClick={() => updateSettings({ chart: { skins: { [modeKey]: { bg: b.bg, grid: b.grid, text: b.text } } } })}
                      style={skinBg === b.bg ? { borderColor: "var(--brand)" } : undefined}>
                      <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 4, background: b.bg, border: "1px solid var(--line-2)", marginRight: 6, verticalAlign: "-2px" }} />{b.name}
                    </button>
                  ))}
                </div>
                <ColorRow label="Custom background" value={skinBg || chartThemeFor(modeKey, settings.chart, settings.candles).bg}
                  onChange={(v) => {
                    if (!bgSuitsMode(v, modeKey)) { toast(modeKey === "light" ? "Pick a light colour for light mode." : "Pick a dark colour for dark mode.", "error"); return; }
                    updateSettings({ chart: { skins: { [modeKey]: { bg: v } } } });
                  }} />
                <div className="hint" style={{ marginTop: -4 }}>Saved for {modeKey === "light" ? "light" : "dark"} mode only. Each mode keeps its own background.</div>
                {[["volume", "Show volume"], ["grid", "Show grid"], ["rsi", "RSI pane"], ["logScale", "Logarithmic price scale"], ["watermark", "Symbol watermark"], ["killzones", "Killzone windows (London, New York)"]].map(([k, l]) => (
                  <label key={k} className="check"><input type="checkbox" checked={!!settings.chart[k]} onChange={(e) => updateSettings({ chart: { [k]: e.target.checked } })} /> {l}</label>
                ))}
                <div className="label">Interface</div>
                <div className="seg brand">
                  <button className={settings.theme !== "light" ? "on" : ""} onClick={() => updateSettings({ theme: "dark" })}><Icon name="moon" size={14} /> Dark</button>
                  <button className={settings.theme === "light" ? "on" : ""} onClick={() => updateSettings({ theme: "light" })}><Icon name="sun" size={14} /> Light</button>
                </div>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button className="btn ghost" onClick={() => updateSettings({ candles: DEFAULT_SETTINGS.candles, chart: DEFAULT_SETTINGS.chart })}>Reset chart look</button>
                </div>
              </div>
            ) : null}
            {sec === "analysis" ? (
              <div className="card stack">
                <b>Analysis defaults</b>
                <div className="hint">Used to size every plan (risk per trade, position size, leverage and liquidation).</div>
                <AnalysisOptions settings={settings} updateSettings={updateSettings} />
                <div className="field">
                  <label>How much the analyst draws</label>
                  <div className="seg brand">
                    {[[1, "Essentials"], [2, "Normal"], [3, "Everything"]].map(([n, l]) => (
                      <button key={n} className={settings.analysis.detail === n ? "on" : ""} onClick={() => updateSettings({ analysis: { detail: n } })}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label>Bull / bear bar</label>
                  <div className="seg brand">
                    {DIRECTION_VIEWS.map(([id, l]) => (
                      <button key={id} className={(settings.analysis.directionView || "range") === id ? "on" : ""} onClick={() => updateSettings({ analysis: { directionView: id } })}>{l}</button>
                    ))}
                  </div>
                  <div className="hint">Range vs trend is the model&apos;s most tested view. The lean is calibrated, but up versus down is weak in testing.</div>
                </div>
                <label className="check"><input type="checkbox" checked={settings.analysis.animate !== false} onChange={(e) => updateSettings({ analysis: { animate: e.target.checked } })} /> Animate drawings when the analysis arrives</label>
                <div className="hint">Saved automatically.</div>
              </div>
            ) : null}
            {sec === "alerts" ? <PhoneAlerts toast={toast} /> : null}
            {sec === "help" ? (
              <div className="card stack">
                <b>Learning</b>
                <label className="check">
                  <input type="checkbox" checked={!!user.learn_consent} disabled={busy} onChange={(e) => setLearn(e.target.checked)} />
                  Let StreixAnalyst use my charts and practice to improve the model. Turning it off stops new use.
                </label>
                <div className="hint">
                  You accepted Terms version {user.terms_version || "none yet"}. <Link href="/terms">Read the Terms</Link> · <Link href="/privacy">Privacy Policy</Link>
                </div>
                <div className="divider" />
                <b>Tour</b>
                <div className="hint">Replay the quick tour of the terminal.</div>
                <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={replayTour}>Replay the tour</button></div>
              </div>
            ) : null}
            {sec === "security" ? (
              <form className="card stack" onSubmit={savePw}>
                <b>{user.has_password ? "Change password" : "Set a password"}</b>
                {!user.has_password ? <div className="hint">You signed up with Google or LinkedIn. Add a password to also sign in with email.</div> : null}
                {user.has_password ? (
                  <Field label="Current password"><input className="input" type="password" autoComplete="current-password" required value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
                ) : null}
                <Field label="New password" hint="At least 8 characters, with a number or symbol."><input className="input" type="password" autoComplete="new-password" required minLength={8} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></Field>
                <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary" disabled={busy}>Save password</button></div>
              </form>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return <RequireAuth><SettingsInner /></RequireAuth>;
}

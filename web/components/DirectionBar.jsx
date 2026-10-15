"use client";
// The bull/bear bar. Each person chooses the view, or hides the bar (saved as settings.analysis.directionView):
//   Range vs trend: will price stay between the two levels over the next 24 candles, or break out of them?
//   Lean: if it breaks out, is it more likely up or down?
// Range uses the model's own share, which was closer than the calibrated one in testing. Lean is calibrated, because
// the raw up and down shares were too spread out. Exact numbers are for admins only
// until the calibration is verified on fresh data. Each view also shows the accuracy found in testing, so nobody has
// to guess how much skill sits behind it.
import { useAuth } from "@/components/Providers";
import { fmtPct, fmtPrice } from "@/lib/format";

export const DIRECTION_VIEWS = [["range", "Range vs trend"], ["lean", "Lean"], ["off", "Hide"]];
const GAP = 0.03;          // a difference smaller than this (3 points) counts as "about the usual"

function Frame({ title, seg, children }) {
  return (
    <div className="dirbar card" style={{ padding: 14 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: "0.92rem" }}>{title}</b>
        {seg}
      </div>
      {children}
    </div>
  );
}

function Accuracy({ auc, what }) {
  if (auc === null || auc === undefined || !Number.isFinite(auc)) return null;
  return <div className="faint num" style={{ fontSize: "0.76rem", marginTop: 6 }}>{what}: AUC {auc.toFixed(2)} (0.50 is a coin flip)</div>;
}

function RangeView({ r, probs, decimals, isAdmin, trained, seg }) {
  const p = r.p;
  const diff = r.base === null || r.base === undefined ? 0 : p - r.base;
  const word = diff > GAP ? "Range more likely than usual" : diff < -GAP ? "Trend more likely than usual" : "About the usual odds";
  return (
    <Frame title="Range vs trend · next 24 candles" seg={seg}>
      <div className="badge" style={{ marginTop: 8, alignSelf: "flex-start" }}>{word}</div>
      <div className="dirbar-track" role="img" aria-label={`Range ${fmtPct(p)}, trend ${fmtPct(1 - p)}`}>
        <span className="dirbar-side" style={{ width: `${p * 100}%` }} />
        <span className="dirbar-trend" style={{ width: `${(1 - p) * 100}%` }} />
      </div>
      <div className="dirbar-legend"><span>↔ Range</span><span>Trend ↗↘</span></div>
      <div className="faint" style={{ fontSize: "0.78rem", marginTop: 8, lineHeight: 1.5 }}>
        Range: price touches neither level in the next 24 candles. Trend: it touches one of them.
        {probs.up_level !== undefined && probs.down_level !== undefined
          ? ` Levels: up ${fmtPrice(probs.up_level, decimals)}, down ${fmtPrice(probs.down_level, decimals)}.` : ""}
      </div>
      <Accuracy auc={r.skill_auc} what="Range calls in testing" />
      {isAdmin ? (
        <div className="faint num" style={{ fontSize: "0.78rem", marginTop: 6 }}>
          Admin view: range {fmtPct(p)} · usual {r.base === null || r.base === undefined ? "n/a" : fmtPct(r.base)}
        </div>
      ) : null}
      <div className="hint" style={{ marginTop: 8 }}>
        {trained
          ? "The model's own range share, tested on data it never saw. A forecast, not a promise."
          : "Rough estimate: the trained model is not loaded on this server yet."}
      </div>
    </Frame>
  );
}

function LeanView({ l, probs, decimals, isAdmin, trained, seg }) {
  const d = l.up - l.down;
  const word = d > GAP ? "Leans up" : d < -GAP ? "Leans down" : "No clear lean";
  const tone = d > GAP ? "up" : d < -GAP ? "down" : "";
  const weak = l.skill_auc === null || l.skill_auc === undefined || !Number.isFinite(l.skill_auc) || l.skill_auc < 0.55;
  return (
    <Frame title="Lean · next 24 candles" seg={seg}>
      <div className={`badge ${tone}`} style={{ marginTop: 8, alignSelf: "flex-start" }}>{word}</div>
      <div className="dirbar-track" role="img"
        aria-label={`Up ${fmtPct(l.up)}, sideways ${fmtPct(l.sideways)}, down ${fmtPct(l.down)}`}>
        <span className="dirbar-up" style={{ width: `${l.up * 100}%` }} />
        <span className="dirbar-side" style={{ width: `${l.sideways * 100}%` }} />
        <span className="dirbar-down" style={{ width: `${l.down * 100}%` }} />
      </div>
      <div className="dirbar-legend"><span>▲ Up</span><span>↔ Sideways</span><span>▼ Down</span></div>
      {probs.up_level !== undefined && probs.down_level !== undefined ? (
        <div className="faint" style={{ fontSize: "0.78rem", marginTop: 8, lineHeight: 1.5 }}>
          Up means price touches {fmtPrice(probs.up_level, decimals)} within 24 candles. Down means it touches {fmtPrice(probs.down_level, decimals)}.
        </div>
      ) : null}
      <div style={{ fontSize: "0.8rem", marginTop: 8, color: weak ? "var(--warn)" : "var(--text-2)", lineHeight: 1.5 }}>
        {weak
          ? "Weak signal: in testing, up and down were close to a coin flip. Treat any lean as a small nudge, not a call."
          : "Modest signal in testing. Still a lean, not a promise."}
      </div>
      <Accuracy auc={l.skill_auc} what="Up versus down in testing" />
      {isAdmin ? (
        <div className="faint num" style={{ fontSize: "0.78rem", marginTop: 6 }}>
          Admin view: up {fmtPct(l.up)} · sideways {fmtPct(l.sideways)} · down {fmtPct(l.down)}
        </div>
      ) : null}
      <div className="hint" style={{ marginTop: 8 }}>
        {trained
          ? "Calibrated on data the curves never saw. Direction only, not a promise."
          : "Rough estimate: the trained model is not loaded on this server yet."}
      </div>
    </Frame>
  );
}

export default function DirectionBar({ probs, decimals, trained = true }) {
  const { user, settings, updateSettings } = useAuth();
  const saved = settings && settings.analysis ? settings.analysis.directionView : undefined;
  const view = saved === "lean" || saved === "off" ? saved : "range";
  const setView = (v) => updateSettings({ analysis: { directionView: v } });
  if (!probs) return null;

  if (view === "off") {
    return (
      <div className="dirbar-hidden">
        <span className="faint" style={{ fontSize: "0.8rem" }}>Bull / bear bar hidden.</span>
        <button className="btn sm ghost" onClick={() => setView("range")}>Show it</button>
      </div>
    );
  }

  const bar = probs.bar;
  if (!bar || !bar.calibrated) {
    return (
      <Frame title="Bull / bear bar" seg={null}>
        <div className="hint" style={{ marginTop: 8 }}>
          Not available yet: this server runs a brain without the calibration. Upload the newest brain to show it.
        </div>
      </Frame>
    );
  }

  const isAdmin = !!user && user.role === "admin";
  const seg = (
    <div className="seg brand" role="radiogroup" aria-label="Bull and bear bar view">
      {DIRECTION_VIEWS.map(([id, label]) => (
        <button key={id} className={view === id ? "on" : ""} role="radio" aria-checked={view === id} onClick={() => setView(id)}>
          {label}
        </button>
      ))}
    </div>
  );
  const common = { probs, decimals, isAdmin, trained, seg };
  return view === "lean" ? <LeanView l={bar.lean} {...common} /> : <RangeView r={bar.range} {...common} />;
}

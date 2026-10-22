"use client";
// Replay: go back to a past moment, see what the analyst said then, make your own call, then reveal what happened,
// or play the candles forward at 1x to 16x. Until you reveal or play, the chart stops at that moment. Calls are scored
// the same way as the verified track record. Your analysis of the moment can be saved to My analysis.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/Icons";
import { ApiError, get, post, qs } from "@/lib/api";
import { aiToDrawings, verdictTone } from "@/lib/analysis";
import PlanLadder from "@/components/terminal/PlanLadder";
import { CHART_TYPES } from "@/components/chart/series";

const AHEAD = 200;                       // candles of "what happened next" the chart shows after a reveal
const NO_CALL = { side: "", entry: "", sl: "", tp: "" };
// how the person felt making the call. Named before the outcome is known, and kept with the call for the model.
const FEELINGS = [["calm", "Calm"], ["confident", "Confident"], ["fomo", "FOMO"], ["fear", "Fear"],
  ["revenge", "Revenge"], ["bored", "Bored"], ["unsure", "Unsure"]];
const WORDS = {
  tp: "Target hit",
  sl: "Stop hit",
  time: "Closed at the time limit",
  missed: "Never filled, and the target was hit first",
  expired: "Never filled in time",
  void: "These levels don't fit the side",
  open: "Still playing out",
  pending: "Waiting for a fill",
  unknown: "Not enough data yet",
};
const TONE_OF_VERDICT = { buy: "up", sell: "down", wait: "warn" };
const SPEEDS = [1, 2, 3, 6, 8, 12, 16];
const JUMPS = [["1 day ago", 1], ["1 week ago", 7], ["1 month ago", 30], ["3 months ago", 91]];

// a Date as the value a datetime-local input takes (in local time)
function localInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function utcText(iso) {
  return iso ? `${iso.replace("T", " ").slice(0, 16)} UTC` : "";
}

// One card: a heading row with a status badge, the big result, and the trade drawn as a ladder.
function Card({ title, tone = "", badge, children }) {
  return (
    <div className="replay-card">
      <div className="replay-head">
        <span className="faint" style={{ fontSize: "0.8rem" }}>{title}</span>
        {badge ? <span className={`badge ${tone}`}>{badge}</span> : null}
      </div>
      {children}
    </div>
  );
}

// How a finished or running trade ended, as a card: the result in R after costs and the levels it was played on.
function OutcomeCard({ title, o, dec }) {
  if (!o) return null;
  const tone = o.status === "tp" ? "up" : o.status === "sl" ? "down" : o.status === "open" || o.status === "pending" ? "warn" : "";
  const side = o.side === "long" ? "Long" : o.side === "short" ? "Short" : "";
  return (
    <Card title={side ? `${title}, ${side.toLowerCase()}` : title} tone={tone} badge={WORDS[o.status] || o.status}>
      {typeof o.r === "number" ? (
        <div className="replay-r num">
          <span className={o.r >= 0 ? "up" : "down"}>{o.r >= 0 ? "+" : ""}{o.r.toFixed(2)}R</span>
          <span className="faint" style={{ fontSize: "0.8rem", fontWeight: 500 }}> after costs</span>
        </div>
      ) : null}
      {o.entry ? <PlanLadder p={{ entry: o.entry, sl: o.sl, tps: o.tp ? [o.tp] : [], rr: [] }} dec={dec} /> : null}
      {o.filled_at ? <div className="hint num" style={{ marginTop: 8 }}>Filled {utcText(o.filled_at)}</div> : null}
    </Card>
  );
}

/** Play the candles after the replay moment forward, one at a time, at the chosen speed. */
function Player({ eng, symbol, tf, at, onLimit, onStopHere, setError }) {
  const [speed, setSpeed] = useState(2);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(0);
  const data = useRef(null);
  useEffect(() => {
    data.current = null;
    setPlaying(false);
    setPos(0);
    setTotal(0);
    return () => { if (eng.current) eng.current.replayLock = false; };
  }, [at, eng]);
  const load = async () => {
    if (data.current) return data.current;
    try {
      const d = await get(`/market/candles?${qs({ symbol, tf, bars: 600, at, ahead: AHEAD })}`);
      const cut = Date.parse(at) / 1000;
      const base = d.candles.filter((c) => c[0] + d.tf_seconds <= cut + 1).length;
      data.current = { ...d, base };
      setTotal(d.candles.length - base);
      return data.current;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429) && onLimit) onLimit(e);
      else setError(e.message || "Couldn't load the candles after this moment.");
      return null;
    }
  };
  const show = (d, k) => {
    if (!eng.current) return;
    eng.current.replayLock = true;
    eng.current.setData(d.candles.slice(0, d.base + k), { tfSec: d.tf_seconds, decimals: d.decimals, keepView: true });
  };
  const stepBy = async (n) => {
    const d = await load();
    if (!d) return;
    setPos((p) => {
      const k = Math.max(0, Math.min(d.candles.length - d.base, p + n));
      show(d, k);
      return k;
    });
  };
  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => {
      const d = data.current;
      if (!d) return;
      setPos((p) => {
        if (p >= d.candles.length - d.base) {
          setPlaying(false);
          return p;
        }
        show(d, p + 1);
        return p + 1;
      });
    }, Math.round(1000 / speed));
    return () => clearInterval(t);
  }, [playing, speed]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async () => {
    if (playing) { setPlaying(false); return; }
    const d = await load();
    if (d) setPlaying(true);
  };
  const stopHere = () => {
    const d = data.current;
    setPlaying(false);
    if (!d || !pos) return;
    const c = d.candles[d.base + pos - 1];
    onStopHere(new Date((c[0] + d.tf_seconds) * 1000).toISOString());
  };
  return (
    <div className="rp-player">
      <div className="row" style={{ gap: 6 }}>
        <button className="icon-btn" onClick={() => stepBy(-1)} disabled={!pos} aria-label="One candle back"><Icon name="chevronLeft" size={18} /></button>
        <button className="btn primary sm rp-play" onClick={toggle}><Icon name={playing ? "pause" : "play"} size={15} /> {playing ? "Pause" : pos ? "Play" : "Play forward"}</button>
        <button className="icon-btn" onClick={() => stepBy(1)} aria-label="One candle forward"><Icon name="chevronRight" size={18} /></button>
        <span className="grow faint num" style={{ fontSize: "0.78rem", textAlign: "right" }}>{pos ? `+${pos}${total ? ` / ${total}` : ""} candles` : ""}</span>
      </div>
      <div className="rp-speeds" role="radiogroup" aria-label="Speed">
        {SPEEDS.map((x) => <button key={x} role="radio" aria-checked={speed === x} className={speed === x ? "on" : ""} onClick={() => setSpeed(x)}>{x}×</button>)}
      </div>
      {pos ? <button className="btn sm" onClick={stopHere}><Icon name="target" size={14} /> Make this candle the replay moment</button> : null}
    </div>
  );
}

export default function ReplayPanel({ symbol, tf, replay, setReplay, onAnalysis, onLimit, chartType, onChartType, eng }) {
  const router = useRouter();
  const at = replay ? replay.at : null;
  const [when, setWhen] = useState(() => localInput(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const [analysis, setAnalysis] = useState(null);
  const [call, setCall] = useState(NO_CALL);
  const [feel, setFeel] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // another moment starts again from scratch
  useEffect(() => {
    setAnalysis(null);
    setCall(NO_CALL);
    setFeel("");
    setNote("");
    setResult(null);
    setError(null);
    if (onAnalysis) onAnalysis(null);
  }, [at]);

  const dec = analysis && analysis.meta ? analysis.meta.decimals : 2;
  const plan = analysis ? analysis.plan : null;
  const verdict = analysis ? analysis.verdict || {} : {};
  const locked = !!(result && result.final);
  const decided = !!(result && result.decision);      // the call is written down: it cannot change now
  const canReveal = !!analysis && !locked && (!!plan || !!call.side);

  const show = () => {
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) { setError("Pick a date and time."); return; }
    if (d.getTime() >= Date.now()) { setError("Pick a moment in the past."); return; }
    setError(null);
    setReplay({ at: d.toISOString(), ahead: 0 });
  };

  const analyse = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await post("/replay/analyze", { symbol, tf, at });
      setAnalysis(d);
      if (onAnalysis) onAnalysis(d, { symbol, tf, at });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 429) && onLimit) onLimit(e);
      else setError(e.message || "The analysis failed.");
    }
    setBusy(false);
  };

  // this moment, the analyst's drawings and your own, and your call, as an analysis in My analysis
  const saveMine = async () => {
    setBusy(true);
    try {
      const mineDrawings = eng && eng.current ? eng.current.getDrawings() : [];
      const drawings = (analysis ? aiToDrawings(analysis) : []).concat(mineDrawings);
      const n = (x) => Number(x);
      const myPlan = call.side && n(call.entry) > 0 && n(call.sl) > 0 && n(call.tp) > 0
        ? { side: call.side, entry: n(call.entry), sl: n(call.sl), tps: [n(call.tp)] }
        : plan ? { side: plan.side, entry: plan.entry, sl: plan.sl, tps: (plan.tps || []).slice(0, 3) } : null;
      const d = await post("/my-analyses", {
        symbol, tf, source: "replay", replay_at: at, drawings, plan: myPlan,
        title: `${symbol} · ${tf} · replay ${at.slice(0, 16).replace("T", " ")}`,
        ai: analysis ? { action: verdict.action, headline: verdict.headline, plan: plan ? { side: plan.side, entry: plan.entry, sl: plan.sl, tps: plan.tps } : null } : null,
      });
      router.push(`/desk?id=${d.id}`);
    } catch (e) {
      setError(e.message || "Couldn't save it.");
    }
    setBusy(false);
  };

  const reveal = async () => {
    let mine = {};
    if (call.side) {
      const entry = Number(call.entry);
      const sl = Number(call.sl);
      const tp = Number(call.tp);
      if (!(entry > 0 && sl > 0 && tp > 0)) { setError("Fill in entry, stop and target, or leave the call empty."); return; }
      mine = { side: call.side, entry, sl, tp, emotion: feel || null, note: note.trim() || null };
    }
    setBusy(true);
    setError(null);
    try {
      const d = await post("/replay/reveal", { replay_id: analysis.replay_id, ...mine });
      setResult(d);
      if (d.decision) {
        setCall({ side: d.decision.side, entry: String(d.decision.entry), sl: String(d.decision.sl), tp: String(d.decision.tp) });
        setFeel(d.decision.emotion || "");
        setNote(d.decision.note || "");
      }
      setReplay({ at, ahead: AHEAD });
    } catch (e) {
      setError(e.message || "Couldn't reveal this replay.");
    }
    setBusy(false);
  };

  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <b style={{ fontSize: "0.92rem" }}>Replay a past moment</b>
      <div className="hint" style={{ lineHeight: 1.5 }}>
        Go back to a moment on {symbol} {tf}. The chart stops there, the analyst reads only what was known then, and you
        see what happened next when you reveal it. Past results don&apos;t predict the future.
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <div className="label">Go back to</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {JUMPS.map(([l, days]) => (
            <button key={l} className="chip" onClick={() => { setError(null); setReplay({ at: new Date(Date.now() - days * 86400000).toISOString(), ahead: 0 }); }}>{l}</button>
          ))}
          <button className="chip" onClick={() => { setError(null); setReplay({ at: new Date(Date.now() - (2 + Math.random() * 120) * 86400000).toISOString(), ahead: 0 }); }}>Surprise me</button>
        </div>
        <div className="label" style={{ marginTop: 4 }}>Or a date and time (your local time)</div>
        <div className="row" style={{ gap: 6 }}>
          <input className="input" type="datetime-local" value={when} max={localInput(new Date())} onChange={(e) => setWhen(e.target.value)} />
          <button className="btn" onClick={show}>Go</button>
        </div>
        {onChartType ? (
          <button className="rp-type" onClick={onChartType}>
            <span className="grow">Chart type: <b>{(CHART_TYPES.find((t) => t.id === chartType) || {}).label || "Candles"}</b></span>
            <Icon name="chevronRight" size={15} />
          </button>
        ) : null}
      </div>

      {at ? (
        <div className="stack" style={{ gap: 10 }}>
          <div className="hint">Chart stops at {utcText(at)}. Candles after it stay hidden until you reveal or play forward.</div>
          {eng ? <Player eng={eng} symbol={symbol} tf={tf} at={at} onLimit={onLimit} setError={setError}
            onStopHere={(iso) => setReplay({ at: iso, ahead: 0 })} /> : null}

          {!analysis ? (
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn primary" disabled={busy} onClick={analyse}>{busy ? "Analysing…" : "Analyse this moment"}</button>
            </div>
          ) : (
            <>
              <Card title="What the analyst saw" tone={TONE_OF_VERDICT[verdictTone(verdict)]}
                badge={verdict.action || "No verdict"}>
                {verdict.headline ? <div className="muted" style={{ fontSize: "0.88rem" }}>{verdict.headline}</div> : null}
                {plan ? <PlanLadder p={plan} dec={dec} /> : <div className="hint">The analyst didn&apos;t call a trade here.</div>}
              </Card>

              <div className="stack" style={{ gap: 8 }}>
                <div className="label">Your call (optional)</div>
                <div className="hint">Scored the same way as the analyst&apos;s. A limit order fills when price reaches your entry. Once you reveal, the call is written down and can&apos;t change.</div>
                <select className="select" value={call.side} disabled={decided || locked} onChange={(e) => setCall({ ...call, side: e.target.value })}>
                  <option value="">No call</option>
                  <option value="long">Long (buy)</option>
                  <option value="short">Short (sell)</option>
                </select>
                <div className="grid-2" style={{ gap: 8 }}>
                  {[["entry", "Entry"], ["sl", "Stop"], ["tp", "Target"]].map(([k, l]) => (
                    <input key={k} className="input" type="number" step="any" placeholder={l} aria-label={l} value={call[k]}
                      disabled={decided || locked} onChange={(e) => setCall({ ...call, [k]: e.target.value })} />
                  ))}
                </div>
                {call.side ? (
                  <>
                    <div className="label">How do you feel about it?</div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {FEELINGS.map(([k, l]) => (
                        <button key={k} type="button" className={`chip ${feel === k ? "on" : ""}`} aria-pressed={feel === k}
                          disabled={decided || locked} onClick={() => setFeel(feel === k ? "" : k)}>{l}</button>
                      ))}
                    </div>
                    <textarea className="input" rows={2} maxLength={280} placeholder="Why this call? (optional)" aria-label="Why this call"
                      value={note} disabled={decided || locked} onChange={(e) => setNote(e.target.value)} />
                  </>
                ) : null}
              </div>

              {!locked ? (
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <button className="btn primary" disabled={!canReveal || busy} onClick={reveal}>
                    {busy ? "Revealing…" : result ? "Reveal again" : "Reveal what happened"}
                  </button>
                </div>
              ) : null}

              {result ? (
                <div className="stack" style={{ gap: 10 }}>
                  <OutcomeCard title="Analyst" o={result.analyst} dec={dec} />
                  <OutcomeCard title="Your call" o={result.user} dec={dec} />
                  {!result.final ? <div className="hint">Not finished yet. Reveal again later to see the rest.</div> : null}
                  {result.coach && result.coach.length ? (
                    <div className="replay-card">
                      <div className="replay-head"><span className="faint" style={{ fontSize: "0.8rem" }}>Coach</span></div>
                      {result.coach.map((t, i) => <div key={i} className="hint" style={{ lineHeight: 1.5, marginTop: i ? 8 : 0 }}>{t}</div>)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {error ? <div className="hint" style={{ color: "var(--warn)" }}>{error}</div> : null}
      {at ? (
        <div className="row wrap" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn sm" disabled={busy} onClick={saveMine} title="Save this moment with the analyst's drawings, yours and your call">
            <Icon name="book" size={14} /> Save to My analysis
          </button>
          <button className="btn ghost sm" onClick={() => setReplay(null)}>Back to live chart</button>
        </div>
      ) : null}
    </div>
  );
}

"use client";
// Replay: go back to a past moment, see what the analyst said then, make your own call, then reveal what happened.
// Until you reveal, the chart stops at that moment. Calls are scored the same way as the verified track record.
import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { verdictTone } from "@/lib/analysis";
import PlanLadder from "@/components/terminal/PlanLadder";

const AHEAD = 200;                       // candles of "what happened next" the chart shows after a reveal
const NO_CALL = { side: "", entry: "", sl: "", tp: "" };
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

export default function ReplayPanel({ symbol, tf, replay, setReplay }) {
  const at = replay ? replay.at : null;
  const [when, setWhen] = useState(() => localInput(new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const [analysis, setAnalysis] = useState(null);
  const [call, setCall] = useState(NO_CALL);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // another moment starts again from scratch
  useEffect(() => {
    setAnalysis(null);
    setCall(NO_CALL);
    setResult(null);
    setError(null);
  }, [at]);

  const dec = analysis && analysis.meta ? analysis.meta.decimals : 2;
  const plan = analysis ? analysis.plan : null;
  const verdict = analysis ? analysis.verdict || {} : {};
  const locked = !!(result && result.final);
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
      setAnalysis(await post("/replay/analyze", { symbol, tf, at }));
    } catch (e) {
      setError(e.message || "The analysis failed.");
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
      mine = { side: call.side, entry, sl, tp };
    }
    setBusy(true);
    setError(null);
    try {
      const d = await post("/replay/reveal", { replay_id: analysis.replay_id, ...mine });
      setResult(d);
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
        <div className="label">Date and time (your local time)</div>
        <input className="input" type="datetime-local" value={when} max={localInput(new Date())}
          onChange={(e) => setWhen(e.target.value)} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={show}>Show the chart then</button>
        </div>
      </div>

      {at ? (
        <div className="stack" style={{ gap: 10 }}>
          <div className="hint">Chart stops at {utcText(at)}. Candles after it stay hidden until you reveal.</div>

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
                <div className="hint">Scored the same way as the analyst&apos;s. A limit order fills when price reaches your entry.</div>
                <select className="select" value={call.side} disabled={locked} onChange={(e) => setCall({ ...call, side: e.target.value })}>
                  <option value="">No call</option>
                  <option value="long">Long (buy)</option>
                  <option value="short">Short (sell)</option>
                </select>
                <div className="grid-2" style={{ gap: 8 }}>
                  {[["entry", "Entry"], ["sl", "Stop"], ["tp", "Target"]].map(([k, l]) => (
                    <input key={k} className="input" type="number" step="any" placeholder={l} aria-label={l} value={call[k]}
                      disabled={locked} onChange={(e) => setCall({ ...call, [k]: e.target.value })} />
                  ))}
                </div>
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
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {error ? <div className="hint" style={{ color: "var(--warn)" }}>{error}</div> : null}
      {at ? (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={() => setReplay(null)}>Back to live chart</button>
        </div>
      ) : null}
    </div>
  );
}

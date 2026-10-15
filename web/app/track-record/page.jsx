"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import Icon from "@/components/Icons";
import EquityCurve from "@/components/EquityCurve";
import SubNav from "@/components/SubNav";
import { useAuth } from "@/components/Providers";
import { Spinner } from "@/components/ui";
import { get, qs } from "@/lib/api";
import { gradeClass } from "@/lib/analysis";
import { fmtDateTime, fmtPct, fmtPrice, timeAgo } from "@/lib/format";

const signed = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}`);
const OUTCOME = {
  tp: ["Target hit", "up"], sl: ["Stopped out", "down"], time: ["Time exit", ""], expired: ["Expired unfilled", ""],
  missed: ["Missed (target first)", ""], open: ["Running", "brand"], pending: ["Waiting for fill", "violet"], dup: ["Same as an earlier call", ""],
};
const TF_OPTS = [["", "All"], ["15m", "15m"], ["1h", "1h"], ["4h", "4h"], ["1D", "1D"]];
const DAY_OPTS = [[30, "30 days"], [90, "90 days"], [365, "1 year"]];
const CALL_OPTS = [["called", "Trades it called"], ["rejected", "Ideas it rejected"], ["all", "Everything"]];

function decOf(p) {
  if (!Number.isFinite(p)) return 2;
  const a = Math.abs(p);
  return a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 6;
}

function Method({ text, rules }) {
  if (!text) return null;
  const [head, ...rest] = text.split("\n- ");
  const items = rest.map((x) => x.replace(/\n\s*/g, " ").trim());
  return (
    <details className="fold">
      <summary><span><Icon name="book" size={15} /> How every call is judged</span><span className="faint" style={{ fontSize: "0.78rem" }}>orders valid {rules ? rules.expiry : 24} candles · held up to {rules ? rules.max_hold : 100}</span></summary>
      <div className="stack" style={{ gap: 8, fontSize: "0.88rem" }}>
        <div className="muted">{head.replace(/\n\s*/g, " ").replace(/:$/, ".")}</div>
        <ul className="check-list">{items.map((t, i) => <li key={i} className="ok"><span className="ic">✓</span><span>{t}</span></li>)}</ul>
      </div>
    </details>
  );
}

function GroupTable({ rows, keyName, label }) {
  if (!rows || !rows.length) return null;
  const maxAbs = Math.max(0.25, ...rows.map((r) => Math.abs(r.avg_r || 0)));
  return (
    <div className="table-wrap">
      <table className="t" style={{ minWidth: 0 }}>
        <thead><tr><th>{label}</th><th style={{ textAlign: "right" }}>Calls</th><th style={{ textAlign: "right" }}>Resolved</th><th style={{ textAlign: "right" }}>Win rate</th><th>Average result</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const w = r.avg_r === null ? 0 : (Math.abs(r.avg_r) / maxAbs) * 50;
            return (
              <tr key={r[keyName]}>
                <td>{keyName === "grade" ? <span className={`grade ${gradeClass(r.grade)}`} style={{ width: 30, height: 30, fontSize: "0.85rem" }}>{r.grade}</span> : <b>{r[keyName]}</b>}</td>
                <td className="num" style={{ textAlign: "right" }}>{r.calls}</td>
                <td className="num" style={{ textAlign: "right" }}>{r.resolved}</td>
                <td className="num" style={{ textAlign: "right" }}>{fmtPct(r.win_rate)}</td>
                <td style={{ minWidth: 160 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="div-bar" aria-hidden="true">
                      <i className={r.avg_r >= 0 ? "pos" : "neg"} style={{ width: `${w}%`, [r.avg_r >= 0 ? "left" : "right"]: "50%" }} />
                    </div>
                    <b className={`num ${r.avg_r > 0 ? "up" : r.avg_r < 0 ? "down" : ""}`} style={{ minWidth: 54, textAlign: "right" }}>{r.avg_r === null ? "—" : `${signed(r.avg_r)}R`}</b>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TrackRecordPage() {
  const { user } = useAuth();
  const [width, setWidth] = useState(1400);
  useEffect(() => {
    const f = () => setWidth(window.innerWidth);
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const mobile = width <= 760;
  const [scope, setScope] = useState("all");
  const [tf, setTf] = useState("");
  const [days, setDays] = useState(90);
  const [calls, setCalls] = useState("called");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    get(`/track-record?${qs({ scope, tf: tf || undefined, days, calls })}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [scope, tf, days, calls]);

  const s = data && data.summary;
  const running = s ? (s.status.open || 0) + (s.status.pending || 0) : 0;
  const unfilled = s ? (s.status.expired || 0) + (s.status.missed || 0) : 0;
  const [showAll, setShowAll] = useState(false);
  const tone = s && s.resolved >= 30 ? (s.verdict.startsWith("positive and") ? "up" : s.verdict.startsWith("positive") ? "warn" : "down") : "";
  const cmp = data && data.compare;
  return (
    <div className="page lab-page">
      <SubNav mobile={mobile} />
      <main className="container stack tr" style={{ gap: 18, paddingTop: 22, paddingBottom: 60, maxWidth: 1240 }}>
        <div>
          <div className="eyebrow">Track record</div>
          <h1 className="h-display" style={{ fontSize: "clamp(1.7rem, 3.6vw, 2.5rem)", margin: "6px 0 8px" }}>Every call, checked against the market.</h1>
          <p className="muted" style={{ maxWidth: 760, margin: 0 }}>
            When the analyst says trade, the call is saved with its entry, stop and target, then followed on live prices until it hits the target, hits the stop or expires.
            Results are computed by the server and never edited. You see the losses too.
          </p>
        </div>

        <div className="row wrap tr-controls">
          {user ? (
            <div className="seg brand" role="radiogroup" aria-label="Whose calls">
              {[["all", "All calls"], ["mine", "My analyses"]].map(([v, l]) => <button key={v} className={scope === v ? "on" : ""} onClick={() => setScope(v)}>{l}</button>)}
            </div>
          ) : null}
          <div className="seg" role="radiogroup" aria-label="Which calls">
            {CALL_OPTS.map(([v, l]) => <button key={v} className={calls === v ? "on" : ""} onClick={() => setCalls(v)}>{l}</button>)}
          </div>
          <div className="seg" role="radiogroup" aria-label="Timeframe">
            {TF_OPTS.map(([v, l]) => <button key={l} className={tf === v ? "on" : ""} onClick={() => setTf(v)}>{l}</button>)}
          </div>
          <div className="seg" role="radiogroup" aria-label="Period">
            {DAY_OPTS.map(([v, l]) => <button key={v} className={days === v ? "on" : ""} onClick={() => setDays(v)}>{l}</button>)}
          </div>
          {loading && data ? <Spinner /> : null}
        </div>

        {error ? <div className="card" style={{ padding: 18 }}><b>Couldn't load the record.</b><div className="muted">{error}</div></div> : null}
        {!data && !error ? <div style={{ padding: 40, display: "grid", placeItems: "center" }}><Spinner /></div> : null}

        {s ? (
          s.calls === 0 ? (
            <div className="card" style={{ padding: 22 }}>
              <b>No {calls === "rejected" ? "rejected ideas" : "calls"} tracked {scope === "mine" ? "for you " : ""}in this period yet.</b>
              <div className="muted" style={{ marginTop: 6 }}>
                Every analysis with a trade plan is followed automatically. {scope === "mine" ? "Run an analysis in the terminal and its plan appears here, then resolves as the market moves." : "Results appear as the market resolves them."}
              </div>
              {user ? <Link href="/terminal" className="btn primary" style={{ marginTop: 12 }}><Icon name="zap" size={16} /> Open the terminal</Link> : <Link href="/signup" className="btn primary" style={{ marginTop: 12 }}>Start free</Link>}
            </div>
          ) : (
            <>
              <div className={`verdict-bar ${tone}`}>
                <Icon name={tone === "up" ? "check" : tone === "down" ? "alert" : "info"} size={18} />
                <div>
                  <b>Verdict so far: {s.verdict}.</b>
                  <div style={{ fontSize: "0.82rem", opacity: 0.9 }}>
                    {s.resolved} resolved of {s.calls} {calls === "rejected" ? "rejected ideas" : "calls"} in the last {days} days{tf ? ` on ${tf}` : ""}
                    {s.t_stat !== null && s.t_stat !== undefined ? ` · t-stat ${s.t_stat.toFixed(2)} (2+ means it's unlikely to be luck)` : ""}
                    {data.updated_at ? ` · checked ${timeAgo(data.updated_at)}` : ""}
                  </div>
                </div>
              </div>
              <div className="stats lab-stats">
                <div className="card stat"><div className="k">Resolved</div><div className="v">{s.resolved}</div>
                  <div className="faint" style={{ fontSize: "0.76rem" }}>{s.exits.tp} targets · {s.exits.sl} stops · {s.exits.time} timed out</div></div>
                <div className="card stat"><div className="k">Win rate</div><div className="v">{fmtPct(s.win_rate)}</div>
                  <div className="faint" style={{ fontSize: "0.76rem" }}>results above 0R after costs</div></div>
                <div className="card stat"><div className="k">Average per call</div><div className={`v ${s.avg_r > 0 ? "up" : s.avg_r < 0 ? "down" : ""}`}>{s.avg_r === null ? "—" : `${signed(s.avg_r)}R`}</div>
                  <div className="faint" style={{ fontSize: "0.76rem" }}>R = multiples of the planned risk</div></div>
                <div className="card stat"><div className="k">Total</div><div className={`v ${s.total_r > 0 ? "up" : s.total_r < 0 ? "down" : ""}`}>{signed(s.total_r, 1)}R</div>
                  <div className="faint" style={{ fontSize: "0.76rem" }}>at 1% risk per call ≈ {signed(s.total_r, 0)}%</div></div>
                <div className="card stat"><div className="k">Orders filled</div><div className="v">{fmtPct(s.fill_rate)}</div>
                  <div className="faint" style={{ fontSize: "0.76rem" }}>{unfilled} limit/stop order{unfilled === 1 ? "" : "s"} never filled</div></div>
                <div className="card stat"><div className="k">Still running</div><div className="v">{running}</div>
                  <div className="faint" style={{ fontSize: "0.76rem" }}>{s.status.open || 0} in a trade · {s.status.pending || 0} waiting to fill</div></div>
              </div>

              <div className="tr-grid">
                <div className="card" style={{ padding: 14 }}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <b>Cumulative result</b><span className="faint" style={{ fontSize: "0.8rem" }}>R after each resolved call</span>
                  </div>
                  <EquityCurve equity={data.equity} unit="call" />
                </div>
                {cmp ? (
                  <div className="card" style={{ padding: 16 }}>
                    <b>Does the "trade / don't trade" filter help?</b>
                    <div className="muted" style={{ fontSize: "0.84rem", margin: "4px 0 12px" }}>The analyst also writes plans it decides not to trade. Both are followed, so you can see whether saying no was right.</div>
                    {[["called", "Trades it called"], ["rejected", "Ideas it rejected"]].map(([k, l]) => (
                      <div key={k} className="row" style={{ justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                        <span>{l}</span>
                        <span className="faint num" style={{ fontSize: "0.82rem" }}>{cmp[k].resolved} resolved · win {fmtPct(cmp[k].win_rate)}</span>
                        <b className={`num ${cmp[k].avg_r > 0 ? "up" : cmp[k].avg_r < 0 ? "down" : ""}`}>{cmp[k].avg_r === null ? "—" : `${signed(cmp[k].avg_r)}R`}</b>
                      </div>
                    ))}
                    <div className="hint" style={{ marginTop: 6 }}>Small samples swing a lot. Judge it after 30+ resolved calls in each group.</div>
                  </div>
                ) : null}
              </div>

              <div className="tr-grid">
                <div>
                  <div className="section-title">By grade</div>
                  <GroupTable rows={data.by_grade} keyName="grade" label="Grade" />
                  <div className="hint" style={{ marginTop: 6 }}>If grades mean anything, A+ and A should beat B and C over time.</div>
                </div>
                <div>
                  <div className="section-title">By timeframe</div>
                  <GroupTable rows={data.by_tf} keyName="tf" label="Timeframe" />
                </div>
              </div>

              <div>
                <div className="section-title">Latest calls</div>
                <div className="table-wrap">
                  <table className="t">
                    <thead><tr><th>Called</th><th>Market</th><th>Side</th><th>Grade</th><th>Entry</th><th>Stop</th><th>Target</th><th>Result</th><th style={{ textAlign: "right" }}>R</th></tr></thead>
                    <tbody>
                      {(showAll ? data.recent : data.recent.slice(0, 15)).map((r) => {
                        const [label, cls] = OUTCOME[r.outcome] || [r.outcome, ""];
                        const d = decOf(r.entry);
                        return (
                          <tr key={r.id}>
                            <td className="num">{fmtDateTime(r.created_at)}</td>
                            <td><b>{r.symbol}</b> <span className="faint">{r.tf}</span></td>
                            <td><span className={`badge ${r.side === "long" ? "up" : "down"}`}>{r.side === "long" ? "buy" : "sell"} {r.type || ""}</span></td>
                            <td>{r.grade ? <span className={`grade ${gradeClass(r.grade)}`} style={{ width: 28, height: 28, fontSize: "0.8rem" }}>{r.grade}</span> : "—"}</td>
                            <td className="num">{fmtPrice(r.entry, d)}</td>
                            <td className="num">{fmtPrice(r.sl, d)}</td>
                            <td className="num">{fmtPrice(r.tp, d)}</td>
                            <td><span className={`badge ${cls}`}>{label}</span>{r.outcome_at && ["tp", "sl", "time"].includes(r.outcome) ? <div className="faint" style={{ fontSize: "0.72rem" }}>{fmtDateTime(r.outcome_at)}</div> : null}</td>
                            <td className={`num ${r.r > 0 ? "up" : r.r < 0 ? "down" : ""}`} style={{ textAlign: "right", fontWeight: 700 }}>{r.r === null || r.r === undefined ? "—" : signed(r.r)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {data.recent.length > 15 ? (
                  <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>
                    {showAll ? "Show fewer" : `Show the latest ${data.recent.length}`}
                  </button>
                ) : null}
              </div>
            </>
          )
        ) : null}
        {data ? <Method text={data.method} rules={data.rules} /> : null}
        <div className="hint">Past results describe the past and don't guarantee future ones. Trading carries risk; size every trade so a loss is affordable.</div>
      </main>
    </div>
  );
}

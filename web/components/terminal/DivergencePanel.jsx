"use client";
// The divergence scorecard: regular divergence on nine oscillators, and how each one's past signals played out.
// Runs on request, for the market and timeframe on the chart. Past results are not a forecast.
import { useEffect, useState } from "react";
import { get, qs } from "@/lib/api";

const CELL = { textAlign: "right", padding: "6px 4px", whiteSpace: "nowrap" };
const RULE = "1px solid rgba(128, 128, 128, 0.25)";

function show(v, suffix = "") {
  return v === null || v === undefined ? "–" : `${v}${suffix}`;
}

export default function DivergencePanel({ symbol, tf }) {
  const [st, setSt] = useState({ loading: false, data: null, error: null });

  // A different market or timeframe means the old result no longer applies.
  useEffect(() => {
    setSt({ loading: false, data: null, error: null });
  }, [symbol, tf]);

  const run = async () => {
    setSt({ loading: true, data: null, error: null });
    try {
      const data = await get(`/market/divergence?${qs({ symbol, tf })}`);
      setSt({ loading: false, data, error: null });
    } catch (e) {
      setSt({ loading: false, data: null, error: (e && e.message) || "Couldn't score this market right now." });
    }
  };

  const { loading, data, error } = st;
  return (
    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: "0.92rem" }}>Divergence scorecard</b>
        <button className="btn sm" onClick={run} disabled={loading}>
          {loading ? "Scoring…" : data ? "Run again" : `Run on ${tf}`}
        </button>
      </div>
      <div className="hint" style={{ lineHeight: 1.5 }}>
        Price makes a new high or low that an oscillator doesn&apos;t confirm. Each oscillator is scored on its past
        signals, after costs. Past results don&apos;t predict the future.
      </div>
      {error ? <div className="hint" style={{ color: "var(--warn)" }}>{error}</div> : null}

      {data ? (
        <>
          <div className="faint num" style={{ fontSize: "0.78rem" }}>
            {data.symbol} · {data.tf} · {data.bars} candles · {data.source}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
              <thead>
                <tr className="faint" style={{ textAlign: "left" }}>
                  <th style={{ padding: "6px 4px" }}>Oscillator</th>
                  <th style={CELL}>Signals</th>
                  <th style={CELL}>Win rate</th>
                  <th style={CELL}>Avg win</th>
                  <th style={CELL}>Avg loss</th>
                  <th style={CELL}>Total</th>
                </tr>
              </thead>
              <tbody>
                {data.indicators.map((r) => (
                  <tr key={r.key} style={{ borderTop: RULE, opacity: r.enough ? 1 : 0.6 }}>
                    <td style={{ padding: "6px 4px" }}>
                      {r.name}
                      {!r.enough ? <span className="faint"> · few signals</span> : null}
                    </td>
                    <td style={CELL}>{r.signals}</td>
                    <td style={CELL}>{show(r.win_rate, "%")}</td>
                    <td style={CELL}>{show(r.avg_win_atr, " ATR")}</td>
                    <td style={CELL}>{show(r.avg_loss_atr, " ATR")}</td>
                    <td style={CELL}>{show(r.cumulative_atr, " ATR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="faint" style={{ fontSize: "0.78rem", marginBottom: 4 }}>Fresh divergences</div>
            {data.fresh.length ? (
              data.fresh.map((f, i) => (
                <div key={i} style={{ fontSize: "0.8rem", padding: "3px 0" }}>
                  <span className={`badge ${f.direction === "bullish" ? "up" : "down"}`}>{f.direction}</span>{" "}
                  {f.name} · {f.bars_ago === 0 ? "just confirmed" : `${f.bars_ago} candles ago`}
                </div>
              ))
            ) : (
              <div className="faint" style={{ fontSize: "0.8rem" }}>None in the last few candles.</div>
            )}
          </div>

          {data.notes.map((n, i) => (
            <div key={i} className="hint" style={{ lineHeight: 1.5 }}>{n}</div>
          ))}
        </>
      ) : null}
    </div>
  );
}

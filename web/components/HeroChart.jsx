"use client";
import { useEffect, useRef, useState } from "react";
import ChartView from "@/components/chart/ChartView";
import { get } from "@/lib/api";

function decorative(n = 160) {
  // a smooth made-up series, only used when live data can't load (labelled "Preview")
  const out = [];
  let p = 100;
  const t0 = Math.floor(Date.now() / 3600000) * 3600 - n * 3600;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + Math.sin(i / 9) * 0.004 + Math.cos(i / 4.3) * 0.003 + ((i * 7919) % 13 - 6) * 0.0009);
    const h = Math.max(o, p) * (1 + 0.002 + ((i * 31) % 7) * 0.0006);
    const l = Math.min(o, p) * (1 - 0.002 - ((i * 17) % 5) * 0.0006);
    out.push([t0 + i * 3600, o, h, l, p, 1000 + ((i * 37) % 400)]);
  }
  return out;
}

function sketch(rows) {
  // structure that is simply true of the data: the range high/low (liquidity) and its midpoint
  const recent = rows.slice(-90);
  let hi = -Infinity;
  let lo = Infinity;
  let hiT = 0;
  let loT = 0;
  for (const r of recent) {
    if (r[2] > hi) { hi = r[2]; hiT = r[0]; }
    if (r[3] < lo) { lo = r[3]; loT = r[0]; }
  }
  const last = rows[rows.length - 1][0];
  const step = rows.length > 1 ? rows[1][0] - rows[0][0] : 3600;
  const eq = (hi + lo) / 2;
  return [
    { id: "z1", layer: "zones", kind: "box", order: 2, prio: 1, t1: hiT, t2: last + step * 16, p1: hi - (hi - lo) * 0.06, p2: hi, fill: "rgba(239,83,80,0.13)", extend: "right", text: "Range high" },
    { id: "z2", layer: "zones", kind: "box", order: 2, prio: 1, t1: loT, t2: last + step * 16, p1: lo, p2: lo + (hi - lo) * 0.06, fill: "rgba(38,166,154,0.13)", extend: "right", text: "Range low" },
    { id: "l1", layer: "liquidity", kind: "line", order: 3, prio: 1, t1: hiT, t2: last + step * 16, p1: hi, p2: hi, color: "#b388ff", dash: "dashdot", width: 1, text: "Buy-side liquidity", extend: "right" },
    { id: "l2", layer: "liquidity", kind: "line", order: 3, prio: 1, t1: loT, t2: last + step * 16, p1: lo, p2: lo, color: "#b388ff", dash: "dashdot", width: 1, text: "Sell-side liquidity", extend: "right" },
    { id: "e1", layer: "range", kind: "line", order: 4, prio: 1, t1: Math.min(hiT, loT), t2: last + step * 16, p1: eq, p2: eq, color: "rgba(209,212,220,0.55)", dash: "dash", width: 1, text: "Equilibrium 50%", extend: "right" },
  ];
}

export default function HeroChart() {
  const eng = useRef(null);
  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    const show = (rows, decimals, label) => {
      const e = eng.current;
      if (!e || !alive) return;
      e.setTheme({ bg: "#000000" });
      e.setOptions({ volume: true, watermark: true, indicators: { ema50: true, ema200: false, ema20: false } });
      e.setData(rows, { tfSec: rows.length > 1 ? rows[1][0] - rows[0][0] : 3600, decimals, label });
      setTimeout(() => e.setAnalysis(sketch(rows), { animate: true, pins: [] }), 500);
    };
    get("/market/demo")
      .then((d) => { setLive(d.display || "BTC/USDT"); show(d.candles, d.decimals, `${d.display} · 1h`); })
      .catch(() => { setLive(false); show(decorative(), 2, "STREIXANALYST"); });
    return () => { alive = false; };
  }, [ready]);
  return (
    <div className="hero-chart">
      <ChartView interactive={false} onReady={(e) => { eng.current = e; setReady(!!e); }} />
      <div style={{ position: "absolute", left: 14, top: 12, zIndex: 3, display: "flex", gap: 8, pointerEvents: "none" }}>
        {live ? <span className="badge up"><span className="live-dot" /> Live {live} · 1h</span> : live === false ? <span className="badge">Preview</span> : null}
      </div>
    </div>
  );
}

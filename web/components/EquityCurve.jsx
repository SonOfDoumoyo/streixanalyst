"use client";
import { useEffect, useRef, useState } from "react";
import { fmtDate, fmtDateTime } from "@/lib/format";

const signed = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}`);

/** Cumulative R per closed trade, with a crosshair tooltip. */
export default function EquityCurve({ equity, height = 180, unit = "trade" }) {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600));
    ro.observe(el);
    setW(el.clientWidth || 600);
    return () => ro.disconnect();
  }, []);
  if (!equity || !equity.length) return <div className="empty">No closed trades to plot.</div>;
  const pts = [[equity[0][0], 0], ...equity];
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.08 || 1;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const L = 44;
  const R = 10;
  const T = 10;
  const B = 22;
  const iw = Math.max(10, w - L - R);
  const ih = height - T - B;
  const x = (i) => L + (pts.length > 1 ? (i / (pts.length - 1)) * iw : iw / 2);
  const y = (v) => T + ((yMax - v) / (yMax - yMin)) * ih;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const area = `${path}L${x(pts.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const last = vals[vals.length - 1];
  const stroke = last >= 0 ? "var(--eq-up)" : "var(--eq-down)";
  const ticks = [yMin + pad, 0, yMax - pad].filter((v, i, a) => a.findIndex((u) => Math.abs(u - v) < (yMax - yMin) * 0.12) === i);
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - L) / iw) * (pts.length - 1))));
    setHover(i);
  };
  const hv = hover !== null ? pts[hover] : null;
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={w} height={height} role="img" aria-label={`Equity curve: ${equity.length} trades, ending at ${signed(last)}R`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block", touchAction: "pan-y" }}
        onTouchMove={(e) => onMove(e.touches[0] ? { clientX: e.touches[0].clientX, currentTarget: e.currentTarget } : e)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={L + iw} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 0 ? undefined : "3 4"} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-3)">{signed(v, 1)}R</text>
          </g>
        ))}
        <path d={area} fill={stroke} opacity="0.1" />
        <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <text x={L} y={height - 6} fontSize="11" fill="var(--text-3)">{fmtDate(pts[0][0] * 1000)}</text>
        <text x={L + iw} y={height - 6} fontSize="11" fill="var(--text-3)" textAnchor="end">{fmtDate(pts[pts.length - 1][0] * 1000)}</text>
        {hv ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ih} stroke="var(--text-3)" strokeDasharray="2 3" />
            <circle cx={x(hover)} cy={y(hv[1])} r="4.5" fill={stroke} stroke="var(--bg-2)" strokeWidth="2" />
          </g>
        ) : null}
      </svg>
      {hv ? (
        <div className="eq-tip glass" style={{ left: Math.min(w - 150, Math.max(0, x(hover) - 70)) }}>
          <b className="num">{signed(hv[1])}R</b>
          <div className="faint">{hover === 0 ? "start" : `after ${unit} ${hover}`} · {fmtDateTime(hv[0] * 1000)}</div>
        </div>
      ) : null}
    </div>
  );
}


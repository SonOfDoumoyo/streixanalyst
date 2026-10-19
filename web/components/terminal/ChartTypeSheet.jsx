"use client";
// Chart type: every way the chart can be drawn, as tiles, the way TradingView's mobile app lists them. A long press
// on a tile adds it to Favourites, which sit at the top.
import { useRef, useState } from "react";
import { CHART_TYPES } from "@/components/chart/series";
import Sheet from "./Sheet";

const I = {
  bars: <path d="M7 4v16M4 8h3M7 15h3M17 3v14M14 6h3M17 13h3" />,
  candles: <><path d="M7 3v4M7 17v4M17 5v3M17 17v3" /><rect x="5" y="7" width="4" height="10" rx="0.5" fill="currentColor" /><rect x="15" y="8" width="4" height="9" rx="0.5" /></>,
  hollow: <><path d="M7 3v4M7 17v4M17 5v3M17 17v3" /><rect x="5" y="7" width="4" height="10" rx="0.5" /><rect x="15" y="8" width="4" height="9" rx="0.5" fill="currentColor" /></>,
  volcandles: <><path d="M6 4v3M6 17v3M17 3v4M17 18v3" /><rect x="4.5" y="7" width="3" height="10" rx="0.5" /><rect x="13" y="7" width="8" height="11" rx="0.5" /></>,
  line: <path d="M3 17l5-6 4 3 4-6 5 3" />,
  linemarkers: <><path d="M3 17l5-6 4 3 4-6 5 3" /><circle cx="8" cy="11" r="1.6" fill="currentColor" /><circle cx="12" cy="14" r="1.6" fill="currentColor" /><circle cx="16" cy="8" r="1.6" fill="currentColor" /></>,
  stepline: <path d="M3 18h4v-5h4V9h4V5h3v3h3" />,
  area: <><path d="M3 16l5-6 4 3 4-5 5 3" /><path d="M3 16l5-6 4 3 4-5 5 3V20H3z" fill="currentColor" opacity="0.28" stroke="none" /><path d="M3 20h18" strokeDasharray="1.5 2" /></>,
  hlcarea: <><path d="M3 12l5-5 4 3 4-4 5 2" /><path d="M3 18l5-4 4 2 4-4 5 2" /><path d="M3 12l5-5 4 3 4-4 5 2V16l-5-2-4 4-4-2-5 4z" fill="currentColor" opacity="0.25" stroke="none" /></>,
  baseline: <><path d="M3 15l4-6 4 4 4-6 6 7" /><path d="M2 12h20" strokeDasharray="2 2" /></>,
  columns: <><rect x="4" y="12" width="3.5" height="8" /><rect x="10.2" y="6" width="3.5" height="14" /><rect x="16.5" y="14" width="3.5" height="6" /></>,
  highlow: <><rect x="5" y="4" width="4" height="15" /><rect x="15" y="7" width="4" height="11" /></>,
  footprint: <><path d="M6 3v18" /><rect x="3.5" y="6" width="5" height="11" /><path d="M12 7h9M12 11h9M12 15h9" /></>,
  tpo: <><rect x="3" y="4" width="16" height="16" rx="1" /><path d="M3 8h11M3 12h16M3 16h8M9 4v16M14 4v8" /></>,
  svp: <><path d="M3 5h10M3 9h15M3 13h18M3 17h8" /></>,
  heikin: <><path d="M6 3v4M6 17v4M16 4v4M16 16v4" /><rect x="4" y="7" width="4" height="10" /><rect x="14" y="8" width="4" height="8" /><path d="M20 10v4" /></>,
  renko: <><rect x="3" y="14" width="5" height="5" /><rect x="9" y="9" width="5" height="5" /><rect x="15" y="4" width="5" height="5" /></>,
  linebreak: <><rect x="4" y="12" width="4" height="7" /><rect x="10" y="6" width="4" height="8" /><rect x="16" y="9" width="4" height="9" /></>,
  kagi: <path d="M3 18V8h5v6h4V5h5v9h4" />,
  pnf: <><path d="M4 5l4 4M8 5l-4 4M4 11l4 4M8 11l-4 4" /><circle cx="15" cy="7" r="2" /><circle cx="15" cy="13" r="2" /><path d="M18 15l3 3M21 15l-3 3" /></>,
  range: <><path d="M6 3v18M18 3v18" /><rect x="4" y="6" width="4" height="12" /><rect x="16" y="6" width="4" height="12" /></>,
};

export function ChartTypeIcon({ id, size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {I[id] || I.candles}
    </svg>
  );
}

export default function ChartTypeSheet({ open, onClose, value, onPick, favorites = [], onFavorites, onUnavailable, tipSeen, onTipSeen }) {
  const timer = useRef(null);
  const longed = useRef(false);
  const [flash, setFlash] = useState(null);
  const fav = new Set(favorites);
  const press = (id) => {
    longed.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      longed.current = true;
      const next = fav.has(id) ? favorites.filter((x) => x !== id) : [...favorites, id];
      onFavorites(next);
      setFlash(id);
      setTimeout(() => setFlash(null), 600);
      try { if (navigator.vibrate) navigator.vibrate(10); } catch { /* not supported */ }
    }, 520);
  };
  const release = () => clearTimeout(timer.current);
  const pick = (t) => {
    if (longed.current) return;
    if (t.needs) {
      onUnavailable(t);
      return;
    }
    onPick(t.id);
  };
  const tile = (t) => (
    <button key={t.id} className={`type-tile ${value === t.id ? "on" : ""} ${t.needs ? "off" : ""} ${flash === t.id ? "flash" : ""}`}
      onPointerDown={() => press(t.id)} onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()} onClick={() => pick(t)} aria-pressed={value === t.id}
      title={t.needs || t.label}>
      {fav.has(t.id) ? <span className="type-star" aria-label="Favourite">★</span> : null}
      <ChartTypeIcon id={t.id} />
      <span>{t.label}</span>
    </button>
  );
  const favs = CHART_TYPES.filter((t) => fav.has(t.id));
  return (
    <Sheet open={open} onClose={onClose} title="Chart type">
      {!tipSeen ? (
        <div className="sheet-tip">
          <span className="sheet-tip-ic">☆</span>
          <span>Use a long tap to add the chart type to your favourites</span>
          <button className="icon-btn" onClick={onTipSeen} aria-label="Dismiss">×</button>
        </div>
      ) : null}
      {favs.length ? (
        <>
          <div className="sheet-sec">Favourites</div>
          <div className="type-grid">{favs.map(tile)}</div>
          <div className="sheet-sec">All types</div>
        </>
      ) : null}
      <div className="type-grid">{CHART_TYPES.map(tile)}</div>
    </Sheet>
  );
}

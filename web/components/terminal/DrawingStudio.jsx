"use client";
// Drawing tools: a small dock on the chart (your favourite tools, magnet, lock, hide, undo) and the drawing studio
// sheet with every tool, grouped and searchable. Tap the star on a tool to keep it in the dock.
import { useMemo, useState } from "react";
import Icon from "@/components/Icons";
import { TOOLS } from "@/components/chart/engine";
import { STICKER_SET } from "@/components/chart/drawtools";
import Sheet from "./Sheet";

const BASIC = [
  ["Lines", ["trendline", "ray", "extline", "arrow", "hline", "hray", "vline", "crossline", "infoline", "trendangle", "channel", "regression"]],
  ["Fibonacci", ["fib", "fibext", "fibchannel", "fibtime", "fibfan", "fibcircles", "fibarcs"]],
  ["Gann & forks", ["gannbox", "gannfan", "gannsquare", "pitchfork", "schiff"]],
  ["Patterns", ["xabcd", "cypher", "abcd", "headshoulders", "trianglepat", "threedrives"]],
  ["Elliott waves", ["elliott_impulse", "elliott_correction", "elliott_triangle", "elliott_double", "elliott_triple"]],
  ["Cycles", ["cycliclines", "timecycles", "sineline"]],
  ["Forecast & measure", ["long", "short", "forecast", "projection", "barspattern", "measure", "pricerange", "daterange", "avwap", "frvp"]],
  ["Shapes", ["rect", "circle", "ellipse", "triangle", "curve", "polyline", "arrowmark_up", "arrowmark_down", "brush", "highlighter"]],
  ["Notes", ["text", "note", "callout", "comment", "pricelabel", "pricenote", "signpost", "flag", "pin"]],
  ["Stickers", ["emoji", "sticker", "icon"]],
];
const ICONS = { cursor: "cursor", trendline: "trendline", ray: "ray", extline: "extline", arrow: "arrow", hline: "hline", hray: "hray",
  vline: "vline", rect: "rect", channel: "channel", fib: "fib", long: "long", short: "short", measure: "ruler", text: "note" };

// small glyphs for the tools that have no icon of their own
const G = {
  crossline: <path d="M12 3v18M3 12h18" />,
  infoline: <><path d="M4 18L20 6" /><rect x="12" y="13" width="8" height="5" rx="1" /></>,
  trendangle: <><path d="M4 18L20 7M4 18h12" /><path d="M10 18a6 6 0 0 0-1.5-4" /></>,
  regression: <><path d="M4 17L20 7M4 13l16-10M4 21l16-10" strokeDasharray="2 2" /></>,
  fibext: <><path d="M4 18l6-8 4 5" /><path d="M14 6h7M14 10h7M14 14h7" /></>,
  fibchannel: <path d="M3 17L17 5M5 20L19 8M7 22.5L21 11" />,
  fibtime: <path d="M4 4v16M7 4v16M10 4v16M15 4v16M21 4v16" />,
  fibfan: <path d="M4 20L20 4M4 20L20 9M4 20L20 14M4 20h16" />,
  fibcircles: <><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="9" /></>,
  fibarcs: <><path d="M3 18a9 9 0 0 1 18 0M7 18a5 5 0 0 1 10 0" /></>,
  gannbox: <><rect x="4" y="4" width="16" height="16" /><path d="M4 4l16 16M4 20L20 4M12 4v16M4 12h16" /></>,
  gannfan: <path d="M4 20L20 4M4 20L20 12M4 20L12 4M4 20h16M4 20V4" />,
  gannsquare: <><rect x="4" y="4" width="16" height="16" /><path d="M4 4l16 16M4 20L20 4" /></>,
  pitchfork: <path d="M3 13l18-7M6 19l15-6M9 4l12-1" />,
  schiff: <path d="M3 15l18-8M6 20l15-6M7 7l14-4" />,
  xabcd: <><path d="M3 18l4-12 4 8 4-5 6 9" /><path d="M3 18l8-4M11 14l10 4" strokeDasharray="2 2" /></>,
  cypher: <><path d="M3 16l4-10 5 6 4-7 5 11" /></>,
  abcd: <path d="M3 18l6-12 5 6 7-8" />,
  headshoulders: <path d="M2 18l4-7 3 4 3-10 3 10 3-4 4 7" />,
  trianglepat: <><path d="M3 5l6 12 4-8 4 6" /><path d="M3 5l18 8M9 17l12-4" strokeDasharray="2 2" /></>,
  threedrives: <path d="M2 20l4-6 2 3 5-8 2 3 6-9" />,
  elliott_impulse: <path d="M2 20l4-8 3 4 5-12 3 6 5-6" />,
  elliott_correction: <path d="M3 5l6 10 4-5 8 10" />,
  elliott_triangle: <path d="M3 4l3 14 3-10 3 8 3-6 3 4" />,
  elliott_double: <path d="M3 5l5 9 4-4 9 10" />,
  elliott_triple: <path d="M2 5l4 7 3-3 4 6 3-3 6 8" />,
  cycliclines: <path d="M4 4v16M10 4v16M16 4v16M22 4v16" />,
  timecycles: <path d="M2 16a5 5 0 0 1 10 0M12 16a5 5 0 0 1 10 0" />,
  sineline: <path d="M2 12c3-8 6-8 9 0s6 8 9 0" />,
  forecast: <><path d="M4 17l12-10" strokeDasharray="3 2" /><circle cx="18" cy="6" r="2.5" /></>,
  projection: <><path d="M3 18l6-10 4 4" /><path d="M13 12l6-10" strokeDasharray="3 2" /></>,
  barspattern: <><path d="M5 8v10M9 5v9M13 9v8" /><path d="M16 8v10M20 5v9" strokeDasharray="2 2" /></>,
  pricerange: <><path d="M12 4v16M8 4h8M8 20h8" /></>,
  daterange: <><path d="M4 12h16M4 8v8M20 8v8" /></>,
  avwap: <><path d="M3 18c4-1 6-6 9-7s6 0 9-6" /><circle cx="3" cy="18" r="1.5" /></>,
  frvp: <><path d="M4 4v16" /><path d="M4 6h6M4 10h12M4 14h9M4 18h5" /></>,
  circle: <circle cx="12" cy="12" r="8" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="6" />,
  triangle: <path d="M12 4l9 16H3z" />,
  curve: <path d="M3 18C6 4 18 4 21 18" />,
  polyline: <path d="M3 18l5-9 5 5 8-10" />,
  arrowmark_up: <path d="M12 4l6 7h-4v9h-4v-9H6z" />,
  arrowmark_down: <path d="M12 20l6-7h-4V4h-4v9H6z" />,
  brush: <><path d="M4 20c2-1 3-3 3-5l9-9 3 3-9 9c-2 0-4 1-6 2z" /></>,
  highlighter: <><path d="M5 19h6M9 15l8-8 3 3-8 8H9z" /></>,
  note: <><path d="M5 4h14v12l-4 4H5z" /><path d="M15 20v-4h4" /></>,
  callout: <><rect x="6" y="3" width="15" height="9" rx="2" /><path d="M9 12l-6 8" /></>,
  comment: <path d="M4 5h16v10H9l-5 4z" />,
  pricelabel: <><path d="M3 12l4-5h14v10H7z" /></>,
  pricenote: <><circle cx="5" cy="17" r="2" /><path d="M6.5 15.5L13 9" /><rect x="13" y="5" width="8" height="5" rx="1" /></>,
  signpost: <><path d="M6 21V3" /><path d="M6 4h12l-3 3 3 3H6" /></>,
  flag: <><path d="M6 21V3" /><path d="M6 4l10 3-10 4" /></>,
  pin: <><circle cx="12" cy="9" r="4" /><path d="M12 13v8" /></>,
  emoji: <><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></>,
  sticker: <><path d="M4 4h12l4 4v12H4z" /><path d="M16 4v4h4" /></>,
  icon: <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" />,
  eraser: <><path d="M3 17l8-8 6 6-4 4H7z" /><path d="M13 19h8" /></>,
};

export function ToolGlyph({ id, size = 20 }) {
  if (ICONS[id]) return <Icon name={ICONS[id]} size={size} />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {G[id] || <path d="M4 18L20 6" />}
    </svg>
  );
}

const GLYPHS = ["★", "✓", "✕", "⚠", "↑", "↓", "→", "●", "◆", "$", "€", "£"];

export function DrawingStudio({ open, onClose, tool, setTool, favorites = [], onFavorites, toolStyle, setToolStyle }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("Lines");
  const needle = q.trim().toLowerCase();
  const groups = useMemo(() => (needle
    ? [["Results", BASIC.flatMap(([, ids]) => ids).filter((id) => (TOOLS[id] && TOOLS[id].label || id).toLowerCase().includes(needle))]]
    : BASIC.filter(([g]) => g === cat)), [needle, cat]);
  const fav = (id) => favorites.includes(id);
  const pick = (id) => {
    setTool(id);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Drawing studio" wide>
      <div className="tb-search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools: fib, pitchfork, Elliott…" aria-label="Search tools" />
      </div>
      {!needle ? (
        <div className="ds-cats" role="tablist">
          {BASIC.map(([g]) => <button key={g} className={cat === g ? "on" : ""} onClick={() => setCat(g)}>{g}</button>)}
        </div>
      ) : null}
      {groups.map(([g, ids]) => (
        <div key={g} className="ds-grid">
          {ids.map((id) => (
            <div key={id} className={`ds-tile${tool === id ? " on" : ""}`}>
              <button className="ds-pick" onClick={() => pick(id)}>
                <ToolGlyph id={id} size={22} />
                <span>{(TOOLS[id] && TOOLS[id].label) || id}</span>
              </button>
              <button className={`iv-star${fav(id) ? " on" : ""}`} onClick={() => onFavorites(fav(id) ? favorites.filter((x) => x !== id) : [...favorites, id].slice(-8))}
                aria-label={fav(id) ? "Remove from the dock" : "Keep in the dock"}>
                <Icon name="star" size={12} />
              </button>
            </div>
          ))}
          {!ids.length ? <p className="muted">No tool matches “{q}”.</p> : null}
        </div>
      ))}
      {cat === "Stickers" && !needle ? (
        <div className="ds-stickers">
          <h4>Sticker</h4>
          <div className="row wrap">
            {STICKER_SET.map((e) => (
              <button key={e} className={`ds-emoji${toolStyle.emoji === e ? " on" : ""}`} onClick={() => setToolStyle({ ...toolStyle, emoji: e })}>{e}</button>
            ))}
          </div>
          <h4>Icon</h4>
          <div className="row wrap">
            {GLYPHS.map((g) => (
              <button key={g} className={`ds-emoji${toolStyle.glyph === g ? " on" : ""}`} onClick={() => setToolStyle({ ...toolStyle, glyph: g })}>{g}</button>
            ))}
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

/** The dock on the chart: select, your favourite tools, all tools, then magnet, keep drawing, lock, hide, undo, clear. */
export function ToolDock({ tool, setTool, favorites, onStudio, magnet, setMagnet, keep, setKeep, locked, setLocked, visible, setVisible,
  onUndo, onRedo, onClear, hidden }) {
  const cycleMagnet = () => setMagnet(magnet === false ? "weak" : magnet === "weak" ? "strong" : false);
  return (
    <div className={`dock${hidden ? " dock-hidden" : ""}`} role="toolbar" aria-label="Drawing tools" data-tour={hidden ? undefined : "dock"}>
      <button className={`dock-b${tool === "cursor" ? " on" : ""}`} onClick={() => setTool("cursor")} title="Select and move" aria-label="Select and move">
        <ToolGlyph id="cursor" size={18} />
      </button>
      {favorites.map((id) => (
        <button key={id} className={`dock-b${tool === id ? " on" : ""}`} onClick={() => setTool(tool === id ? "cursor" : id)}
          title={(TOOLS[id] && TOOLS[id].label) || id} aria-label={(TOOLS[id] && TOOLS[id].label) || id} aria-pressed={tool === id}>
          <ToolGlyph id={id} size={18} />
        </button>
      ))}
      <button className="dock-b dock-all" onClick={onStudio} title="All drawing tools" aria-label="All drawing tools">
        <Icon name="grid" size={17} />
      </button>
      <i className="dock-sep" />
      <button className={`dock-b${tool === "eraser" ? " on" : ""}`} onClick={() => setTool(tool === "eraser" ? "cursor" : "eraser")} title="Eraser: tap a drawing to remove it" aria-label="Eraser">
        <ToolGlyph id="eraser" size={18} />
      </button>
      <button className={`dock-b${magnet ? " on" : ""}`} onClick={cycleMagnet} title={`Magnet: ${magnet ? magnet : "off"} (tap to change)`} aria-label="Magnet">
        <Icon name="magnet" size={17} />
        {magnet === "strong" ? <sup>S</sup> : null}
      </button>
      <button className={`dock-b${keep ? " on" : ""}`} onClick={() => setKeep(!keep)} title="Keep drawing: stay in the tool after each drawing" aria-label="Keep drawing">
        <Icon name="pen" size={17} />
      </button>
      <button className={`dock-b${locked ? " on" : ""}`} onClick={() => setLocked(!locked)} title={locked ? "Unlock all drawings" : "Lock all drawings"} aria-label="Lock all drawings">
        <Icon name={locked ? "lock" : "unlock"} size={17} />
      </button>
      <button className={`dock-b${!visible ? " on" : ""}`} onClick={() => setVisible(!visible)} title={visible ? "Hide my drawings" : "Show my drawings"} aria-label="Hide drawings">
        <Icon name={visible ? "eye" : "eyeOff"} size={17} />
      </button>
      <button className="dock-b" onClick={onUndo} title="Undo" aria-label="Undo"><Icon name="undo" size={17} /></button>
      <button className="dock-b hide-mobile" onClick={onRedo} title="Redo" aria-label="Redo"><Icon name="redo" size={17} /></button>
      <button className="dock-b" onClick={onClear} title="Remove all my drawings" aria-label="Remove all drawings"><Icon name="trash" size={17} /></button>
    </div>
  );
}

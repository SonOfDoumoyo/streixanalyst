// Turns the analyst's JSON into chart overlay items, and the user's drawings into analyst input.
import { hexA } from "@/components/chart/engine";

export const LAYERS = {
  plan: "Trade plan",
  structure: "Market structure",
  liquidity: "Liquidity",
  zones: "Support & resistance",
  orderblocks: "Order blocks",
  fvg: "Fair value gaps",
  fib: "Fibonacci / OTE",
  trendlines: "Trendlines",
  patterns: "Chart patterns",
  period: "Prev. day / week / month",
  session: "Sessions",
  range: "Dealing range",
  volume_profile: "Volume profile",
  candles: "Candle patterns",
  divergence: "RSI divergence",
  round: "Round numbers",
  user: "Your levels",
};

export const ANALYSIS_STEPS = [
  "Reading the higher timeframes",
  "Mapping market structure",
  "Marking liquidity pools",
  "Finding order blocks and fair value gaps",
  "Checking the news and calendar",
  "Building the trade plan",
  "Grading the setup",
];

const UP = "#26a69a";
const DOWN = "#ef5350";
const TEXT = "#d1d4dc";

function recolor(c, theme) {
  if (!c) return c;
  const low = String(c).toLowerCase();
  if (low === UP) return theme.up;
  if (low === DOWN) return theme.down;
  if (low === TEXT) return theme.text;
  const m = low.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  if (m) {
    const a = parseFloat(m[4]);
    if (m[1] === "38" && m[2] === "166" && m[3] === "154") return hexA(theme.up, a);
    if (m[1] === "239" && m[2] === "83" && m[3] === "80") return hexA(theme.down, a);
  }
  return c;
}

export function toOverlay(res, theme) {
  if (!res || !Array.isArray(res.drawings) || !Array.isArray(res.candles) || !res.candles.length) return { items: [], pins: [], layers: [] };
  const ct = res.candles.map((c) => c[0]);
  const last = ct.length - 1;
  const step = (res.meta && res.meta.tf_seconds) || (ct.length > 1 ? ct[last] - ct[last - 1] : 3600);
  const xt = (x) => {
    if (x === null || x === undefined) return null;
    const xi = Math.round(x);
    if (xi <= 0) return ct[0] + xi * step;
    if (xi <= last) return ct[xi];
    return ct[last] + (xi - last) * step;
  };
  const th = { up: theme.up || UP, down: theme.down || DOWN, text: theme.text || TEXT };
  const counts = {};
  const items = [];
  for (const d of res.drawings) {
    if (d.layer === "price") continue;
    const it = {
      id: d.id, layer: d.layer, kind: d.kind, order: d.order, prio: d.prio || 2, plan: d.plan,
      color: recolor(d.color, th), fill: recolor(d.fill, th), width: d.width, dash: d.dash, text: d.text,
      labelAt: d.label_at, anchor: d.anchor, extend: d.extend, symbol: d.symbol,
      t1: d.t1 !== undefined && d.t1 !== null ? d.t1 : xt(d.x1), t2: d.t2 !== undefined && d.t2 !== null ? d.t2 : xt(d.x2),
      p1: d.y1, p2: d.y2 !== undefined && d.y2 !== null ? d.y2 : d.y1,
      points: Array.isArray(d.points) ? d.points.map(([x, y]) => ({ t: xt(x), p: y })) : null,
      bins: d.bins, axisTag: d.layer === "plan" && d.kind === "line",
    };
    if (it.kind === "histogram" && !Array.isArray(it.bins)) continue;
    counts[it.layer] = (counts[it.layer] || 0) + 1;
    items.push(it);
  }
  const pl = res.plan;
  const pins = pl ? [pl.entry, pl.sl, ...(pl.tps || []).slice(0, 2)].filter((v) => Number.isFinite(v)) : [];
  const layers = Object.keys(LAYERS).filter((k) => counts[k]).map((k) => ({ id: k, label: LAYERS[k], count: counts[k] }));
  return { items, pins, layers };
}

/** The user's chart drawings in the format the analyst understands (levels, zones, trendlines, notes). */
export function toUserDrawings(drawings) {
  const out = [];
  for (const d of drawings || []) {
    if (d.hidden || !d.points || !d.points.length) continue;
    const label = d.style && d.style.text ? String(d.style.text).slice(0, 60) : undefined;
    const P = d.points;
    if (d.type === "hline" || d.type === "hray") out.push({ type: "hline", price: P[0].p, label, id: d.id });
    else if (d.type === "rect" && P.length >= 2) out.push({ type: "zone", top: Math.max(P[0].p, P[1].p), bottom: Math.min(P[0].p, P[1].p), label, id: d.id });
    else if ((d.type === "trendline" || d.type === "ray" || d.type === "extline") && P.length >= 2 && P[0].t !== P[1].t)
      out.push({ type: "trendline", t1: P[0].t, p1: P[0].p, t2: P[1].t, p2: P[1].p, label, id: d.id });
    else if (d.type === "text" && label) out.push({ type: "note", t: P[0].t, price: P[0].p, text: label, id: d.id });
    if (out.length >= 40) break;
  }
  return out;
}

export function verdictTone(v) {
  if (!v) return "wait";
  if (v.trade && v.side === "long") return "buy";
  if (v.trade && v.side === "short") return "sell";
  return "wait";
}

export function gradeClass(g) {
  return `g-${String(g || "").replace("+", "plus")}`;
}

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
  indicators: "Strategy indicators",
  strategy: "Strategy trades",
  user: "Your levels",
};

export const ANALYSIS_STEPS = [
  "Reading every timeframe",
  "Mapping market structure",
  "Marking liquidity and how deep stop hunts reach",
  "Running your strategies",
  "Checking each strategy's record on this market",
  "Checking the news and calendar",
  "Placing stops past the liquidity",
  "Grading the scenario",
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
      why: d.why, title: d.title, copy: d.copy,
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

const DASH = { dash: "dashed", dashdot: "dashed", dot: "dotted" };
let SEQ = 0;
const did = () => `ai${Date.now().toString(36)}${(SEQ++).toString(36)}`;

/** The analyst's drawings as ordinary chart drawings the person can move, restyle or delete (My analysis). The trade
 *  plan becomes one long/short position drawing with handles for the entry, stop and target. */
export function aiToDrawings(res, theme = {}, hidden = null) {
  const ov = toOverlay(res, theme);
  const out = [];
  const plan = res && res.plan;
  // only what the chart showed: the chosen strategies' layers (or the main items without a choice), minus hidden layers
  const scope = res && res.layers_scope ? new Set([...res.layers_scope, "user", "indicators"]) : null;
  for (const it of ov.items) {
    if (it.layer === "plan" || it.kind === "histogram" || it.plan === "alternative") continue;
    if ((scope && !scope.has(it.layer)) || (!scope && (it.prio || 2) > 2) || (hidden && hidden.has(it.layer))) continue;
    const style = { color: it.color || "#4ea4ff", width: Math.max(1, Math.round((it.width || 1) * 1.5)), dash: DASH[it.dash] || "solid", text: it.text || "", fromAi: true };
    if ((it.kind === "line" || it.kind === "hline") && it.t1 !== null && it.p1 !== null) {
      const flat = Math.abs((it.p2 ?? it.p1) - it.p1) < 1e-12;
      if (flat && it.extend === "right") out.push({ id: did(), type: "hray", points: [{ t: it.t1, p: it.p1 }], style });
      else if (it.t2 !== null && it.t2 !== undefined) out.push({ id: did(), type: "trendline", points: [{ t: it.t1, p: it.p1 }, { t: it.t2, p: it.p2 ?? it.p1 }], style });
    } else if (it.kind === "box" && it.t1 !== null) {
      out.push({ id: did(), type: "rect", points: [{ t: it.t1, p: it.p1 }, { t: it.t2 ?? it.t1, p: it.p2 }],
        style: { ...style, fill: it.fill, extendRight: it.extend === "right", width: 1 } });
    } else if (it.kind === "label" && it.text) {
      out.push({ id: did(), type: "text", points: [{ t: it.t1, p: it.p1 }], style: { ...style, text: it.text } });
    } else if (it.kind === "marker") {
      out.push({ id: did(), type: it.symbol === "triangle-down" ? "arrowmark_down" : it.symbol === "triangle-up" ? "arrowmark_up" : "flag",
        points: [{ t: it.t1, p: it.p1 }], style });
    } else if (it.kind === "path" && it.points && it.points.length > 1) {
      out.push({ id: did(), type: "brush", points: it.points.filter((p) => p.t !== null), style: { ...style, width: 1 } });
    }
  }
  if (plan && plan.entry && plan.sl && plan.tps && plan.tps.length) {
    const ct = res.candles.map((c) => c[0]);
    const last = ct[ct.length - 1];
    const step = (res.meta && res.meta.tf_seconds) || 3600;
    out.push({ id: did(), type: plan.side === "short" ? "short" : "long",
      points: [{ t: last + step, p: plan.entry }, { t: last + step * 25, p: plan.sl }, { t: last + step * 25, p: plan.tps[Math.min(1, plan.tps.length - 1)] }],
      style: { color: "#2962ff", width: 2, dash: "solid", fromAi: true } });
  }
  return out;
}

/** The plan inside a long/short drawing: { side, entry, sl, tps } (or null). */
export function planFromDrawings(drawings) {
  const d = [...(drawings || [])].reverse().find((x) => (x.type === "long" || x.type === "short") && x.points && x.points.length >= 3);
  if (!d) return null;
  return { side: d.type, entry: d.points[0].p, sl: d.points[1].p, tps: [d.points[2].p] };
}

// A TradingView Pine Script (v5) that draws an analysis's plan on any chart: the entry, the stop, the targets and
// the risk and reward areas. TradingView lets no website draw on its charts directly, so the person pastes this
// script into TradingView's Pine Editor once per plan. The levels in it are fixed numbers from the analysis.

const clean = (s) => String(s || "").replace(/["\\\n\r]/g, " ").slice(0, 40);

function n(x, dec) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "na";
  return String(Number(v.toFixed(dec)));
}

/** The Pine Script for `res` (an analysis result), or null when it has no plan. */
export function pineFor(res, nowMs = Date.now()) {
  const p = res && res.plan;
  if (!p || !Number.isFinite(p.entry) || !Number.isFinite(p.sl)) return null;
  const long = p.side === "long";
  const dec = Number.isFinite(res.decimals) ? res.decimals : 5;
  const tps = (p.tps || []).filter((t) => Number.isFinite(t)).slice(0, 3);
  if (!tps.length) return null;
  const t0 = ((res.hud && Number.isFinite(res.hud.last_t) ? res.hud.last_t : Math.floor(nowMs / 1000) - 7200) * 1000);
  const title = `StreixAnalyst ${clean(res.symbol)} ${clean(res.tf)} ${long ? "Buy" : "Sell"}`;
  const when = new Date(nowMs).toISOString().slice(0, 16).replace("T", " ");
  const lines = [
    "//@version=5",
    `indicator("${title}", overlay=true, max_lines_count=20, max_labels_count=20, max_boxes_count=10)`,
    `// Made by StreixAnalyst on ${when} UTC from its analysis of ${clean(res.symbol)} on ${clean(res.tf)}.`,
    "// The levels are fixed numbers from that analysis. They do not update. Research tool, not financial advice.",
    "",
    `t0     = ${t0}   // the analysis candle (ms)`,
    `entry  = ${n(p.entry, dec)}`,
    `sl     = ${n(p.sl, dec)}`,
    ...tps.map((t, i) => `tp${i + 1}    = ${n(t, dec)}`),
    "",
    "bar = timeframe.in_seconds() * 1000",
    "",
    "if barstate.isfirst",
    "    ahead = t0 + 12 * bar",
    `    box.new(t0, math.max(entry, sl), t0 + bar, math.min(entry, sl), xloc=xloc.bar_time, extend=extend.right, bgcolor=color.new(color.red, 88), border_color=color.new(color.red, 100))`,
    `    box.new(t0, math.max(entry, tp${tps.length}), t0 + bar, math.min(entry, tp${tps.length}), xloc=xloc.bar_time, extend=extend.right, bgcolor=color.new(color.green, 90), border_color=color.new(color.green, 100))`,
    `    line.new(t0, entry, t0 + bar, entry, xloc=xloc.bar_time, extend=extend.right, color=#2962ff, width=2)`,
    `    line.new(t0, sl, t0 + bar, sl, xloc=xloc.bar_time, extend=extend.right, color=color.red, style=line.style_dashed)`,
    ...tps.map((_, i) => `    line.new(t0, tp${i + 1}, t0 + bar, tp${i + 1}, xloc=xloc.bar_time, extend=extend.right, color=color.green, style=line.style_dashed)`),
    `    label.new(ahead, entry, "${long ? "BUY" : "SELL"} ${String(p.type || "").toUpperCase()}  EP " + str.tostring(entry, format.mintick), xloc=xloc.bar_time, style=label.style_label_left, color=#2962ff, textcolor=color.white, size=size.small)`,
    `    label.new(ahead, sl, "SL " + str.tostring(sl, format.mintick), xloc=xloc.bar_time, style=label.style_label_left, color=color.red, textcolor=color.white, size=size.small)`,
    ...tps.map((_, i) => `    label.new(ahead, tp${i + 1}, "TP${i + 1} " + str.tostring(tp${i + 1}, format.mintick), xloc=xloc.bar_time, style=label.style_label_left, color=color.green, textcolor=color.white, size=size.small)`),
    "",
  ];
  return lines.join("\n");
}

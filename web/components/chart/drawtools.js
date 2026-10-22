// The drawing studio: every drawing tool beyond the basics in engine.js (lines, rectangle, channel, Fibonacci
// retracement, long/short position, measure, text). Each tool says how many points it needs, which group it belongs to,
// and how to draw itself; the engine handles placing, selecting, dragging, saving and undo for all of them alike.
//
// draw(E, ctx, d, P): E is the engine, d the drawing {type, points:[{t,p}], style}, P the points on screen [{x,y}].

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXT = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];
const FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34];
const GANN = [1 / 8, 1 / 4, 1 / 3, 1 / 2, 1, 2, 3, 4, 8];
const GANN_LAB = ["1×8", "1×4", "1×3", "1×2", "1×1", "2×1", "3×1", "4×1", "8×1"];

function hexA(color, a) {
  if (!color) return `rgba(255,255,255,${a})`;
  if (color.startsWith("rgba")) return color.replace(/[\d.]+\)$/, `${a})`);
  if (color.startsWith("rgb(")) return color.replace("rgb(", "rgba(").replace(")", `,${a})`);
  let h = color.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function seg(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function poly(ctx, pts, close = false) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  if (close) ctx.closePath();
  ctx.stroke();
}

function ext(a, b, k) {                 // the point k times the a→b vector from a
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function far(a, b, E) {                 // a→b extended to well beyond the screen
  const big = (E.W + E.H) * 4 / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
  return ext(a, b, big);
}

function label(E, ctx, text, x, y, { color = "#fff", bg = null, align = "left", base = "bottom", bold = true } = {}) {
  ctx.font = bold ? E.fontB : E.font;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  if (bg) {
    const w = ctx.measureText(text).width + 10 * E.scale;
    const h = E.fs + 8 * E.scale;
    const x0 = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    const y0 = base === "bottom" ? y - h : base === "middle" ? y - h / 2 : y;
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, w, h, 4 * E.scale);
    else ctx.rect(x0, y0, w, h);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x0 + w / 2, y0 + h / 2 + 0.5);
    return { x: x0, y: y0, w, h };
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  return null;
}

function wavePoints(names) {
  return (E, ctx, d, P) => {
    const col = d.style.color || "#2962ff";
    poly(ctx, P);
    P.forEach((p, k) => {
      if (!names[k]) return;
      const up = k + 1 < P.length ? P[k + 1].y > p.y : k > 0 ? P[k - 1].y > p.y : true;
      label(E, ctx, names[k], p.x, p.y + (up ? -6 : 6) * E.scale, { color: col, align: "center", base: up ? "bottom" : "top" });
    });
  };
}

function harmonic(names) {
  return (E, ctx, d, P) => {
    const col = d.style.color || "#2962ff";
    ctx.fillStyle = hexA(col, 0.1);
    if (P.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(P[0].x, P[0].y);
      ctx.lineTo(P[1].x, P[1].y);
      ctx.lineTo(P[2].x, P[2].y);
      ctx.closePath();
      ctx.fill();
    }
    if (P.length >= 5) {
      ctx.beginPath();
      ctx.moveTo(P[2].x, P[2].y);
      ctx.lineTo(P[3].x, P[3].y);
      ctx.lineTo(P[4].x, P[4].y);
      ctx.closePath();
      ctx.fill();
    }
    poly(ctx, P);
    ctx.setLineDash([4, 4]);
    if (P.length >= 3) seg(ctx, P[0], P[2]);
    if (P.length >= 5) seg(ctx, P[2], P[4]);
    ctx.setLineDash([]);
    const pts = d.points;
    const r = (a, b, c) => Math.abs((pts[c].p - pts[b].p) / ((pts[b].p - pts[a].p) || 1));
    const ratios = [null, null, P.length >= 3 ? r(0, 1, 2) : null, P.length >= 4 ? r(1, 2, 3) : null, P.length >= 5 ? Math.abs((pts[4].p - pts[3].p) / ((pts[1].p - pts[0].p) || 1)) : null];
    P.forEach((p, k) => {
      const up = k % 2 === 1 ? P[k].y < (P[k - 1] || P[k]).y : P[k].y < (P[k + 1] || P[k - 1] || P[k]).y;
      label(E, ctx, names[k] || "", p.x, p.y + (up ? -6 : 6) * E.scale, { color: col, align: "center", base: up ? "bottom" : "top" });
      if (ratios[k]) label(E, ctx, ratios[k].toFixed(3), p.x, p.y + (up ? -8 - E.fs : 8 + E.fs) * E.scale, { color: hexA(col, 0.8), align: "center", base: up ? "bottom" : "top", bold: false });
    });
  };
}

const T = {};
const add = (id, def) => { T[id] = def; };

// ── lines
add("crossline", { pts: 1, label: "Cross line", group: "Lines", draw(E, ctx, d, P) {
  seg(ctx, { x: 0, y: P[0].y }, { x: E.plotW, y: P[0].y });
  seg(ctx, { x: P[0].x, y: 0 }, { x: P[0].x, y: E.mainH });
}, hit: (E, d, x, y, tol, P) => Math.abs(y - P[0].y) <= tol || Math.abs(x - P[0].x) <= tol });
add("infoline", { pts: 2, label: "Info line", group: "Lines", draw(E, ctx, d, P) {
  seg(ctx, P[0], P[1]);
  const a = d.points[0];
  const b = d.points[1];
  const dp = b.p - a.p;
  const bars = Math.round(E.timeToIndex(b.t) - E.timeToIndex(a.t));
  const ang = (Math.atan2(-(P[1].y - P[0].y), P[1].x - P[0].x) * 180) / Math.PI;
  label(E, ctx, `${dp >= 0 ? "+" : ""}${E.fmt(dp)} (${((dp / a.p) * 100).toFixed(2)}%) · ${bars} bars · ${ang.toFixed(0)}°`,
    (P[0].x + P[1].x) / 2, (P[0].y + P[1].y) / 2 - 6 * E.scale, { bg: hexA(d.style.color || "#2962ff", 0.9), align: "center" });
} });
add("trendangle", { pts: 2, label: "Trend angle", group: "Lines", draw(E, ctx, d, P) {
  seg(ctx, P[0], P[1]);
  const ang = Math.atan2(-(P[1].y - P[0].y), P[1].x - P[0].x);
  ctx.setLineDash([3, 3]);
  seg(ctx, P[0], { x: P[0].x + 60 * E.scale, y: P[0].y });
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(P[0].x, P[0].y, 34 * E.scale, -Math.max(ang, 0), -Math.min(ang, 0));
  ctx.stroke();
  label(E, ctx, `${((ang * 180) / Math.PI).toFixed(1)}°`, P[0].x + 40 * E.scale, P[0].y - 4 * E.scale, { color: d.style.color });
} });
add("regression", { pts: 2, label: "Regression trend", group: "Lines", draw(E, ctx, d, P) {
  const i0 = Math.round(E.timeToIndex(Math.min(d.points[0].t, d.points[1].t)));
  const i1 = Math.round(E.timeToIndex(Math.max(d.points[0].t, d.points[1].t)));
  const xs = [];
  for (let i = Math.max(0, i0); i <= Math.min(E.d.length - 1, i1); i++) xs.push(i);
  if (xs.length < 3) { seg(ctx, P[0], P[1]); return; }
  const ys = xs.map((i) => E.d[i].c);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  xs.forEach((x, k) => { num += (x - mx) * (ys[k] - my); den += (x - mx) ** 2; });
  const sl = den ? num / den : 0;
  const at = (x) => my + sl * (x - mx);
  const sd = Math.sqrt(ys.reduce((a, y, k) => a + (y - at(xs[k])) ** 2, 0) / n);
  const xa = E.x(xs[0]);
  const xb = E.x(xs[n - 1]);
  for (const [k, dash] of [[0, []], [2, [5, 4]], [-2, [5, 4]]]) {
    ctx.setLineDash(dash);
    seg(ctx, { x: xa, y: E.y(at(xs[0]) + k * sd) }, { x: xb, y: E.y(at(xs[n - 1]) + k * sd) });
  }
  ctx.setLineDash([]);
  ctx.fillStyle = hexA(d.style.color || "#2962ff", 0.06);
  ctx.beginPath();
  ctx.moveTo(xa, E.y(at(xs[0]) + 2 * sd));
  ctx.lineTo(xb, E.y(at(xs[n - 1]) + 2 * sd));
  ctx.lineTo(xb, E.y(at(xs[n - 1]) - 2 * sd));
  ctx.lineTo(xa, E.y(at(xs[0]) - 2 * sd));
  ctx.closePath();
  ctx.fill();
} });

// ── Fibonacci
add("fibext", { pts: 3, label: "Fib extension (trend-based)", group: "Fibonacci", draw(E, ctx, d, P) {
  const [a, b, c] = d.points;
  ctx.setLineDash([4, 4]);
  poly(ctx, P);
  ctx.setLineDash([]);
  if (!c) return;
  const leg = b.p - a.p;
  const x1 = Math.min(P[2].x, P[1].x);
  const x2 = Math.max(P[2].x + 140 * E.scale, P[1].x);
  for (const f of FIB_EXT) {
    const p = c.p + leg * f;
    const yy = E.y(p);
    ctx.strokeStyle = hexA(d.style.color || "#2962ff", f === 1 ? 1 : 0.7);
    seg(ctx, { x: x1, y: yy }, { x: x2, y: yy });
    label(E, ctx, `${f} (${E.fmt(p)})`, x1 + 4, yy - 2, { color: d.style.color, bold: false });
  }
} });
add("fibchannel", { pts: 3, label: "Fib channel", group: "Fibonacci", draw(E, ctx, d, P) {
  const [a, b] = P;
  const c = P[2] || b;
  const off = c.y - (a.y + ((b.y - a.y) * (c.x - a.x)) / ((b.x - a.x) || 1));
  for (const f of [0, 0.236, 0.382, 0.5, 0.618, 1]) {
    ctx.strokeStyle = hexA(d.style.color || "#2962ff", f === 0 || f === 1 ? 1 : 0.6);
    seg(ctx, { x: a.x, y: a.y + off * f }, { x: b.x, y: b.y + off * f });
    label(E, ctx, String(f), b.x + 4, b.y + off * f, { color: d.style.color, base: "middle", bold: false });
  }
} });
add("fibtime", { pts: 2, label: "Fib time zones", group: "Fibonacci", draw(E, ctx, d, P) {
  const dx = P[1].x - P[0].x;
  for (const f of FIB_TIME) {
    const xx = P[0].x + dx * f;
    if (xx > E.plotW + 2) break;
    seg(ctx, { x: xx, y: 0 }, { x: xx, y: E.mainH });
    label(E, ctx, String(f), xx + 3, E.mainH - 4, { color: d.style.color, bold: false });
  }
} });
add("fibfan", { pts: 2, label: "Fib speed fan", group: "Fibonacci", draw(E, ctx, d, P) {
  const [a, b] = P;
  for (const f of [0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
    const t = { x: b.x, y: a.y + (b.y - a.y) * f };
    ctx.strokeStyle = hexA(d.style.color || "#2962ff", f === 1 ? 1 : 0.65);
    seg(ctx, a, far(a, t, E));
    label(E, ctx, String(f), t.x + 4, t.y, { color: d.style.color, base: "middle", bold: false });
  }
} });
add("fibcircles", { pts: 2, label: "Fib circles", group: "Fibonacci", draw(E, ctx, d, P) {
  const r0 = Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y);
  for (const f of [0.382, 0.5, 0.618, 1, 1.618]) {
    ctx.beginPath();
    ctx.arc(P[0].x, P[0].y, r0 * f, 0, Math.PI * 2);
    ctx.stroke();
  }
} });
add("fibarcs", { pts: 2, label: "Fib speed arcs", group: "Fibonacci", draw(E, ctx, d, P) {
  const r0 = Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y);
  const up = P[1].y < P[0].y;
  seg(ctx, P[0], P[1]);
  for (const f of [0.382, 0.5, 0.618, 1]) {
    ctx.beginPath();
    ctx.arc(P[1].x, P[1].y, r0 * f, up ? 0 : Math.PI, up ? Math.PI : 2 * Math.PI);
    ctx.stroke();
  }
} });
// ── Gann & pitchforks
add("gannbox", { pts: 2, label: "Gann box", group: "Gann & forks", draw(E, ctx, d, P) {
  const [a, b] = P;
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.strokeStyle = hexA(d.style.color || "#2962ff", 0.5);
  for (const f of [0.25, 0.382, 0.5, 0.618, 0.75]) {
    seg(ctx, { x: x1 + (x2 - x1) * f, y: y1 }, { x: x1 + (x2 - x1) * f, y: y2 });
    seg(ctx, { x: x1, y: y1 + (y2 - y1) * f }, { x: x2, y: y1 + (y2 - y1) * f });
  }
  ctx.setLineDash([4, 4]);
  seg(ctx, { x: x1, y: y1 }, { x: x2, y: y2 });
  seg(ctx, { x: x1, y: y2 }, { x: x2, y: y1 });
  ctx.setLineDash([]);
} });
add("gannfan", { pts: 2, label: "Gann fan", group: "Gann & forks", draw(E, ctx, d, P) {
  const [a, b] = P;
  const dx = b.x - a.x || 1;
  const dy = b.y - a.y;
  GANN.forEach((g, k) => {
    const t = { x: a.x + dx, y: a.y + dy * g };
    ctx.strokeStyle = hexA(d.style.color || "#2962ff", g === 1 ? 1 : 0.55);
    seg(ctx, a, far(a, t, E));
    const lp = ext(a, t, 1.15);
    label(E, ctx, GANN_LAB[k], lp.x + 3, lp.y, { color: d.style.color, base: "middle", bold: false });
  });
} });
add("gannsquare", { pts: 2, label: "Gann square", group: "Gann & forks", draw(E, ctx, d, P) {
  const [a, b] = P;
  const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const x1 = a.x, y1 = b.y < a.y ? a.y - s : a.y;
  ctx.strokeRect(x1, y1, s, s);
  ctx.strokeStyle = hexA(d.style.color || "#2962ff", 0.45);
  for (let k = 1; k < 4; k++) {
    seg(ctx, { x: x1 + (s * k) / 4, y: y1 }, { x: x1 + (s * k) / 4, y: y1 + s });
    seg(ctx, { x: x1, y: y1 + (s * k) / 4 }, { x: x1 + s, y: y1 + (s * k) / 4 });
  }
  seg(ctx, { x: x1, y: y1 }, { x: x1 + s, y: y1 + s });
  seg(ctx, { x: x1, y: y1 + s }, { x: x1 + s, y: y1 });
} });
function fork(schiff) {
  return (E, ctx, d, P) => {
    if (P.length < 3) { poly(ctx, P); return; }
    let [a, b, c] = P;
    const m = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
    if (schiff) a = { x: a.x, y: (a.y + b.y) / 2 };
    const end = far(a, m, E);
    seg(ctx, a, end);
    const v = { x: end.x - a.x, y: end.y - a.y };
    seg(ctx, b, { x: b.x + v.x, y: b.y + v.y });
    seg(ctx, c, { x: c.x + v.x, y: c.y + v.y });
    ctx.setLineDash([4, 4]);
    seg(ctx, b, c);
    ctx.setLineDash([]);
    ctx.fillStyle = hexA(d.style.color || "#2962ff", 0.06);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x + v.x, b.y + v.y);
    ctx.lineTo(c.x + v.x, c.y + v.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
    ctx.fill();
  };
}
add("pitchfork", { pts: 3, label: "Pitchfork", group: "Gann & forks", draw: fork(false) });
add("schiff", { pts: 3, label: "Schiff pitchfork", group: "Gann & forks", draw: fork(true) });

// ── patterns
add("xabcd", { pts: 5, label: "XABCD pattern", group: "Patterns", draw: harmonic(["X", "A", "B", "C", "D"]) });
add("cypher", { pts: 5, label: "Cypher pattern", group: "Patterns", draw: harmonic(["X", "A", "B", "C", "D"]) });
add("abcd", { pts: 4, label: "ABCD pattern", group: "Patterns", draw: harmonic(["A", "B", "C", "D"]) });
add("headshoulders", { pts: 7, label: "Head and shoulders", group: "Patterns", draw(E, ctx, d, P) {
  const col = d.style.color || "#2962ff";
  ctx.fillStyle = hexA(col, 0.08);
  if (P.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(P[0].x, P[0].y);
    P.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fill();
  }
  poly(ctx, P);
  if (P.length >= 5) {
    ctx.setLineDash([5, 4]);
    seg(ctx, ext(P[2], P[4], -0.6), ext(P[2], P[4], 1.8));
    ctx.setLineDash([]);
  }
  const names = [null, "LS", null, "H", null, "RS", null];
  P.forEach((p, k) => { if (names[k]) label(E, ctx, names[k], p.x, p.y - 6 * E.scale, { color: col, align: "center" }); });
} });
add("trianglepat", { pts: 4, label: "Triangle pattern", group: "Patterns", draw(E, ctx, d, P) {
  poly(ctx, P);
  if (P.length >= 3) seg(ctx, P[0], ext(P[0], P[2], 1.6));
  if (P.length >= 4) seg(ctx, P[1], ext(P[1], P[3], 1.6));
  ["A", "B", "C", "D"].forEach((n, k) => { if (P[k]) label(E, ctx, n, P[k].x, P[k].y - 6 * E.scale, { color: d.style.color, align: "center" }); });
} });
add("threedrives", { pts: 7, label: "Three drives", group: "Patterns", draw: wavePoints(["0", "1", "A", "2", "B", "3", ""]) });
// ── Elliott waves
add("elliott_impulse", { pts: 6, label: "Elliott impulse (1-2-3-4-5)", group: "Elliott waves", draw: wavePoints(["0", "1", "2", "3", "4", "5"]) });
add("elliott_correction", { pts: 4, label: "Elliott correction (A-B-C)", group: "Elliott waves", draw: wavePoints(["0", "A", "B", "C"]) });
add("elliott_triangle", { pts: 6, label: "Elliott triangle (A-B-C-D-E)", group: "Elliott waves", draw: wavePoints(["0", "A", "B", "C", "D", "E"]) });
add("elliott_double", { pts: 4, label: "Elliott double combo (W-X-Y)", group: "Elliott waves", draw: wavePoints(["0", "W", "X", "Y"]) });
add("elliott_triple", { pts: 6, label: "Elliott triple combo (W-X-Y-X-Z)", group: "Elliott waves", draw: wavePoints(["0", "W", "X", "Y", "X", "Z"]) });
// ── cycles
add("cycliclines", { pts: 2, label: "Cyclic lines", group: "Cycles", draw(E, ctx, d, P) {
  const dx = Math.abs(P[1].x - P[0].x);
  if (dx < 4) return;
  for (let xx = Math.min(P[0].x, P[1].x); xx <= E.plotW; xx += dx) seg(ctx, { x: xx, y: 0 }, { x: xx, y: E.mainH });
} });
add("timecycles", { pts: 2, label: "Time cycles", group: "Cycles", draw(E, ctx, d, P) {
  const dx = Math.abs(P[1].x - P[0].x);
  if (dx < 4) return;
  const y = P[0].y;
  for (let xx = Math.min(P[0].x, P[1].x); xx <= E.plotW + dx; xx += dx) {
    ctx.beginPath();
    ctx.ellipse(xx + dx / 2, y, dx / 2, Math.min(dx / 2, E.mainH / 3), 0, Math.PI, 2 * Math.PI);
    ctx.stroke();
  }
} });
add("sineline", { pts: 2, label: "Sine line", group: "Cycles", draw(E, ctx, d, P) {
  const half = P[1].x - P[0].x || 1;
  const amp = (P[1].y - P[0].y) / 2;
  const mid = (P[0].y + P[1].y) / 2;
  ctx.beginPath();
  for (let xx = Math.min(P[0].x, 0); xx <= E.plotW; xx += 2) {
    const yy = mid - amp * Math.cos(((xx - P[0].x) / half) * Math.PI);
    if (xx === Math.min(P[0].x, 0)) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  }
  ctx.stroke();
} });

// ── forecast & measure
add("forecast", { pts: 2, label: "Forecast", group: "Forecast & measure", draw(E, ctx, d, P) {
  const col = d.style.color || "#2962ff";
  ctx.setLineDash([6, 4]);
  seg(ctx, P[0], P[1]);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(P[1].x, P[1].y, 5 * E.scale, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  const dp = d.points[1].p - d.points[0].p;
  label(E, ctx, `${d.style.text || "Forecast"} ${dp >= 0 ? "+" : ""}${((dp / d.points[0].p) * 100).toFixed(2)}%`, P[1].x + 8, P[1].y,
    { bg: hexA(col, 0.9), base: "middle" });
} });
add("projection", { pts: 3, label: "Projection", group: "Forecast & measure", draw(E, ctx, d, P) {
  if (P.length < 3) { poly(ctx, P); return; }
  const [a, b, c] = P;
  const t = { x: c.x + (b.x - a.x), y: c.y + (b.y - a.y) };
  poly(ctx, [a, b, c]);
  ctx.setLineDash([6, 4]);
  seg(ctx, c, t);
  ctx.setLineDash([]);
  ctx.fillStyle = hexA(d.style.color || "#2962ff", 0.08);
  ctx.fillRect(Math.min(c.x, t.x), Math.min(c.y, t.y), Math.abs(t.x - c.x), Math.abs(t.y - c.y));
  label(E, ctx, E.fmt(E.price(t.y)), t.x + 6, t.y, { color: d.style.color, base: "middle" });
} });
add("barspattern", { pts: 2, label: "Bars pattern", group: "Forecast & measure", draw(E, ctx, d, P) {
  const i0 = Math.round(E.timeToIndex(Math.min(d.points[0].t, d.points[1].t)));
  const i1 = Math.round(E.timeToIndex(Math.max(d.points[0].t, d.points[1].t)));
  if (i1 <= i0) return;
  const base = E.d[Math.max(0, Math.min(E.d.length - 1, i0))];
  const last = E.d[E.d.length - 1];
  const shiftI = E.d.length - i0;
  const shiftP = last.c - base.o;
  const col = d.style.color || "#2962ff";
  ctx.strokeStyle = hexA(col, 0.8);
  ctx.fillStyle = hexA(col, 0.35);
  ctx.strokeRect(Math.min(P[0].x, P[1].x), 0, Math.abs(P[1].x - P[0].x), E.mainH);
  for (let i = Math.max(0, i0); i <= Math.min(E.d.length - 1, i1); i++) {
    const k = E.d[i];
    const xx = E.x(i + shiftI);
    if (xx < 0 || xx > E.plotW) continue;
    const w = Math.max(1, E.spacing * 0.6);
    seg(ctx, { x: xx, y: E.y(k.h + shiftP) }, { x: xx, y: E.y(k.l + shiftP) });
    const y1 = E.y(Math.max(k.o, k.c) + shiftP);
    const y2 = E.y(Math.min(k.o, k.c) + shiftP);
    ctx.fillRect(xx - w / 2, y1, w, Math.max(1, y2 - y1));
  }
} });
add("pricerange", { pts: 2, label: "Price range", group: "Forecast & measure", draw(E, ctx, d, P) {
  const col = d.style.color || "#2962ff";
  const x = (P[0].x + P[1].x) / 2;
  ctx.fillStyle = hexA(col, 0.1);
  ctx.fillRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
  seg(ctx, { x: P[0].x, y: P[0].y }, { x: P[1].x, y: P[0].y });
  seg(ctx, { x: P[0].x, y: P[1].y }, { x: P[1].x, y: P[1].y });
  seg(ctx, { x, y: P[0].y }, { x, y: P[1].y });
  const dp = d.points[1].p - d.points[0].p;
  label(E, ctx, `${dp >= 0 ? "+" : ""}${E.fmt(dp)} (${((dp / d.points[0].p) * 100).toFixed(2)}%)`, x, Math.min(P[0].y, P[1].y) - 4,
    { bg: hexA(col, 0.9), align: "center" });
} });
add("daterange", { pts: 2, label: "Date range", group: "Forecast & measure", draw(E, ctx, d, P) {
  const col = d.style.color || "#2962ff";
  const y = (P[0].y + P[1].y) / 2;
  ctx.fillStyle = hexA(col, 0.1);
  ctx.fillRect(Math.min(P[0].x, P[1].x), Math.min(P[0].y, P[1].y), Math.abs(P[1].x - P[0].x), Math.abs(P[1].y - P[0].y));
  seg(ctx, { x: P[0].x, y: P[0].y }, { x: P[0].x, y: P[1].y });
  seg(ctx, { x: P[1].x, y: P[0].y }, { x: P[1].x, y: P[1].y });
  seg(ctx, { x: P[0].x, y }, { x: P[1].x, y });
  const bars = Math.round(E.timeToIndex(d.points[1].t) - E.timeToIndex(d.points[0].t));
  const secs = Math.abs(d.points[1].t - d.points[0].t);
  const dur = secs >= 86400 ? `${(secs / 86400).toFixed(1)}d` : secs >= 3600 ? `${(secs / 3600).toFixed(1)}h` : `${Math.round(secs / 60)}m`;
  label(E, ctx, `${bars} bars · ${dur}`, (P[0].x + P[1].x) / 2, Math.max(P[0].y, P[1].y) + 4, { bg: hexA(col, 0.9), align: "center", base: "top" });
} });
add("avwap", { pts: 1, label: "Anchored VWAP", group: "Forecast & measure", draw(E, ctx, d) {
  const i0 = Math.max(0, Math.round(E.timeToIndex(d.points[0].t)));
  let pv = 0, vol = 0, first = true;
  ctx.beginPath();
  for (let i = i0; i < E.d.length; i++) {
    const k = E.d[i];
    const tp = (k.h + k.l + k.c) / 3;
    pv += tp * (k.v || 1);
    vol += k.v || 1;
    const xx = E.x(i);
    const yy = E.y(pv / vol);
    if (first) { ctx.moveTo(xx, yy); first = false; } else ctx.lineTo(xx, yy);
  }
  ctx.lineWidth = 1.6 * E.scale;
  ctx.stroke();
  const p0 = E.d[i0];
  if (p0) label(E, ctx, "AVWAP", E.x(i0) + 4, E.y(p0.l) + 14 * E.scale, { color: d.style.color, base: "top" });
} });
add("frvp", { pts: 2, label: "Fixed range volume profile", group: "Forecast & measure", draw(E, ctx, d, P) {
  const i0 = Math.max(0, Math.round(E.timeToIndex(Math.min(d.points[0].t, d.points[1].t))));
  const i1 = Math.min(E.d.length - 1, Math.round(E.timeToIndex(Math.max(d.points[0].t, d.points[1].t))));
  if (i1 <= i0) return;
  let hi = -Infinity, lo = Infinity;
  for (let i = i0; i <= i1; i++) { hi = Math.max(hi, E.d[i].h); lo = Math.min(lo, E.d[i].l); }
  const bins = 24;
  const step = (hi - lo) / bins || 1;
  const vol = new Array(bins).fill(0);
  for (let i = i0; i <= i1; i++) {
    const k = E.d[i];
    const a = Math.max(0, Math.floor((k.l - lo) / step));
    const b = Math.min(bins - 1, Math.floor((k.h - lo) / step));
    for (let j = a; j <= b; j++) vol[j] += (k.v || 1) / (b - a + 1);
  }
  const mx = Math.max(...vol) || 1;
  const xa = E.x(i0);
  const width = (E.x(i1) - xa) * 0.6;
  const col = d.style.color || "#2962ff";
  let poc = 0;
  vol.forEach((v, j) => {
    if (v > vol[poc]) poc = j;
    const y1 = E.y(lo + (j + 1) * step);
    const y2 = E.y(lo + j * step);
    ctx.fillStyle = hexA(col, 0.28);
    ctx.fillRect(xa, y1 + 0.5, (v / mx) * width, Math.max(1, y2 - y1 - 1));
  });
  ctx.strokeStyle = "#ff5a6e";
  seg(ctx, { x: xa, y: E.y(lo + (poc + 0.5) * step) }, { x: E.x(i1), y: E.y(lo + (poc + 0.5) * step) });
  ctx.strokeStyle = hexA(col, 0.5);
  ctx.strokeRect(xa, E.y(hi), E.x(i1) - xa, E.y(lo) - E.y(hi));
} });

// ── shapes
add("circle", { pts: 2, label: "Circle", group: "Shapes", area: true, draw(E, ctx, d, P) {
  const r = Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y);
  ctx.beginPath();
  ctx.arc(P[0].x, P[0].y, r, 0, Math.PI * 2);
  ctx.fillStyle = d.style.fill || hexA(d.style.color || "#2962ff", 0.12);
  ctx.fill();
  ctx.stroke();
}, hit: (E, d, x, y, tol, P) => Math.abs(Math.hypot(x - P[0].x, y - P[0].y) - Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y)) <= tol
  || Math.hypot(x - P[0].x, y - P[0].y) <= Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y) });
add("ellipse", { pts: 2, label: "Ellipse", group: "Shapes", area: true, draw(E, ctx, d, P) {
  ctx.beginPath();
  ctx.ellipse((P[0].x + P[1].x) / 2, (P[0].y + P[1].y) / 2, Math.abs(P[1].x - P[0].x) / 2 || 1, Math.abs(P[1].y - P[0].y) / 2 || 1, 0, 0, Math.PI * 2);
  ctx.fillStyle = d.style.fill || hexA(d.style.color || "#2962ff", 0.12);
  ctx.fill();
  ctx.stroke();
} });
add("triangle", { pts: 3, label: "Triangle", group: "Shapes", area: true, draw(E, ctx, d, P) {
  ctx.fillStyle = d.style.fill || hexA(d.style.color || "#2962ff", 0.12);
  ctx.beginPath();
  ctx.moveTo(P[0].x, P[0].y);
  P.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
} });
add("curve", { pts: 3, label: "Curve", group: "Shapes", draw(E, ctx, d, P) {
  if (P.length < 3) { poly(ctx, P); return; }
  ctx.beginPath();
  ctx.moveTo(P[0].x, P[0].y);
  ctx.quadraticCurveTo(P[2].x, P[2].y, P[1].x, P[1].y);
  ctx.stroke();
} });
add("polyline", { pts: 4, label: "Polyline", group: "Shapes", draw(E, ctx, d, P) { poly(ctx, P); } });
add("arrowmark_up", { pts: 1, label: "Arrow up", group: "Shapes", draw(E, ctx, d, P) {
  const s = 9 * E.scale;
  ctx.fillStyle = d.style.color || "#22c993";
  ctx.beginPath();
  ctx.moveTo(P[0].x, P[0].y - s);
  ctx.lineTo(P[0].x + s, P[0].y + s * 0.4);
  ctx.lineTo(P[0].x + s * 0.35, P[0].y + s * 0.4);
  ctx.lineTo(P[0].x + s * 0.35, P[0].y + s * 1.4);
  ctx.lineTo(P[0].x - s * 0.35, P[0].y + s * 1.4);
  ctx.lineTo(P[0].x - s * 0.35, P[0].y + s * 0.4);
  ctx.lineTo(P[0].x - s, P[0].y + s * 0.4);
  ctx.closePath();
  ctx.fill();
}, hit: (E, d, x, y, tol, P) => Math.abs(x - P[0].x) <= 12 * E.scale && y >= P[0].y - 12 * E.scale && y <= P[0].y + 16 * E.scale });
add("arrowmark_down", { pts: 1, label: "Arrow down", group: "Shapes", draw(E, ctx, d, P) {
  const s = 9 * E.scale;
  ctx.fillStyle = d.style.color || "#ff5a6e";
  ctx.beginPath();
  ctx.moveTo(P[0].x, P[0].y + s);
  ctx.lineTo(P[0].x + s, P[0].y - s * 0.4);
  ctx.lineTo(P[0].x + s * 0.35, P[0].y - s * 0.4);
  ctx.lineTo(P[0].x + s * 0.35, P[0].y - s * 1.4);
  ctx.lineTo(P[0].x - s * 0.35, P[0].y - s * 1.4);
  ctx.lineTo(P[0].x - s * 0.35, P[0].y - s * 0.4);
  ctx.lineTo(P[0].x - s, P[0].y - s * 0.4);
  ctx.closePath();
  ctx.fill();
}, hit: (E, d, x, y, tol, P) => Math.abs(x - P[0].x) <= 12 * E.scale && y >= P[0].y - 16 * E.scale && y <= P[0].y + 12 * E.scale });
add("brush", { pts: 0, freehand: true, label: "Brush", group: "Shapes", draw(E, ctx, d, P) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  poly(ctx, P);
} });
add("highlighter", { pts: 0, freehand: true, label: "Highlighter", group: "Shapes", draw(E, ctx, d, P) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = hexA(d.style.color || "#f7c948", 0.35);
  ctx.lineWidth = 12 * E.scale;
  poly(ctx, P);
} });

// ── notes
function noteBox(E, ctx, d, x, y, text, { tail = null, icon = null } = {}) {
  const col = d.style.color || "#2962ff";
  ctx.font = E.fontB;
  const t = text || "Note";
  const w = ctx.measureText(t).width + 16 * E.scale + (icon ? 14 * E.scale : 0);
  const h = E.fs + 12 * E.scale;
  const x0 = x;
  const y0 = y - h;
  ctx.fillStyle = hexA(col, 0.92);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x0, y0, w, h, 6 * E.scale);
  else ctx.rect(x0, y0, w, h);
  ctx.fill();
  if (tail) {
    ctx.beginPath();
    ctx.moveTo(x0 + 10 * E.scale, y0 + h);
    ctx.lineTo(tail.x, tail.y);
    ctx.lineTo(x0 + 22 * E.scale, y0 + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText((icon ? `${icon} ` : "") + t, x0 + 8 * E.scale, y0 + h / 2 + 0.5);
  return { x: x0, y: y0, w, h };
}
const boxHit = (fn) => (E, d, x, y, tol, P) => {
  const b = fn(E, d, P);
  return b && x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
};
function noteRect(E, d, x, y, icon) {
  E.ctx.font = E.fontB;
  const w = E.ctx.measureText(d.style.text || "Note").width + 16 * E.scale + (icon ? 14 * E.scale : 0);
  const h = E.fs + 12 * E.scale;
  return { x, y: y - h, w, h };
}
add("note", { pts: 1, text: true, label: "Note", group: "Notes", draw(E, ctx, d, P) { noteBox(E, ctx, d, P[0].x, P[0].y, d.style.text, { icon: "✎" }); },
  hit: boxHit((E, d, P) => noteRect(E, d, P[0].x, P[0].y, true)) });
add("callout", { pts: 2, text: true, label: "Callout", group: "Notes", draw(E, ctx, d, P) {
  ctx.beginPath();
  ctx.arc(P[0].x, P[0].y, 3 * E.scale, 0, Math.PI * 2);
  ctx.fillStyle = d.style.color || "#2962ff";
  ctx.fill();
  noteBox(E, ctx, d, P[1] ? P[1].x : P[0].x, P[1] ? P[1].y : P[0].y - 30, d.style.text || "Callout", { tail: P[0] });
}, hit: boxHit((E, d, P) => noteRect(E, d, (P[1] || P[0]).x, (P[1] || P[0]).y, false)) });
add("comment", { pts: 1, text: true, label: "Comment", group: "Notes", draw(E, ctx, d, P) {
  noteBox(E, ctx, d, P[0].x - 12 * E.scale, P[0].y - 10 * E.scale, d.style.text || "Comment", { tail: P[0], icon: "💬" });
}, hit: boxHit((E, d, P) => noteRect(E, d, P[0].x - 12 * E.scale, P[0].y - 10 * E.scale, true)) });
add("pricelabel", { pts: 1, label: "Price label", group: "Notes", draw(E, ctx, d, P) {
  noteBox(E, ctx, { ...d, style: { ...d.style } }, P[0].x - 10 * E.scale, P[0].y - 10 * E.scale, E.fmt(d.points[0].p), { tail: P[0] });
} });
add("pricenote", { pts: 2, label: "Price note", group: "Notes", draw(E, ctx, d, P) {
  seg(ctx, P[0], P[1] || P[0]);
  ctx.beginPath();
  ctx.arc(P[0].x, P[0].y, 3 * E.scale, 0, Math.PI * 2);
  ctx.fillStyle = d.style.color || "#2962ff";
  ctx.fill();
  const b = P[1] || P[0];
  label(E, ctx, E.fmt(d.points[0].p), b.x + 4, b.y, { bg: hexA(d.style.color || "#2962ff", 0.92), base: "middle" });
} });
add("signpost", { pts: 1, text: true, label: "Signpost", group: "Notes", draw(E, ctx, d, P) {
  const top = P[0].y - 46 * E.scale;
  seg(ctx, P[0], { x: P[0].x, y: top });
  noteBox(E, ctx, d, P[0].x, top + 4 * E.scale, d.style.text || "Signpost");
}, hit: (E, d, x, y, tol, P) => Math.abs(x - P[0].x) <= tol + 30 * E.scale && y <= P[0].y + tol && y >= P[0].y - 70 * E.scale });
add("flag", { pts: 1, label: "Flag mark", group: "Notes", draw(E, ctx, d, P) {
  const s = E.scale;
  const col = d.style.color || "#ff5a6e";
  ctx.strokeStyle = col;
  seg(ctx, P[0], { x: P[0].x, y: P[0].y - 26 * s });
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(P[0].x, P[0].y - 26 * s);
  ctx.lineTo(P[0].x + 16 * s, P[0].y - 21 * s);
  ctx.lineTo(P[0].x, P[0].y - 15 * s);
  ctx.closePath();
  ctx.fill();
}, hit: (E, d, x, y, tol, P) => x >= P[0].x - tol && x <= P[0].x + 18 * E.scale && y <= P[0].y + tol && y >= P[0].y - 28 * E.scale });
add("pin", { pts: 1, text: true, label: "Pin", group: "Notes", draw(E, ctx, d, P) {
  const s = E.scale;
  const col = d.style.color || "#ff9f43";
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(P[0].x, P[0].y - 16 * s, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(P[0].x - 4 * s, P[0].y - 11 * s);
  ctx.lineTo(P[0].x, P[0].y);
  ctx.lineTo(P[0].x + 4 * s, P[0].y - 11 * s);
  ctx.fill();
  if (d.style.text) label(E, ctx, d.style.text, P[0].x + 10 * s, P[0].y - 16 * s, { color: col, base: "middle" });
}, hit: (E, d, x, y, tol, P) => Math.hypot(x - P[0].x, y - (P[0].y - 12 * E.scale)) <= 12 * E.scale + tol });

// ── stickers
const STICKERS = ["🚀", "🔥", "🎯", "💰", "⚠️", "✅", "❌", "👀", "📈", "📉", "🐂", "🐻", "💎", "🧲", "⏰", "⭐"];
export const STICKER_SET = STICKERS;
add("emoji", { pts: 1, label: "Emoji", group: "Stickers", draw(E, ctx, d, P) {
  ctx.font = `${Math.round(22 * E.scale)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(d.style.emoji || "🎯", P[0].x, P[0].y);
}, hit: (E, d, x, y, tol, P) => Math.hypot(x - P[0].x, y - P[0].y) <= 16 * E.scale + tol });
add("sticker", { pts: 1, label: "Sticker", group: "Stickers", draw(E, ctx, d, P) {
  const r = 22 * E.scale;
  ctx.fillStyle = hexA(d.style.color || "#2962ff", 0.22);
  ctx.beginPath();
  ctx.arc(P[0].x, P[0].y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `${Math.round(26 * E.scale)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(d.style.emoji || "🚀", P[0].x, P[0].y + 1);
}, hit: (E, d, x, y, tol, P) => Math.hypot(x - P[0].x, y - P[0].y) <= 24 * E.scale + tol });
add("icon", { pts: 1, label: "Icon", group: "Stickers", draw(E, ctx, d, P) {
  ctx.font = `700 ${Math.round(20 * E.scale)}px ${E.theme.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = d.style.color || "#f7c948";
  ctx.fillText(d.style.glyph || "★", P[0].x, P[0].y);
}, hit: (E, d, x, y, tol, P) => Math.hypot(x - P[0].x, y - P[0].y) <= 14 * E.scale + tol });

export const EXTRA_TOOLS = T;

/** Default hit test: near any segment between consecutive points, or inside the shape for area tools. */
export function hitExtra(E, d, x, y, tol) {
  const def = T[d.type];
  if (!def) return false;
  const P = d.points.map((p) => ({ x: E.tx(p.t), y: E.y(p.p) }));
  if (def.hit) return def.hit(E, d, x, y, tol, P);
  if (P.length === 1) return Math.hypot(x - P[0].x, y - P[0].y) <= tol + 4;
  for (let k = 0; k + 1 < P.length; k++) {
    const a = P[k];
    const b = P[k + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    let t = L ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)) <= tol) return true;
  }
  if (def.area) {
    const xs = P.map((p) => p.x);
    const ys = P.map((p) => p.y);
    return x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys);
  }
  return false;
}

export function drawExtra(E, d) {
  const def = T[d.type];
  if (!def) return false;
  const ctx = E.ctx;
  const P = d.points.map((p) => ({ x: E.tx(p.t), y: E.y(p.p) }));
  if (!P.length) return true;
  ctx.save();
  def.draw(E, ctx, d, P);
  ctx.restore();
  return true;
}

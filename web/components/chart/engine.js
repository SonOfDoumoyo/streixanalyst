// StreixAnalyst chart engine: a fast canvas chart with pan / zoom / pinch, candle styles, indicators,
// TradingView-style drawing tools and the animated AI analysis overlay. Framework-free; React wraps it.
import { computeAll, heikinAshi } from "./indicators";
import { DERIVED, derive, sessionProfiles, tpoLetter, niceBox, atr as atrOf } from "./series";
import { EXTRA_TOOLS, drawExtra, hitExtra } from "./drawtools";
import { runStudy } from "./studies";

export const TOOLS = {
  cursor: { pts: 0 }, crosshair: { pts: 0 }, eraser: { pts: 0, label: "Eraser" },
  trendline: { pts: 2, label: "Trend line" }, ray: { pts: 2, label: "Ray" }, extline: { pts: 2, label: "Extended line" },
  arrow: { pts: 2, label: "Arrow" }, hline: { pts: 1, label: "Horizontal line" }, hray: { pts: 1, label: "Horizontal ray" },
  vline: { pts: 1, label: "Vertical line" }, rect: { pts: 2, label: "Rectangle / zone" }, channel: { pts: 3, label: "Parallel channel" },
  fib: { pts: 2, label: "Fib retracement" }, long: { pts: 1, label: "Long position" }, short: { pts: 1, label: "Short position" },
  measure: { pts: 2, label: "Measure" }, text: { pts: 1, label: "Text note" },
  ...EXTRA_TOOLS,
};
// analysis layers that are always drawn, whichever strategies are chosen
const ALWAYS_LAYERS = new Set(["plan", "price", "user", "strategy"]);
// a touch is followed by emulated mouse events on most phones; those must never paint a crosshair
const TOUCH_GHOST_MS = 900;
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618];
// New York clock hour (0–23) of a unix time, for the killzone windows.
const NY_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
const nyHour = (sec) => Number(NY_HOUR.format(new Date(sec * 1000))) % 24;
// Fixed clock windows in New York time, the ones fixed-time traders trade: London 02:00–05:00, New York 07:00–10:00.
const KILLZONES = [
  { key: "london", label: "London", from: 2, to: 5, fill: "rgba(41,98,255,0.10)", text: "rgba(120,160,255,0.95)" },
  { key: "newyork", label: "New York", from: 7, to: 10, fill: "rgba(255,176,32,0.09)", text: "rgba(255,190,80,0.95)" },
];
const FIB_COL = ["#9aa7bd","#ff4d5e", "#ffa726", "#3ddc84", "#12d9a0", "#2fb5d6", "#ffc83d", "#9aa7bd", "#a77bff", "#ff4fa3"];
// TradingView-style dark palette, pushed brighter: chart #000000, axis text #9a9fac, candles #00e6a0 / #ff2d55.
const DEFAULT_THEME = {
  bg: "#000000", grid: "rgba(42,46,57,0.85)", text: "#9a9fac", crosshair: "#758696",
  up: "#00e6a0", down: "#ff2d55", wickUp: "#00e6a0", wickDown: "#ff2d55", borderUp: "#00e6a0", borderDown: "#ff2d55",
  line: "#e8a33d", axisLine: "#23262d", font: "-apple-system, BlinkMacSystemFont, \"Trebuchet MS\", Roboto, Ubuntu, sans-serif",
  label: "#2a3a5c", ma20: "#3fb8ff", ma50: "#ffb020", ma200: "#b78bff",
};
// grid is off by default (premium look); the user turns it on from the chart menu
const DEFAULT_OPTS = { style: "candles", volume: true, logScale: false, rsi: false, grid: false, watermark: true,
  indicators: { ema20: false, ema50: true, ema200: true, bb: false, vwap: false } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
let NEXT_ID = 1;
const newId = () => `d${Date.now().toString(36)}${(NEXT_ID++).toString(36)}`;

export function hexA(color, a) {
  if (!color) return `rgba(85,174,255,${a})`;
  if (color.startsWith("rgba(")) return color.replace(/rgba\(([^)]+),\s*[\d.]+\)/, `rgba($1,${a})`);
  if (color.startsWith("rgb(")) return color.replace("rgb(", "rgba(").replace(")", `,${a})`);
  let h = color.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return color;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Candle body and wick widths in DEVICE pixels for a bar spacing. The body takes about 80% of the slot, so candles
// are thick with a narrow gap, like TradingView. Body and wick have the same parity, so the wick sits exactly in the
// middle of the body with no half-pixel blur.
function bodyWidthD(sp, D) {
  const wick = Math.max(1, Math.round(D));
  const slot = sp * D;
  const minGap = Math.max(1, Math.round(D * 0.75));
  let b = Math.round(slot * 0.8);
  if ((b - wick) % 2) b = b + 1 <= Math.floor(slot) - minGap ? b + 1 : b - 1;
  b = Math.min(b, Math.floor(slot) - minGap);
  if ((b - wick) % 2) b -= 1;
  return { bw: Math.max(wick, b), wick };
}
const toRow = (r) => (Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] || 0 } : r);

export class ChartEngine {
  constructor(canvas, { onEvent, scale = 1 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.emit = onEvent || (() => {});
    this.scale = scale;
    this.d = [];                   // the series on screen: the candles, or the bricks of a renko / Kagi / P&F chart
    this.raw = [];                 // the candles as they came from the market
    this.box = null;               // box size of a derived chart (renko, Kagi, P&F, range)
    this.cross = null;             // the touch crosshair {x, y}: stays on the chart until a tap removes it
    this.compare = [];             // other markets drawn over this one: [{ symbol, color, rows }]
    this.ha = null;
    this.ind = null;
    this.tfSec = 3600;
    this.dec = 2;
    this.label = "";
    this.theme = { ...DEFAULT_THEME };
    this.opts = { ...DEFAULT_OPTS, indicators: { ...DEFAULT_OPTS.indicators } };
    this.spacing = 9;
    this.minCandle = 2;            // narrowest candle in px (Settings > Chart); pinching in stops here
    this.right = 0;
    this.auto = true;
    this.pmin = 0;
    this.pmax = 1;
    this.drawings = [];
    this.sel = null;
    this.tool = "cursor";
    this.placing = null;
    this.magnet = false;
    this.undoStack = [];
    this.redoStack = [];
    this.ana = null;
    this.anaStart = 0;
    this.detail = 2;
    this.scope = null;             // the analysis layers the chosen strategies use (null: all)
    this.hiddenLayers = new Set();
    this.studies = [];             // indicator instances [{ key, id, params }] (studies.js)
    this.studyOut = [];            // their computed values, same order
    this.sov = null;               // a strategy's trades drawn on the chart (strategy overlay)
    this.keepDrawing = false;      // stay in the drawing tool after placing a drawing
    this._lastTouch = -1e9;
    this._hoverOK = typeof window === "undefined" || !window.matchMedia || window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    this._labelBoxes = [];
    this.showAlt = true;
    this.pins = [];
    this.hover = null;
    this.pointers = new Map();
    this.drag = null;
    this.W = 0;
    this.H = 0;
    this.dpr = 1;
    this.axisW = 60;
    this.timeH = 24;
    this.rsiH = 0;
    this.mainH = 0;
    this.plotW = 0;
    this.drawingsVisible = true;
    this._dirty = true;
    this._alive = true;
    this._lastTap = 0;
    this._h = {
      down: (e) => this.onDown(e), move: (e) => this.onMove(e), up: (e) => this.onUp(e), leave: (e) => this.onLeave(e),
      wheel: (e) => this.onWheel(e), key: (e) => this.onKey(e), dbl: (e) => this.onDbl(e), ctx: (e) => this.onCtx(e),
    };
    const c = canvas;
    c.addEventListener("pointerdown", this._h.down);
    c.addEventListener("pointermove", this._h.move);
    c.addEventListener("pointerup", this._h.up);
    c.addEventListener("pointercancel", this._h.up);
    c.addEventListener("pointerleave", this._h.leave);
    c.addEventListener("wheel", this._h.wheel, { passive: false });
    c.addEventListener("keydown", this._h.key);
    c.addEventListener("dblclick", this._h.dbl);
    c.addEventListener("contextmenu", this._h.ctx);
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  destroy() {
    this._alive = false;
    cancelAnimationFrame(this._raf);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this._h.down);
    c.removeEventListener("pointermove", this._h.move);
    c.removeEventListener("pointerup", this._h.up);
    c.removeEventListener("pointercancel", this._h.up);
    c.removeEventListener("pointerleave", this._h.leave);
    c.removeEventListener("wheel", this._h.wheel);
    c.removeEventListener("keydown", this._h.key);
    c.removeEventListener("dblclick", this._h.dbl);
    c.removeEventListener("contextmenu", this._h.ctx);
  }

  dirty() {
    this._dirty = true;
  }

  _loop() {
    if (!this._alive) return;
    const animating = this.ana && performance.now() - this.anaStart < this._anaDuration() + 50;
    if (this._dirty || animating) {
      this._dirty = false;
      try {
        this.draw();
      } catch (err) {
        // never let one bad frame kill the chart
        if (typeof console !== "undefined") console.error("chart draw error", err);
      }
    }
    this._raf = requestAnimationFrame(this._loop);
  }

  resize(w, h, dpr) {
    this.W = Math.max(10, Math.floor(w));
    this.H = Math.max(10, Math.floor(h));
    this.dpr = dpr || window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(this.W * this.dpr);
    this.canvas.height = Math.floor(this.H * this.dpr);
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.layout();
    this.dirty();
  }

  // ───────────── data ─────────────
  setData(rows, { tfSec, decimals, label, keepView = false, keepWidth = false } = {}) {
    const keepT = keepView && this.d.length ? this.indexToTime(this.right) : null;
    // a chart that was following the latest candle keeps following it after a reload
    const n0 = this.d.length;
    const follow = keepView && n0 && this.right >= n0 - 1.5 ? this.right - (n0 - 1) : null;
    // keepWidth: a new set of candles (another symbol, timeframe or replay moment) keeps the candle width the person
    // chose. The view still goes to the latest candle, but the zoom is never changed for them.
    const width = keepWidth ? this.spacing : null;
    this.raw = rows.map(toRow);
    if (!keepView) {                           // a new chart starts without the crosshair
      this.cross = null;
      this.hover = null;
    }
    if (tfSec) this.tfSec = tfSec;
    if (decimals !== undefined && decimals !== null) this.dec = decimals;
    if (label !== undefined) this.label = label;
    this._recompute();
    if (follow !== null && this.d.length) this.right = this.d.length - 1 + follow;
    else if (keepT !== null) this.right = this.timeToIndex(keepT);
    else if (rows.length) {
      this.resetView();
      if (width !== null) {
        this.spacing = clamp(width, this._minSp(), 80 * this.scale);
        this._clampRight();
      }
    }
    this.dirty();
  }

  /** Live candles: the last few, the forming one included. Returns { gap } when the new candles do not follow on from
   *  the chart's last one (the phone slept, the tab was hidden, the network dropped): those candles are not added, so
   *  the chart never shows a hole, and the page reloads the whole series instead. */
  updateTail(rows) {
    if (!this.raw.length || !rows || !rows.length) return { gap: false, added: 0 };
    const following = this.right >= this.d.length - 1.5;
    const before = this.d.length;
    let added = 0;
    for (const r of rows) {
      const k = toRow(r);
      const L = this.raw[this.raw.length - 1];
      if (k.t === L.t) this.raw[this.raw.length - 1] = k;
      else if (k.t > L.t) {
        // one step after the last candle follows on; anything later means candles in between are missing
        if (k.t - L.t > this.tfSec * 1.5) return { gap: true, added };
        this.raw.push(k);
        added++;
      }
    }
    this._recompute();
    const grew = this.d.length - before;
    if (following && grew > 0) this.right += grew;
    if (this.cross) this._emitHover();
    this.dirty();
    return { gap: false, added };
  }

  _recompute() {
    const style = this.opts.style;
    if (DERIVED.has(style)) {
      const r = derive(style, this.raw);
      this.d = r.d;
      this.box = r.box;
    } else {
      this.d = this.raw;
      this.box = null;
    }
    this.ha = style === "heikin" ? heikinAshi(this.d) : null;
    this.ind = this.d.length ? computeAll(this.d, this.tfSec < 86400 && !DERIVED.has(style)) : null;
    this._computeStudies();
    this._prof = null;
    let top = 1;
    for (const k of this.raw) if (k.h > top) top = k.h;
    this._axisRef = top;         // the widest price in the data sets the axis width (see layout)
    this._kz = null;             // killzone of each candle, worked out again for the new data
  }

  // Which killzone a candle opens in: 0 none, 1 London, 2 New York. The windows are fixed clock hours in New York time.
  _zoneOf(i) {
    if (!this._kz || this._kz.length !== this.d.length) this._kz = new Int8Array(this.d.length).fill(-1);
    if (this._kz[i] < 0) {
      const h = nyHour(this.d[i].t);
      this._kz[i] = h >= KILLZONES[0].from && h < KILLZONES[0].to ? 1 : h >= KILLZONES[1].from && h < KILLZONES[1].to ? 2 : 0;
    }
    return this._kz[i];
  }

  // A band behind the candles for each killzone in view, labelled at its left edge.
  _drawKillzones(i0, i1) {
    const ctx = this.ctx;
    const first = Math.max(0, Math.floor(i0));
    const last = Math.min(this.d.length - 1, Math.ceil(i1));
    const runs = [];
    let cur = null;
    for (let i = first; i <= last; i++) {
      const z = this._zoneOf(i);
      if (z === 0) { cur = null; continue; }
      if (cur && cur.z === z) cur.b = i;
      else { cur = { z, a: i, b: i }; runs.push(cur); }
    }
    const half = this.spacing / 2;
    const pad = 6 * this.scale;
    ctx.save();
    ctx.font = `600 ${Math.round(10 * this.scale)}px ${this.theme.font}`;
    ctx.textBaseline = "top";
    let labelEnd = -Infinity;   // where the last name printed ends, so two names never overprint
    for (const r of runs) {
      const K = KILLZONES[r.z - 1];
      const x0 = Math.max(0, this.x(r.a) - half);
      const x1 = Math.min(this.plotW, this.x(r.b) + half);
      if (x1 <= x0) continue;
      ctx.fillStyle = K.fill;
      ctx.fillRect(x0, 0, x1 - x0, this.mainH);
      const lx = x0 + pad;
      const lw = ctx.measureText(K.label).width;
      if (lx >= labelEnd + 4 * this.scale && lx + lw <= this.plotW) {
        ctx.fillStyle = K.text;
        ctx.fillText(K.label, lx, pad);
        labelEnd = lx + lw;
      }
    }
    ctx.restore();
  }

  setTheme(theme) {
    this.theme = { ...this.theme, ...theme };
    this.dirty();
  }

  setOptions(opts) {
    const prevStyle = this.opts.style;
    this.opts = { ...this.opts, ...opts, indicators: { ...this.opts.indicators, ...(opts.indicators || {}) } };
    if (this.opts.style !== prevStyle) {
      // renko, Kagi, P&F and range charts have their own bricks, so the view is carried over by time
      const n0 = this.d.length;
      const following = n0 && this.right >= n0 - 1.5;
      const t = n0 ? this.indexToTime(clamp(this.right, 0, n0 - 1)) : null;
      const reshaped = DERIVED.has(prevStyle) || DERIVED.has(this.opts.style);
      this._recompute();
      if (reshaped && this.d.length) {
        this.right = following ? this.d.length - 1 + Math.max(4, Math.round((this.plotW || 800) / this.spacing * 0.08))
          : this.timeToIndex(t);
        this.auto = true;
        this._clampRight();
      }
    }
    if (opts.minCandle !== undefined) {
      this.minCandle = clamp(Number(opts.minCandle) || 2, 1, 10);
      if (this.spacing < this._minSp()) this.spacing = this._minSp();
    }
    this.dirty();
  }

  setScale(s) {
    this.scale = s;
    this.dirty();
  }

  // ───────────── coordinates ─────────────
  layout() {
    const s = this.scale;
    const fs = Math.round(11 * s);
    this.fs = fs;
    this.font = `${fs}px ${this.theme.font}`;
    this.fontB = `600 ${fs}px ${this.theme.font}`;
    const ctx = this.ctx;
    ctx.font = this.font;
    // sized from the widest price in the data, not the visible range, so the axis keeps its width while the price pane is scaled
    const sample = this.fmt(Math.max(this._axisRef || 1, 1) * 1.1);
    this.axisW = Math.max(Math.round(58 * s), Math.ceil(ctx.measureText(sample).width) + Math.round(20 * s));
    this.timeH = Math.round(24 * s);
    const avail = this.H - this.timeH;
    // panes under the price chart: the RSI switch and every pane study; each gets ~18% (less when there are many)
    const n = (this.opts.rsi ? 1 : 0) + this._panes().length;
    const each = n ? Math.round(avail * Math.max(0.1, Math.min(0.2, 0.42 / n))) : 0;
    this.paneH = each;
    this.rsiH = each * n;
    this.mainH = avail - this.rsiH;
    this.plotW = this.W - this.axisW;
  }

  fmt(p) {
    if (p === null || p === undefined || !Number.isFinite(p)) return "";
    // large prices get thousands separators (99,500.00), so they read at a glance
    if (Math.abs(p) >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: this.dec, maximumFractionDigits: this.dec });
    return p.toFixed(this.dec);
  }

  x(i) {
    return this.plotW - (this.right - i) * this.spacing;
  }

  index(x) {
    return this.right - (this.plotW - x) / this.spacing;
  }

  _f(p) {
    return this.opts.logScale ? Math.log(Math.max(p, 1e-12)) : p;
  }

  _fi(v) {
    return this.opts.logScale ? Math.exp(v) : v;
  }

  _pads() {
    return [this.mainH * 0.07, this.mainH * (this.opts.volume ? 0.13 : 0.07)];
  }

  y(p) {
    const [top, bot] = this._pads();
    const a = this._f(this.pmin);
    const b = this._f(this.pmax);
    return top + ((b - this._f(p)) / (b - a || 1)) * (this.mainH - top - bot);
  }

  price(y) {
    const [top, bot] = this._pads();
    const a = this._f(this.pmin);
    const b = this._f(this.pmax);
    return this._fi(b - ((y - top) / (this.mainH - top - bot)) * (b - a));
  }

  timeToIndex(t) {
    const d = this.d;
    const n = d.length;
    if (!n) return 0;
    if (t >= d[n - 1].t) return n - 1 + (t - d[n - 1].t) / this.tfSec;
    if (t <= d[0].t) return (t - d[0].t) / this.tfSec;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (d[m].t <= t) lo = m;
      else hi = m;
    }
    const span = d[hi].t - d[lo].t;
    return lo + (span > 0 ? (t - d[lo].t) / span : 0);
  }

  indexToTime(i) {
    const d = this.d;
    const n = d.length;
    if (!n) return 0;
    if (i >= n - 1) return d[n - 1].t + (i - (n - 1)) * this.tfSec;
    if (i <= 0) return d[0].t + i * this.tfSec;
    const lo = Math.floor(i);
    return d[lo].t + (i - lo) * (d[lo + 1].t - d[lo].t);
  }

  tx(t) {
    return this.x(this.timeToIndex(t));
  }

  visRange() {
    const n = this.d.length;
    const i0 = Math.max(0, Math.floor(this.index(0)) - 1);
    const i1 = Math.min(n - 1, Math.ceil(this.index(this.plotW)) + 1);
    return [i0, i1];
  }

  autoscale() {
    const [i0, i1] = this.visRange();
    const src = this.ha || this.d;
    // one bad tick can stretch the scale far past the price. A wick more than 6 typical ranges beyond the candles
    // around it is clipped to that band, so trends and real moves keep their full height.
    const n = src.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      const near = [];
      for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) if (j !== i && src[j]) near.push(src[j]);
      let l = k.l;
      let h = k.h;
      if (near.length >= 3) {
        const lows = near.map((x) => x.l).sort((a, b) => a - b);
        const highs = near.map((x) => x.h).sort((a, b) => a - b);
        const spans = near.map((x) => x.h - x.l).sort((a, b) => a - b);
        const band = spans[spans.length >> 1] * 6 || Infinity;
        const midLo = lows[lows.length >> 1];
        const midHi = highs[highs.length >> 1];
        if (l < midLo - band) l = midLo - band;
        if (h > midHi + band) h = midHi + band;
      }
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }
    for (const { vals } of this._compareLines(i0, i1)) {
      for (let i = i0; i <= i1; i++) {
        if (vals[i] === null) continue;
        if (vals[i] < lo) lo = vals[i];
        if (vals[i] > hi) hi = vals[i];
      }
    }
    if (!Number.isFinite(lo)) {
      if (this.d.length) {
        const k = this.d[this.d.length - 1];
        lo = k.l;
        hi = k.h;
      } else return;
    }
    if (this.ana && this.pins.length) {
      for (const p of this.pins) {
        if (p > 0 && p < hi + (hi - lo) * 3 && p > lo - (hi - lo) * 3) {
          lo = Math.min(lo, p);
          hi = Math.max(hi, p);
        }
      }
    }
    if (hi - lo < Math.abs(hi) * 1e-6) {
      hi += Math.abs(hi) * 0.005 || 1;
      lo -= Math.abs(lo) * 0.005 || 1;
    }
    this.pmin = lo;
    this.pmax = hi;
  }

  resetView() {
    const n = this.d.length;
    this.spacing = clamp(Math.round(10 * this.scale), 3, 40);
    this.right = n - 1 + Math.max(6, Math.round((this.plotW || 800) / this.spacing * 0.08));
    this.auto = true;
    this.dirty();
    this.emit("view", this.viewState());
  }

  viewState() {
    const [i0, i1] = this.visRange();
    return { i0, i1, n: this.d.length, auto: this.auto, spacing: this.spacing };
  }

  /** Show the time span [tFrom, tTo] (e.g. the analysis focus). */
  fitTimes(tFrom, tTo, minSpacing = 2) {
    if (!this.d.length || !this.plotW) return;
    const a = this.timeToIndex(tFrom);
    const b = this.timeToIndex(tTo);
    const bars = Math.max(20, b - a);
    this.spacing = clamp(this.plotW / bars, Math.min(minSpacing * this.scale, 40), 40);
    this.right = b;
    this.auto = true;
    this.dirty();
  }

  /** Show a span of time ending at the latest candle: seconds, "ytd" or "all". */
  showRange(span) {
    if (!this.d.length) return;
    const last = this.d[this.d.length - 1].t;
    let from;
    if (span === "all") from = this.d[0].t;
    else if (span === "ytd") from = Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000;
    else from = last - Number(span);
    this.fitTimes(Math.max(from, this.d[0].t), last + this.tfSec * 3, 0.5);
    this.emit("view", this.viewState());
  }

  /** Centre the chart on a time (a date picked by the person). */
  goTo(t) {
    if (!this.d.length || !this.plotW) return;
    const i = this.timeToIndex(t);
    this.right = i + this.plotW / this.spacing / 2;
    this._clampRight();
    this.auto = true;
    this.dirty();
    this.emit("view", this.viewState());
  }

  /** Bring the time span [tFrom, tTo] on screen by panning. The candle width the person chose stays as it is, and a
   *  span that is already visible leaves the view alone. */
  panTo(tFrom, tTo) {
    if (!this.d.length || !this.plotW) return;
    const a = this.timeToIndex(tFrom);
    const b = this.timeToIndex(tTo);
    const [i0, i1] = this.visRange();
    if (a >= i0 && b <= i1) return;
    const visible = i1 - i0;
    // a span that fits is centred; a longer one starts at the left edge, so the setup and its levels are seen first
    this.right = b - a <= visible ? (a + b) / 2 + visible / 2 : a + visible - 3;
    this._clampRight();
    this.dirty();
    this.emit("view", this.viewState());
  }

  // ───────────── analysis overlay ─────────────
  setAnalysis(items, { animate = true, pins = [] } = {}) {
    this.ana = items && items.length ? items : null;
    this.pins = pins;
    this.anaStart = animate ? performance.now() : performance.now() - 1e6;
    const orders = [...new Set((items || []).map((d) => d.order))].sort((a, b) => a - b);
    this._orderRank = new Map(orders.map((o, k) => [o, k]));
    this.dirty();
  }

  /** Show or hide the analysis overlay without removing it (the object tree's switch). */
  setAnalysisVisible(on) {
    this.anaHidden = !on;
    this.dirty();
  }

  clearAnalysis() {
    this.ana = null;
    this.pins = [];
    this.dirty();
  }

  setDetail(n) {
    this.detail = n;
    this.dirty();
  }

  setHiddenLayers(set) {
    this.hiddenLayers = new Set(set || []);
    this.dirty();
  }

  setShowAlt(b) {
    this.showAlt = b;
    this.dirty();
  }

  /** The analysis layers to draw (the ones the chosen strategies use); null draws every layer. */
  setScope(layers) {
    this.scope = layers && layers.length ? new Set(layers) : null;
    this.dirty();
  }

  /** Is this analysis item drawn right now? (layer switches, the strategies' scope, the alternative plan) */
  _anaOn(it) {
    // with strategies chosen, the chart shows everything those strategies use (no detail levels); without, the main items
    if ((!this.scope && it.prio > this.detail) || this.hiddenLayers.has(it.layer)) return false;
    if (this.scope && !this.scope.has(it.layer) && !ALWAYS_LAYERS.has(it.layer) && it.layer !== "indicators") return false;
    if (it.plan === "alternative" && !this.showAlt) return false;
    return true;
  }

  /** A strategy's past trades and lines drawn on the chart (same item format as the analysis). */
  setStrategyOverlay(items) {
    this.sov = items && items.length ? items : null;
    this.dirty();
  }

  // ───────────── indicators (studies.js) ─────────────
  setStudies(list) {
    this.studies = (list || []).filter((s) => s && s.id).map((s) => ({ ...s, params: { ...(s.params || {}) } }));
    this._computeStudies();
    this.layout();
    this.dirty();
  }

  _computeStudies() {
    this.studyOut = this.d.length ? this.studies.map((s) => (s.hidden ? null : runStudy(s, this.d))) : [];
  }

  _panes() {
    const out = [];
    this.studies.forEach((s, k) => {
      const r = this.studyOut[k];
      if (r && r.kind === "pane") out.push({ inst: s, out: r });
    });
    return out;
  }

  /** Values of every study at candle i, for the legend. */
  studyValues(i) {
    const out = [];
    this.studies.forEach((s, k) => {
      const r = this.studyOut[k];
      if (!r) return;
      const vals = [];
      if (r.hist && r.hist.v[i] !== null && r.hist.v[i] !== undefined) vals.push({ v: r.hist.v[i], color: r.hist.up });
      for (const l of r.lines || []) if (l.v[i] !== null && l.v[i] !== undefined) vals.push({ v: l.v[i], color: l.color, label: l.label });
      out.push({ key: s.key, id: s.id, name: r.name, kind: r.kind, vals });
    });
    return out;
  }

  lockAll(on) {
    if (!this.drawings.length) return;
    this._snapshot();
    for (const d of this.drawings) d.locked = !!on;
    this._changed();
  }

  _anaDuration() {
    if (!this.ana) return 0;
    const n = this._orderRank ? this._orderRank.size : 0;
    return n * 110 + 520;
  }

  _prog(item) {
    const k = (this._orderRank && this._orderRank.get(item.order)) || 0;
    const t = (performance.now() - this.anaStart - k * 110) / 520;
    return easeOut(clamp(t, 0, 1));
  }

  // ───────────── drawings ─────────────
  setDrawings(list) {
    this.drawings = (list || []).map((d) => ({ ...d, points: (d.points || []).map((p) => ({ ...p })), style: { ...(d.style || {}) } }));
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty();
  }

  getDrawings() {
    return this.drawings.map((d) => ({ ...d, points: d.points.map((p) => ({ ...p })), style: { ...d.style } }));
  }

  _snapshot() {
    this.undoStack.push(JSON.stringify(this.drawings));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  _changed() {
    this.emit("drawings", this.getDrawings());
    this.dirty();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.undoStack.pop());
    this.sel = null;
    this.emit("select", null);
    this._changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.redoStack.pop());
    this.sel = null;
    this.emit("select", null);
    this._changed();
  }

  setTool(name) {
    this.tool = TOOLS[name] ? name : "cursor";
    this.placing = null;
    if (this.tool !== "cursor" && this.tool !== "crosshair") this.select(null);
    this.canvas.style.cursor = "crosshair";
    this.dirty();
  }

  select(id) {
    this.sel = id;
    const d = this.drawings.find((x) => x.id === id) || null;
    this.emit("select", d ? { ...d, points: d.points.map((p) => ({ ...p })), style: { ...d.style } } : null);
    this.dirty();
  }

  selected() {
    return this.drawings.find((x) => x.id === this.sel) || null;
  }

  updateSelected(patch) {
    const d = this.selected();
    if (!d) return;
    this._snapshot();
    if (patch.style) d.style = { ...d.style, ...patch.style };
    if (patch.locked !== undefined) d.locked = patch.locked;
    if (patch.hidden !== undefined) d.hidden = patch.hidden;
    if (patch.points) d.points = patch.points.map((p) => ({ ...p }));
    this._changed();
    this.select(d.id);
  }

  deleteSelected() {
    if (!this.sel) return;
    this._snapshot();
    this.drawings = this.drawings.filter((d) => d.id !== this.sel);
    this.sel = null;
    this.emit("select", null);
    this._changed();
  }

  /** Change one drawing (hide, lock) without selecting it: the object tree's buttons. */
  updateDrawing(id, patch) {
    const d = this.drawings.find((x) => x.id === id);
    if (!d) return;
    this._snapshot();
    if (patch.hidden !== undefined) d.hidden = patch.hidden;
    if (patch.locked !== undefined) d.locked = patch.locked;
    if (patch.style) d.style = { ...d.style, ...patch.style };
    this._changed();
  }

  deleteDrawing(id) {
    if (!this.drawings.some((x) => x.id === id)) return;
    this._snapshot();
    this.drawings = this.drawings.filter((d) => d.id !== id);
    if (this.sel === id) {
      this.sel = null;
      this.emit("select", null);
    }
    this._changed();
  }

  /** Markets drawn over this one: [{ symbol, color, label, rows }] with rows as [t, o, h, l, c, v]. */
  setCompare(list) {
    this.compare = (list || []).filter((c) => c && c.rows && c.rows.length).map((c) => ({ ...c, map: null }));
    this.dirty();
  }

  cloneSelected() {
    const d = this.selected();
    if (!d) return;
    this._snapshot();
    const shift = this.tfSec * 5;
    const c = { ...d, id: newId(), points: d.points.map((p) => ({ t: p.t + shift, p: p.p })), style: { ...d.style } };
    this.drawings.push(c);
    this._changed();
    this.select(c.id);
  }

  clearDrawings() {
    if (!this.drawings.length) return;
    this._snapshot();
    this.drawings = [];
    this.sel = null;
    this.emit("select", null);
    this._changed();
  }

  setDrawingsVisible(v) {
    this.drawingsVisible = v;
    this.dirty();
  }

  addDrawing(d) {
    this._snapshot();
    const nd = { id: newId(), style: {}, ...d };
    this.drawings.push(nd);
    this._changed();
    return nd.id;
  }

  setText(id, text) {
    const d = this.drawings.find((x) => x.id === id);
    if (!d) return;
    if (!text) {
      this.drawings = this.drawings.filter((x) => x.id !== id);
      this.sel = null;
      this.emit("select", null);
    } else d.style = { ...d.style, text };
    this._changed();
  }

  // ───────────── pointer handling ─────────────
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _area(x, y) {
    if (x > this.plotW) return y < this.mainH ? "paxis" : "corner";
    if (y > this.H - this.timeH) return "taxis";
    if (y > this.mainH) return "rsi";
    return "plot";
  }

  _pt(x, y, snap = true) {
    let i = this.index(x);
    if (snap) i = Math.round(i);
    let p = this.price(y);
    if (this.magnet && snap) {
      const k = this.d[clamp(Math.round(i), 0, this.d.length - 1)];
      if (k && Math.round(i) <= this.d.length - 1 && Math.round(i) >= 0) {
        let best = null;
        let bd = this.magnet === "strong" ? Infinity : 16 * this.scale;
        for (const v of [k.o, k.h, k.l, k.c]) {
          const dd = Math.abs(this.y(v) - y);
          if (dd < bd) {
            bd = dd;
            best = v;
          }
        }
        if (best !== null) p = best;
      }
    }
    return { t: Math.round(this.indexToTime(i)), p };
  }

  onDown(e) {
    if (!this.d.length) return;
    this.canvas.focus({ preventScroll: true });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const { x, y } = this._pos(e);
    this.pointers.set(e.pointerId, { x, y });
    const touch = e.pointerType === "touch";
    if (e.pointerType !== "mouse") this._lastTouch = performance.now();
    clearTimeout(this._pressT);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      // two fingers: apart sideways zooms the candle width only; the price scale is the price pane's job. A crosshair
      // that is up stays where it is.
      this.drag = { mode: "pinch", dx0: Math.abs(a.x - b.x), sp0: this.spacing,
        i0: this.index((a.x + b.x) / 2), right0: this.right };
      this.placing = null;
      return;
    }
    if (this.pointers.size > 2) return;
    const area = this._area(x, y);
    // the eraser removes the drawing under the finger
    if (this.tool === "eraser" && area === "plot") {
      const hit = this._hit(x, y);
      if (hit) this.deleteDrawing(hit.id);
      return;
    }
    // freehand: the brush and the highlighter record the finger's path
    const spec0 = TOOLS[this.tool];
    if (spec0 && spec0.freehand && area === "plot") {
      this._snapshot();
      const def = this.drawingDefaults || { color: "#2962ff", width: 2, dash: "solid" };
      const d = { id: newId(), type: this.tool, points: [this._pt(x, y, false)], style: { ...def, ...(this.toolStyle || {}) } };
      this.drawings.push(d);
      this.drag = { mode: "brush", id: d.id, last: { x, y } };
      this.dirty();
      return;
    }
    // placing a drawing
    if (this.tool !== "cursor" && this.tool !== "crosshair" && area === "plot") {
      this._place(x, y, touch);
      return;
    }
    if (area === "paxis") {
      // on the crosshair's price tag (the + button) a tap opens the line and alert menu; a drag scales the price axis
      const ch = this._ch();
      const tagH = this.fs + 8 * this.scale;
      const tag = !!ch && Math.abs(y - clamp(ch.y, tagH / 2, this.mainH - tagH / 2)) <= tagH / 2 + 10 * this.scale;
      this.drag = { mode: "yscale", y0: y, pmin: this.pmin, pmax: this.pmax, tag, tagY: ch ? ch.y : y, tagX: ch ? ch.x : this.plotW,
        scaled: false, t0: performance.now() };
      return;
    }
    if (area === "taxis") {
      this.drag = { mode: "xscale", x0: x, sp0: this.spacing, i0: this.index(this.plotW / 2), mid: this.plotW / 2, moved: false,
        t0: performance.now() };
      return;
    }
    if (touch && this.cross) {
      // The crosshair is up. Like TradingView: a finger moved anywhere on the chart moves the crosshair with it, by the
      // same distance, and lifting leaves it where it is. A tap without moving removes it.
      this.drag = { mode: "cross", x0: x, y0: y, cx0: this.cross.x, cy0: this.cross.y, moved: false, fresh: false,
        t0: performance.now() };
      return;
    }
    if (area === "plot" && this.drawingsVisible) {
      const hit = this._hit(x, y);
      if (hit) {
        const d = this.drawings.find((q) => q.id === hit.id);
        if (this.sel !== hit.id) this.select(hit.id);
        if (d && !d.locked) {
          this._snapshot();
          this.drag = { mode: hit.handle !== undefined ? "handle" : "body", id: hit.id, handle: hit.handle, x0: x, y0: y,
            pts: d.points.map((p) => ({ ...p })), moved: false };
        } else this.drag = { mode: "pan", x0: x, y0: y, right0: this.right, pmin: this.pmin, pmax: this.pmax, moved: false };
        return;
      }
    }
    this.drag = { mode: "pan", x0: x, y0: y, right0: this.right, pmin: this.pmin, pmax: this.pmax, moved: false, touch,
      t0: performance.now(), far: false, last: { x, y } };
    // touch: holding still brings up the crosshair under the finger. It follows the finger, and it stays on the chart
    // after the finger lifts, until a tap removes it. Moving more than 10px first keeps the press a pan.
    if (touch) {
      this._pressT = setTimeout(() => {
        const dr = this.drag;
        if (!dr || dr.mode !== "pan" || dr.far || this.pointers.size !== 1) return;
        const p = dr.last || { x: dr.x0, y: dr.y0 };
        this.right = dr.right0;                 // undo the few pixels of pan the finger made while holding
        this.cross = { x: clamp(p.x, 0, this.plotW), y: clamp(p.y, 0, this.mainH) };
        Object.assign(dr, { mode: "cross", x0: p.x, y0: p.y, cx0: this.cross.x, cy0: this.cross.y, moved: false, fresh: true });
        try { if (navigator.vibrate) navigator.vibrate(8); } catch { /* not supported */ }
        this._emitHover();
        this.dirty();
      }, 380);
    }
  }

  _place(x, y, touch) {
    const tool = this.tool;
    const spec = TOOLS[tool];
    const pt = this._pt(x, y);
    const def = this.drawingDefaults || { color: "#2962ff", width: 2, dash: "solid" };
    if (!this.placing) {
      if (spec.pts === 1) {
        let d;
        if (tool === "long" || tool === "short") {
          const k = this.d[this.d.length - 1];
          const range = Math.abs(this.pmax - this.pmin) || k.c * 0.02;
          const risk = range * 0.06;
          const dir = tool === "long" ? 1 : -1;
          const t2 = pt.t + this.tfSec * 24;
          d = { type: tool, points: [{ t: pt.t, p: pt.p }, { t: t2, p: pt.p - dir * risk }, { t: t2, p: pt.p + dir * 2 * risk }],
            style: { ...def } };
        } else {
          const wantsText = tool === "text" || (spec && spec.text);
          d = { type: tool, points: [pt], style: { ...def, ...(wantsText ? { text: "" } : {}), ...(this.toolStyle || {}) } };
        }
        const id = this.addDrawing(d);
        this.select(id);
        if (tool === "text" || (spec && spec.text)) this.emit("requestText", id);
        if (!this.keepDrawing) {
          this.emit("toolDone", tool);
          this.tool = "cursor";
        }
        return;
      }
      this._snapshot();
      const d = { id: newId(), type: tool, points: Array.from({ length: Math.min(2, spec.pts) }, () => ({ ...pt })), style: { ...def, ...(this.toolStyle || {}) } };
      if (tool === "rect") d.style.fill = d.style.fill || hexA(def.color, 0.14);
      this.drawings.push(d);
      this.placing = { id: d.id, step: 1, x0: x, y0: y, touch, downAt: performance.now() };
      this.sel = d.id;
      this.dirty();
      return;
    }
    // next click
    this._advancePlacing();
  }

  _advancePlacing() {
    const pl = this.placing;
    const d = this.drawings.find((q) => q.id === pl.id);
    if (!d) {
      this.placing = null;
      return;
    }
    const need = TOOLS[d.type].pts;
    if (pl.step + 1 < need) {
      pl.step += 1;
      d.points.push({ ...d.points[d.points.length - 1] });
      this.dirty();
      return;
    }
    this.placing = null;
    if (!this.keepDrawing) {
      this.tool = "cursor";
      this.emit("toolDone", d.type);
    }
    this._changed();
    this.select(d.id);
    if (TOOLS[d.type] && TOOLS[d.type].text) this.emit("requestText", d.id);
  }

  onMove(e) {
    const { x, y } = this._pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    const dr = this.drag;
    if (dr && dr.mode === "pinch" && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dx = Math.abs(a.x - b.x);
      const mid = (a.x + b.x) / 2;
      // Fingers apart sideways change the candle width and nothing else. The price scale only moves from the price
      // pane, so a sideways pinch can never stretch the right-hand scale.
      if (dr.dx0 > 30) this.spacing = clamp(dr.sp0 * (dx / dr.dx0), this._minSp(), 80 * this.scale);
      this.right = dr.i0 + (this.plotW - mid) / this.spacing;
      this._clampRight();
      this.dirty();
      return;
    }
    if (this.placing) {
      const d = this.drawings.find((q) => q.id === this.placing.id);
      if (d) {
        const pt = this._pt(x, y);
        if (d.type === "channel" && this.placing.step === 2) {
          d.points[2] = pt;
        } else d.points[d.points.length - 1] = pt;
        this.hover = { x, y };
        this.dirty();
      }
      return;
    }
    if (dr && dr.mode === "brush") {
      const d = this.drawings.find((q) => q.id === dr.id);
      if (d && Math.hypot(x - dr.last.x, y - dr.last.y) > 3) {
        d.points.push(this._pt(x, y, false));
        dr.last = { x, y };
        this.dirty();
      }
      return;
    }
    if (dr && dr.mode === "cross") {
      const dx = x - dr.x0;
      const dy = y - dr.y0;
      if (Math.hypot(dx, dy) > 6) dr.moved = true;
      this.cross = { x: clamp(dr.cx0 + dx, 0, this.plotW), y: clamp(dr.cy0 + dy, 0, this.mainH) };
      this._emitHover();
      this.dirty();
      return;
    }
    if (dr) {
      const dx = x - dr.x0;
      const dy = y - dr.y0;
      if (Math.abs(dx) + Math.abs(dy) > 3) dr.moved = true;
      if (Math.hypot(dx, dy) > 10) dr.far = true;
      dr.last = { x, y };
      if (dr.mode === "pan") {
        this.right = dr.right0 - dx / this.spacing;
        this._clampRight();
        if (!this.auto || (Math.abs(dy) > 60 * this.scale && Math.abs(dy) > Math.abs(dx) * 1.2 && !dr.touch)) {
          if (this.auto) {
            this.auto = false;
            dr.pmin = this.pmin;
            dr.pmax = this.pmax;
            dr.y0 = y;
          } else {
            const a = this._f(dr.pmin);
            const b = this._f(dr.pmax);
            const [top, bot] = this._pads();
            const dv = ((y - dr.y0) / (this.mainH - top - bot)) * (b - a);
            this._setY((a + b) / 2 + dv, b - a);
          }
        }
        this.canvas.style.cursor = "grabbing";
        this.dirty();
        this.emit("view", this.viewState());
        return;
      }
      if (dr.mode === "yscale") {
        if (!dr.scaled && Math.abs(y - dr.y0) <= 4) return;     // still a tap (on the + of the crosshair tag, say)
        if (!dr.scaled) {
          this.auto = false;
          dr.scaled = true;
        }
        const f = Math.exp((y - dr.y0) * 0.003);        // drag down: a wider range, shorter candles (as in TradingView)
        const a = this._f(dr.pmin);
        const b = this._f(dr.pmax);
        this._setY((a + b) / 2, (b - a) * f);
        this.dirty();
        return;
      }
      if (dr.mode === "xscale") {
        if (Math.abs(x - dr.x0) <= 4 && !dr.scaled) return;
        dr.scaled = true;
        this.spacing = clamp(dr.sp0 * Math.exp((x - dr.x0) * 0.008), this._minSp(), 80 * this.scale);
        this.right = dr.i0 + (this.plotW - dr.mid) / this.spacing;
        this._clampRight();
        this.dirty();
        return;
      }
      if (dr.mode === "handle" || dr.mode === "body") {
        const d = this.drawings.find((q) => q.id === dr.id);
        if (!d) return;
        if (dr.mode === "handle") {
          const pt = this._pt(x, y);
          const pts = dr.pts.map((p) => ({ ...p }));
          if (d.type === "long" || d.type === "short") {
            // 0 = entry (time + price), 1 = stop (price), 2 = target (price), 3 = right edge (time)
            if (dr.handle === 0) {
              pts[0] = pt;
            } else if (dr.handle === 1) pts[1] = { t: pts[1].t, p: pt.p };
            else if (dr.handle === 2) pts[2] = { t: pts[2].t, p: pt.p };
            else if (dr.handle === 3) {
              pts[1] = { t: Math.max(pt.t, pts[0].t + this.tfSec), p: pts[1].p };
              pts[2] = { t: pts[1].t, p: pts[2].p };
            }
          } else if (d.type === "channel" && dr.handle === 2) {
            pts[2] = pt;
          } else pts[dr.handle] = pt;
          d.points = pts;
        } else {
          const di = (x - dr.x0) / this.spacing;
          const dpx = this.price(y) - this.price(dr.y0);
          d.points = dr.pts.map((p) => ({ t: Math.round(this.indexToTime(Math.round(this.timeToIndex(p.t) + di))), p: p.p + dpx }));
        }
        this.dirty();
        return;
      }
    }
    // hover: only a real mouse moves the crosshair. On a phone the crosshair comes from holding a finger on the chart,
    // so the mouse events a phone imitates after a tap (on page load, after picking a market) must not draw one.
    if (e.pointerType !== "mouse" || !this._hoverOK || performance.now() - this._lastTouch < TOUCH_GHOST_MS) return;
    const area = this._area(x, y);
    this.hover = { x, y, area };
    if (area === "paxis") this.canvas.style.cursor = "ns-resize";
    else if (area === "taxis") this.canvas.style.cursor = "ew-resize";
    else if (this.tool !== "cursor" && this.tool !== "crosshair") this.canvas.style.cursor = "crosshair";
    else {
      const hit = this.drawingsVisible ? this._hit(x, y) : null;
      this.canvas.style.cursor = hit ? (hit.handle !== undefined ? "pointer" : "move") : "crosshair";
    }
    this._emitHover();
    this.dirty();
  }

  onUp(e) {
    const { x, y } = this._pos(e);
    this.pointers.delete(e.pointerId);
    clearTimeout(this._pressT);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const dr = this.drag;
    if (this.placing) {
      const pl = this.placing;
      // touch: press-drag-release places the second point in one gesture
      if (pl.touch && Math.hypot(x - pl.x0, y - pl.y0) > 12) this._advancePlacing();
      return;
    }
    if (dr && dr.mode === "pinch") {
      if (this.pointers.size < 2) this.drag = null;
      return;
    }
    this.drag = null;
    if (!dr) return;
    if (dr.mode === "brush") {
      const d = this.drawings.find((q) => q.id === dr.id);
      if (d && d.points.length < 2) this.drawings = this.drawings.filter((q) => q.id !== dr.id);
      else if (d) {
        this._changed();
        this.select(d.id);
      }
      if (!this.keepDrawing) {
        this.tool = "cursor";
        this.emit("toolDone", d ? d.type : null);
      }
      return;
    }
    const cancelled = e.type === "pointercancel";
    const quickTap = !cancelled && performance.now() - (dr.t0 || 0) < 450;
    if (dr.mode === "yscale" && !dr.scaled) {
      if (dr.tag && !cancelled) this._crossMenu(e.clientX, e.clientY, dr.tagX, dr.tagY);      // the + on the price tag
      else if (this.cross && quickTap && e.pointerType === "touch") this._clearCross();
      return;
    }
    if (dr.mode === "xscale" && !dr.scaled) {
      if (this.cross && quickTap && e.pointerType === "touch") this._clearCross();
      return;
    }
    if (dr.mode === "cross") {
      // The crosshair stays on the chart after the finger lifts, wherever it was moved to. Only a tap (no movement, a
      // short touch) removes it, and the long press that brought it up never counts as that tap.
      if (!dr.fresh && !dr.moved && quickTap) this._clearCross();
      this.dirty();
      return;
    }
    if (dr.mode === "handle" || dr.mode === "body") {
      if (dr.moved) this._changed();
      else this.undoStack.pop();
      const d = this.selected();
      if (d) this.select(d.id);
      return;
    }
    if (dr.mode === "pan") {
      this.canvas.style.cursor = "crosshair";
      if (!dr.moved && !cancelled) {
        // a tap on the analyst's drawing: copy a plan price (its label), or say why the drawing is there
        const box = this._labelBoxes.find((b) => x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4);
        if (box && box.it.copy) {
          this.emit("copyLevel", { text: box.it.copy, title: box.it.title || box.it.text, item: box.it });
          this.dirty();
          return;
        }
        const it = this._hitAnalysis(x, y);
        if (it && (it.why || it.copy)) {
          this.emit("explain", { item: it, x: e.clientX, y: e.clientY });
          this.dirty();
          return;
        }
      }
      if (!dr.moved) {
        if (this.sel) this.select(null);
        if (dr.touch) {
          // a tap does nothing else; double tap resets the view. The crosshair comes from a long press.
          const now = performance.now();
          if (now - this._lastTap < 320) this.resetView();
          this._lastTap = now;
        }
      }
      this.dirty();
    }
  }

  _clearCross() {
    this.cross = null;
    this.hover = null;
    this.emit("hover", null);
    this.dirty();
  }

  /** Remove the crosshair (the Escape key, or the page). */
  clearCrosshair() {
    this._clearCross();
  }

  onCtx(e) {
    e.preventDefault();
    if (!this.d.length) return;
    const { x, y } = this._pos(e);
    if (this._area(x, y) !== "plot") return;
    this.hover = { x, y, area: "plot" };
    this._crossMenu(e.clientX, e.clientY, x, y);
    this.dirty();
  }

  /** Tell the page where the crosshair is, so it can offer a line or an alert at that price and time. */
  _crossMenu(clientX, clientY, x, y) {
    const i = clamp(Math.round(this.index(Math.min(x, this.plotW))), 0, this.d.length - 1);
    this.emit("crossMenu", { price: this.price(y), time: Math.round(this.indexToTime(i)), x: clientX, y: clientY, decimals: this.dec });
  }

  onLeave(e) {
    if (this.drag) return;
    // touch screens fire pointerleave as the finger lifts; the touch crosshair stays until a tap removes it
    if (e && e.pointerType === "touch") return;
    this.hover = null;
    this.emit("hover", null);
    this.dirty();
  }

  onWheel(e) {
    if (!this.d.length) return;
    e.preventDefault();
    const { x, y } = this._pos(e);
    const area = this._area(x, y);
    if (area === "paxis") {
      this.auto = false;
      const f = Math.exp(e.deltaY * 0.0015);
      const a = this._f(this.pmin);
      const b = this._f(this.pmax);
      this._setY((a + b) / 2, (b - a) * f);
      this.dirty();
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      this.right += d / this.spacing;
      this._clampRight();
    } else {
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const i0 = this.index(x);
      this.spacing = clamp(this.spacing * f, this._minSp(), 80 * this.scale);
      this.right = i0 + (this.plotW - x) / this.spacing;
      this._clampRight();
    }
    this.dirty();
    this.emit("view", this.viewState());
  }

  onDbl(e) {
    const { x, y } = this._pos(e);
    const area = this._area(x, y);
    if (area === "paxis") {
      this.auto = true;
      this.dirty();
      return;
    }
    if (area === "plot") {
      const hit = this._hit(x, y);
      if (hit) {
        const d = this.drawings.find((q) => q.id === hit.id);
        if (d && d.type === "text") this.emit("requestText", d.id);
        return;
      }
      this.resetView();
    }
  }

  onKey(e) {
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      if (this.sel) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (k === "Escape") {
      if (this.cross) this._clearCross();
      if (this.placing) {
        this.drawings = this.drawings.filter((d) => d.id !== this.placing.id);
        this.undoStack.pop();
        this.placing = null;
      }
      this.tool = "cursor";
      this.emit("toolDone", null);
      this.select(null);
      return;
    }
    if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      this.right += (k === "ArrowLeft" ? -1 : 1) * Math.max(1, Math.round(20 / this.spacing * 3));
      this._clampRight();
      this.dirty();
      return;
    }
    if (k === "+" || k === "=" || k === "-" || k === "_") {
      const f = k === "+" || k === "=" ? 1.15 : 1 / 1.15;
      const i0 = this.index(this.plotW);
      this.spacing = clamp(this.spacing * f, this._minSp(), 80 * this.scale);
      this.right = i0;
      this.dirty();
    }
  }

  _minSp() {
    return Math.max(1, this.minCandle || 2) * this.scale;
  }

  zoom(f) {
    const i0 = this.index(this.plotW * 0.8);
    this.spacing = clamp(this.spacing * f, this._minSp(), 80 * this.scale);
    this.right = i0 + (this.plotW * 0.2) / this.spacing;
    this._clampRight();
    this.dirty();
    this.emit("view", this.viewState());
  }

  /** Set the visible price range from its middle and its span, both on the price scale (log or linear). The price pane
   *  scales about the middle, so the candles shrink as the range grows, and a linear range may pass zero, as on
   *  TradingView. The span is kept finite: 0.2% to 100 times the last price (log: up to e^6). Without that limit a few
   *  pixels of finger movement can stretch the axis into numbers like 10^25, which is how the right-hand scale blew up. */
  _setY(mid, span) {
    if (!Number.isFinite(mid) || !Number.isFinite(span)) return;     // leave the scale as it was
    const log = !!this.opts.logScale;
    const last = this.d.length ? Math.abs(this.d[this.d.length - 1].c) : 0;
    const ref = log ? 1 : last || Math.abs(mid) || 1;      // linear: the span is measured against the last price
    const s = clamp(span / ref, 0.002, log ? 6 : 100) * ref;
    this.pmin = this._fi(mid - s / 2);
    this.pmax = this._fi(mid + s / 2);
  }

  // Scale the price axis around its middle. Same sense as zoom(): f > 1 zooms in (a narrower price range).
  zoomY(f) {
    if (!this.d.length) return;
    if (this.auto) this.autoscale();
    this.auto = false;
    const a = this._f(this.pmin);
    const b = this._f(this.pmax);
    this._setY((a + b) / 2, (b - a) / f);
    this.dirty();
    this.emit("view", this.viewState());
  }

  _clampRight() {
    const n = this.d.length;
    const visible = this.plotW / this.spacing;
    this.right = clamp(this.right, Math.min(n - 1, visible * 0.25), n - 1 + visible * 0.85);
  }

  /** Where the crosshair is: the touch crosshair (it stays until a tap removes it), else the mouse, or null. */
  _ch() {
    if (this.cross) return { x: this.cross.x, y: this.cross.y, area: "plot", touch: true };
    const h = this.hover;
    if (!h || (this.drag && this.drag.mode !== "cross")) return null;
    return h;
  }

  _emitHover() {
    const h = this._ch();
    if (!h || !this.d.length || h.area === "taxis" || h.area === "paxis") {
      this.emit("hover", null);
      return;
    }
    const i = clamp(Math.round(this.index(h.x)), 0, this.d.length - 1);
    const k = this.d[i];
    const prev = this.d[i - 1];
    const ind = this.ind;
    let cx = null;
    let cy = null;
    try {
      const r = this.canvas.getBoundingClientRect();
      cx = r.left + h.x;
      cy = r.top + h.y;
    } catch { /* not in a page */ }
    this.emit("hover", {
      i, candle: k, change: prev ? (k.c / prev.c - 1) * 100 : null, price: this.price(h.y),
      ema20: ind && ind.ema20[i], ema50: ind && ind.ema50[i], ema200: ind && ind.ema200[i], rsi: ind && ind.rsi[i],
      vwap: ind && ind.vwap ? ind.vwap[i] : null,
      // the touch crosshair on the newest candle: the page offers "analyse from this price"
      touch: !!this.cross, latest: i >= this.d.length - 1, time: k.t, cx, cy, inPlot: h.y <= this.mainH,
      studies: this.studies.length ? this.studyValues(i) : null,
    });
  }

  // ───────────── hit testing ─────────────
  _handles(d) {
    const P = d.points.map((p) => ({ x: this.tx(p.t), y: this.y(p.p) }));
    if (d.type === "long" || d.type === "short") {
      const xR = this.tx(d.points[1].t);
      return [{ x: P[0].x, y: P[0].y }, { x: P[0].x, y: P[1].y }, { x: P[0].x, y: P[2].y }, { x: xR, y: P[0].y }];
    }
    if (d.type === "hline" || d.type === "hray") return [{ x: d.type === "hline" ? Math.min(P[0].x, this.plotW - 30) : P[0].x, y: P[0].y }];
    if (d.type === "vline") return [{ x: P[0].x, y: this.mainH / 2 }];
    return P;
  }

  _hit(x, y) {
    const tol = 7 * this.scale;
    const sel = this.selected();
    if (sel && !sel.hidden) {
      const hs = this._handles(sel);
      for (let k = 0; k < hs.length; k++) {
        if (Math.hypot(hs[k].x - x, hs[k].y - y) <= tol + 3) return { id: sel.id, handle: k };
      }
    }
    for (let j = this.drawings.length - 1; j >= 0; j--) {
      const d = this.drawings[j];
      if (d.hidden) continue;
      if (this._hitOne(d, x, y, tol)) return { id: d.id };
    }
    return null;
  }

  /** The analyst's drawing under (x, y): markers and labels first, then lines and paths, then boxes. */
  _hitAnalysis(x, y) {
    const lists = [];
    if (this.sov) lists.push([this.sov, false]);
    if (this.ana && !this.anaHidden) lists.push([this.ana, true]);
    const tol = 8 * this.scale;
    let best = null;
    let bestRank = 9;
    for (const [list, own] of lists) {
      for (let k = list.length - 1; k >= 0; k--) {
        const it = list[k];
        if (own && !this._anaOn(it)) continue;
        if (!it.why && !it.copy) continue;
        let rank = 9;
        if (it.kind === "marker" || it.kind === "label") {
          const xx = this.tx(it.t1);
          const yy = this.y(it.p1) + (it.kind === "label" ? (it.anchor === "above" ? -10 : 10) * this.scale : 0);
          if (Math.hypot(x - xx, y - yy) <= tol + 6 * this.scale) rank = 0;
        } else if (it.kind === "line" || it.kind === "hline") {
          const x1 = it.kind === "hline" && it.extend === "right" && it.layer !== "plan" ? 0 : this.tx(it.t1);
          const x2 = it.extend === "right" ? this.plotW : this.tx(it.t2);
          if (distToSeg(x, y, x1, this.y(it.p1), x2, this.y(it.p2)) <= tol) rank = it.layer === "plan" ? 0 : 1;
        } else if (it.kind === "path" && it.points) {
          for (let j = 0; j + 1 < it.points.length; j++) {
            const a = it.points[j];
            const b = it.points[j + 1];
            if (distToSeg(x, y, this.tx(a.t), this.y(a.p), this.tx(b.t), this.y(b.p)) <= tol) {
              rank = 2;
              break;
            }
          }
        } else if (it.kind === "box") {
          const x1 = this.tx(it.t1);
          const x2 = it.extend === "right" ? this.plotW : this.tx(it.t2);
          const ya = this.y(it.p1);
          const yb = this.y(it.p2);
          if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(ya, yb) && y <= Math.max(ya, yb)) {
            rank = it.layer === "plan" ? 5 : 3;
          }
        }
        if (rank < bestRank) {
          best = it;
          bestRank = rank;
          if (rank === 0) return best;
        }
      }
    }
    return best;
  }

  _lineEnds(d) {
    const [a, b] = d.points;
    let x1 = this.tx(a.t);
    let y1 = this.y(a.p);
    let x2 = this.tx(b.t);
    let y2 = this.y(b.p);
    const extR = d.type === "ray" || d.type === "extline" || d.style.extendRight;
    const extL = d.type === "extline" || d.style.extendLeft;
    if ((extR || extL) && (x2 !== x1 || y2 !== y1)) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const big = (this.W + this.H) * 4 / (Math.hypot(dx, dy) || 1);
      if (extR) {
        x2 = x1 + dx * big;
        y2 = y1 + dy * big;
      }
      if (extL) {
        x1 = x1 - dx * big;
        y1 = y1 - dy * big;
      }
    }
    return [x1, y1, x2, y2];
  }

  _hitOne(d, x, y, tol) {
    const t = d.type;
    if (EXTRA_TOOLS[t]) return hitExtra(this, d, x, y, tol);
    if (t === "hline") return Math.abs(this.y(d.points[0].p) - y) <= tol;
    if (t === "hray") return Math.abs(this.y(d.points[0].p) - y) <= tol && x >= this.tx(d.points[0].t) - tol;
    if (t === "vline") return Math.abs(this.tx(d.points[0].t) - x) <= tol;
    if (t === "trendline" || t === "ray" || t === "extline" || t === "arrow") {
      const [x1, y1, x2, y2] = this._lineEnds(d);
      return distToSeg(x, y, x1, y1, x2, y2) <= tol;
    }
    if (t === "rect" || t === "measure" || t === "fib") {
      const xs = d.points.map((p) => this.tx(p.t));
      const ys = d.points.map((p) => this.y(p.p));
      const x1 = Math.min(...xs);
      const x2 = t === "fib" && d.style.extendRight ? this.plotW : Math.max(...xs);
      const y1 = Math.min(...ys);
      const y2 = Math.max(...ys);
      if (t === "fib") {
        if (x < x1 - tol || x > x2 + tol) return false;
        const a = d.points[0].p;
        const b = d.points[1].p;
        return FIB.some((f) => Math.abs(this.y(b + (a - b) * f) - y) <= tol);
      }
      return x >= x1 - tol && x <= x2 + tol && y >= y1 - tol && y <= y2 + tol;
    }
    if (t === "channel") {
      const [a, b] = d.points;
      const c = d.points[2] || b;
      const x1 = this.tx(a.t);
      const x2 = this.tx(b.t);
      const off = this.y(c.p) - this.y(a.p + ((b.p - a.p) * (c.t - a.t)) / ((b.t - a.t) || 1));
      return distToSeg(x, y, x1, this.y(a.p), x2, this.y(b.p)) <= tol || distToSeg(x, y, x1, this.y(a.p) + off, x2, this.y(b.p) + off) <= tol;
    }
    if (t === "long" || t === "short") {
      const x1 = this.tx(d.points[0].t);
      const x2 = this.tx(d.points[1].t);
      const ys = [d.points[0].p, d.points[1].p, d.points[2].p].map((p) => this.y(p));
      return x >= x1 - tol && x <= x2 + tol && y >= Math.min(...ys) - tol && y <= Math.max(...ys) + tol;
    }
    if (t === "text") {
      const px = this.tx(d.points[0].t);
      const py = this.y(d.points[0].p);
      this.ctx.font = this.fontB;
      const w = this.ctx.measureText(d.style.text || "Text").width + 16;
      return x >= px - 4 && x <= px + w && y >= py - this.fs * 1.6 && y <= py + 6;
    }
    return false;
  }

  // ───────────── drawing ─────────────
  draw() {
    const ctx = this.ctx;
    const { W, H, dpr, theme } = this;
    if (!W || !H) return;
    this.layout();
    if (this.auto) {
      this.autoscale();
      this.layout();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
    if (!this.d.length) return;
    const [i0, i1] = this.visRange();
    const priceTicks = this._priceTicks();
    const timeTicks = this._timeTicks(i0, i1);
    // watermark
    if (this.opts.watermark && this.label) {
      ctx.save();
      ctx.font = `700 ${Math.round(Math.min(this.plotW / 11, this.mainH / 6))}px ${theme.font}`;
      ctx.fillStyle = hexA(theme.text, 0.035);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.label, this.plotW / 2, this.mainH / 2);
      ctx.restore();
    }
    // grid
    if (this.opts.grid) {
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of priceTicks) {
        const yy = Math.round(this.y(p)) + 0.5;
        ctx.moveTo(0, yy);
        ctx.lineTo(this.plotW, yy);
      }
      for (const tk of timeTicks) {
        const xx = Math.round(tk.x) + 0.5;
        ctx.moveTo(xx, 0);
        ctx.lineTo(xx, this.mainH + this.rsiH);
      }
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.plotW, this.mainH);
    ctx.clip();
    if (this.opts.killzones && this.tfSec <= 4 * 3600) this._drawKillzones(i0, i1);
    this._labelBoxes = [];
    if (this.ana && !this.anaHidden) this._drawAnalysis("below");
    if (this.sov) this._drawAnalysis("below", this.sov);
    if (this.opts.volume) this._drawVolume(i0, i1);
    this._drawSeries(i0, i1);
    this._drawIndicators(i0, i1);
    this._drawStudies(i0, i1);
    this._drawCompare(i0, i1);
    if (this.ana && !this.anaHidden) this._drawAnalysis("above");
    if (this.sov) this._drawAnalysis("above", this.sov);
    if (this.drawingsVisible) this._drawUserDrawings();
    this._drawLastLine();
    this._drawLastDot();
    this._drawCrosshair();
    ctx.restore();
    this._drawPanes(i0, i1);
    this._drawPriceAxis(priceTicks);
    this._drawTimeAxis(timeTicks);
  }

  _priceTicks() {
    const ticks = [];
    const n = Math.max(2, Math.floor(this.mainH / (46 * this.scale)));
    if (this.opts.logScale) {
      const a = Math.log(this.pmin);
      const b = Math.log(this.pmax);
      for (let k = 0; k <= n; k++) {
        const v = Math.exp(a + ((b - a) * k) / n);
        const st = niceStep(v * 0.02);
        ticks.push(Math.round(v / st) * st);
      }
      return [...new Set(ticks)];
    }
    const lo = this.price(this.mainH);
    const hi = this.price(0);
    const step = niceStep((hi - lo) / n || 1);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    return ticks;
  }

  _timeTicks(i0, i1) {
    const out = [];
    if (!this.d.length) return out;
    const minPx = 90 * this.scale;
    const everyBars = Math.max(1, Math.ceil(minPx / this.spacing));
    const steps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 30, 48, 60, 96, 120, 240, 480, 1000];
    const stepBars = steps.find((s) => s >= everyBars) || everyBars;
    const start = Math.floor(this.index(0));
    const end = Math.ceil(this.index(this.plotW)) + 1;
    for (let i = Math.ceil(start / stepBars) * stepBars; i <= end; i += stepBars) {
      const t = this.indexToTime(i);
      out.push({ x: this.x(i), t });
    }
    return out;
  }

  _timeLabel(t, full = false) {
    const d = new Date(t * 1000);
    const pad = (v) => String(v).padStart(2, "0");
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    if (this.tfSec >= 86400 * 28) return full ? `${mon} ${d.getUTCFullYear()}` : (d.getUTCMonth() === 0 ? `${d.getUTCFullYear()}` : mon);
    if (this.tfSec >= 86400) return full ? `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}` : (d.getUTCDate() <= Math.ceil(this.tfSec / 86400) ? `${mon} ${d.getUTCFullYear() % 100}` : `${d.getUTCDate()} ${mon}`);
    const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    if (full) return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear() % 100} ${hm}`;
    return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? `${d.getUTCDate()} ${mon}` : hm;
  }

  _series() {
    return this.ha || this.d;
  }

  _drawVolume(i0, i1) {
    const ctx = this.ctx;
    const src = this.d;
    let mx = 0;
    for (let i = i0; i <= i1; i++) if (src[i] && src[i].v > mx) mx = src[i].v;
    if (mx <= 0) return;
    const h = this.mainH * 0.16;
    const base = this.mainH;
    // whole device pixels, like the candles, so the volume bars stay sharp too
    const D = this.dpr || 1;
    const { bw, wick } = bodyWidthD(this.spacing, D);
    const baseD = Math.round(base * D);
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      const vhD = Math.max(1, Math.round((k.v / mx) * h * D));
      ctx.fillStyle = hexA(k.c >= k.o ? this.theme.up : this.theme.down, 0.42);
      const left = Math.round(this.x(i) * D) - Math.floor(wick / 2) - (bw - wick) / 2;
      ctx.fillRect(left / D, (baseD - vhD) / D, bw / D, vhD / D);
    }
  }

  _drawSeries(i0, i1) {
    const style = this.opts.style;
    const src = this._series();
    if (style === "line" || style === "linemarkers" || style === "stepline" || style === "area") {
      this._drawLineSeries(src, i0, i1, style);
      return;
    }
    if (style === "hlcarea") return this._drawHlcArea(src, i0, i1);
    if (style === "baseline") return this._drawBaseline(src, i0, i1);
    if (style === "columns") return this._drawColumns(src, i0, i1);
    if (style === "kagi") return this._drawKagi(src, i0, i1);
    if (style === "pnf") return this._drawPnf(src, i0, i1);
    if (style === "tpo") return this._drawProfiles(i0, i1, "tpo");
    if (style === "svp") this._drawProfiles(i0, i1, "volume");
    this._drawCandles(src, i0, i1, style);
  }

  // Candles, hollow candles, Heikin Ashi, OHLC bars, volume candles, high-low bars, and the bricks of renko,
  // line break and range charts. Every edge sits on the screen's own pixel grid (whole DEVICE pixels), so nothing
  // straddles two pixels: that straddling is what makes candles look soft.
  _drawCandles(src, i0, i1, style) {
    const ctx = this.ctx;
    const th = this.theme;
    const D = this.dpr || 1;
    const dev = (v) => Math.round(v * D);
    const { bw, wick } = bodyWidthD(this.spacing, D);
    const tickD = Math.max(1, dev(this.spacing >= 7 ? 2.5 : 1.5));
    const rect = (x, y, w, h) => ctx.fillRect(x / D, y / D, w / D, h / D);
    const boxes = style === "renko" || style === "linebreak";
    let maxV = 0;
    if (style === "volcandles") for (let i = i0; i <= i1; i++) if (src[i] && src[i].v > maxV) maxV = src[i].v;
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      const prev = src[i - 1];
      // hollow candles take their colour from the close against the previous close, and are hollow when they rose
      const up = style === "hollow" && prev ? k.c >= prev.c : k.c >= k.o;
      const cxD = dev(this.x(i));
      const wl = cxD - Math.floor(wick / 2);
      let w = bw;
      if (style === "volcandles" && maxV > 0) {
        w = Math.max(wick, Math.round(bw * (0.2 + 0.8 * Math.sqrt((k.v || 0) / maxV))));
        if ((w - wick) % 2) w -= 1;
        w = Math.max(wick, w);
      }
      const left = wl - (w - wick) / 2;
      const yoD = dev(this.y(k.o));
      const ycD = dev(this.y(k.c));
      const yhD = dev(this.y(k.h));
      const ylD = dev(this.y(k.l));
      const body = up ? th.up : th.down;
      if (style === "bars") {
        // OHLC bars: thick ticks, with arms as wide as a candle body
        ctx.fillStyle = body;
        const tl = cxD - Math.floor(tickD / 2);
        rect(tl, yhD, tickD, Math.max(tickD, ylD - yhD));
        rect(left, yoD - Math.floor(tickD / 2), tl - left, tickD);
        rect(tl + tickD, ycD - Math.floor(tickD / 2), left + w - tl - tickD, tickD);
        continue;
      }
      if (style === "highlow") {
        ctx.fillStyle = body;
        rect(left, yhD, w, Math.max(1, ylD - yhD));
        continue;
      }
      const topD = Math.min(yoD, ycD);
      const hD = Math.max(Math.max(1, Math.round(D)), Math.abs(ycD - yoD));
      if (boxes) {
        // bricks touch their neighbours the way they do on TradingView, with a hairline between them
        const gapD = Math.max(1, Math.round(D * 0.5));
        const slot = Math.max(w + gapD, Math.floor(this.spacing * D));
        ctx.fillStyle = body;
        rect(cxD - Math.floor(slot / 2) + gapD, topD, slot - gapD, hD);
        continue;
      }
      // the wick: a one-CSS-pixel column through the middle of the body
      ctx.fillStyle = up ? th.wickUp || body : th.wickDown || body;
      rect(wl, yhD, wick, Math.max(wick, ylD - yhD));
      const hollow = style === "hollow" && k.c >= k.o && w >= 3 * wick;
      if (hollow) {
        const ring = wick;
        ctx.fillStyle = body;
        rect(left, topD, w, hD);
        ctx.fillStyle = th.bg;
        rect(left + ring, topD + ring, w - 2 * ring, Math.max(1, hD - 2 * ring));
        ctx.fillStyle = body;
        rect(wl, yhD, wick, Math.max(0, topD - yhD));
        rect(wl, topD + hD, wick, Math.max(0, ylD - topD - hD));
        continue;
      }
      ctx.fillStyle = body;
      rect(left, topD, w, hD);
      const border = up ? th.borderUp : th.borderDown;
      if (w >= 5 * wick && border && border !== body) {
        ctx.fillStyle = border;
        rect(left, topD, w, wick);
        rect(left, topD + hD - wick, w, wick);
        rect(left, topD, wick, hD);
        rect(left + w - wick, topD, wick, hD);
      }
    }
  }

  _path(src, i0, i1, val, step = false) {
    const ctx = this.ctx;
    let first = true;
    let py = 0;
    for (let i = i0; i <= i1; i++) {
      if (!src[i]) continue;
      const xx = this.x(i);
      const yy = this.y(val(src[i]));
      if (first) {
        ctx.moveTo(xx, yy);
        first = false;
      } else {
        if (step) ctx.lineTo(xx, py);
        ctx.lineTo(xx, yy);
      }
      py = yy;
    }
  }

  _drawLineSeries(src, i0, i1, style) {
    const ctx = this.ctx;
    const th = this.theme;
    const col = th.line;
    const step = style === "stepline";
    ctx.save();
    ctx.lineJoin = "round";
    ctx.beginPath();
    this._path(src, i0, i1, (k) => k.c, step);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.4 * this.scale;
    ctx.stroke();
    if (style === "area") {
      ctx.lineTo(this.x(i1), this.mainH);
      ctx.lineTo(this.x(i0), this.mainH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, this.mainH);
      g.addColorStop(0, hexA(col, 0.34));
      g.addColorStop(1, hexA(col, 0.0));
      ctx.fillStyle = g;
      ctx.fill();
    }
    if (style === "linemarkers" && this.spacing >= 4) {
      const r = Math.min(3.2, this.spacing * 0.3) * this.scale;
      for (let i = i0; i <= i1; i++) {
        if (!src[i]) continue;
        ctx.beginPath();
        ctx.arc(this.x(i), this.y(src[i].c), r, 0, Math.PI * 2);
        ctx.fillStyle = th.bg;
        ctx.fill();
        ctx.lineWidth = 1.6 * this.scale;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // HLC area: the band between high and close in the rising colour, close to low in the falling colour, and the close
  // as a line through the middle
  _drawHlcArea(src, i0, i1) {
    const ctx = this.ctx;
    const th = this.theme;
    const band = (top, bot, color) => {
      ctx.beginPath();
      this._path(src, i0, i1, top);
      for (let i = i1; i >= i0; i--) if (src[i]) ctx.lineTo(this.x(i), this.y(bot(src[i])));
      ctx.closePath();
      ctx.fillStyle = hexA(color, 0.22);
      ctx.fill();
    };
    band((k) => k.h, (k) => k.c, th.up);
    band((k) => k.c, (k) => k.l, th.down);
    const line = (val, color, width) => {
      ctx.beginPath();
      this._path(src, i0, i1, val);
      ctx.strokeStyle = color;
      ctx.lineWidth = width * this.scale;
      ctx.stroke();
    };
    line((k) => k.h, hexA(th.up, 0.75), 1);
    line((k) => k.l, hexA(th.down, 0.75), 1);
    line((k) => k.c, th.text, 1.8);
  }

  // Baseline: the close against a line at the middle of the price scale, rising colour above it, falling colour below
  _drawBaseline(src, i0, i1) {
    const ctx = this.ctx;
    const th = this.theme;
    const baseY = Math.round(this.mainH * 0.5) + 0.5;
    const part = (y0, y1, color) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, this.plotW, y1 - y0);
      ctx.clip();
      ctx.beginPath();
      this._path(src, i0, i1, (k) => k.c);
      ctx.lineTo(this.x(i1), baseY);
      ctx.lineTo(this.x(i0), baseY);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(y0 < baseY ? 0 : 1, hexA(color, 0.32));
      g.addColorStop(y0 < baseY ? 1 : 0, hexA(color, 0.04));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      this._path(src, i0, i1, (k) => k.c);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2 * this.scale;
      ctx.stroke();
      ctx.restore();
    };
    part(0, baseY, th.up);
    part(baseY, this.mainH, th.down);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hexA(th.text, 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(this.plotW, baseY);
    ctx.stroke();
    ctx.restore();
  }

  // Columns: a column from the bottom of the chart to each close, coloured by the close against the previous close
  _drawColumns(src, i0, i1) {
    const ctx = this.ctx;
    const th = this.theme;
    const D = this.dpr || 1;
    const { bw, wick } = bodyWidthD(this.spacing, D);
    const baseD = Math.round(this.mainH * D);
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      const prev = src[i - 1];
      ctx.fillStyle = hexA(!prev || k.c >= prev.c ? th.up : th.down, 0.85);
      const yD = Math.round(this.y(k.c) * D);
      const left = Math.round(this.x(i) * D) - Math.floor(wick / 2) - (bw - wick) / 2;
      ctx.fillRect(left / D, yD / D, bw / D, Math.max(1, baseD - yD) / D);
    }
  }

  // Kagi: thick (yang) lines after price takes out the last shoulder, thin (yin) lines after it loses the last waist
  _drawKagi(src, i0, i1) {
    const ctx = this.ctx;
    const th = this.theme;
    const thick = 3.2 * this.scale;
    const thin = 1.3 * this.scale;
    const seg = (x0, y0, x1, y1, fat) => {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = fat ? th.up : th.down;
      ctx.lineWidth = fat ? thick : thin;
      ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = "square";
    for (let i = Math.max(0, i0 - 1); i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      const x = this.x(i);
      if (i > 0 && src[i - 1]) seg(this.x(i - 1), this.y(k.o), x, this.y(k.o), src[i - 1].thick1);
      if (k.turn !== null && k.turn !== undefined) {
        seg(x, this.y(k.o), x, this.y(k.turn), k.thick0);
        seg(x, this.y(k.turn), x, this.y(k.c), k.thick1);
      } else seg(x, this.y(k.o), x, this.y(k.c), k.thick1);
    }
    ctx.restore();
  }

  // Point & figure: a column of X for each rise and of O for each fall, one mark per box
  _drawPnf(src, i0, i1) {
    const ctx = this.ctx;
    const th = this.theme;
    ctx.save();
    ctx.lineWidth = Math.max(1, 1.4 * this.scale);
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k || !k.box) continue;
      const x = this.x(i);
      const n = Math.round((k.h - k.l) / k.box) + 1;
      const bh = Math.abs(this.y(k.l) - this.y(k.l + k.box));
      const half = Math.min(this.spacing * 0.42, Math.max(2, bh * 0.6));
      const col = k.dir === 1 ? th.up : th.down;
      ctx.strokeStyle = col;
      if (bh < 4 || n > 300) {
        // boxes too small to draw one by one: the column as a bar
        ctx.fillStyle = hexA(col, 0.8);
        ctx.fillRect(x - half, this.y(k.h + k.box / 2), half * 2, Math.max(1, this.y(k.l - k.box / 2) - this.y(k.h + k.box / 2)));
        continue;
      }
      const r = Math.min(half, bh * 0.42);
      for (let j = 0; j < n; j++) {
        const yy = this.y(k.l + j * k.box);
        if (yy < -bh || yy > this.mainH + bh) continue;
        ctx.beginPath();
        if (k.dir === 1) {
          ctx.moveTo(x - r, yy - r);
          ctx.lineTo(x + r, yy + r);
          ctx.moveTo(x + r, yy - r);
          ctx.lineTo(x - r, yy + r);
        } else ctx.ellipse(x, yy, r, r, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Session volume profile (beside the candles) and TPO (in place of them). One profile per session: a day on
  // intraday charts, a week on 4h, a month on daily. The value area holds 70% of the session; the point of control
  // (the busiest price) is the yellow line.
  _drawProfiles(i0, i1, mode) {
    const d = this.d;
    if (!d.length) return;
    const span = this.tfSec >= 86400 ? 30 * 86400 : this.tfSec >= 14400 ? 7 * 86400 : 86400;
    let a = Math.max(0, i0);
    const s0 = Math.floor(d[a].t / span);
    for (let g = 0; a > 0 && g < 3000 && Math.floor(d[a - 1].t / span) === s0; g++) a--;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i <= i1; i++) {
      if (!d[i]) continue;
      lo = Math.min(lo, d[i].l);
      hi = Math.max(hi, d[i].h);
    }
    if (!(hi > lo)) return;
    let row = niceBox(atrOf(d.slice(Math.max(0, i1 - 60), i1 + 1), 14) * (mode === "tpo" ? 0.5 : 0.3));
    const px = Math.abs(this.y(lo) - this.y(lo + row));
    if (px < 3) row = niceBox(row * (3 / Math.max(px, 0.1)));
    if ((hi - lo) / row > 400) row = niceBox((hi - lo) / 400);
    const profs = sessionProfiles(d, a, i1, this.tfSec, row, mode, span);
    const ctx = this.ctx;
    const th = this.theme;
    ctx.save();
    for (const p of profs) {
      const x0 = this.x(p.i0) - this.spacing / 2;
      const x1 = this.x(p.i1) + this.spacing / 2;
      if (x1 < 0 || x0 > this.plotW) continue;
      const avail = x1 - x0;
      let mx = 0;
      for (const r of p.rows) mx = Math.max(mx, r.v);
      const rh = Math.max(1, Math.abs(this.y(p.rows[0].p) - this.y(p.rows[0].p + row)) - 1);
      if (mode === "volume") {
        for (const r of p.rows) {
          const inVa = r.p >= p.val && r.p <= p.vah;
          const w = (r.v / (mx || 1)) * avail * 0.7;
          ctx.fillStyle = hexA(r.p === p.poc ? "#ffc83d" : th.line, r.p === p.poc ? 0.55 : inVa ? 0.32 : 0.14);
          ctx.fillRect(x0, this.y(r.p + row), w, rh);
        }
      } else {
        // TPO: a letter for each period that traded at a price, A for the session's first period, B for the next…
        const most = Math.max(...p.rows.map((r) => (p.letters.get(Math.round(r.p / row)) || []).length));
        const cw = Math.min(avail / Math.max(1, most), 14 * this.scale);
        const letters = cw >= 6 * this.scale && rh >= 7 * this.scale;
        ctx.font = `600 ${Math.round(Math.min(rh, cw * 1.3, 12 * this.scale))}px ${th.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const r of p.rows) {
          const L = p.letters.get(Math.round(r.p / row)) || [];
          const inVa = r.p >= p.val && r.p <= p.vah;
          const col = r.p === p.poc ? "#ffc83d" : inVa ? th.line : th.text;
          const yy = this.y(r.p + row);
          L.forEach((n, j) => {
            const cx = x0 + j * cw;
            if (letters) {
              ctx.fillStyle = col;
              ctx.fillText(tpoLetter(n), cx + cw / 2, yy + rh / 2 + 0.5);
            } else {
              ctx.fillStyle = hexA(col, 0.75);
              ctx.fillRect(cx, yy, Math.max(1, cw - 1), rh);
            }
          });
        }
      }
      ctx.strokeStyle = "#ffc83d";
      ctx.lineWidth = 1.2 * this.scale;
      ctx.beginPath();
      const py = this.y(p.poc + row / 2);
      ctx.moveTo(x0, py);
      ctx.lineTo(x1, py);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Other markets drawn over this one (Compare). Each is scaled so it starts at this market's price at the left edge
  // of the screen, so the two lines show how far each has moved since then.
  _compareLines(i0, i1) {
    if (!this.compare.length || DERIVED.has(this.opts.style)) return [];
    const out = [];
    for (const c of this.compare) {
      if (!c.map) c.map = new Map(c.rows.map((r) => [r[0], r[4]]));
      let base = null;
      for (let i = i0; i <= i1 && base === null; i++) {
        const v = this.d[i] && c.map.get(this.d[i].t);
        if (v) base = this.d[i].c / v;
      }
      if (base === null) continue;
      const vals = new Array(this.d.length).fill(null);
      for (let i = i0; i <= i1; i++) {
        const v = this.d[i] && c.map.get(this.d[i].t);
        if (v) vals[i] = v * base;
      }
      out.push({ c, vals });
    }
    return out;
  }

  _drawCompare(i0, i1) {
    for (const { c, vals } of this._compareLines(i0, i1)) {
      this._line(vals, i0, i1, c.color, 1.8);
      let last = null;
      for (let i = i1; i >= i0 && last === null; i--) if (vals[i] !== null) last = i;
      if (last === null) continue;
      const ctx = this.ctx;
      ctx.font = this.fontB;
      ctx.fillStyle = c.color;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(c.label || c.symbol, Math.min(this.plotW - 6, this.x(last)), this.y(vals[last]) - 4);
    }
  }

  _line(values, i0, i1, color, width = 1.4, dash = null) {
    if (!values) return;
    const ctx = this.ctx;
    ctx.beginPath();
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = values[i];
      if (v === null || v === undefined) {
        pen = false;
        continue;
      }
      const xx = this.x(i);
      const yy = this.y(v);
      if (!pen) {
        ctx.moveTo(xx, yy);
        pen = true;
      } else ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width * this.scale;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawIndicators(i0, i1) {
    const I = this.ind;
    if (!I) return;
    const on = this.opts.indicators || {};
    if (on.bb) {
      this._line(I.bb.up, i0, i1, "rgba(79,157,255,0.9)", 1.2);
      this._line(I.bb.lo, i0, i1, "rgba(79,157,255,0.9)", 1.2);
      this._line(I.bb.mid, i0, i1, "rgba(79,157,255,0.6)", 1.2, [4, 4]);
    }
    if (on.ema20) this._line(I.ema20, i0, i1, this.theme.ma20, 1.1);
    if (on.ema50) this._line(I.ema50, i0, i1, this.theme.ma50, 1.2);
    if (on.ema200) this._line(I.ema200, i0, i1, this.theme.ma200, 1.6);
    if (on.vwap && I.vwap) this._line(I.vwap, i0, i1, "#ff8a1f", 1.5);
  }

  _drawLastLine() {
    const k = this.d[this.d.length - 1];
    const ctx = this.ctx;
    const D = this.dpr || 1;
    const yy = (Math.round(this.y(k.c) * D) + 0.5) / D;   // centred on a device pixel
    ctx.strokeStyle = hexA(k.c >= k.o ? this.theme.up : this.theme.down, 0.9);
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1 / D;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(this.plotW, yy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // a soft glow on the last close: the live price reads as the focus of the chart
  _drawLastDot() {
    const i = this.d.length - 1;
    const x = this.x(i) + this.spacing * 0.35;
    if (x < 0 || x > this.plotW) return;
    const k = this.d[i];
    const y = this.y(k.c);
    const col = k.c >= k.o ? this.theme.up : this.theme.down;
    const ctx = this.ctx;
    const r = 10 * this.scale;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(col, 0.5));
    g.addColorStop(1, hexA(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, 2.4 * this.scale, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawCrosshair() {
    const h = this._ch();
    if (!h || h.area === "paxis" || h.area === "taxis") return;
    const ctx = this.ctx;
    const i = Math.round(this.index(h.x));
    const xx = Math.round(this.x(i)) + 0.5;
    const yy = Math.round(h.y) + 0.5;
    ctx.strokeStyle = this.theme.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xx, 0);
    ctx.lineTo(xx, this.mainH);
    if (h.y <= this.mainH) {
      ctx.moveTo(0, yy);
      ctx.lineTo(this.plotW, yy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawRsiAt(i0, i1, top, h) {
    const ctx = this.ctx;
    const yv = (v) => top + 6 + ((100 - v) / 100) * (h - 12);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.plotW, h);
    ctx.clip();
    ctx.fillStyle = hexA(this.theme.line, 0.05);
    ctx.fillRect(0, yv(70), this.plotW, yv(30) - yv(70));
    ctx.strokeStyle = this.theme.grid;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const v of [30, 50, 70]) {
      ctx.moveTo(0, Math.round(yv(v)) + 0.5);
      ctx.lineTo(this.plotW, Math.round(yv(v)) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const r = this.ind && this.ind.rsi;
    if (r) {
      ctx.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i++) {
        if (r[i] === null) continue;
        const xx = this.x(i);
        const yy = yv(r[i]);
        if (!pen) {
          ctx.moveTo(xx, yy);
          pen = true;
        } else ctx.lineTo(xx, yy);
      }
      ctx.strokeStyle = "#b388ff";
      ctx.lineWidth = 1.4 * this.scale;
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = this.theme.axisLine;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(this.W, top + 0.5);
    ctx.stroke();
    ctx.font = this.font;
    ctx.fillStyle = this.theme.text;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const v of [30, 70]) ctx.fillText(String(v), this.plotW + 8, yv(v));
    const last = r && r[Math.min(i1, r.length - 1)];
    ctx.fillText(`RSI 14${last ? "  " + last.toFixed(1) : ""}`, 8, top + 12 * this.scale);
  }

  _tag(y, text, bg, fg = "#fff", xLeft = null, ring = false) {
    const ctx = this.ctx;
    ctx.font = this.fontB;
    const pad = 6 * this.scale;
    const ringW = ring ? 15 * this.scale : 0;        // room for the + on the crosshair's tag
    const w = Math.max(this.axisW - 4, ctx.measureText(text).width + pad * 2 + ringW);
    const h = this.fs + 8 * this.scale;
    const x = xLeft === null ? this.plotW + 1 : xLeft;
    const yy = clamp(y - h / 2, 0, this.mainH - h);
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, yy, w, h, 3 * this.scale);
    else ctx.rect(x, yy, w, h);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    if (ring) {
      // a + in a circle: tap it for a horizontal line or an alert at this price
      const cx = x + pad + 4.5 * this.scale;
      const cy = yy + h / 2;
      const r = 4.6 * this.scale;
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1.2 * this.scale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.moveTo(cx - r * 0.5, cy);
      ctx.lineTo(cx + r * 0.5, cy);
      ctx.moveTo(cx, cy - r * 0.5);
      ctx.lineTo(cx, cy + r * 0.5);
      ctx.stroke();
    }
    ctx.fillText(text, x + pad + ringW, yy + h / 2 + 0.5);
    return { y: yy, h };
  }

  _drawPriceAxis(ticks) {
    const ctx = this.ctx;
    const th = this.theme;
    ctx.fillStyle = th.bg;
    ctx.fillRect(this.plotW, 0, this.axisW, this.mainH);
    ctx.strokeStyle = th.axisLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.plotW + 0.5, 0);
    ctx.lineTo(this.plotW + 0.5, this.H);
    ctx.stroke();
    ctx.font = this.font;
    ctx.fillStyle = th.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const p of ticks) {
      const yy = this.y(p);
      if (yy < 6 || yy > this.mainH - 6) continue;
      ctx.fillText(this.fmt(p), this.plotW + 8 * this.scale, yy);
    }
    // coloured tags, most important first; a tag that would overlap a more important one is skipped
    const tagH = this.fs + 8 * this.scale;
    const tags = [];
    const k = this.d[this.d.length - 1];
    const col = k.c >= k.o ? th.up : th.down;
    const left = k.t + this.tfSec - Date.now() / 1000;
    const cd = left > 0 && left < this.tfSec + 5;
    tags.push({ y: this.y(k.c), text: this.fmt(k.c), bg: col, prio: 0, extra: cd ? this.fs + 4 : 0, last: true });
    const sd = this.selected();
    if (sd && sd.type !== "text" && sd.type !== "vline") {
      for (const p of sd.points) tags.push({ y: this.y(p.p), text: this.fmt(p.p), bg: hexA(sd.style.color || "#2962ff", 0.9), prio: 1 });
    }
    if (this.ana && !this.anaHidden) {
      for (const it of this.ana) {
        if (!it.axisTag || !this._anaOn(it)) continue;
        if (this._prog(it) < 0.6) continue;
        const isTp = /TP\d/.test(it.text || "");
        tags.push({ y: this.y(it.p1), text: this.fmt(it.p1), bg: it.color === th.text || it.color === "#d1d4dc" ? "#3a4a6b" : it.color,
          prio: (it.plan === "alternative" ? 5 : 2) + (isTp ? 1 : 0) });
      }
    }
    if (this.drawingsVisible) {
      for (const d of this.drawings) {
        if (d.hidden || (d.type !== "hline" && d.type !== "hray")) continue;
        tags.push({ y: this.y(d.points[0].p), text: this.fmt(d.points[0].p), bg: d.style.color || "#2962ff", prio: 4 });
      }
    }
    tags.sort((a, b) => a.prio - b.prio);
    const placed = [];
    for (const t of tags) {
      if (t.y < -tagH || t.y > this.mainH + tagH) continue;
      const top = clamp(t.y - tagH / 2, 0, this.mainH - tagH);
      const bot = top + tagH + (t.extra || 0);
      if (placed.some((q) => top < q.bot + 1 && bot > q.top - 1)) continue;
      placed.push({ top, bot });
      const r = this._tag(t.y, t.text, t.bg);
      if (t.last && t.extra) {
        const s = Math.floor(left);
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        const txt = hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
        ctx.font = this.font;
        ctx.fillStyle = hexA(col, 0.85);
        ctx.fillRect(this.plotW + 1, r.y + r.h, this.axisW - 4, this.fs + 4);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(txt, this.plotW + 6 * this.scale, r.y + r.h + (this.fs + 4) / 2);
        this._countdownDirty = true;
      }
    }
    // crosshair price always on top, with the + that opens the line and alert menu
    const h = this._ch();
    if (h && h.area !== "taxis" && h.y <= this.mainH) {
      this._tag(h.y, this.fmt(this.price(h.y)), this.theme.label, "#fff", null, true);
    }
  }

  _drawTimeAxis(ticks) {
    const ctx = this.ctx;
    const th = this.theme;
    const top = this.H - this.timeH;
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, top, this.W, this.timeH);
    ctx.strokeStyle = th.axisLine;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(this.W, top + 0.5);
    ctx.stroke();
    ctx.font = this.font;
    ctx.fillStyle = th.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const tk of ticks) {
      if (tk.x < 20 || tk.x > this.plotW - 20) continue;
      ctx.fillText(this._timeLabel(tk.t), tk.x, top + this.timeH / 2);
    }
    const h = this._ch();
    if (h && h.area !== "paxis") {
      const i = Math.round(this.index(h.x));
      const t = this.indexToTime(i);
      const txt = this._timeLabel(t, true);
      ctx.font = this.fontB;
      const w = ctx.measureText(txt).width + 14 * this.scale;
      const xx = clamp(this.x(i) - w / 2, 0, this.plotW - w);
      ctx.fillStyle = this.theme.label;
      ctx.fillRect(xx, top + 2, w, this.timeH - 4);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(txt, xx + w / 2, top + this.timeH / 2);
    }
    // keep the countdown ticking
    if (this._countdownDirty) {
      this._countdownDirty = false;
      clearTimeout(this._cdTimer);
      this._cdTimer = setTimeout(() => this.dirty(), 1000);
    }
  }

  // ───────────── analysis overlay ─────────────
  _drawAnalysis(pass, list = null) {
    const ctx = this.ctx;
    const labels = [];
    const own = !list;
    for (const it of list || this.ana) {
      if (own && !this._anaOn(it)) continue;
      const below = it.kind === "box" || it.kind === "histogram";
      if ((pass === "below") !== below) continue;
      const pr = own ? this._prog(it) : 1;
      if (pr <= 0) continue;
      ctx.globalAlpha = pr;
      const k = it.kind;
      if (k === "box") {
        const x1 = this.tx(it.t1);
        let x2 = it.extend === "right" ? this.plotW : this.tx(it.t2);
        x2 = x1 + (x2 - x1) * pr;
        const ya = this.y(it.p2);
        const yb = this.y(it.p1);
        if (x2 < 0 || x1 > this.plotW) continue;
        ctx.fillStyle = it.fill || "rgba(85,174,255,0.12)";
        ctx.fillRect(x1, Math.min(ya, yb), x2 - x1, Math.abs(yb - ya));
        if (it.text) {
          if (it.labelAt === "start") {
            ctx.font = this.font;
            ctx.fillStyle = hexA(this.theme.text, 0.9);
            ctx.textAlign = "left";
            ctx.textBaseline = "bottom";
            ctx.fillText(it.text, Math.max(4, x1 + 4), Math.min(ya, yb) - 2);
          } else labels.push({ y: (ya + yb) / 2, text: it.text, color: this.theme.text, prio: it.prio });
        }
      } else if (k === "histogram") {
        const bins = it.bins || [];
        if (bins.length < 2) continue;
        let mx = 0;
        for (const b of bins) mx = Math.max(mx, b[1]);
        const step = Math.abs(bins[1][0] - bins[0][0]);
        const maxW = this.plotW * 0.14 * pr;
        ctx.fillStyle = it.color || "rgba(240,98,146,0.25)";
        for (const [pc, v] of bins) {
          const ya = this.y(pc + step * 0.45);
          const yb = this.y(pc - step * 0.45);
          const w = (v / (mx || 1)) * maxW;
          ctx.fillRect(this.plotW - w, Math.min(ya, yb), w, Math.max(1, Math.abs(yb - ya)));
        }
      } else if (k === "line" || k === "hline") {
        const x1 = k === "hline" && it.extend === "right" && it.layer !== "plan" ? 0 : this.tx(it.t1);
        let x2 = it.extend === "right" ? this.plotW : this.tx(it.t2);
        const y1 = this.y(it.p1);
        let y2 = this.y(it.p2);
        x2 = x1 + (x2 - x1) * pr;
        y2 = y1 + (y2 - y1) * pr;
        ctx.strokeStyle = it.color;
        ctx.lineWidth = (it.width || 1) * this.scale;
        ctx.setLineDash(it.dash === "dash" ? [6, 4] : it.dash === "dot" ? [2, 3] : it.dash === "dashdot" ? [7, 3, 2, 3] : []);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (it.text && pr > 0.7) {
          const at = it.labelAt;
          ctx.font = it.layer === "plan" ? this.fontB : this.font;
          if (at === "plan") {
            ctx.fillStyle = it.color === "#d1d4dc" ? this.theme.text : it.color;
            ctx.textAlign = "left";
            ctx.textBaseline = "bottom";
            ctx.fillText(it.text, x1 + 4, y1 - 2);
            const tw = ctx.measureText(it.text).width;
            this._labelBoxes.push({ x: x1, y: y1 - this.fs - 6 * this.scale, w: tw + 10 * this.scale, h: this.fs + 10 * this.scale, it });
          } else if (at === "middle" || at === "start" || at === "end") {
            const xa = at === "middle" ? (x1 + x2) / 2 : at === "start" ? x1 : x2;
            const ya = at === "end" ? y2 : y1;
            ctx.fillStyle = it.color;
            ctx.textAlign = at === "middle" ? "center" : "left";
            ctx.textBaseline = it.anchor === "below" ? "top" : "bottom";
            ctx.fillText(it.text, xa + (at === "end" ? 4 : 0), ya + (it.anchor === "below" ? 3 : -3));
          } else if (it.extend === "right" || x2 >= this.plotW - 2) {
            labels.push({ y: y2, text: it.text, color: it.color, prio: it.prio });
          }
        }
      } else if (k === "path") {
        const pts = it.points || [];
        const n = Math.max(1, Math.floor(pts.length * pr));
        ctx.strokeStyle = it.color;
        ctx.lineWidth = (it.width || 1) * this.scale;
        ctx.setLineDash(it.dash === "dot" ? [2, 3] : it.dash === "dash" ? [6, 4] : []);
        ctx.beginPath();
        pts.slice(0, n + 1).forEach((p, j) => {
          const xx = this.tx(p.t);
          const yy = this.y(p.p);
          if (j === 0) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        if (it.text && pts.length && pr > 0.9) {
          const lp = pts[pts.length - 1];
          ctx.font = this.font;
          ctx.fillStyle = it.color;
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(it.text, this.tx(lp.t) + 4, this.y(lp.p) - 4);
        }
      } else if (k === "label") {
        const xx = this.tx(it.t1);
        const yy = this.y(it.p1);
        if (xx < -20 || xx > this.plotW + 20) continue;
        ctx.font = this.fontB;
        ctx.fillStyle = it.color;
        ctx.textAlign = "center";
        ctx.textBaseline = it.anchor === "above" ? "bottom" : "top";
        ctx.fillText(it.text, xx, yy + (it.anchor === "above" ? -5 : 5));
      } else if (k === "marker") {
        const xx = this.tx(it.t1);
        const yy = this.y(it.p1);
        const s = 4.5 * this.scale;
        ctx.fillStyle = it.color;
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 2 * this.scale;
        ctx.beginPath();
        if (it.symbol === "x") {
          ctx.moveTo(xx - s, yy - s);
          ctx.lineTo(xx + s, yy + s);
          ctx.moveTo(xx + s, yy - s);
          ctx.lineTo(xx - s, yy + s);
          ctx.stroke();
        } else if (it.symbol === "triangle-up") {
          ctx.moveTo(xx, yy - s);
          ctx.lineTo(xx + s, yy + s);
          ctx.lineTo(xx - s, yy + s);
          ctx.fill();
        } else if (it.symbol === "triangle-down") {
          ctx.moveTo(xx, yy + s);
          ctx.lineTo(xx + s, yy - s);
          ctx.lineTo(xx - s, yy - s);
          ctx.fill();
        } else {
          ctx.arc(xx, yy, s * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    if (pass === "above" && labels.length) this._rightLabels(labels);
  }

  // ───────────── studies: overlays on the price chart, and panes under it ─────────────
  _studyLine(vals, i0, i1, yOf, color, width = 1.3, dash = null, style = "line") {
    const ctx = this.ctx;
    if (style === "dots") {
      ctx.fillStyle = color;
      for (let i = i0; i <= i1; i++) {
        const v = vals[i];
        if (v === null || v === undefined) continue;
        ctx.beginPath();
        ctx.arc(this.x(i), yOf(v), 1.6 * this.scale, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.beginPath();
    let pen = false;
    let lastY = null;
    for (let i = i0; i <= i1; i++) {
      const v = vals[i];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        if (style !== "connect") pen = false;
        continue;
      }
      const xx = this.x(i);
      const yy = yOf(v);
      if (!pen) {
        ctx.moveTo(xx, yy);
        pen = true;
      } else if (style === "step" && lastY !== null) {
        ctx.lineTo(xx, lastY);
        ctx.lineTo(xx, yy);
      } else ctx.lineTo(xx, yy);
      lastY = yy;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width * this.scale;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _studyBand(b, i0, i1, yOf) {
    const ctx = this.ctx;
    let start = null;
    const flush = (end) => {
      if (start === null || end - start < 1) return;
      ctx.beginPath();
      for (let i = start; i <= end; i++) ctx.lineTo(this.x(i), yOf(b.up[i]));
      for (let i = end; i >= start; i--) ctx.lineTo(this.x(i), yOf(b.lo[i]));
      ctx.closePath();
      const upIsUp = b.fill2 ? b.up[end] >= b.lo[end] : true;
      ctx.fillStyle = upIsUp ? b.fill : b.fill2;
      ctx.fill();
    };
    for (let i = i0; i <= i1; i++) {
      const ok = b.up[i] !== null && b.lo[i] !== null && b.up[i] !== undefined && b.lo[i] !== undefined;
      if (ok && start === null) start = i;
      if (!ok && start !== null) {
        flush(i - 1);
        start = null;
      }
      if (ok && b.fill2 && start !== null && i > start && (b.up[i] >= b.lo[i]) !== (b.up[i - 1] >= b.lo[i - 1])) {
        flush(i - 1);
        start = i - 1;
      }
    }
    if (start !== null) flush(i1);
  }

  _studyMarkers(markers, i0, i1, yOf) {
    const ctx = this.ctx;
    const s = 4 * this.scale;
    ctx.font = this.font;
    for (const m of markers) {
      if (m.i < i0 || m.i > i1) continue;
      const xx = this.x(m.i);
      const off = (m.above ? -1 : 1) * 9 * this.scale;
      const yy = yOf(m.p) + off;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      if (m.symbol === "triangle-up") {
        ctx.moveTo(xx, yy - s);
        ctx.lineTo(xx + s, yy + s);
        ctx.lineTo(xx - s, yy + s);
      } else if (m.symbol === "triangle-down") {
        ctx.moveTo(xx, yy + s);
        ctx.lineTo(xx + s, yy - s);
        ctx.lineTo(xx - s, yy - s);
      } else ctx.arc(xx, yy, s * 0.8, 0, Math.PI * 2);
      ctx.fill();
      if (m.text && this.spacing > 5) {
        ctx.textAlign = "center";
        ctx.textBaseline = m.above ? "bottom" : "top";
        ctx.fillText(m.text, xx, yy + (m.above ? -s - 2 : s + 2));
      }
    }
  }

  _drawStudies(i0, i1) {
    const yOf = (v) => this.y(v);
    this.studies.forEach((s, k) => {
      const r = this.studyOut[k];
      if (!r || r.kind !== "overlay") return;
      for (const b of r.bands || []) this._studyBand(b, i0, i1, yOf);
      for (const l of r.lines || []) this._studyLine(l.v, i0, i1, yOf, l.color, l.width || 1.3, l.dash, l.style);
      if (r.markers) this._studyMarkers(r.markers, i0, i1, yOf);
    });
  }

  _drawPanes(i0, i1) {
    let top = this.mainH;
    if (this.opts.rsi) {
      this._drawRsiAt(i0, i1, top, this.paneH);
      top += this.paneH;
    }
    for (const { out } of this._panes()) {
      this._drawPane(out, i0, i1, top, this.paneH);
      top += this.paneH;
    }
  }

  _drawPane(r, i0, i1, top, h) {
    const ctx = this.ctx;
    let lo = Infinity;
    let hi = -Infinity;
    if (r.range) [lo, hi] = r.range;
    else {
      const look = (v) => {
        for (let i = i0; i <= i1; i++) {
          const x = v[i];
          if (x === null || x === undefined || !Number.isFinite(x)) continue;
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      };
      for (const l of r.lines || []) look(l.v);
      if (r.hist) look(r.hist.v);
      for (const lv of r.levels || []) {
        lo = Math.min(lo, lv);
        hi = Math.max(hi, lv);
      }
      if (r.hist) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi - lo < 1e-12) {
      hi += 1;
      lo -= 1;
    }
    const pad = 6 * this.scale;
    const yv = (v) => top + pad + ((hi - v) / (hi - lo)) * (h - 2 * pad);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.plotW, h);
    ctx.clip();
    ctx.strokeStyle = this.theme.grid;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const v of r.levels || []) {
      ctx.moveTo(0, Math.round(yv(v)) + 0.5);
      ctx.lineTo(this.plotW, Math.round(yv(v)) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (r.hist) {
      const base = yv(r.hist.above !== undefined ? r.hist.above : 0);
      const w = Math.max(1, this.spacing * 0.6);
      for (let i = i0; i <= i1; i++) {
        const v = r.hist.v[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const prev = i ? r.hist.v[i - 1] : null;
        const pos = r.hist.rising ? prev === null || v >= prev : v >= (r.hist.above !== undefined ? r.hist.above : 0);
        ctx.fillStyle = hexA(pos ? r.hist.up : r.hist.down, 0.8);
        const yy = yv(v);
        ctx.fillRect(this.x(i) - w / 2, Math.min(yy, base), w, Math.max(1, Math.abs(yy - base)));
      }
    }
    for (const l of r.lines || []) this._studyLine(l.v, i0, i1, yv, l.color, l.width || 1.3, l.dash, l.style);
    if (r.markers) this._studyMarkers(r.markers, i0, i1, yv);
    ctx.restore();
    ctx.strokeStyle = this.theme.axisLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(this.W, top + 0.5);
    ctx.stroke();
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(this.plotW + 1, top + 1, this.axisW, h - 1);
    ctx.font = this.font;
    ctx.fillStyle = this.theme.text;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const f = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(Math.min(4, this.dec)));
    ctx.fillText(f(hi), this.plotW + 6 * this.scale, top + pad + 2);
    ctx.fillText(f(lo), this.plotW + 6 * this.scale, top + h - pad - 2);
    const last = (r.lines || []).map((l) => l.v[Math.min(i1, l.v.length - 1)]).filter((v) => v !== null && v !== undefined);
    ctx.fillText(`${r.name}${last.length ? "  " + last.map(f).join("  ") : ""}`, 8, top + 11 * this.scale);
  }

  _rightLabels(items) {
    const ctx = this.ctx;
    const gap = this.fs + 6 * this.scale;
    const kept = [];
    items.sort((a, b) => a.prio - b.prio);
    for (const it of items) {
      if (it.y < 4 || it.y > this.mainH - 4) continue;
      if (kept.every((k) => Math.abs(k.y - it.y) >= gap)) kept.push(it);
    }
    ctx.font = this.font;
    for (const it of kept) {
      const w = ctx.measureText(it.text).width + 10 * this.scale;
      const x = this.plotW - w - 4;
      ctx.fillStyle = hexA(this.theme.bg, 0.78);
      ctx.fillRect(x, it.y - this.fs / 2 - 3, w, this.fs + 6);
      ctx.fillStyle = it.color && it.color.startsWith("#") ? it.color : this.theme.text;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(it.text, x + 5 * this.scale, it.y);
    }
  }

  // ───────────── user drawings ─────────────
  _dash(style) {
    const s = this.scale;
    return style === "dashed" ? [7 * s, 5 * s] : style === "dotted" ? [2 * s, 3 * s] : [];
  }

  _drawUserDrawings() {
    for (const d of this.drawings) {
      if (d.hidden) continue;
      this._drawOne(d);
    }
    const sd = this.selected();
    if (sd && !sd.hidden) {
      const ctx = this.ctx;
      for (const h of this._handles(sd)) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, 5 * this.scale, 0, Math.PI * 2);
        ctx.fillStyle = this.theme.bg;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = sd.style.color || "#2962ff";
        ctx.stroke();
      }
    }
  }

  _drawOne(d) {
    const ctx = this.ctx;
    const st = d.style || {};
    const col = st.color || "#2962ff";
    const lw = (st.width || 2) * this.scale * 0.75;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = lw;
    ctx.setLineDash(this._dash(st.dash));
    const t = d.type;
    const P = d.points;
    if (EXTRA_TOOLS[t]) {
      drawExtra(this, d);
      ctx.setLineDash([]);
      return;
    }
    if (t === "hline" || t === "hray") {
      const yy = this.y(P[0].p);
      const x1 = t === "hline" ? 0 : this.tx(P[0].t);
      ctx.beginPath();
      ctx.moveTo(x1, yy);
      ctx.lineTo(this.plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      if (st.text) {
        ctx.font = this.fontB;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(st.text, Math.max(6, x1 + 6), yy - 3);
      }
      return;
    }
    if (t === "vline") {
      const xx = this.tx(P[0].t);
      ctx.beginPath();
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, this.mainH);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (t === "trendline" || t === "ray" || t === "extline" || t === "arrow") {
      if (P.length < 2) return;
      const [x1, y1, x2, y2] = this._lineEnds(d);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (t === "arrow") {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const s = 12 * this.scale;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - s * Math.cos(ang - 0.45), y2 - s * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - s * Math.cos(ang + 0.45), y2 - s * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
      if (st.text) {
        ctx.font = this.fontB;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(st.text, this.tx(P[1].t) + 6, this.y(P[1].p) - 4);
      }
      return;
    }
    if (t === "rect") {
      const x1 = this.tx(P[0].t);
      const x2 = st.extendRight ? this.plotW : this.tx(P[1].t);
      const y1 = this.y(P[0].p);
      const y2 = this.y(P[1].p);
      ctx.fillStyle = st.fill || hexA(col, 0.14);
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.setLineDash([]);
      if (st.text) {
        ctx.font = this.fontB;
        ctx.fillStyle = col;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(st.text, Math.min(x1, x2) + 6, Math.min(y1, y2) + 5);
      }
      return;
    }
    if (t === "channel") {
      if (P.length < 2) return;
      const [a, b] = P;
      const c = P[2] || b;
      const x1 = this.tx(a.t);
      const x2 = this.tx(b.t);
      const ya = this.y(a.p);
      const yb = this.y(b.p);
      const lineAtC = a.p + ((b.p - a.p) * (c.t - a.t)) / ((b.t - a.t) || 1);
      const off = this.y(c.p) - this.y(lineAtC);
      ctx.fillStyle = hexA(col, 0.08);
      ctx.beginPath();
      ctx.moveTo(x1, ya);
      ctx.lineTo(x2, yb);
      ctx.lineTo(x2, yb + off);
      ctx.lineTo(x1, ya + off);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x1, ya);
      ctx.lineTo(x2, yb);
      ctx.moveTo(x1, ya + off);
      ctx.lineTo(x2, yb + off);
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, ya + off / 2);
      ctx.lineTo(x2, yb + off / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (t === "fib") {
      if (P.length < 2) return;
      const x1 = Math.min(this.tx(P[0].t), this.tx(P[1].t));
      const x2 = st.extendRight ? this.plotW : Math.max(this.tx(P[0].t), this.tx(P[1].t));
      const a = P[0].p;
      const b = P[1].p;
      ctx.setLineDash([]);
      ctx.font = this.font;
      FIB.forEach((f, j) => {
        const p = b + (a - b) * f;
        const yy = this.y(p);
        if (j > 0) {
          const pp = b + (a - b) * FIB[j - 1];
          ctx.fillStyle = hexA(FIB_COL[j], 0.06);
          ctx.fillRect(x1, Math.min(yy, this.y(pp)), x2 - x1, Math.abs(yy - this.y(pp)));
        }
        ctx.strokeStyle = FIB_COL[j];
        ctx.lineWidth = 1 * this.scale;
        ctx.beginPath();
        ctx.moveTo(x1, yy);
        ctx.lineTo(x2, yy);
        ctx.stroke();
        ctx.fillStyle = FIB_COL[j];
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${f} (${this.fmt(p)})`, x1 + 4, yy - 2);
      });
      ctx.strokeStyle = hexA(col, 0.6);
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.tx(P[0].t), this.y(a));
      ctx.lineTo(this.tx(P[1].t), this.y(b));
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    if (t === "measure") {
      if (P.length < 2) return;
      const x1 = this.tx(P[0].t);
      const x2 = this.tx(P[1].t);
      const y1 = this.y(P[0].p);
      const y2 = this.y(P[1].p);
      const up = P[1].p >= P[0].p;
      const c2 = up ? this.theme.up : this.theme.down;
      ctx.setLineDash([]);
      ctx.fillStyle = hexA(c2, 0.14);
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.strokeStyle = c2;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo((x1 + x2) / 2, y1);
      ctx.lineTo((x1 + x2) / 2, y2);
      ctx.moveTo(x1, (y1 + y2) / 2);
      ctx.lineTo(x2, (y1 + y2) / 2);
      ctx.stroke();
      const dp = P[1].p - P[0].p;
      const bars = Math.round(this.timeToIndex(P[1].t) - this.timeToIndex(P[0].t));
      const txt = `${dp >= 0 ? "+" : ""}${this.fmt(dp)} (${((dp / P[0].p) * 100).toFixed(2)}%) · ${bars} bars`;
      ctx.font = this.fontB;
      const w = ctx.measureText(txt).width + 14;
      const bx = (x1 + x2) / 2 - w / 2;
      const by = up ? Math.min(y1, y2) - this.fs - 14 : Math.max(y1, y2) + 6;
      ctx.fillStyle = c2;
      ctx.fillRect(bx, by, w, this.fs + 8);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, bx + w / 2, by + (this.fs + 8) / 2);
      return;
    }
    if (t === "long" || t === "short") {
      if (P.length < 3) return;
      const x1 = this.tx(P[0].t);
      const x2 = this.tx(P[1].t);
      const ye = this.y(P[0].p);
      const ys = this.y(P[1].p);
      const yt = this.y(P[2].p);
      ctx.setLineDash([]);
      ctx.fillStyle = hexA(this.theme.up, 0.18);
      ctx.fillRect(x1, Math.min(ye, yt), x2 - x1, Math.abs(yt - ye));
      ctx.fillStyle = hexA(this.theme.down, 0.18);
      ctx.fillRect(x1, Math.min(ye, ys), x2 - x1, Math.abs(ys - ye));
      ctx.strokeStyle = hexA(this.theme.text, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, ye);
      ctx.lineTo(x2, ye);
      ctx.stroke();
      const entry = P[0].p;
      const risk = Math.abs(entry - P[1].p);
      const reward = Math.abs(P[2].p - entry);
      const rr = risk ? reward / risk : 0;
      ctx.font = this.fontB;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const lab = (y, txt, bg) => {
        const w = ctx.measureText(txt).width + 12;
        ctx.fillStyle = bg;
        ctx.fillRect(x1 + 4, y - this.fs / 2 - 4, w, this.fs + 8);
        ctx.fillStyle = "#fff";
        ctx.fillText(txt, x1 + 10, y);
      };
      const pct = (p) => `${(((p - entry) / entry) * 100).toFixed(2)}%`;
      const off = this.fs + 2;
      lab(yt + (yt < ye ? off : -off), `Target ${this.fmt(P[2].p)} (${pct(P[2].p)})`, hexA(this.theme.up, 0.9));
      lab(ys + (ys > ye ? -off : off), `Stop ${this.fmt(P[1].p)} (${pct(P[1].p)})`, hexA(this.theme.down, 0.9));
      lab(ye + (ys > ye ? off : -off), `${t === "long" ? "Long" : "Short"} ${this.fmt(entry)} · R:R ${rr.toFixed(2)}`, "rgba(42,58,92,0.95)");
      return;
    }
    if (t === "text") {
      const xx = this.tx(P[0].t);
      const yy = this.y(P[0].p);
      const txt = st.text || "Text";
      ctx.setLineDash([]);
      ctx.font = this.fontB;
      const w = ctx.measureText(txt).width + 14;
      const h = this.fs + 10;
      ctx.fillStyle = hexA(col, 0.18);
      ctx.strokeStyle = hexA(col, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(xx, yy - h, w, h, 6);
      else ctx.rect(xx, yy - h, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(txt, xx + 7, yy - h / 2);
    }
    ctx.setLineDash([]);
  }

  screenshot() {
    return this.canvas.toDataURL("image/png");
  }
}

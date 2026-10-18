// StreixAnalyst chart engine: a fast canvas chart with pan / zoom / pinch, candle styles, indicators,
// TradingView-style drawing tools and the animated AI analysis overlay. Framework-free; React wraps it.
import { computeAll, heikinAshi } from "./indicators";

export const TOOLS = {
  cursor: { pts: 0 }, crosshair: { pts: 0 },
  trendline: { pts: 2, label: "Trend line" }, ray: { pts: 2, label: "Ray" }, extline: { pts: 2, label: "Extended line" },
  arrow: { pts: 2, label: "Arrow" }, hline: { pts: 1, label: "Horizontal line" }, hray: { pts: 1, label: "Horizontal ray" },
  vline: { pts: 1, label: "Vertical line" }, rect: { pts: 2, label: "Rectangle / zone" }, channel: { pts: 3, label: "Parallel channel" },
  fib: { pts: 2, label: "Fib retracement" }, long: { pts: 1, label: "Long position" }, short: { pts: 1, label: "Short position" },
  measure: { pts: 2, label: "Measure" }, text: { pts: 1, label: "Text note" },
};
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1, 1.272, 1.618];
const FIB_COL = ["#9aa7bd", "#ef5350", "#ff9800", "#4caf50", "#26a69a", "#2fb5d6", "#d97757", "#9aa7bd", "#9b7bff", "#e91e63"];
// TradingView dark palette: chart #131722, axis text #787b86, candles #089981 / #f23645.
const DEFAULT_THEME = {
  bg: "#131722", grid: "rgba(42,46,57,0.85)", text: "#787b86", crosshair: "#758696",
  up: "#089981", down: "#f23645", wickUp: "#089981", wickDown: "#f23645", borderUp: "#089981", borderDown: "#f23645",
  line: "#2962ff", axisLine: "#2a2e39", font: "Inter, system-ui, -apple-system, Segoe UI, sans-serif",
  label: "#2a3a5c", ma20: "rgba(255,255,255,0.55)", ma50: "rgba(255,213,79,0.75)", ma200: "rgba(155,123,255,0.95)",
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

export class ChartEngine {
  constructor(canvas, { onEvent, scale = 1 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.emit = onEvent || (() => {});
    this.scale = scale;
    this.d = [];
    this.ha = null;
    this.ind = null;
    this.tfSec = 3600;
    this.dec = 2;
    this.label = "";
    this.theme = { ...DEFAULT_THEME };
    this.opts = { ...DEFAULT_OPTS, indicators: { ...DEFAULT_OPTS.indicators } };
    this.spacing = 9;
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
    this.hiddenLayers = new Set();
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
      down: (e) => this.onDown(e), move: (e) => this.onMove(e), up: (e) => this.onUp(e), leave: () => this.onLeave(),
      wheel: (e) => this.onWheel(e), key: (e) => this.onKey(e), dbl: (e) => this.onDbl(e), ctx: (e) => e.preventDefault(),
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
  setData(rows, { tfSec, decimals, label, keepView = false } = {}) {
    const keepT = keepView && this.d.length ? this.indexToTime(this.right) : null;
    this.d = rows.map((r) => (Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] || 0 } : r));
    if (tfSec) this.tfSec = tfSec;
    if (decimals !== undefined && decimals !== null) this.dec = decimals;
    if (label !== undefined) this.label = label;
    this._recompute();
    if (keepT !== null) this.right = this.timeToIndex(keepT);
    else this.resetView();
    this.dirty();
  }

  updateTail(rows) {
    if (!this.d.length || !rows || !rows.length) return;
    const last = this.d.length - 1;
    const following = this.right >= last - 0.5;
    let added = 0;
    for (const r of rows) {
      const k = Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] || 0 } : r;
      const L = this.d[this.d.length - 1];
      if (k.t === L.t) this.d[this.d.length - 1] = k;
      else if (k.t > L.t) {
        this.d.push(k);
        added++;
      }
    }
    this._recompute();
    if (following && added) this.right += added;
    this.dirty();
  }

  _recompute() {
    this.ha = this.opts.style === "heikin" ? heikinAshi(this.d) : null;
    this.ind = this.d.length ? computeAll(this.d, this.tfSec < 86400) : null;
  }

  setTheme(theme) {
    this.theme = { ...this.theme, ...theme };
    this.dirty();
  }

  setOptions(opts) {
    const prevStyle = this.opts.style;
    this.opts = { ...this.opts, ...opts, indicators: { ...this.opts.indicators, ...(opts.indicators || {}) } };
    if (this.opts.style !== prevStyle) this._recompute();
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
    const sample = this.fmt(Math.max(Math.abs(this.pmax || 0), Math.abs(this.pmin || 0), 1) * 1.1);
    this.axisW = Math.max(Math.round(58 * s), Math.ceil(ctx.measureText(sample).width) + Math.round(20 * s));
    this.timeH = Math.round(24 * s);
    const avail = this.H - this.timeH;
    this.rsiH = this.opts.rsi ? Math.round(avail * 0.2) : 0;
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
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      if (k.l < lo) lo = k.l;
      if (k.h > hi) hi = k.h;
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
    this.spacing = clamp(Math.round(9 * this.scale), 3, 40);
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

  // ───────────── analysis overlay ─────────────
  setAnalysis(items, { animate = true, pins = [] } = {}) {
    this.ana = items && items.length ? items : null;
    this.pins = pins;
    this.anaStart = animate ? performance.now() : performance.now() - 1e6;
    const orders = [...new Set((items || []).map((d) => d.order))].sort((a, b) => a - b);
    this._orderRank = new Map(orders.map((o, k) => [o, k]));
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
        let bd = 16 * this.scale;
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
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { mode: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), sp0: this.spacing, mid0: (a.x + b.x) / 2,
        i0: this.index((a.x + b.x) / 2), right0: this.right };
      this.placing = null;
      return;
    }
    const area = this._area(x, y);
    // placing a drawing
    if (this.tool !== "cursor" && this.tool !== "crosshair" && area === "plot") {
      this._place(x, y, touch);
      return;
    }
    if (area === "paxis") {
      this.drag = { mode: "yscale", y0: y, pmin: this.pmin, pmax: this.pmax };
      this.auto = false;
      return;
    }
    if (area === "taxis") {
      this.drag = { mode: "xscale", x0: x, sp0: this.spacing, i0: this.index(this.plotW / 2), mid: this.plotW / 2 };
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
      t0: performance.now() };
  }

  _place(x, y, touch) {
    const tool = this.tool;
    const spec = TOOLS[tool];
    const pt = this._pt(x, y);
    const def = this.drawingDefaults || { color: "#e8a287", width: 2, dash: "solid" };
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
          d = { type: tool, points: [pt], style: { ...def, ...(tool === "text" ? { text: "" } : {}) } };
        }
        const id = this.addDrawing(d);
        this.select(id);
        if (tool === "text") this.emit("requestText", id);
        this.emit("toolDone", tool);
        this.tool = "cursor";
        return;
      }
      this._snapshot();
      const d = { id: newId(), type: tool, points: Array.from({ length: Math.min(2, spec.pts) }, () => ({ ...pt })), style: { ...def } };
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
    this.tool = "cursor";
    this.emit("toolDone", d.type);
    this._changed();
    this.select(d.id);
  }

  onMove(e) {
    const { x, y } = this._pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    const dr = this.drag;
    if (dr && dr.mode === "pinch" && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = (a.x + b.x) / 2;
      this.spacing = clamp(dr.sp0 * (dist / (dr.d0 || 1)), 1.2, 80 * this.scale);
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
    if (dr) {
      const dx = x - dr.x0;
      const dy = y - dr.y0;
      if (Math.abs(dx) + Math.abs(dy) > 3) dr.moved = true;
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
            this.pmin = this._fi(a + dv);
            this.pmax = this._fi(b + dv);
          }
        }
        this.canvas.style.cursor = "grabbing";
        this.dirty();
        this.emit("view", this.viewState());
        return;
      }
      if (dr.mode === "yscale") {
        const f = Math.exp((y - dr.y0) * 0.006);
        const a = this._f(dr.pmin);
        const b = this._f(dr.pmax);
        const mid = (a + b) / 2;
        const half = ((b - a) / 2) * f;
        this.pmin = this._fi(mid - half);
        this.pmax = this._fi(mid + half);
        this.dirty();
        return;
      }
      if (dr.mode === "xscale") {
        this.spacing = clamp(dr.sp0 * Math.exp((x - dr.x0) * 0.008), 1.2, 80 * this.scale);
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
    // hover
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
    if (dr.mode === "handle" || dr.mode === "body") {
      if (dr.moved) this._changed();
      else this.undoStack.pop();
      const d = this.selected();
      if (d) this.select(d.id);
      return;
    }
    if (dr.mode === "pan") {
      this.canvas.style.cursor = "crosshair";
      if (!dr.moved) {
        if (this.sel) this.select(null);
        if (dr.touch) {
          // tap = show crosshair there; double tap = reset view
          const now = performance.now();
          if (now - this._lastTap < 320) this.resetView();
          this._lastTap = now;
          this.hover = { x, y, area: "plot", touch: true };
          this._emitHover();
        }
      }
      this.dirty();
    }
  }

  onLeave() {
    if (this.drag) return;
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
      const mid = (a + b) / 2;
      const half = ((b - a) / 2) * f;
      this.pmin = this._fi(mid - half);
      this.pmax = this._fi(mid + half);
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
      this.spacing = clamp(this.spacing * f, 1.2, 80 * this.scale);
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
      this.spacing = clamp(this.spacing * f, 1.2, 80 * this.scale);
      this.right = i0;
      this.dirty();
    }
  }

  zoom(f) {
    const i0 = this.index(this.plotW * 0.8);
    this.spacing = clamp(this.spacing * f, 1.2, 80 * this.scale);
    this.right = i0 + (this.plotW * 0.2) / this.spacing;
    this._clampRight();
    this.dirty();
  }

  _clampRight() {
    const n = this.d.length;
    const visible = this.plotW / this.spacing;
    this.right = clamp(this.right, Math.min(n - 1, visible * 0.25), n - 1 + visible * 0.85);
  }

  _emitHover() {
    const h = this.hover;
    if (!h || !this.d.length || h.area === "taxis" || h.area === "paxis") {
      this.emit("hover", null);
      return;
    }
    const i = clamp(Math.round(this.index(h.x)), 0, this.d.length - 1);
    const k = this.d[i];
    const prev = this.d[i - 1];
    const ind = this.ind;
    this.emit("hover", {
      i, candle: k, change: prev ? (k.c / prev.c - 1) * 100 : null, price: this.price(h.y),
      ema20: ind && ind.ema20[i], ema50: ind && ind.ema50[i], ema200: ind && ind.ema200[i], rsi: ind && ind.rsi[i],
      vwap: ind && ind.vwap ? ind.vwap[i] : null,
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
    if (this.ana) this._drawAnalysis("below");
    if (this.opts.volume) this._drawVolume(i0, i1);
    this._drawSeries(i0, i1);
    this._drawIndicators(i0, i1);
    if (this.ana) this._drawAnalysis("above");
    if (this.drawingsVisible) this._drawUserDrawings();
    this._drawLastLine();
    this._drawLastDot();
    this._drawCrosshair();
    ctx.restore();
    if (this.opts.rsi) this._drawRsi(i0, i1);
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
    const w = Math.max(1, this.spacing * 0.7);
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      const vh = (k.v / mx) * h;
      ctx.fillStyle = hexA(k.c >= k.o ? this.theme.up : this.theme.down, 0.22);
      ctx.fillRect(this.x(i) - w / 2, base - vh, w, vh);
    }
  }

  _drawSeries(i0, i1) {
    const ctx = this.ctx;
    const th = this.theme;
    const src = this._series();
    const style = this.opts.style;
    if (style === "line" || style === "area") {
      ctx.beginPath();
      let first = true;
      for (let i = i0; i <= i1; i++) {
        const xx = this.x(i);
        const yy = this.y(src[i].c);
        if (first) {
          ctx.moveTo(xx, yy);
          first = false;
        } else ctx.lineTo(xx, yy);
      }
      ctx.strokeStyle = th.line;
      ctx.lineWidth = 2 * this.scale;
      ctx.stroke();
      if (style === "area") {
        ctx.lineTo(this.x(i1), this.mainH);
        ctx.lineTo(this.x(i0), this.mainH);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, this.mainH);
        g.addColorStop(0, hexA(th.line, 0.32));
        g.addColorStop(1, hexA(th.line, 0.0));
        ctx.fillStyle = g;
        ctx.fill();
      }
      return;
    }
    const bw = Math.max(1, Math.min(this.spacing * 0.72, this.spacing - 1));
    const thin = bw < 3;
    for (let i = i0; i <= i1; i++) {
      const k = src[i];
      if (!k) continue;
      const up = k.c >= k.o;
      const xx = Math.round(this.x(i));
      const yo = this.y(k.o);
      const yc = this.y(k.c);
      const yh = this.y(k.h);
      const yl = this.y(k.l);
      if (style === "bars") {
        ctx.strokeStyle = up ? th.up : th.down;
        ctx.lineWidth = Math.max(1, Math.min(2, this.spacing / 6));
        ctx.beginPath();
        ctx.moveTo(xx + 0.5, yh);
        ctx.lineTo(xx + 0.5, yl);
        ctx.moveTo(xx - bw / 2, yo);
        ctx.lineTo(xx + 0.5, yo);
        ctx.moveTo(xx + 0.5, yc);
        ctx.lineTo(xx + bw / 2, yc);
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = up ? th.wickUp : th.wickDown;
      ctx.fillRect(xx, yh, 1, Math.max(1, yl - yh));
      const top = Math.min(yo, yc);
      const hgt = Math.max(1, Math.abs(yc - yo));
      if (thin) {
        ctx.fillStyle = up ? th.up : th.down;
        ctx.fillRect(xx - Math.floor(bw / 2), top, Math.max(1, bw), hgt);
        continue;
      }
      const left = Math.round(xx - bw / 2) + 0.5;
      if (style === "hollow" && up) {
        ctx.fillStyle = th.bg;
        ctx.fillRect(left, top, bw, hgt);
        ctx.strokeStyle = th.borderUp || th.up;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, Math.round(top) + 0.5, Math.round(bw) - 1, Math.max(1, Math.round(hgt) - 1));
      } else {
        ctx.fillStyle = up ? th.up : th.down;
        ctx.fillRect(left - 0.5, top, bw, hgt);
        const border = up ? th.borderUp : th.borderDown;
        if (border && border !== (up ? th.up : th.down)) {
          ctx.strokeStyle = border;
          ctx.lineWidth = 1;
          ctx.strokeRect(left, Math.round(top) + 0.5, Math.round(bw) - 1, Math.max(1, Math.round(hgt) - 1));
        }
      }
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
      this._line(I.bb.up, i0, i1, "rgba(155,123,255,0.65)", 1);
      this._line(I.bb.lo, i0, i1, "rgba(155,123,255,0.65)", 1);
      this._line(I.bb.mid, i0, i1, "rgba(155,123,255,0.35)", 1, [4, 4]);
    }
    if (on.ema20) this._line(I.ema20, i0, i1, this.theme.ma20, 1.1);
    if (on.ema50) this._line(I.ema50, i0, i1, this.theme.ma50, 1.2);
    if (on.ema200) this._line(I.ema200, i0, i1, this.theme.ma200, 1.6);
    if (on.vwap && I.vwap) this._line(I.vwap, i0, i1, "rgba(255,152,0,0.85)", 1.3);
  }

  _drawLastLine() {
    const k = this.d[this.d.length - 1];
    const ctx = this.ctx;
    const yy = Math.round(this.y(k.c)) + 0.5;
    ctx.strokeStyle = hexA(k.c >= k.o ? this.theme.up : this.theme.down, 0.75);
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
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
    const h = this.hover;
    if (!h || h.area === "paxis" || h.area === "taxis" || this.drag) return;
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

  _drawRsi(i0, i1) {
    const ctx = this.ctx;
    const top = this.mainH;
    const h = this.rsiH;
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

  _tag(y, text, bg, fg = "#fff", xLeft = null) {
    const ctx = this.ctx;
    ctx.font = this.fontB;
    const pad = 6 * this.scale;
    const w = Math.max(this.axisW - 4, ctx.measureText(text).width + pad * 2);
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
    ctx.fillText(text, x + pad, yy + h / 2 + 0.5);
    return { y: yy, h };
  }

  _drawPriceAxis(ticks) {
    const ctx = this.ctx;
    const th = this.theme;
    ctx.fillStyle = th.bg;
    ctx.fillRect(this.plotW, 0, this.axisW, this.mainH + this.rsiH);
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
      for (const p of sd.points) tags.push({ y: this.y(p.p), text: this.fmt(p.p), bg: hexA(sd.style.color || "#e8a287", 0.9), prio: 1 });
    }
    if (this.ana) {
      for (const it of this.ana) {
        if (!it.axisTag || it.prio > this.detail || this.hiddenLayers.has(it.layer)) continue;
        if (it.plan === "alternative" && !this.showAlt) continue;
        if (this._prog(it) < 0.6) continue;
        const isTp = /TP\d/.test(it.text || "");
        tags.push({ y: this.y(it.p1), text: this.fmt(it.p1), bg: it.color === th.text || it.color === "#d1d4dc" ? "#3a4a6b" : it.color,
          prio: (it.plan === "alternative" ? 5 : 2) + (isTp ? 1 : 0) });
      }
    }
    if (this.drawingsVisible) {
      for (const d of this.drawings) {
        if (d.hidden || (d.type !== "hline" && d.type !== "hray")) continue;
        tags.push({ y: this.y(d.points[0].p), text: this.fmt(d.points[0].p), bg: d.style.color || "#e8a287", prio: 4 });
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
    // crosshair price always on top
    const h = this.hover;
    if (h && !this.drag && h.area !== "taxis" && h.y <= this.mainH) {
      this._tag(h.y, this.fmt(this.price(h.y)), this.theme.label);
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
    const h = this.hover;
    if (h && !this.drag && h.area !== "paxis") {
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
  _drawAnalysis(pass) {
    const ctx = this.ctx;
    const labels = [];
    for (const it of this.ana) {
      if (it.prio > this.detail || this.hiddenLayers.has(it.layer)) continue;
      if (it.plan === "alternative" && !this.showAlt) continue;
      const below = it.kind === "box" || it.kind === "histogram";
      if ((pass === "below") !== below) continue;
      const pr = this._prog(it);
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
        ctx.strokeStyle = sd.style.color || "#e8a287";
        ctx.stroke();
      }
    }
  }

  _drawOne(d) {
    const ctx = this.ctx;
    const st = d.style || {};
    const col = st.color || "#e8a287";
    const lw = (st.width || 2) * this.scale * 0.75;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = lw;
    ctx.setLineDash(this._dash(st.dash));
    const t = d.type;
    const P = d.points;
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

// The indicator library: overlays on the price pane and studies in panes under it, plus candlestick patterns.
// Every study is computed from the candles on the chart ({t, o, h, l, c, v}) and returns plain arrays (null until
// there is enough data). The engine draws whatever a study returns: lines, histograms, bands, fixed levels, markers.

const N = (n) => new Array(n).fill(null);
const closes = (d) => d.map((k) => k.c);
const hl2 = (d) => d.map((k) => (k.h + k.l) / 2);
const hlc3 = (d) => d.map((k) => (k.h + k.l + k.c) / 3);

export function sma(v, n) {
  const out = N(v.length);
  let s = 0;
  let cnt = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === null || x === undefined) { s = 0; cnt = 0; continue; }
    s += x;
    cnt++;
    if (cnt > n) { s -= v[i - n]; cnt = n; }
    if (cnt === n) out[i] = s / n;
  }
  return out;
}

export function ema(v, n) {
  const out = N(v.length);
  const k = 2 / (n + 1);
  let prev = null;
  let s = 0;
  let cnt = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === null || x === undefined) continue;
    if (prev === null) {
      s += x;
      cnt++;
      if (cnt === n) { prev = s / n; out[i] = prev; }
      continue;
    }
    prev = x * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rma(v, n) {
  const out = N(v.length);
  let prev = null;
  let s = 0;
  let cnt = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x === null || x === undefined) continue;
    if (prev === null) {
      s += x;
      cnt++;
      if (cnt === n) { prev = s / n; out[i] = prev; }
      continue;
    }
    prev = (prev * (n - 1) + x) / n;
    out[i] = prev;
  }
  return out;
}

export function wma(v, n) {
  const out = N(v.length);
  const den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < v.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = 0; j < n; j++) {
      const x = v[i - n + 1 + j];
      if (x === null || x === undefined) { ok = false; break; }
      s += x * (j + 1);
    }
    if (ok) out[i] = s / den;
  }
  return out;
}

function stdev(v, n) {
  const m = sma(v, n);
  const out = N(v.length);
  for (let i = n - 1; i < v.length; i++) {
    if (m[i] === null) continue;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

function trueRange(d) {
  return d.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - d[i - 1].c), Math.abs(k.l - d[i - 1].c)) : k.h - k.l));
}

export function atr(d, n = 14) {
  return rma(trueRange(d), n);
}

function highest(v, n, i) {
  let m = -Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (v[j] > m) m = v[j];
  return m;
}

function lowest(v, n, i) {
  let m = Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (v[j] < m) m = v[j];
  return m;
}

function sub(a, b) {
  return a.map((x, i) => (x === null || b[i] === null ? null : x - b[i]));
}

function rsiArr(v, n) {
  const out = N(v.length);
  let g = 0;
  let l = 0;
  let cnt = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i] === null || v[i - 1] === null) continue;
    const ch = v[i] - v[i - 1];
    if (cnt < n) {
      g += Math.max(ch, 0);
      l += Math.max(-ch, 0);
      cnt++;
      if (cnt === n) {
        g /= n;
        l /= n;
        out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
      }
      continue;
    }
    g = (g * (n - 1) + Math.max(ch, 0)) / n;
    l = (l * (n - 1) + Math.max(-ch, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function stochArr(d, n, smooth) {
  const H = d.map((k) => k.h);
  const L = d.map((k) => k.l);
  const raw = d.map((_, i) => {
    if (i < n - 1) return null;
    const hh = highest(H, n, i);
    const ll = lowest(L, n, i);
    return hh > ll ? ((d[i].c - ll) / (hh - ll)) * 100 : 50;
  });
  return sma(raw, smooth);
}

const C = {
  blue: "#4ea4ff", orange: "#ff9f43", violet: "#b28dff", pink: "#ff6fb5", teal: "#2dd4bf", yellow: "#f7c948",
  red: "#ff5a6e", green: "#22c993", grey: "#9aa3ad", white: "#e8e6df", cyan: "#4dd8ff",
};

// ── the library ──
// kind: "overlay" (price pane) | "pane" (own pane under the chart). range: fixed y range for a pane, else auto.
export const STUDIES = [
  // moving averages
  { id: "sma", name: "Simple moving average", short: "SMA", cat: "Moving averages", kind: "overlay", params: { length: 20 },
    calc: (d, p) => ({ lines: [{ v: sma(closes(d), p.length), color: C.blue, label: `SMA ${p.length}` }] }) },
  { id: "ema", name: "Exponential moving average", short: "EMA", cat: "Moving averages", kind: "overlay", params: { length: 21 },
    calc: (d, p) => ({ lines: [{ v: ema(closes(d), p.length), color: C.orange, label: `EMA ${p.length}` }] }) },
  { id: "wma", name: "Weighted moving average", short: "WMA", cat: "Moving averages", kind: "overlay", params: { length: 20 },
    calc: (d, p) => ({ lines: [{ v: wma(closes(d), p.length), color: C.pink, label: `WMA ${p.length}` }] }) },
  { id: "hma", name: "Hull moving average", short: "HMA", cat: "Moving averages", kind: "overlay", params: { length: 21 },
    calc: (d, p) => {
      const c = closes(d);
      const half = wma(c, Math.max(2, Math.round(p.length / 2)));
      const full = wma(c, p.length);
      const diff = half.map((x, i) => (x === null || full[i] === null ? null : 2 * x - full[i]));
      return { lines: [{ v: wma(diff, Math.max(2, Math.round(Math.sqrt(p.length)))), color: C.teal, label: `HMA ${p.length}` }] };
    } },
  { id: "vwma", name: "Volume-weighted moving average", short: "VWMA", cat: "Moving averages", kind: "overlay", params: { length: 20 },
    calc: (d, p) => {
      const pv = sma(d.map((k) => k.c * (k.v || 0)), p.length);
      const vv = sma(d.map((k) => k.v || 0), p.length);
      return { lines: [{ v: pv.map((x, i) => (x === null || !vv[i] ? null : x / vv[i])), color: C.violet, label: `VWMA ${p.length}` }] };
    } },
  { id: "dema", name: "Double EMA", short: "DEMA", cat: "Moving averages", kind: "overlay", params: { length: 21 },
    calc: (d, p) => {
      const e1 = ema(closes(d), p.length);
      const e2 = ema(e1, p.length);
      return { lines: [{ v: e1.map((x, i) => (x === null || e2[i] === null ? null : 2 * x - e2[i])), color: C.cyan, label: `DEMA ${p.length}` }] };
    } },
  { id: "tema", name: "Triple EMA", short: "TEMA", cat: "Moving averages", kind: "overlay", params: { length: 21 },
    calc: (d, p) => {
      const e1 = ema(closes(d), p.length);
      const e2 = ema(e1, p.length);
      const e3 = ema(e2, p.length);
      return { lines: [{ v: e1.map((x, i) => (x === null || e2[i] === null || e3[i] === null ? null : 3 * x - 3 * e2[i] + e3[i])), color: C.yellow, label: `TEMA ${p.length}` }] };
    } },
  { id: "kama", name: "Kaufman adaptive moving average", short: "KAMA", cat: "Moving averages", kind: "overlay", params: { length: 10 },
    calc: (d, p) => {
      const c = closes(d);
      const out = N(c.length);
      const fast = 2 / 3;
      const slow = 2 / 31;
      for (let i = p.length; i < c.length; i++) {
        const change = Math.abs(c[i] - c[i - p.length]);
        let vol = 0;
        for (let j = i - p.length + 1; j <= i; j++) vol += Math.abs(c[j] - c[j - 1]);
        const er = vol ? change / vol : 0;
        const sc = (er * (fast - slow) + slow) ** 2;
        const prev = out[i - 1] === null ? c[i - 1] : out[i - 1];
        out[i] = prev + sc * (c[i] - prev);
      }
      return { lines: [{ v: out, color: C.green, label: `KAMA ${p.length}` }] };
    } },
  { id: "mcginley", name: "McGinley dynamic", short: "McGinley", cat: "Moving averages", kind: "overlay", params: { length: 14 },
    calc: (d, p) => {
      const c = closes(d);
      const out = N(c.length);
      let m = null;
      for (let i = 0; i < c.length; i++) {
        m = m === null ? c[i] : m + (c[i] - m) / (p.length * (c[i] / m) ** 4);
        if (i >= p.length) out[i] = m;
      }
      return { lines: [{ v: out, color: C.pink, label: `McGinley ${p.length}` }] };
    } },
  { id: "lsma", name: "Least squares moving average", short: "LSMA", cat: "Moving averages", kind: "overlay", params: { length: 25 },
    calc: (d, p) => {
      const c = closes(d);
      const n = p.length;
      const out = N(c.length);
      for (let i = n - 1; i < c.length; i++) {
        let sx = 0, sy = 0, sxy = 0, sxx = 0;
        for (let j = 0; j < n; j++) {
          const y = c[i - n + 1 + j];
          sx += j; sy += y; sxy += j * y; sxx += j * j;
        }
        const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
        const icpt = (sy - slope * sx) / n;
        out[i] = icpt + slope * (n - 1);
      }
      return { lines: [{ v: out, color: C.white, label: `LSMA ${n}` }] };
    } },
  { id: "ribbon", name: "Moving average ribbon", short: "MA ribbon", cat: "Moving averages", kind: "overlay", params: {},
    calc: (d) => ({ lines: [8, 13, 21, 34, 55].map((n, k) => ({ v: ema(closes(d), n), color: ["#7ef2c5", "#4fd6b0", "#2fb59a", "#1f8f7c", "#16695c"][k], label: `EMA ${n}`, width: 1 })) }) },
  // bands & channels
  { id: "bb", name: "Bollinger Bands", short: "BB", cat: "Bands & channels", kind: "overlay", params: { length: 20, mult: 2 },
    calc: (d, p) => {
      const c = closes(d);
      const m = sma(c, p.length);
      const s = stdev(c, p.length);
      const up = m.map((x, i) => (x === null ? null : x + p.mult * s[i]));
      const lo = m.map((x, i) => (x === null ? null : x - p.mult * s[i]));
      return { lines: [{ v: up, color: C.blue, label: "Upper" }, { v: m, color: C.orange, label: "Basis", dash: [4, 4] }, { v: lo, color: C.blue, label: "Lower" }],
        bands: [{ up, lo, fill: "rgba(78,164,255,0.07)" }] };
    } },
  { id: "keltner", name: "Keltner channels", short: "KC", cat: "Bands & channels", kind: "overlay", params: { length: 20, mult: 2 },
    calc: (d, p) => {
      const m = ema(closes(d), p.length);
      const a = atr(d, 10);
      const up = m.map((x, i) => (x === null || a[i] === null ? null : x + p.mult * a[i]));
      const lo = m.map((x, i) => (x === null || a[i] === null ? null : x - p.mult * a[i]));
      return { lines: [{ v: up, color: C.teal, label: "Upper" }, { v: m, color: C.teal, label: "Basis", dash: [4, 4] }, { v: lo, color: C.teal, label: "Lower" }],
        bands: [{ up, lo, fill: "rgba(45,212,191,0.06)" }] };
    } },
  { id: "donchian", name: "Donchian channels", short: "DC", cat: "Bands & channels", kind: "overlay", params: { length: 20 },
    calc: (d, p) => {
      const H = d.map((k) => k.h);
      const L = d.map((k) => k.l);
      const up = d.map((_, i) => (i < p.length - 1 ? null : highest(H, p.length, i)));
      const lo = d.map((_, i) => (i < p.length - 1 ? null : lowest(L, p.length, i)));
      return { lines: [{ v: up, color: C.cyan, label: "Upper" }, { v: up.map((x, i) => (x === null ? null : (x + lo[i]) / 2)), color: C.orange, label: "Basis" }, { v: lo, color: C.cyan, label: "Lower" }],
        bands: [{ up, lo, fill: "rgba(77,216,255,0.05)" }] };
    } },
  { id: "envelopes", name: "Envelopes", short: "Env", cat: "Bands & channels", kind: "overlay", params: { length: 20, pct: 2 },
    calc: (d, p) => {
      const m = sma(closes(d), p.length);
      return { lines: [{ v: m.map((x) => (x === null ? null : x * (1 + p.pct / 100))), color: C.violet, label: "Upper" }, { v: m, color: C.orange, label: "Basis", dash: [4, 4] },
        { v: m.map((x) => (x === null ? null : x * (1 - p.pct / 100))), color: C.violet, label: "Lower" }] };
    } },
  { id: "ichimoku", name: "Ichimoku cloud", short: "Ichimoku", cat: "Bands & channels", kind: "overlay", params: { conv: 9, base: 26, span: 52 },
    calc: (d, p) => {
      const H = d.map((k) => k.h);
      const L = d.map((k) => k.l);
      const mid = (n, i) => (i < n - 1 ? null : (highest(H, n, i) + lowest(L, n, i)) / 2);
      const tenkan = d.map((_, i) => mid(p.conv, i));
      const kijun = d.map((_, i) => mid(p.base, i));
      const a = d.map((_, i) => (tenkan[i] === null || kijun[i] === null ? null : (tenkan[i] + kijun[i]) / 2));
      const b = d.map((_, i) => mid(p.span, i));
      const shift = (v, s) => [...N(s), ...v].slice(0, v.length);       // drawn 26 candles ahead on the past candles
      const sa = shift(a, p.base);
      const sb = shift(b, p.base);
      const lag = [...d.map((k) => k.c).slice(p.base), ...N(p.base)];
      return { lines: [{ v: tenkan, color: "#4ea4ff", label: "Conversion" }, { v: kijun, color: "#ff5a6e", label: "Base" }, { v: lag, color: "#9ccf5a", label: "Lagging", width: 1 },
        { v: sa, color: "rgba(34,201,147,0.8)", label: "Span A", width: 1 }, { v: sb, color: "rgba(255,90,110,0.8)", label: "Span B", width: 1 }],
      bands: [{ up: sa, lo: sb, fill: "rgba(34,201,147,0.08)", fill2: "rgba(255,90,110,0.08)" }] };
    } },
  { id: "linreg", name: "Linear regression channel", short: "LinReg", cat: "Bands & channels", kind: "overlay", params: { length: 100, mult: 2 },
    calc: (d, p) => {
      const n = Math.min(p.length, d.length);
      const c = closes(d);
      const out = { mid: N(c.length), up: N(c.length), lo: N(c.length) };
      if (n < 5) return { lines: [] };
      const s0 = c.length - n;
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let j = 0; j < n; j++) { sx += j; sy += c[s0 + j]; sxy += j * c[s0 + j]; sxx += j * j; }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
      const icpt = (sy - slope * sx) / n;
      let dev = 0;
      for (let j = 0; j < n; j++) dev += (c[s0 + j] - (icpt + slope * j)) ** 2;
      dev = Math.sqrt(dev / n);
      for (let j = 0; j < n; j++) {
        const m = icpt + slope * j;
        out.mid[s0 + j] = m;
        out.up[s0 + j] = m + p.mult * dev;
        out.lo[s0 + j] = m - p.mult * dev;
      }
      return { lines: [{ v: out.up, color: C.blue, label: "Upper" }, { v: out.mid, color: C.orange, label: "Regression" }, { v: out.lo, color: C.blue, label: "Lower" }],
        bands: [{ up: out.up, lo: out.lo, fill: "rgba(78,164,255,0.06)" }] };
    } },
  // trend
  { id: "supertrend", name: "Supertrend", short: "Supertrend", cat: "Trend", kind: "overlay", params: { length: 10, mult: 3 },
    calc: (d, p) => {
      const a = atr(d, p.length);
      const upL = N(d.length);
      const dnL = N(d.length);
      let fu = null, fd = null, dir = 1;
      const markers = [];
      for (let i = 0; i < d.length; i++) {
        if (a[i] === null) continue;
        const mid = (d[i].h + d[i].l) / 2;
        const ub = mid - p.mult * a[i];
        const db = mid + p.mult * a[i];
        const pc = i ? d[i - 1].c : d[i].c;
        fu = fu === null || pc < fu ? ub : Math.max(ub, fu);
        fd = fd === null || pc > fd ? db : Math.min(db, fd);
        const prev = dir;
        if (dir === 1 && d[i].c < fu) dir = -1;
        else if (dir === -1 && d[i].c > fd) dir = 1;
        if (dir === 1) upL[i] = fu; else dnL[i] = fd;
        if (prev !== dir) markers.push({ i, p: dir === 1 ? d[i].l : d[i].h, symbol: dir === 1 ? "triangle-up" : "triangle-down", color: dir === 1 ? C.green : C.red, text: dir === 1 ? "Buy" : "Sell" });
      }
      return { lines: [{ v: upL, color: C.green, label: "Up", width: 1.6 }, { v: dnL, color: C.red, label: "Down", width: 1.6 }], markers };
    } },
  { id: "psar", name: "Parabolic SAR", short: "SAR", cat: "Trend", kind: "overlay", params: { step: 0.02, max: 0.2 },
    calc: (d, p) => {
      const out = N(d.length);
      if (d.length < 3) return { lines: [] };
      let dir = d[1].c >= d[0].c ? 1 : -1;
      let ep = dir === 1 ? d[0].h : d[0].l;
      let s = dir === 1 ? d[0].l : d[0].h;
      let af = p.step;
      for (let i = 1; i < d.length; i++) {
        s += af * (ep - s);
        if (dir === 1) {
          s = Math.min(s, d[i - 1].l, i >= 2 ? d[i - 2].l : d[i - 1].l);
          if (d[i].l < s) { dir = -1; s = ep; ep = d[i].l; af = p.step; } else if (d[i].h > ep) { ep = d[i].h; af = Math.min(p.max, af + p.step); }
        } else {
          s = Math.max(s, d[i - 1].h, i >= 2 ? d[i - 2].h : d[i - 1].h);
          if (d[i].h > s) { dir = 1; s = ep; ep = d[i].h; af = p.step; } else if (d[i].l < ep) { ep = d[i].l; af = Math.min(p.max, af + p.step); }
        }
        out[i] = s;
      }
      return { lines: [{ v: out, color: C.orange, label: "SAR", style: "dots" }] };
    } },
  { id: "alligator", name: "Williams alligator", short: "Alligator", cat: "Trend", kind: "overlay", params: {},
    calc: (d) => {
      const m = hl2(d);
      const shift = (v, s) => [...N(s), ...v].slice(0, v.length);
      return { lines: [{ v: shift(rma(m, 13), 8), color: "#4ea4ff", label: "Jaw" }, { v: shift(rma(m, 8), 5), color: "#ff5a6e", label: "Teeth" }, { v: shift(rma(m, 5), 3), color: "#22c993", label: "Lips" }] };
    } },
  { id: "chandelier", name: "Chandelier exit", short: "Chandelier", cat: "Trend", kind: "overlay", params: { length: 22, mult: 3 },
    calc: (d, p) => {
      const a = atr(d, p.length);
      const H = d.map((k) => k.h);
      const L = d.map((k) => k.l);
      return { lines: [{ v: d.map((_, i) => (a[i] === null ? null : highest(H, p.length, i) - p.mult * a[i])), color: C.green, label: "Long stop", dash: [3, 3] },
        { v: d.map((_, i) => (a[i] === null ? null : lowest(L, p.length, i) + p.mult * a[i])), color: C.red, label: "Short stop", dash: [3, 3] }] };
    } },
  { id: "zigzag", name: "Zig zag", short: "ZigZag", cat: "Trend", kind: "overlay", params: { pct: 5 },
    calc: (d, p) => {
      const out = N(d.length);
      if (!d.length) return { lines: [] };
      let dir = 0, piv = 0, pivP = d[0].c;
      out[0] = d[0].c;
      for (let i = 1; i < d.length; i++) {
        const up = (d[i].h - pivP) / pivP * 100;
        const dn = (pivP - d[i].l) / pivP * 100;
        if (dir >= 0 && d[i].h > pivP && dir === 1) { piv = i; pivP = d[i].h; }
        else if (dir <= 0 && d[i].l < pivP && dir === -1) { piv = i; pivP = d[i].l; }
        else if (dir !== -1 && dn >= p.pct && (dir === 1 || dir === 0)) { out[piv] = pivP; dir = -1; piv = i; pivP = d[i].l; }
        else if (dir !== 1 && up >= p.pct && (dir === -1 || dir === 0)) { out[piv] = pivP; dir = 1; piv = i; pivP = d[i].h; }
      }
      out[piv] = pivP;
      return { lines: [{ v: out, color: C.white, label: "ZigZag", style: "connect" }] };
    } },
  { id: "fractals", name: "Williams fractals", short: "Fractals", cat: "Trend", kind: "overlay", params: {},
    calc: (d) => {
      const markers = [];
      for (let i = 2; i < d.length - 2; i++) {
        if (d[i].h > d[i - 1].h && d[i].h > d[i - 2].h && d[i].h > d[i + 1].h && d[i].h > d[i + 2].h) markers.push({ i, p: d[i].h, symbol: "triangle-down", color: C.red, above: true });
        if (d[i].l < d[i - 1].l && d[i].l < d[i - 2].l && d[i].l < d[i + 1].l && d[i].l < d[i + 2].l) markers.push({ i, p: d[i].l, symbol: "triangle-up", color: C.green });
      }
      return { lines: [], markers };
    } },
  { id: "pivots", name: "Pivot points (daily)", short: "Pivots", cat: "Support & resistance", kind: "overlay", params: {},
    calc: (d) => {
      const n = d.length;
      const keys = ["PP", "R1", "S1", "R2", "S2", "R3", "S3"];
      const out = Object.fromEntries(keys.map((k) => [k, N(n)]));
      let day = null, prev = null, cur = null;
      for (let i = 0; i < n; i++) {
        const dd = Math.floor(d[i].t / 86400);
        if (dd !== day) { prev = cur; cur = { h: d[i].h, l: d[i].l, c: d[i].c }; day = dd; } else { cur.h = Math.max(cur.h, d[i].h); cur.l = Math.min(cur.l, d[i].l); cur.c = d[i].c; }
        if (prev) {
          const pp = (prev.h + prev.l + prev.c) / 3;
          const r = prev.h - prev.l;
          const v = { PP: pp, R1: 2 * pp - prev.l, S1: 2 * pp - prev.h, R2: pp + r, S2: pp - r, R3: prev.h + 2 * (pp - prev.l), S3: prev.l - 2 * (prev.h - pp) };
          for (const k of keys) out[k][i] = v[k];
        }
      }
      return { lines: keys.map((k) => ({ v: out[k], color: k === "PP" ? C.yellow : k[0] === "R" ? C.red : C.green, label: k, width: 1, style: "step", dash: [5, 3] })) };
    } },
  { id: "vwap", name: "VWAP (session)", short: "VWAP", cat: "Volume", kind: "overlay", params: {},
    calc: (d) => {
      const out = N(d.length);
      let day = null, pv = 0, vol = 0;
      for (let i = 0; i < d.length; i++) {
        const dd = Math.floor(d[i].t / 86400);
        if (dd !== day) { day = dd; pv = 0; vol = 0; }
        const tp = (d[i].h + d[i].l + d[i].c) / 3;
        pv += tp * (d[i].v || 0);
        vol += d[i].v || 0;
        out[i] = vol > 0 ? pv / vol : null;
      }
      return { lines: [{ v: out, color: "#ff8a1f", label: "VWAP", width: 1.5 }] };
    } },
  // momentum (panes)
  { id: "rsi", name: "Relative strength index", short: "RSI", cat: "Momentum", kind: "pane", params: { length: 14 }, range: [0, 100], levels: [30, 50, 70],
    calc: (d, p) => ({ lines: [{ v: rsiArr(closes(d), p.length), color: C.violet, label: `RSI ${p.length}` }] }) },
  { id: "stoch", name: "Stochastic", short: "Stoch", cat: "Momentum", kind: "pane", params: { k: 14, smooth: 3, d: 3 }, range: [0, 100], levels: [20, 80],
    calc: (dd, p) => {
      const k = stochArr(dd, p.k, p.smooth);
      return { lines: [{ v: k, color: C.blue, label: "%K" }, { v: sma(k, p.d), color: C.orange, label: "%D" }] };
    } },
  { id: "stochrsi", name: "Stochastic RSI", short: "Stoch RSI", cat: "Momentum", kind: "pane", params: { length: 14 }, range: [0, 100], levels: [20, 80],
    calc: (d, p) => {
      const r = rsiArr(closes(d), p.length);
      const raw = r.map((x, i) => {
        if (x === null || i < p.length * 2) return null;
        const w = r.slice(i - p.length + 1, i + 1).filter((v) => v !== null);
        const hi = Math.max(...w), lo = Math.min(...w);
        return hi > lo ? ((x - lo) / (hi - lo)) * 100 : 50;
      });
      const k = sma(raw, 3);
      return { lines: [{ v: k, color: C.blue, label: "K" }, { v: sma(k, 3), color: C.orange, label: "D" }] };
    } },
  { id: "macd", name: "MACD", short: "MACD", cat: "Momentum", kind: "pane", params: { fast: 12, slow: 26, signal: 9 }, levels: [0],
    calc: (d, p) => {
      const c = closes(d);
      const m = sub(ema(c, p.fast), ema(c, p.slow));
      const s = ema(m, p.signal);
      const h = sub(m, s);
      return { hist: { v: h, up: C.green, down: C.red }, lines: [{ v: m, color: C.blue, label: "MACD" }, { v: s, color: C.orange, label: "Signal" }] };
    } },
  { id: "cci", name: "Commodity channel index", short: "CCI", cat: "Momentum", kind: "pane", params: { length: 20 }, levels: [-100, 0, 100],
    calc: (d, p) => {
      const tp = hlc3(d);
      const m = sma(tp, p.length);
      const out = tp.map((x, i) => {
        if (m[i] === null) return null;
        let md = 0;
        for (let j = i - p.length + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
        md /= p.length;
        return md ? (x - m[i]) / (0.015 * md) : 0;
      });
      return { lines: [{ v: out, color: C.teal, label: `CCI ${p.length}` }] };
    } },
  { id: "willr", name: "Williams %R", short: "%R", cat: "Momentum", kind: "pane", params: { length: 14 }, range: [-100, 0], levels: [-80, -20],
    calc: (d, p) => {
      const H = d.map((k) => k.h);
      const L = d.map((k) => k.l);
      return { lines: [{ v: d.map((k, i) => { if (i < p.length - 1) return null; const hh = highest(H, p.length, i); const ll = lowest(L, p.length, i); return hh > ll ? ((hh - k.c) / (hh - ll)) * -100 : -50; }), color: C.pink, label: "%R" }] };
    } },
  { id: "mom", name: "Momentum", short: "Mom", cat: "Momentum", kind: "pane", params: { length: 10 }, levels: [0],
    calc: (d, p) => ({ lines: [{ v: d.map((k, i) => (i < p.length ? null : k.c - d[i - p.length].c)), color: C.cyan, label: `Mom ${p.length}` }] }) },
  { id: "roc", name: "Rate of change", short: "ROC", cat: "Momentum", kind: "pane", params: { length: 9 }, levels: [0],
    calc: (d, p) => ({ lines: [{ v: d.map((k, i) => (i < p.length ? null : ((k.c / d[i - p.length].c) - 1) * 100)), color: C.blue, label: `ROC ${p.length}` }] }) },
  { id: "ao", name: "Awesome oscillator", short: "AO", cat: "Momentum", kind: "pane", params: {}, levels: [0],
    calc: (d) => {
      const m = hl2(d);
      return { hist: { v: sub(sma(m, 5), sma(m, 34)), up: C.green, down: C.red, rising: true }, lines: [] };
    } },
  { id: "uo", name: "Ultimate oscillator", short: "UO", cat: "Momentum", kind: "pane", params: {}, range: [0, 100], levels: [30, 70],
    calc: (d) => {
      const bp = d.map((k, i) => k.c - Math.min(k.l, i ? d[i - 1].c : k.l));
      const tr = trueRange(d);
      const avg = (n) => d.map((_, i) => { if (i < n) return null; let a = 0, b = 0; for (let j = i - n + 1; j <= i; j++) { a += bp[j]; b += tr[j]; } return b ? a / b : 0; });
      const a7 = avg(7), a14 = avg(14), a28 = avg(28);
      return { lines: [{ v: d.map((_, i) => (a28[i] === null ? null : (100 * (4 * a7[i] + 2 * a14[i] + a28[i])) / 7)), color: C.orange, label: "UO" }] };
    } },
  { id: "tsi", name: "True strength index", short: "TSI", cat: "Momentum", kind: "pane", params: { long: 25, short: 13 }, levels: [0],
    calc: (d, p) => {
      const ch = d.map((k, i) => (i ? k.c - d[i - 1].c : 0));
      const num = ema(ema(ch, p.long), p.short);
      const den = ema(ema(ch.map(Math.abs), p.long), p.short);
      const t = num.map((x, i) => (x === null || !den[i] ? null : (100 * x) / den[i]));
      return { lines: [{ v: t, color: C.blue, label: "TSI" }, { v: ema(t, 7), color: C.red, label: "Signal" }] };
    } },
  { id: "cmo", name: "Chande momentum oscillator", short: "CMO", cat: "Momentum", kind: "pane", params: { length: 9 }, range: [-100, 100], levels: [-50, 0, 50],
    calc: (d, p) => ({ lines: [{ v: d.map((_, i) => { if (i < p.length) return null; let u = 0, w = 0; for (let j = i - p.length + 1; j <= i; j++) { const x = d[j].c - d[j - 1].c; if (x > 0) u += x; else w -= x; } return u + w ? (100 * (u - w)) / (u + w) : 0; }), color: C.violet, label: "CMO" }] }) },
  { id: "bop", name: "Balance of power", short: "BOP", cat: "Momentum", kind: "pane", params: {}, levels: [0],
    calc: (d) => ({ hist: { v: sma(d.map((k) => (k.h > k.l ? (k.c - k.o) / (k.h - k.l) : 0)), 14), up: C.green, down: C.red }, lines: [] }) },
  { id: "coppock", name: "Coppock curve", short: "Coppock", cat: "Momentum", kind: "pane", params: {}, levels: [0],
    calc: (d) => {
      const r = (n) => d.map((k, i) => (i < n ? null : ((k.c / d[i - n].c) - 1) * 100));
      const r11 = r(11);
      const s = r(14).map((x, i) => (x === null || r11[i] === null ? null : x + r11[i]));
      return { lines: [{ v: wma(s, 10), color: C.teal, label: "Coppock" }] };
    } },
  // trend strength (panes)
  { id: "adx", name: "ADX / DMI", short: "ADX", cat: "Trend", kind: "pane", params: { length: 14 }, levels: [20, 25],
    calc: (d, p) => {
      const up = d.map((k, i) => (i ? k.h - d[i - 1].h : 0));
      const dn = d.map((k, i) => (i ? d[i - 1].l - k.l : 0));
      const plus = up.map((u, i) => (u > dn[i] && u > 0 ? u : 0));
      const minus = dn.map((w, i) => (w > up[i] && w > 0 ? w : 0));
      const a = rma(trueRange(d), p.length);
      const pdi = rma(plus, p.length).map((x, i) => (x === null || !a[i] ? null : (100 * x) / a[i]));
      const mdi = rma(minus, p.length).map((x, i) => (x === null || !a[i] ? null : (100 * x) / a[i]));
      const dx = pdi.map((x, i) => (x === null || mdi[i] === null || x + mdi[i] === 0 ? null : (100 * Math.abs(x - mdi[i])) / (x + mdi[i])));
      return { lines: [{ v: rma(dx, p.length), color: C.yellow, label: "ADX", width: 1.6 }, { v: pdi, color: C.green, label: "+DI", width: 1 }, { v: mdi, color: C.red, label: "-DI", width: 1 }] };
    } },
  { id: "aroon", name: "Aroon", short: "Aroon", cat: "Trend", kind: "pane", params: { length: 14 }, range: [0, 100],
    calc: (d, p) => {
      const n = p.length;
      const up = d.map((_, i) => { if (i < n) return null; let b = i; for (let j = i - n; j <= i; j++) if (d[j].h >= d[b].h) b = j; return (100 * (n - (i - b))) / n; });
      const dn = d.map((_, i) => { if (i < n) return null; let b = i; for (let j = i - n; j <= i; j++) if (d[j].l <= d[b].l) b = j; return (100 * (n - (i - b))) / n; });
      return { lines: [{ v: up, color: C.green, label: "Up" }, { v: dn, color: C.red, label: "Down" }] };
    } },
  { id: "vortex", name: "Vortex indicator", short: "VI", cat: "Trend", kind: "pane", params: { length: 14 },
    calc: (d, p) => {
      const n = p.length;
      const tr = trueRange(d);
      const vp = d.map((k, i) => (i ? Math.abs(k.h - d[i - 1].l) : 0));
      const vm = d.map((k, i) => (i ? Math.abs(k.l - d[i - 1].h) : 0));
      const s = (v) => d.map((_, i) => { if (i < n) return null; let a = 0; for (let j = i - n + 1; j <= i; j++) a += v[j]; return a; });
      const st = s(tr), sp = s(vp), sm = s(vm);
      return { lines: [{ v: sp.map((x, i) => (x === null || !st[i] ? null : x / st[i])), color: C.green, label: "VI+" }, { v: sm.map((x, i) => (x === null || !st[i] ? null : x / st[i])), color: C.red, label: "VI-" }] };
    } },
  { id: "trix", name: "TRIX", short: "TRIX", cat: "Trend", kind: "pane", params: { length: 18 }, levels: [0],
    calc: (d, p) => {
      const e = ema(ema(ema(closes(d), p.length), p.length), p.length);
      return { lines: [{ v: e.map((x, i) => (x === null || i === 0 || e[i - 1] === null ? null : 10000 * (x / e[i - 1] - 1))), color: C.pink, label: "TRIX" }] };
    } },
  { id: "dpo", name: "Detrended price oscillator", short: "DPO", cat: "Trend", kind: "pane", params: { length: 21 }, levels: [0],
    calc: (d, p) => {
      const m = sma(closes(d), p.length);
      const k = Math.floor(p.length / 2) + 1;
      return { lines: [{ v: d.map((x, i) => (i < k || m[i - k] === null ? null : x.c - m[i - k])), color: C.cyan, label: "DPO" }] };
    } },
  // volume (panes)
  { id: "obv", name: "On balance volume", short: "OBV", cat: "Volume", kind: "pane", params: {},
    calc: (d) => {
      let o = 0;
      return { lines: [{ v: d.map((k, i) => { if (i) o += k.c > d[i - 1].c ? (k.v || 0) : k.c < d[i - 1].c ? -(k.v || 0) : 0; return o; }), color: C.blue, label: "OBV" }] };
    } },
  { id: "cmf", name: "Chaikin money flow", short: "CMF", cat: "Volume", kind: "pane", params: { length: 20 }, levels: [0],
    calc: (d, p) => {
      const mfv = d.map((k) => (k.h > k.l ? (((k.c - k.l) - (k.h - k.c)) / (k.h - k.l)) * (k.v || 0) : 0));
      const a = sma(mfv, p.length);
      const b = sma(d.map((k) => k.v || 0), p.length);
      return { hist: { v: a.map((x, i) => (x === null || !b[i] ? null : x / b[i])), up: C.green, down: C.red }, lines: [] };
    } },
  { id: "mfi", name: "Money flow index", short: "MFI", cat: "Volume", kind: "pane", params: { length: 14 }, range: [0, 100], levels: [20, 80],
    calc: (d, p) => {
      const tp = hlc3(d);
      return { lines: [{ v: d.map((_, i) => { if (i < p.length) return null; let pos = 0, neg = 0; for (let j = i - p.length + 1; j <= i; j++) { const f = tp[j] * (d[j].v || 0); if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; } return neg ? 100 - 100 / (1 + pos / neg) : 100; }), color: C.green, label: "MFI" }] };
    } },
  { id: "ad", name: "Accumulation / distribution", short: "A/D", cat: "Volume", kind: "pane", params: {},
    calc: (d) => {
      let a = 0;
      return { lines: [{ v: d.map((k) => { a += k.h > k.l ? (((k.c - k.l) - (k.h - k.c)) / (k.h - k.l)) * (k.v || 0) : 0; return a; }), color: C.teal, label: "A/D" }] };
    } },
  { id: "chaikin", name: "Chaikin oscillator", short: "Chaikin", cat: "Volume", kind: "pane", params: {}, levels: [0],
    calc: (d) => {
      let a = 0;
      const ad = d.map((k) => { a += k.h > k.l ? (((k.c - k.l) - (k.h - k.c)) / (k.h - k.l)) * (k.v || 0) : 0; return a; });
      return { lines: [{ v: sub(ema(ad, 3), ema(ad, 10)), color: C.orange, label: "Chaikin" }] };
    } },
  { id: "efi", name: "Elder force index", short: "EFI", cat: "Volume", kind: "pane", params: { length: 13 }, levels: [0],
    calc: (d, p) => ({ lines: [{ v: ema(d.map((k, i) => (i ? (k.c - d[i - 1].c) * (k.v || 0) : 0)), p.length), color: C.pink, label: "EFI" }] }) },
  { id: "pvt", name: "Price volume trend", short: "PVT", cat: "Volume", kind: "pane", params: {},
    calc: (d) => {
      let a = 0;
      return { lines: [{ v: d.map((k, i) => { if (i && d[i - 1].c) a += ((k.c - d[i - 1].c) / d[i - 1].c) * (k.v || 0); return a; }), color: C.cyan, label: "PVT" }] };
    } },
  { id: "rvol", name: "Relative volume", short: "RVOL", cat: "Volume", kind: "pane", params: { length: 20 }, levels: [1],
    calc: (d, p) => {
      const m = sma(d.map((k) => k.v || 0), p.length);
      return { hist: { v: d.map((k, i) => (!m[i] ? null : (k.v || 0) / m[i])), up: C.blue, down: "rgba(78,164,255,0.45)", above: 1 }, lines: [] };
    } },
  { id: "volosc", name: "Volume oscillator", short: "Vol osc", cat: "Volume", kind: "pane", params: {}, levels: [0],
    calc: (d) => {
      const v = d.map((k) => k.v || 0);
      const a = ema(v, 5), b = ema(v, 10);
      return { lines: [{ v: a.map((x, i) => (x === null || !b[i] ? null : (100 * (x - b[i])) / b[i])), color: C.violet, label: "Vol osc" }] };
    } },
  // volatility (panes)
  { id: "atr", name: "Average true range", short: "ATR", cat: "Volatility", kind: "pane", params: { length: 14 },
    calc: (d, p) => ({ lines: [{ v: atr(d, p.length), color: C.red, label: `ATR ${p.length}` }] }) },
  { id: "hv", name: "Historical volatility", short: "HV", cat: "Volatility", kind: "pane", params: { length: 20 },
    calc: (d, p) => {
      const r = d.map((k, i) => (i ? Math.log(k.c / d[i - 1].c) : null));
      const s = stdev(r.map((x) => (x === null ? 0 : x)), p.length);
      return { lines: [{ v: s.map((x) => (x === null ? null : x * 100 * Math.sqrt(365))), color: C.orange, label: "HV %" }] };
    } },
  { id: "bbw", name: "Bollinger bandwidth", short: "BBW", cat: "Volatility", kind: "pane", params: { length: 20 },
    calc: (d, p) => {
      const c = closes(d);
      const m = sma(c, p.length);
      const s = stdev(c, p.length);
      return { lines: [{ v: m.map((x, i) => (x === null || !x ? null : (4 * s[i]) / x * 100)), color: C.blue, label: "BBW %" }] };
    } },
  { id: "bbpct", name: "Bollinger %B", short: "%B", cat: "Volatility", kind: "pane", params: { length: 20 }, levels: [0, 1],
    calc: (d, p) => {
      const c = closes(d);
      const m = sma(c, p.length);
      const s = stdev(c, p.length);
      return { lines: [{ v: c.map((x, i) => (m[i] === null || !s[i] ? null : (x - (m[i] - 2 * s[i])) / (4 * s[i]))), color: C.teal, label: "%B" }] };
    } },
  { id: "chop", name: "Choppiness index", short: "CHOP", cat: "Volatility", kind: "pane", params: { length: 14 }, range: [0, 100], levels: [38.2, 61.8],
    calc: (d, p) => {
      const tr = trueRange(d);
      const H = d.map((k) => k.h);
      const L = d.map((k) => k.l);
      return { lines: [{ v: d.map((_, i) => { if (i < p.length) return null; let s = 0; for (let j = i - p.length + 1; j <= i; j++) s += tr[j]; const r = highest(H, p.length, i) - lowest(L, p.length, i); return r > 0 ? (100 * Math.log10(s / r)) / Math.log10(p.length) : null; }), color: C.yellow, label: "CHOP" }] };
    } },
  { id: "stdev", name: "Standard deviation", short: "StDev", cat: "Volatility", kind: "pane", params: { length: 20 },
    calc: (d, p) => ({ lines: [{ v: stdev(closes(d), p.length), color: C.pink, label: "StDev" }] }) },
];

// ── candlestick patterns: one detector, each pattern can be shown on its own ──
const body = (k) => Math.abs(k.c - k.o);
const rng = (k) => Math.max(k.h - k.l, 1e-12);
const green = (k) => k.c > k.o;
const red = (k) => k.c < k.o;
export const PATTERNS = [
  { id: "engulf_bull", name: "Engulfing (bullish)", bias: 1, test: (d, i) => i > 0 && red(d[i - 1]) && green(d[i]) && d[i].c >= d[i - 1].o && d[i].o <= d[i - 1].c },
  { id: "engulf_bear", name: "Engulfing (bearish)", bias: -1, test: (d, i) => i > 0 && green(d[i - 1]) && red(d[i]) && d[i].c <= d[i - 1].o && d[i].o >= d[i - 1].c },
  { id: "hammer", name: "Hammer (bullish)", bias: 1, test: (d, i) => { const k = d[i]; const lw = Math.min(k.o, k.c) - k.l; return lw >= 2 * body(k) && (k.h - Math.max(k.o, k.c)) <= body(k) && i > 3 && k.c < d[i - 3].c; } },
  { id: "inv_hammer", name: "Inverted hammer (bullish)", bias: 1, test: (d, i) => { const k = d[i]; const uw = k.h - Math.max(k.o, k.c); return uw >= 2 * body(k) && (Math.min(k.o, k.c) - k.l) <= body(k) && i > 3 && k.c < d[i - 3].c; } },
  { id: "shooting_star", name: "Shooting star (bearish)", bias: -1, test: (d, i) => { const k = d[i]; const uw = k.h - Math.max(k.o, k.c); return uw >= 2 * body(k) && (Math.min(k.o, k.c) - k.l) <= body(k) && i > 3 && k.c > d[i - 3].c; } },
  { id: "hanging_man", name: "Hanging man (bearish)", bias: -1, test: (d, i) => { const k = d[i]; const lw = Math.min(k.o, k.c) - k.l; return lw >= 2 * body(k) && (k.h - Math.max(k.o, k.c)) <= body(k) && i > 3 && k.c > d[i - 3].c; } },
  { id: "doji", name: "Doji (neutral)", bias: 0, test: (d, i) => body(d[i]) <= 0.08 * rng(d[i]) },
  { id: "dragonfly", name: "Dragonfly doji (bullish)", bias: 1, test: (d, i) => { const k = d[i]; return body(k) <= 0.08 * rng(k) && (k.h - Math.max(k.o, k.c)) <= 0.1 * rng(k); } },
  { id: "gravestone", name: "Gravestone doji (bearish)", bias: -1, test: (d, i) => { const k = d[i]; return body(k) <= 0.08 * rng(k) && (Math.min(k.o, k.c) - k.l) <= 0.1 * rng(k); } },
  { id: "morning_star", name: "Morning star (bullish)", bias: 1, test: (d, i) => i > 1 && red(d[i - 2]) && body(d[i - 1]) < 0.4 * body(d[i - 2]) && green(d[i]) && d[i].c > (d[i - 2].o + d[i - 2].c) / 2 },
  { id: "evening_star", name: "Evening star (bearish)", bias: -1, test: (d, i) => i > 1 && green(d[i - 2]) && body(d[i - 1]) < 0.4 * body(d[i - 2]) && red(d[i]) && d[i].c < (d[i - 2].o + d[i - 2].c) / 2 },
  { id: "harami_bull", name: "Harami (bullish)", bias: 1, test: (d, i) => i > 0 && red(d[i - 1]) && green(d[i]) && d[i].c < d[i - 1].o && d[i].o > d[i - 1].c },
  { id: "harami_bear", name: "Harami (bearish)", bias: -1, test: (d, i) => i > 0 && green(d[i - 1]) && red(d[i]) && d[i].c > d[i - 1].o && d[i].o < d[i - 1].c },
  { id: "piercing", name: "Piercing (bullish)", bias: 1, test: (d, i) => i > 0 && red(d[i - 1]) && green(d[i]) && d[i].o < d[i - 1].l && d[i].c > (d[i - 1].o + d[i - 1].c) / 2 && d[i].c < d[i - 1].o },
  { id: "dark_cloud", name: "Dark cloud cover (bearish)", bias: -1, test: (d, i) => i > 0 && green(d[i - 1]) && red(d[i]) && d[i].o > d[i - 1].h && d[i].c < (d[i - 1].o + d[i - 1].c) / 2 && d[i].c > d[i - 1].o },
  { id: "three_soldiers", name: "Three white soldiers (bullish)", bias: 1, test: (d, i) => i > 1 && [0, 1, 2].every((j) => green(d[i - j]) && body(d[i - j]) > 0.6 * rng(d[i - j])) && d[i].c > d[i - 1].c && d[i - 1].c > d[i - 2].c },
  { id: "three_crows", name: "Three black crows (bearish)", bias: -1, test: (d, i) => i > 1 && [0, 1, 2].every((j) => red(d[i - j]) && body(d[i - j]) > 0.6 * rng(d[i - j])) && d[i].c < d[i - 1].c && d[i - 1].c < d[i - 2].c },
  { id: "tweezer_bottom", name: "Tweezer bottom (bullish)", bias: 1, test: (d, i) => i > 0 && red(d[i - 1]) && green(d[i]) && Math.abs(d[i].l - d[i - 1].l) <= 0.05 * rng(d[i]) },
  { id: "tweezer_top", name: "Tweezer top (bearish)", bias: -1, test: (d, i) => i > 0 && green(d[i - 1]) && red(d[i]) && Math.abs(d[i].h - d[i - 1].h) <= 0.05 * rng(d[i]) },
  { id: "marubozu_bull", name: "Marubozu (bullish)", bias: 1, test: (d, i) => green(d[i]) && body(d[i]) >= 0.95 * rng(d[i]) },
  { id: "marubozu_bear", name: "Marubozu (bearish)", bias: -1, test: (d, i) => red(d[i]) && body(d[i]) >= 0.95 * rng(d[i]) },
  { id: "spinning_top", name: "Spinning top (neutral)", bias: 0, test: (d, i) => { const k = d[i]; return body(k) <= 0.3 * rng(k) && body(k) > 0.08 * rng(k) && (k.h - Math.max(k.o, k.c)) > body(k) && (Math.min(k.o, k.c) - k.l) > body(k); } },
  { id: "inside_bar", name: "Inside bar (neutral)", bias: 0, test: (d, i) => i > 0 && d[i].h < d[i - 1].h && d[i].l > d[i - 1].l },
  { id: "rising_window", name: "Rising window (bullish)", bias: 1, test: (d, i) => i > 0 && d[i].l > d[i - 1].h },
  { id: "falling_window", name: "Falling window (bearish)", bias: -1, test: (d, i) => i > 0 && d[i].h < d[i - 1].l },
];
export const PATTERN_BY_ID = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));

for (const p of PATTERNS) {
  STUDIES.push({ id: `pat_${p.id}`, name: p.name, short: p.name.replace(/ \(.+\)/, ""), cat: "Candlestick patterns", kind: "overlay", params: {},
    calc: (d) => {
      const markers = [];
      for (let i = 0; i < d.length; i++) {
        if (!p.test(d, i)) continue;
        const up = p.bias >= 0;
        markers.push({ i, p: up ? d[i].l : d[i].h, symbol: p.bias > 0 ? "triangle-up" : p.bias < 0 ? "triangle-down" : "circle",
          color: p.bias > 0 ? C.green : p.bias < 0 ? C.red : C.grey, text: p.name.replace(/ \(.+\)/, ""), above: p.bias < 0 });
      }
      return { lines: [], markers };
    } });
}

export const STUDY_BY_ID = Object.fromEntries(STUDIES.map((s) => [s.id, s]));
export const STUDY_CATS = [...new Set(STUDIES.map((s) => s.cat))];

/** Compute one study instance {key, id, params} on candles d. */
export function runStudy(inst, d) {
  const s = STUDY_BY_ID[inst.id];
  if (!s || !d || !d.length) return null;
  try {
    const out = s.calc(d, { ...s.params, ...(inst.params || {}) });
    return { ...out, kind: s.kind, range: s.range, levels: s.levels, name: s.short || s.name, id: s.id, key: inst.key };
  } catch {
    return null;
  }
}

let seq = 0;
export function newStudy(id, params) {
  seq += 1;
  return { key: `${id}-${Date.now().toString(36)}${seq}`, id, params: { ...(STUDY_BY_ID[id] ? STUDY_BY_ID[id].params : {}), ...(params || {}) } };
}

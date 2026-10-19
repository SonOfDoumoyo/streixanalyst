// Chart types, and the series some of them are built from. Renko, line break, Kagi, point & figure and range bars are
// not drawn from the candles as they are: each turns the candles into its own bricks, lines or columns, which are then
// drawn in place of the candles. Each brick keeps the time of the candle that completed it, so the time axis, the
// analysis overlay and the drawings still line up.

// id, label, and how the type is drawn. `needs` marks types that need data the app does not get from the market feeds.
export const CHART_TYPES = [
  { id: "bars", label: "Bars" },
  { id: "candles", label: "Candles" },
  { id: "hollow", label: "Hollow candles" },
  { id: "volcandles", label: "Volume candles" },
  { id: "line", label: "Line" },
  { id: "linemarkers", label: "Line with markers" },
  { id: "stepline", label: "Step line" },
  { id: "area", label: "Area" },
  { id: "hlcarea", label: "HLC area" },
  { id: "baseline", label: "Baseline" },
  { id: "columns", label: "Columns" },
  { id: "highlow", label: "High-low" },
  { id: "footprint", label: "Volume footprint", needs: "Footprint needs trade-by-trade buy and sell volume, which the market feeds this app uses do not send." },
  { id: "tpo", label: "Time Price Opportunity" },
  { id: "svp", label: "Session volume profile" },
  { id: "heikin", label: "Heikin Ashi" },
  { id: "renko", label: "Renko" },
  { id: "linebreak", label: "Line break" },
  { id: "kagi", label: "Kagi" },
  { id: "pnf", label: "Point & Figure" },
  { id: "range", label: "Range" },
];

export const DERIVED = new Set(["renko", "linebreak", "kagi", "pnf", "range"]);
export const LINE_TYPES = new Set(["line", "linemarkers", "stepline", "area", "hlcarea", "baseline"]);

/** Average true range over the last `n` candles (simple mean of the true ranges). */
export function atr(candles, n = 14) {
  if (candles.length < 2) return candles.length ? candles[0].h - candles[0].l : 0;
  const from = Math.max(1, candles.length - n);
  let s = 0;
  let k = 0;
  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    s += Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    k++;
  }
  return k ? s / k : 0;
}

/** A round box size near `v` (1, 2, 2.5 or 5 times a power of ten). */
export function niceBox(v) {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.75 ? 2.5 : f < 7.5 ? 5 : 10) * p;
}

/** The box size used by renko, Kagi, point & figure and range bars: the 14-candle ATR, rounded. */
export function boxSize(candles) {
  return niceBox(atr(candles, 14));
}

// A brick gets the time of the candle that completed it. Several bricks made by one candle get a second apart, so
// times stay in order and every brick has its own place on the time axis.
function stamper() {
  let last = -Infinity;
  return (t) => {
    const s = t > last ? t : last + 1;
    last = s;
    return s;
  };
}

const bar = (t, o, c, v, extra) => ({ t, o, c, h: Math.max(o, c), l: Math.min(o, c), v, ...extra });

/** Traditional renko on closes: a brick per `box` of movement, a reversal needs two boxes. */
export function renko(raw, box) {
  const out = [];
  if (!raw.length || !(box > 0)) return out;
  const stamp = stamper();
  let last = Math.round(raw[0].c / box) * box;
  let dir = 0;
  let vol = 0;
  for (const k of raw) {
    vol += k.v || 0;
    const p = k.c;
    const push = (o, c) => {
      out.push(bar(stamp(k.t), o, c, vol));
      vol = 0;
    };
    if (dir >= 0 && p >= last + box) {
      while (p >= last + box) { push(last, last + box); last += box; }
      dir = 1;
    } else if (dir <= 0 && p <= last - box) {
      while (p <= last - box) { push(last, last - box); last -= box; }
      dir = -1;
    } else if (dir === 1 && p <= last - 2 * box) {
      let o = last - box;
      while (p <= o - box) { push(o, o - box); o -= box; }
      last = o;
      dir = -1;
    } else if (dir === -1 && p >= last + 2 * box) {
      let o = last + box;
      while (p >= o + box) { push(o, o + box); o += box; }
      last = o;
      dir = 1;
    }
  }
  return out;
}

/** Three-line break on closes. */
export function lineBreak(raw, lines = 3) {
  const out = [];
  if (!raw.length) return out;
  const stamp = stamper();
  let vol = 0;
  for (const k of raw) {
    vol += k.v || 0;
    const p = k.c;
    if (!out.length) {
      if (p !== k.o) { out.push(bar(stamp(k.t), k.o, p, vol)); vol = 0; }
      continue;
    }
    const L = out[out.length - 1];
    const up = L.c > L.o;
    const recent = out.slice(-lines);
    const hi = Math.max(...recent.map((x) => x.h));
    const lo = Math.min(...recent.map((x) => x.l));
    let o = null;
    if (up) {
      if (p > L.c) o = L.c;
      else if (p < lo) o = L.o;
    } else if (p < L.c) o = L.c;
    else if (p > hi) o = L.o;
    if (o !== null) { out.push(bar(stamp(k.t), o, p, vol)); vol = 0; }
  }
  return out;
}

/** Kagi on closes. A line turns when price reverses by `rev`. It is thick (yang) after it rises above the last
 *  shoulder and thin (yin) after it falls below the last waist; `turn` is where it changed, if it changed mid-line. */
export function kagi(raw, rev) {
  const segs = [];
  if (!raw.length || !(rev > 0)) return segs;
  const stamp = stamper();
  let cur = { t: raw[0].t, o: raw[0].c, c: raw[0].c, v: 0 };
  let dir = 0;
  for (const k of raw) {
    cur.v += k.v || 0;
    const p = k.c;
    if (dir === 0) {
      if (Math.abs(p - cur.o) >= rev) { dir = p > cur.o ? 1 : -1; cur.c = p; }
      continue;
    }
    if (dir === 1) {
      if (p > cur.c) cur.c = p;
      else if (cur.c - p >= rev) { segs.push(cur); cur = { t: k.t, o: cur.c, c: p, v: 0 }; dir = -1; }
    } else if (p < cur.c) cur.c = p;
    else if (p - cur.c >= rev) { segs.push(cur); cur = { t: k.t, o: cur.c, c: p, v: 0 }; dir = 1; }
  }
  if (dir !== 0) segs.push(cur);
  // thickness: yang after taking out the previous shoulder, yin after losing the previous waist
  let yang = segs.length ? segs[0].c > segs[0].o : true;
  let shoulder = null;
  let waist = null;
  return segs.map((s) => {
    const up = s.c > s.o;
    const thick0 = yang;
    let turn = null;
    if (up && !yang && shoulder !== null && s.c > shoulder) { yang = true; turn = shoulder; }
    else if (!up && yang && waist !== null && s.c < waist) { yang = false; turn = waist; }
    if (up) shoulder = s.c;
    else waist = s.c;
    return { ...bar(stamp(s.t), s.o, s.c, s.v), thick0, thick1: yang, turn };
  });
}

/** Point & figure on closes: columns of X (rising) and O (falling), box `box`, reversal `rev` boxes. */
export function pointFigure(raw, box, rev = 3) {
  const cols = [];
  if (!raw.length || !(box > 0)) return cols;
  const stamp = stamper();
  const fl = (p) => Math.floor(p / box + 1e-9) * box;
  const ce = (p) => Math.ceil(p / box - 1e-9) * box;
  let col = { t: raw[0].t, dir: 0, hi: fl(raw[0].c), lo: fl(raw[0].c), v: 0 };
  for (const k of raw) {
    col.v += k.v || 0;
    const p = k.c;
    if (col.dir >= 0 && p >= col.hi + box) {
      col.hi = fl(p);
      col.dir = 1;
    } else if (col.dir <= 0 && p <= col.lo - box) {
      col.lo = ce(p);
      col.dir = -1;
    } else if (col.dir === 1 && p <= col.hi - rev * box) {
      cols.push(col);
      col = { t: k.t, dir: -1, hi: col.hi - box, lo: ce(p), v: 0 };
    } else if (col.dir === -1 && p >= col.lo + rev * box) {
      cols.push(col);
      col = { t: k.t, dir: 1, lo: col.lo + box, hi: fl(p), v: 0 };
    }
  }
  if (col.dir !== 0) cols.push(col);
  return cols.map((c) => ({ t: stamp(c.t), o: c.dir === 1 ? c.lo : c.hi, c: c.dir === 1 ? c.hi : c.lo, h: c.hi, l: c.lo,
    v: c.v, dir: c.dir, box }));
}

/** Range bars: every bar spans `range` from its low to its high. Each candle is walked open → low → high → close
 *  (or open → high → low → close on a falling candle), the usual way to replay a candle's path. */
export function rangeBars(raw, range) {
  const out = [];
  if (!raw.length || !(range > 0)) return out;
  const stamp = stamper();
  let cur = null;
  for (const k of raw) {
    const path = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
    let vol = k.v || 0;
    for (const p of path) {
      if (!cur) cur = { t: k.t, o: p, h: p, l: p, c: p, v: 0 };
      for (let guard = 0; guard < 10000; guard++) {
        if (p > cur.l + range) {
          cur.h = cur.l + range;
          cur.c = cur.h;
          cur.v += vol;
          vol = 0;
          out.push({ ...cur, t: stamp(k.t) });
          const s = cur.c;
          cur = { t: k.t, o: s, h: s, l: s, c: s, v: 0 };
        } else if (p < cur.h - range) {
          cur.l = cur.h - range;
          cur.c = cur.l;
          cur.v += vol;
          vol = 0;
          out.push({ ...cur, t: stamp(k.t) });
          const s = cur.c;
          cur = { t: k.t, o: s, h: s, l: s, c: s, v: 0 };
        } else {
          cur.h = Math.max(cur.h, p);
          cur.l = Math.min(cur.l, p);
          cur.c = p;
          break;
        }
      }
    }
    if (cur) cur.v += vol;
  }
  if (cur) out.push({ ...cur, t: stamp(cur.t), forming: true });
  return out;
}

/** The series drawn for a derived chart type, and the box size it used. */
export function derive(style, raw) {
  const box = boxSize(raw);
  if (style === "renko") return { d: renko(raw, box), box };
  if (style === "linebreak") return { d: lineBreak(raw, 3), box: null };
  if (style === "kagi") return { d: kagi(raw, box), box };
  if (style === "pnf") return { d: pointFigure(raw, box, 3), box };
  if (style === "range") return { d: rangeBars(raw, box), box };
  return { d: raw, box: null };
}

/** Session profiles for the visible candles: one per UTC day (a week on 4h charts, a month on daily ones). Each candle's
 *  volume (volume profile) or one count (TPO) is spread evenly over the price rows its range covers. Returns
 *  [{ i0, i1, rows: [{ p, v }], row, poc, vah, val }], the value area holding 70% of the total. */
export function sessionProfiles(d, i0, i1, tfSec, row, mode = "volume", span = null) {
  if (!(row > 0)) return [];
  span = span || (tfSec >= 86400 ? 30 * 86400 : tfSec >= 14400 ? 7 * 86400 : 86400);
  const out = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const rows = [...cur.bins.entries()].map(([b, v]) => ({ p: b * row, v })).sort((a, b) => a.p - b.p);
    let tot = 0;
    let poc = rows[0];
    for (const r of rows) {
      tot += r.v;
      if (r.v > poc.v) poc = r;
    }
    // value area: grow out from the point of control until it holds 70% of the total
    let lo = rows.indexOf(poc);
    let hi = lo;
    let acc = poc.v;
    while (acc < tot * 0.7 && (lo > 0 || hi < rows.length - 1)) {
      const a = lo > 0 ? rows[lo - 1].v : -1;
      const b = hi < rows.length - 1 ? rows[hi + 1].v : -1;
      if (b >= a) acc += rows[++hi].v;
      else acc += rows[--lo].v;
    }
    out.push({ i0: cur.i0, i1: cur.i1, rows, row, poc: poc.p, val: rows[lo].p, vah: rows[hi].p, letters: cur.letters });
    cur = null;
  };
  for (let i = Math.max(0, i0); i <= Math.min(d.length - 1, i1); i++) {
    const k = d[i];
    const s = Math.floor(k.t / span);
    if (!cur || cur.s !== s) {
      close();
      cur = { s, i0: i, i1: i, bins: new Map(), letters: new Map(), n: 0 };
    }
    cur.i1 = i;
    const b0 = Math.floor(k.l / row);
    const b1 = Math.floor(k.h / row);
    const nb = Math.max(1, b1 - b0 + 1);
    const w = mode === "tpo" ? 1 : (k.v || 0) / nb;
    for (let b = b0; b <= b1; b++) {
      cur.bins.set(b, (cur.bins.get(b) || 0) + w);
      if (mode === "tpo") {
        const L = cur.letters.get(b) || [];
        L.push(cur.n);
        cur.letters.set(b, L);
      }
    }
    cur.n++;
  }
  close();
  return out.filter((p) => p.rows.length);
}

/** The TPO letter for the n-th period of a session (A–Z, then a–z). */
export function tpoLetter(n) {
  const s = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return s[n % s.length];
}

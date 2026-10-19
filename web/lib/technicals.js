// Technicals: a summary of moving averages and oscillators on the chart's own candles, in the style of TradingView's
// Technicals page. Each reading votes buy, sell or neutral; the summary is the balance of the votes.
import { ema, rsi, sma } from "@/components/chart/indicators";

const last = (a) => {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null && a[i] !== undefined && Number.isFinite(a[i])) return a[i];
  return null;
};
const prevOf = (a) => {
  let seen = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] === null || a[i] === undefined || !Number.isFinite(a[i])) continue;
    if (seen++ === 1) return a[i];
  }
  return null;
};

function stoch(c, n = 14, smooth = 3) {
  const k = c.map((_, i) => {
    if (i < n - 1) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, c[j].h);
      lo = Math.min(lo, c[j].l);
    }
    return hi > lo ? ((c[i].c - lo) / (hi - lo)) * 100 : 50;
  });
  const kk = sma(k.map((v) => (v === null ? 0 : v)), smooth).map((v, i) => (k[i] === null || i < n + smooth - 2 ? null : v));
  const d = sma(kk.map((v) => (v === null ? 0 : v)), smooth).map((v, i) => (kk[i] === null || i < n + 2 * smooth - 3 ? null : v));
  return { k: kk, d };
}

function cci(c, n = 20) {
  const tp = c.map((k) => (k.h + k.l + k.c) / 3);
  const m = sma(tp, n);
  return tp.map((v, i) => {
    if (m[i] === null) return null;
    let dev = 0;
    for (let j = i - n + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]);
    dev /= n;
    return dev ? (v - m[i]) / (0.015 * dev) : 0;
  });
}

function williams(c, n = 14) {
  return c.map((_, i) => {
    if (i < n - 1) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, c[j].h);
      lo = Math.min(lo, c[j].l);
    }
    return hi > lo ? ((hi - c[i].c) / (hi - lo)) * -100 : -50;
  });
}

function adx(c, n = 14) {
  const len = c.length;
  if (len < n * 2 + 1) return { adx: null, pdi: null, mdi: null };
  let trS = 0;
  let pS = 0;
  let mS = 0;
  let dxs = [];
  let adxv = null;
  let pdi = null;
  let mdi = null;
  for (let i = 1; i < len; i++) {
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i <= n) {
      trS += tr;
      pS += pdm;
      mS += mdm;
      if (i < n) continue;
    } else {
      trS = trS - trS / n + tr;
      pS = pS - pS / n + pdm;
      mS = mS - mS / n + mdm;
    }
    pdi = trS ? (100 * pS) / trS : 0;
    mdi = trS ? (100 * mS) / trS : 0;
    const dx = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    dxs.push(dx);
    if (dxs.length === n) adxv = dxs.reduce((a, b) => a + b, 0) / n;
    else if (dxs.length > n) adxv = (adxv * (n - 1) + dx) / n;
  }
  return { adx: adxv, pdi, mdi };
}

const vote = (v) => (v > 0 ? "Buy" : v < 0 ? "Sell" : "Neutral");

/** Ratings for a list of candles {t, o, h, l, c, v}. Returns { summary, ma, osc } where each group has
 *  { rating, buy, sell, neutral, rows: [{ name, value, action }] }. */
export function technicals(c) {
  if (!c || c.length < 30) return null;
  const closes = c.map((k) => k.c);
  const price = closes[closes.length - 1];
  const maRows = [];
  for (const n of [10, 20, 30, 50, 100, 200]) {
    for (const [kind, fn] of [["EMA", ema], ["SMA", sma]]) {
      const v = last(fn(closes, n));
      if (v === null || c.length < n) continue;
      maRows.push({ name: `${kind} (${n})`, value: v, action: vote(price > v ? 1 : price < v ? -1 : 0) });
    }
  }
  const r = rsi(closes, 14);
  const rv = last(r);
  const rp = prevOf(r);
  const st = stoch(c);
  const kv = last(st.k);
  const dv = last(st.d);
  const cc = cci(c);
  const cv = last(cc);
  const cp = prevOf(cc);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macd = closes.map((_, i) => (e12[i] !== null && e26[i] !== null ? e12[i] - e26[i] : null));
  const sig = ema(macd.map((v) => (v === null ? 0 : v)), 9).map((v, i) => (macd[i] === null || i < 34 ? null : v));
  const mv = last(macd);
  const sv = last(sig);
  const mom = closes.length > 10 ? price - closes[closes.length - 11] : null;
  const momPrev = closes.length > 11 ? closes[closes.length - 2] - closes[closes.length - 12] : null;
  const w = williams(c);
  const wv = last(w);
  const wp = prevOf(w);
  const ax = adx(c);
  const ao5 = sma(c.map((k) => (k.h + k.l) / 2), 5);
  const ao34 = sma(c.map((k) => (k.h + k.l) / 2), 34);
  const ao = ao5.map((v, i) => (v !== null && ao34[i] !== null ? v - ao34[i] : null));
  const aov = last(ao);
  const aop = prevOf(ao);
  const osc = [];
  if (rv !== null) osc.push({ name: "RSI (14)", value: rv, action: vote(rv < 30 && rp !== null && rv > rp ? 1 : rv > 70 && rp !== null && rv < rp ? -1 : 0) });
  if (kv !== null && dv !== null) osc.push({ name: "Stochastic %K (14, 3, 3)", value: kv, action: vote(kv < 20 && kv > dv ? 1 : kv > 80 && kv < dv ? -1 : 0) });
  if (cv !== null) osc.push({ name: "CCI (20)", value: cv, action: vote(cv < -100 && cp !== null && cv > cp ? 1 : cv > 100 && cp !== null && cv < cp ? -1 : 0) });
  if (ax.adx !== null) osc.push({ name: "ADX (14)", value: ax.adx, action: vote(ax.adx > 20 ? (ax.pdi > ax.mdi ? 1 : -1) : 0) });
  if (aov !== null && aop !== null) osc.push({ name: "Awesome oscillator", value: aov, action: vote(aov > 0 && aov > aop ? 1 : aov < 0 && aov < aop ? -1 : 0) });
  if (mom !== null && momPrev !== null) osc.push({ name: "Momentum (10)", value: mom, action: vote(mom > momPrev ? 1 : mom < momPrev ? -1 : 0) });
  if (mv !== null && sv !== null) osc.push({ name: "MACD (12, 26)", value: mv, action: vote(mv > sv ? 1 : mv < sv ? -1 : 0) });
  if (wv !== null) osc.push({ name: "Williams %R (14)", value: wv, action: vote(wv < -80 && wp !== null && wv > wp ? 1 : wv > -20 && wp !== null && wv < wp ? -1 : 0) });
  const group = (rows) => {
    const buy = rows.filter((x) => x.action === "Buy").length;
    const sell = rows.filter((x) => x.action === "Sell").length;
    const neutral = rows.length - buy - sell;
    const score = rows.length ? (buy - sell) / rows.length : 0;
    return { rows, buy, sell, neutral, score, rating: ratingOf(score) };
  };
  const ma = group(maRows);
  const os = group(osc);
  const all = group([...maRows, ...osc]);
  return { summary: { ...all, rows: undefined }, ma, osc: os, price };
}

export function ratingOf(score) {
  if (score > 0.5) return "Strong buy";
  if (score > 0.1) return "Buy";
  if (score < -0.5) return "Strong sell";
  if (score < -0.1) return "Sell";
  return "Neutral";
}

// Indicator maths on arrays of candles {t, o, h, l, c, v}. Values are null until enough data exists.

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) {
      sum += v;
      count++;
      if (count === n) {
        prev = sum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function bollinger(values, n = 20, mult = 2) {
  const mid = sma(values, n);
  const up = new Array(values.length).fill(null);
  const lo = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    up[i] = mid[i] + mult * sd;
    lo[i] = mid[i] - mult * sd;
  }
  return { mid, up, lo };
}

export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Session VWAP, reset each UTC day (intraday charts only). */
export function vwap(candles) {
  const out = new Array(candles.length).fill(null);
  let day = null;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const d = Math.floor(k.t / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (k.h + k.l + k.c) / 3;
    pv += tp * (k.v || 0);
    vol += k.v || 0;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export function heikinAshi(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const c = (k.o + k.h + k.l + k.c) / 4;
    const o = i === 0 ? (k.o + k.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out.push({ t: k.t, o, h: Math.max(k.h, o, c), l: Math.min(k.l, o, c), c, v: k.v });
  }
  return out;
}

export function computeAll(candles, intraday) {
  const closes = candles.map((k) => k.c);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    bb: bollinger(closes, 20, 2),
    vwap: intraday ? vwap(candles) : null,
    rsi: rsi(closes, 14),
  };
}

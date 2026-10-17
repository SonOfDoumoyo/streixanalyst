"""Regular divergence on nine oscillators, and a scorecard of how each one's past signals played out.

A regular divergence: price makes a new extreme while an oscillator does not.
  * bullish: price makes a lower low, the oscillator makes a higher low
  * bearish: price makes a higher high, the oscillator makes a lower high

A pivot only counts once PIVOT bars have formed after it, so a signal is confirmed at the pivot's bar + PIVOT and never
repaints. A trade starts at the next bar's open, with a stop and a target set in ATR units. If a bar touches both, the
stop is assumed to hit first (the same rule as the Strategy Lab). Costs are charged on every trade.

The nine oscillators and their formulas are ours, not GainzAlgo's. The scorecard describes past signals only. It is
not a forecast, and a small sample says very little.
"""
import numpy as np
import pandas as pd

PIVOT = 5          # bars on each side that must be lower (higher) for a pivot
LOOKBACK = 200     # two pivots further apart than this do not form a divergence
SL_ATR = 1.5       # stop distance, in ATR
TP_ATR = 2.0       # target distance, in ATR
MAX_HOLD = 40      # bars before a trade closes at the last close
MIN_SIGNALS = 30   # below this many signals, a win rate says very little
FRESH_BARS = 3     # a signal confirmed this recently is listed as "fresh"

NAMES = {
    "rsi": "RSI (14)", "mfi": "Money flow (14)", "stoch": "Stochastic (14,3)", "zscore": "Z-Score (20)",
    "adx": "ADX (14)", "macd": "MACD histogram", "obv": "On-balance volume", "body": "Candle body strength",
    "relvol": "Relative volume",
}


def _wilder(x, n):
    return x.ewm(alpha=1.0 / n, adjust=False).mean()


def oscillators(df):
    """The nine oscillators (pandas Series on df's index) and the 14-bar ATR used for stops and targets."""
    o, h, l, c, v = (df[k].astype(float) for k in ("open", "high", "low", "close", "volume"))
    d = c.diff()
    rsi = 100 - 100 / (1 + _wilder(d.clip(lower=0), 14) / _wilder((-d).clip(lower=0), 14).replace(0, np.nan))

    tp = (h + l + c) / 3
    flow = tp * v
    pos = flow.where(tp.diff() > 0, 0.0).rolling(14).sum()
    neg = flow.where(tp.diff() < 0, 0.0).rolling(14).sum()
    mfi = 100 - 100 / (1 + pos / neg.replace(0, np.nan))

    lo14, hi14 = l.rolling(14).min(), h.rolling(14).max()
    k = 100 * (c - lo14) / (hi14 - lo14).replace(0, np.nan)
    stoch = k.rolling(3).mean()

    zscore = (c - c.rolling(20).mean()) / c.rolling(20).std().replace(0, np.nan)

    macd_line = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    macd = macd_line - macd_line.ewm(span=9, adjust=False).mean()

    obv = (np.sign(d).fillna(0.0) * v).cumsum()
    body = ((c - o) / (h - l).replace(0, np.nan)).ewm(span=5, adjust=False).mean()
    relvol = v / v.rolling(20).mean().replace(0, np.nan)

    prev_c = c.shift(1)
    tr = pd.concat([h - l, (h - prev_c).abs(), (l - prev_c).abs()], axis=1).max(axis=1)
    up_move, down_move = h.diff(), -l.diff()
    plus_dm = up_move.where((up_move > down_move) & (up_move > 0), 0.0)
    minus_dm = down_move.where((down_move > up_move) & (down_move > 0), 0.0)
    wilder_tr = _wilder(tr, 14).replace(0, np.nan)
    pdi = 100 * _wilder(plus_dm, 14) / wilder_tr
    mdi = 100 * _wilder(minus_dm, 14) / wilder_tr
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    adx = _wilder(dx, 14)

    osc = dict(rsi=rsi, mfi=mfi, stoch=stoch, zscore=zscore, adx=adx, macd=macd, obv=obv, body=body, relvol=relvol)
    atr = tr.rolling(14).mean()
    return osc, atr


def pivots(x, n, high):
    """Positions where x is the highest (or lowest) of the 2n+1 bars centred on it."""
    s = pd.Series(np.asarray(x, dtype=float))
    win = 2 * n + 1
    ext = s.rolling(win, center=True).max() if high else s.rolling(win, center=True).min()
    mask = (s == ext) & s.notna()
    return np.flatnonzero(mask.to_numpy())


def find_signals(high, low, osc, pivot=PIVOT, lookback=LOOKBACK):
    """Regular divergences, per oscillator. Each signal is (confirm_bar, direction, pivot_a, pivot_b)."""
    n = len(high)
    out = {k: [] for k in osc}
    for is_high in (False, True):
        series = high if is_high else low
        pts = pivots(series, pivot, is_high)
        for a, b in zip(pts[:-1], pts[1:]):
            if b - a > lookback or b + pivot >= n:
                continue
            if is_high and not series[b] > series[a]:
                continue                       # bearish needs a higher high in price
            if not is_high and not series[b] < series[a]:
                continue                       # bullish needs a lower low in price
            bullish = not is_high
            for k, x in osc.items():
                xa, xb = x[a], x[b]
                if not (np.isfinite(xa) and np.isfinite(xb)):
                    continue
                if bullish and xb > xa:
                    out[k].append((b + pivot, 1, int(a), int(b)))
                elif not bullish and xb < xa:
                    out[k].append((b + pivot, -1, int(a), int(b)))
    for k in out:
        out[k].sort()
    return out


def _simulate(s, d, o, h, l, c, atr, cost_frac, slip_frac, sl_atr, tp_atr, max_hold):
    """One trade from a signal confirmed on bar s. Returns the result in ATR units, after costs (None if unusable)."""
    n = len(c)
    e = s + 1
    if e >= n:
        return None
    a = atr[s]
    if not (np.isfinite(a) and a > 0):
        return None
    entry = o[e]
    stop = entry - d * sl_atr * a
    target = entry + d * tp_atr * a
    last = min(n - 1, e + max_hold - 1)
    exit_px, stopped = c[last], False
    for k in range(e, last + 1):
        if (d == 1 and l[k] <= stop) or (d == -1 and h[k] >= stop):
            exit_px, stopped = stop, True          # stop first when both are touched in one bar
            break
        if (d == 1 and h[k] >= target) or (d == -1 and l[k] <= target):
            exit_px = target
            break
    gross = d * (exit_px - entry)
    costs = cost_frac * entry + (slip_frac * entry if stopped else 0.0)
    return (gross - costs) / a


def scan(df, cost_frac=0.0, slip_frac=0.0, pivot=PIVOT, sl_atr=SL_ATR, tp_atr=TP_ATR, max_hold=MAX_HOLD):
    """Divergence signals and the scorecard for each oscillator. df: closed candles with open/high/low/close/volume."""
    if df is None or len(df) < 60:
        return dict(indicators=[], fresh=[], params=_params(pivot, sl_atr, tp_atr, max_hold, cost_frac, slip_frac),
                    notes=["Not enough candles to look for divergences."])
    osc, atr = oscillators(df)
    arr = {k: v.to_numpy(float) for k, v in osc.items()}
    o, h, l, c = (df[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    atr_v = atr.to_numpy(float)
    n = len(df)
    sigs = find_signals(h, l, arr, pivot=pivot)

    rows, fresh = [], []
    for k in NAMES:
        results = []
        for s, d, _, _ in sigs.get(k, []):
            r = _simulate(s, d, o, h, l, c, atr_v, cost_frac, slip_frac, sl_atr, tp_atr, max_hold)
            if r is not None:
                results.append(r)
            if n - 1 - s <= FRESH_BARS:
                fresh.append(dict(key=k, name=NAMES[k], direction="bullish" if d == 1 else "bearish",
                                  bars_ago=int(n - 1 - s), time=str(df.index[s]), price=float(c[s])))
        p = np.array(results, dtype=float)
        wins, losses = p[p > 0], p[p <= 0]
        rows.append(dict(
            key=k, name=NAMES[k], signals=int(len(p)), wins=int(len(wins)), losses=int(len(losses)),
            win_rate=round(100.0 * len(wins) / len(p), 1) if len(p) else None,
            avg_win_atr=round(float(wins.mean()), 2) if len(wins) else None,
            avg_loss_atr=round(float(losses.mean()), 2) if len(losses) else None,
            cumulative_atr=round(float(p.sum()), 2) if len(p) else 0.0,
            enough=bool(len(p) >= MIN_SIGNALS)))

    fresh.sort(key=lambda f: f["bars_ago"])
    notes = [
        "Past signals only, with spread, fees and slippage included. Not a forecast.",
        "Indicator formulas are StreixAnalyst's own definitions, not GainzAlgo's.",
        f"Each trade: stop {sl_atr} ATR, target {tp_atr} ATR, closed after {max_hold} bars if neither is hit.",
    ]
    if rows and not any(r["enough"] for r in rows):
        notes.append(f"Fewer than {MIN_SIGNALS} signals for every indicator, so no win rate here is reliable yet.")
    return dict(indicators=rows, fresh=fresh[:12],
                params=_params(pivot, sl_atr, tp_atr, max_hold, cost_frac, slip_frac), notes=notes)


def _params(pivot, sl_atr, tp_atr, max_hold, cost_frac, slip_frac):
    return dict(pivot=pivot, sl_atr=sl_atr, tp_atr=tp_atr, max_hold=max_hold,
                round_trip_cost_pct=round(cost_frac * 100, 4), slippage_pct=round(slip_frac * 100, 4))

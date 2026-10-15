"""Market structure engine (Notebook 1), packaged as a module.
Shared by training (Notebook 2), the backtester (Notebook 3) and the live web app."""
import math
import numpy as np
import pandas as pd

ENGINE_DEFAULTS = dict(swing_left=3, swing_right=3, atr_period=14, zone_tol_atr=0.6, zone_min_touches=2,
                       max_zones=6, equal_tol_atr=0.15, min_fvg_atr=0.25, pattern_trend_bars=5)


def load_yfinance(ticker, interval="15m", period="59d"):
    import yfinance as yf
    df = yf.Ticker(ticker).history(period=period, interval=interval, auto_adjust=False)
    if df is None or df.empty:
        raise ValueError(f"No data returned for {ticker} ({interval}, {period}). "
                         "Check the ticker, shorten the period, or use SOURCE='csv'.")
    df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
    df.index.name = "time"
    return df.dropna().astype(float)


def load_csv(path):
    """Reads most broker/charting exports (MT5 <DATE>/<TIME> columns, TradingView, Dukascopy)."""
    raw = pd.read_csv(path, sep=None, engine="python")
    raw.columns = [str(c).strip().strip("<>").lower() for c in raw.columns]
    if "date" in raw.columns and "time" in raw.columns:
        raw["time"] = raw["date"].astype(str) + " " + raw["time"].astype(str)
        raw = raw.drop(columns="date")
    if "tickvol" in raw.columns:   # MT5: tick volume is the useful one for FX
        raw = raw.drop(columns=[c for c in ("vol", "volume") if c in raw.columns]).rename(columns={"tickvol": "volume"})
    raw = raw.rename(columns={"date": "time", "datetime": "time", "timestamp": "time", "gmt time": "time",
                              "tick_volume": "volume", "vol": "volume"})
    t = raw["time"].astype(str).str.strip().str.replace(r"\s*(GMT|UTC).*$", "", regex=True)
    if t.str.fullmatch(r"\d{9,11}").all():                                         # TradingView: unix seconds
        raw["time"] = pd.to_datetime(t.astype("int64"), unit="s")
    else:
        t = t.str.replace(r"^(\d{4})\.(\d{1,2})\.(\d{1,2})", r"\1-\2-\3", regex=True)   # MT5: 2024.01.02
        t = t.str.replace(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})", r"\3-\2-\1", regex=True)   # Dukascopy: 02.01.2024
        raw["time"] = pd.to_datetime(t)
    df = raw.set_index("time").sort_index()
    if "volume" not in df.columns:
        df["volume"] = 0.0
    return df[["open", "high", "low", "close", "volume"]].astype(float).dropna()


def make_demo_data(n=3000, seed=7, start_price=1.0850, freq="15min"):
    """Synthetic trending/ranging prices. For testing the code offline only."""
    rng = np.random.default_rng(seed)
    regime_len = 150
    regimes = rng.choice([-1, 0, 1], size=n // regime_len + 1)
    drift = np.repeat(regimes, regime_len)[:n] * 0.00025
    rets = drift + rng.normal(0, 0.0011, n)
    close = start_price * np.exp(np.cumsum(rets))
    open_ = np.r_[start_price, close[:-1]]
    wicks = np.abs(rng.normal(0, 0.0006, (n, 2))) * close[:, None]
    high = np.maximum(open_, close) + wicks[:, 0]
    low = np.minimum(open_, close) - wicks[:, 1]
    idx = pd.date_range("2026-01-05", periods=n, freq=freq, name="time")
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close,
                         "volume": rng.integers(100, 1000, n).astype(float)}, index=idx)


def add_atr(df, n=14):
    prev_close = df["close"].shift()
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - prev_close).abs(),
                    (df["low"] - prev_close).abs()], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / n, adjust=False).mean()
    return df


def find_pivots(df, left=3, right=3):
    """Raw fractal pivots, in the order they happened. confirmed_idx = first bar where the pivot is knowable."""
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    pivots = []
    for i in range(left, len(df) - right):
        if h[i] > h[i - left:i].max() and h[i] >= h[i + 1:i + right + 1].max():
            pivots.append(dict(idx=i, time=str(df.index[i]), type="high", price=float(h[i]), confirmed_idx=i + right))
        if l[i] < l[i - left:i].min() and l[i] <= l[i + 1:i + right + 1].min():
            pivots.append(dict(idx=i, time=str(df.index[i]), type="low", price=float(l[i]), confirmed_idx=i + right))
    return pivots


def alternate_swings(pivots):
    """Force high/low/high/low order: of two same-type swings in a row, keep the more extreme one."""
    out = []
    for p in pivots:
        p = dict(p)
        if out and out[-1]["type"] == p["type"]:
            more_extreme = p["price"] > out[-1]["price"] if p["type"] == "high" else p["price"] < out[-1]["price"]
            if more_extreme:
                out[-1] = p
        else:
            out.append(p)
    return out


def label_structure(swings):
    last_high = last_low = None
    for s in swings:
        if s["type"] == "high":
            s["label"] = "H" if last_high is None else ("HH" if s["price"] > last_high else "LH")
            last_high = s["price"]
        else:
            s["label"] = "L" if last_low is None else ("HL" if s["price"] > last_low else "LL")
            last_low = s["price"]
    return swings


def detect_structure_breaks(df, pivots):
    c, h, l = (df[k].to_numpy() for k in ("close", "high", "low"))
    by_conf = {}
    for p in pivots:
        by_conf.setdefault(p["confirmed_idx"], []).append(p)
    trend, hi, lo = 0, None, None
    events, sweeps = [], []
    trend_arr = np.zeros(len(df), dtype=int)
    for i in range(len(df)):
        for p in by_conf.get(i, []):
            if p["type"] == "high":
                hi = dict(p, swept=False)
            else:
                lo = dict(p, swept=False)
        if hi is not None:
            if c[i] > hi["price"]:
                events.append(dict(kind="CHoCH" if trend == -1 else "BOS", direction="bullish", level=hi["price"],
                                   from_idx=hi["idx"], idx=i, time=str(df.index[i])))
                trend, hi = 1, None
            elif h[i] > hi["price"] and not hi["swept"]:
                sweeps.append(dict(side="buy-side", level=hi["price"], wick=float(h[i]),
                                   from_idx=hi["idx"], idx=i, time=str(df.index[i])))
                hi["swept"] = True
        if lo is not None:
            if c[i] < lo["price"]:
                events.append(dict(kind="CHoCH" if trend == 1 else "BOS", direction="bearish", level=lo["price"],
                                   from_idx=lo["idx"], idx=i, time=str(df.index[i])))
                trend, lo = -1, None
            elif l[i] < lo["price"] and not lo["swept"]:
                sweeps.append(dict(side="sell-side", level=lo["price"], wick=float(l[i]),
                                   from_idx=lo["idx"], idx=i, time=str(df.index[i])))
                lo["swept"] = True
        trend_arr[i] = trend
    return events, sweeps, trend_arr


def find_liquidity(df, swings, equal_tol_atr=0.15):
    h, l, atr = (df[k].to_numpy() for k in ("high", "low", "atr"))
    # highest high / lowest low strictly AFTER each bar
    fut_max = np.r_[np.maximum.accumulate(h[::-1])[::-1][1:], -np.inf]
    fut_min = np.r_[np.minimum.accumulate(l[::-1])[::-1][1:], np.inf]
    highs = [s for s in swings if s["type"] == "high"]
    lows = [s for s in swings if s["type"] == "low"]
    for s in highs:
        s["taken"] = bool(fut_max[s["idx"]] > s["price"])
    for s in lows:
        s["taken"] = bool(fut_min[s["idx"]] < s["price"])
    pools = []
    for a, b in zip(highs, highs[1:]):
        if abs(a["price"] - b["price"]) <= equal_tol_atr * atr[b["idx"]]:
            lvl = max(a["price"], b["price"])
            pools.append(dict(kind="EQH", side="buy-side", level=lvl, idx_a=a["idx"], idx_b=b["idx"],
                              taken=bool(fut_max[b["idx"]] > lvl)))
    for a, b in zip(lows, lows[1:]):
        if abs(a["price"] - b["price"]) <= equal_tol_atr * atr[b["idx"]]:
            lvl = min(a["price"], b["price"])
            pools.append(dict(kind="EQL", side="sell-side", level=lvl, idx_a=a["idx"], idx_b=b["idx"],
                              taken=bool(fut_min[b["idx"]] < lvl)))
    price = float(df["close"].iloc[-1])
    buy_side = sorted([s for s in highs if not s["taken"] and s["price"] > price], key=lambda s: s["price"])
    sell_side = sorted([s for s in lows if not s["taken"] and s["price"] < price], key=lambda s: -s["price"])
    return dict(pools=pools, buy_side=buy_side, sell_side=sell_side)


def build_zones(df, swings, tol_atr=0.6, min_touches=2, max_zones=6, lookback_swings=200):
    """Density clustering: repeatedly take the price band (width = tol) holding the most recency-weighted
    swings, turn it into a zone, remove those swings, repeat. Keeps the best zones on each side of price."""
    swings = swings[-lookback_swings:]
    if not swings:
        return []
    atr = float(df["atr"].median())
    tol, pad = tol_atr * atr, 0.1 * atr
    n, price = len(df), float(df["close"].iloc[-1])
    prices = np.array([s["price"] for s in swings])
    idxs = np.array([s["idx"] for s in swings])
    weights = 0.5 + idxs / n                       # recent touches count more
    left = np.ones(len(prices), bool)
    zones = []
    while left.sum() >= min_touches:
        near = (np.abs(prices[:, None] - prices[None, :]) <= tol / 2) & left[None, :] & left[:, None]
        best = int(np.argmax((near * weights[None, :]).sum(1)))
        members = near[best]
        if members.sum() < min_touches:
            break
        left &= ~members
        bottom, top = prices[members].min() - pad, prices[members].max() + pad
        if any(bottom <= z["top"] and top >= z["bottom"] for z in zones):
            continue                               # overlaps a stronger zone already kept
        dist_atr = max(0.0, bottom - price, price - top) / atr
        score = weights[members].sum() / (1 + dist_atr / 20)
        zones.append(dict(bottom=float(bottom), top=float(top), touches=int(members.sum()),
                          first_idx=int(idxs[members].min()), last_idx=int(idxs[members].max()),
                          score=round(float(score), 3),
                          role="resistance" if bottom > price else "support" if top < price else "at zone"))
    zones.sort(key=lambda z: -z["score"])
    per_side = max(1, max_zones // 2)
    return ([z for z in zones if z["role"] == "at zone"]
            + [z for z in zones if z["role"] == "support"][:per_side]
            + [z for z in zones if z["role"] == "resistance"][:per_side])


def find_fvgs(df, min_atr=0.25):
    h, l, atr = (df[k].to_numpy() for k in ("high", "low", "atr"))
    gaps = []
    for i in range(2, len(df)):
        if l[i] > h[i - 2] and l[i] - h[i - 2] >= min_atr * atr[i]:
            gaps.append(dict(direction="bullish", top=float(l[i]), bottom=float(h[i - 2]), idx=i - 1))
        elif h[i] < l[i - 2] and l[i - 2] - h[i] >= min_atr * atr[i]:
            gaps.append(dict(direction="bearish", top=float(l[i - 2]), bottom=float(h[i]), idx=i - 1))
    for g in gaps:   # search forward in growing chunks: fast even on years of data
        j, step, g["filled_idx"] = g["idx"] + 2, 64, None
        while j < len(df):
            seg = l[j:j + step] <= g["bottom"] if g["direction"] == "bullish" else h[j:j + step] >= g["top"]
            hit = np.flatnonzero(seg)
            if len(hit):
                g["filled_idx"] = int(j + hit[0])
                break
            j, step = j + step, step * 2
    return gaps


PATTERN_BIAS = {
    "Hammer": "bullish", "Inverted Hammer": "bullish", "Bullish Engulfing": "bullish", "Bullish Harami": "bullish",
    "Piercing Line": "bullish", "Morning Star": "bullish", "Three White Soldiers": "bullish",
    "Bullish Marubozu": "bullish", "Tweezer Bottom": "bullish",
    "Hanging Man": "bearish", "Shooting Star": "bearish", "Bearish Engulfing": "bearish", "Bearish Harami": "bearish",
    "Dark Cloud Cover": "bearish", "Evening Star": "bearish", "Three Black Crows": "bearish",
    "Bearish Marubozu": "bearish", "Tweezer Top": "bearish",
    "Doji": "neutral", "Inside Bar": "neutral",
}


def detect_candles(df, trend_bars=5):
    o, h, l, c = (df[k] for k in ("open", "high", "low", "close"))
    rng = (h - l).replace(0, np.nan)
    body = (c - o).abs()
    top, bot = np.maximum(o, c), np.minimum(o, c)
    upper, lower = h - top, bot - l
    bull, bear = c > o, c < o
    avg_body = body.rolling(14, min_periods=5).mean()
    long_body = body > avg_body
    small_body = body <= 0.3 * rng
    down_before = c.shift(1) < c.shift(trend_bars + 1)
    up_before = c.shift(1) > c.shift(trend_bars + 1)

    def b(s, k=1):   # boolean from k bars ago
        return s.shift(k, fill_value=False).astype(bool)

    def v(s, k=1):   # value from k bars ago
        return s.shift(k)

    hammer = (lower >= 2 * body) & (upper <= 0.15 * rng) & (body >= 0.05 * rng)
    inverted = (upper >= 2 * body) & (lower <= 0.15 * rng) & (body >= 0.05 * rng)
    mid_1 = (v(o) + v(c)) / 2
    mid_2 = (v(o, 2) + v(c, 2)) / 2

    pats = {
        "Doji": body <= 0.08 * rng,
        "Hammer": hammer & down_before,
        "Hanging Man": hammer & up_before,
        "Inverted Hammer": inverted & down_before,
        "Shooting Star": inverted & up_before,
        "Bullish Engulfing": bull & b(bear) & long_body & (c >= v(o)) & (o <= v(c)) & (body > 1.2 * v(body)) & down_before,
        "Bearish Engulfing": bear & b(bull) & long_body & (c <= v(o)) & (o >= v(c)) & (body > 1.2 * v(body)) & up_before,
        "Bullish Harami": b(bear) & b(long_body) & bull & (top <= v(o)) & (bot >= v(c)) & (body <= 0.5 * v(body)) & b(down_before),
        "Bearish Harami": b(bull) & b(long_body) & bear & (top <= v(c)) & (bot >= v(o)) & (body <= 0.5 * v(body)) & b(up_before),
        "Piercing Line": b(bear) & b(long_body) & bull & (o <= v(c)) & (c > mid_1) & (c < v(o)) & b(down_before),
        "Dark Cloud Cover": b(bull) & b(long_body) & bear & (o >= v(c)) & (c < mid_1) & (c > v(o)) & b(up_before),
        "Morning Star": b(bear, 2) & b(long_body, 2) & b(small_body) & bull & (c > mid_2) & b(down_before, 2),
        "Evening Star": b(bull, 2) & b(long_body, 2) & b(small_body) & bear & (c < mid_2) & b(up_before, 2),
        "Three White Soldiers": bull & b(bull) & b(bull, 2) & (c > v(c)) & (v(c) > v(c, 2))
                                & long_body & b(long_body) & b(long_body, 2) & (upper <= 0.3 * body),
        "Three Black Crows": bear & b(bear) & b(bear, 2) & (c < v(c)) & (v(c) < v(c, 2))
                             & long_body & b(long_body) & b(long_body, 2) & (lower <= 0.3 * body),
        "Bullish Marubozu": bull & (body >= 0.9 * rng) & long_body,
        "Bearish Marubozu": bear & (body >= 0.9 * rng) & long_body,
        "Tweezer Bottom": b(bear) & bull & ((l - v(l)).abs() <= 0.05 * rng) & down_before,
        "Tweezer Top": b(bull) & bear & ((h - v(h)).abs() <= 0.05 * rng) & up_before,
        "Inside Bar": (h <= v(h)) & (l >= v(l)),
    }
    flags = pd.DataFrame({k: s.fillna(False).astype(bool) for k, s in pats.items()}, index=df.index)
    events = [dict(idx=int(i), time=str(df.index[i]), name=name, bias=PATTERN_BIAS[name])
              for name in flags.columns for i in np.flatnonzero(flags[name].to_numpy())]
    events.sort(key=lambda e: e["idx"])
    return flags, events


def _decimals(price):
    return int(max(2, 5 - math.floor(math.log10(abs(price))))) if price else 2


def summarize(df, A, recent_bars=3):
    price, atr = float(df["close"].iloc[-1]), float(df["atr"].iloc[-1])
    dp, n = _decimals(price), len(df)
    r = lambda v: round(float(v), dp)
    dist = lambda lvl: round(abs(lvl - price) / atr, 2)
    zone = lambda z: dict(bottom=r(z["bottom"]), top=r(z["top"]), touches=z["touches"],
                          distance_atr=dist((z["bottom"] + z["top"]) / 2))
    ev = A["events"][-1] if A["events"] else None
    sw = A["sweeps"][-1] if A["sweeps"] else None
    liq = A["liquidity"]
    sup = sorted([z for z in A["zones"] if z["role"] == "support"], key=lambda z: price - z["top"])
    res = sorted([z for z in A["zones"] if z["role"] == "resistance"], key=lambda z: z["bottom"] - price)
    open_fvgs = sorted([g for g in A["fvgs"] if g["filled_idx"] is None],
                       key=lambda g: abs((g["top"] + g["bottom"]) / 2 - price))[:3]
    return {
        "time": str(df.index[-1]), "price": r(price), "atr": r(atr),
        "structure": {
            "trend": {1: "bullish", -1: "bearish", 0: "undetermined"}[int(A["trend"][-1])],
            "last_break": None if ev is None else dict(type=ev["kind"], direction=ev["direction"],
                                                       level=r(ev["level"]), bars_ago=n - 1 - ev["idx"]),
            "recent_swings": [w["label"] for w in A["swings"][-6:]],
        },
        "support_zones": [zone(z) for z in sup[:3]],
        "resistance_zones": [zone(z) for z in res[:3]],
        "price_inside_zone": [zone(z) for z in A["zones"] if z["role"] == "at zone"],
        "liquidity": {
            "buy_side_above": [dict(level=r(w["price"]), distance_atr=dist(w["price"])) for w in liq["buy_side"][:3]],
            "sell_side_below": [dict(level=r(w["price"]), distance_atr=dist(w["price"])) for w in liq["sell_side"][:3]],
            "untaken_equal_highs": [r(p["level"]) for p in liq["pools"] if p["kind"] == "EQH" and not p["taken"]][-3:],
            "untaken_equal_lows": [r(p["level"]) for p in liq["pools"] if p["kind"] == "EQL" and not p["taken"]][-3:],
            "last_sweep": None if sw is None else dict(side=sw["side"], level=r(sw["level"]), bars_ago=n - 1 - sw["idx"]),
        },
        "open_fvgs": [dict(direction=g["direction"], bottom=r(g["bottom"]), top=r(g["top"])) for g in open_fvgs],
        "recent_candle_patterns": [dict(name=p["name"], bias=p["bias"], bars_ago=n - 1 - p["idx"])
                                   for p in A["patterns"] if p["idx"] >= n - recent_bars],
    }


def analyze(df, cfg=None):
    cfg = {**ENGINE_DEFAULTS, **(cfg or {})}
    df = add_atr(df[["open", "high", "low", "close", "volume"]].astype(float).copy(), cfg["atr_period"])
    pivots = find_pivots(df, cfg["swing_left"], cfg["swing_right"])
    swings = label_structure(alternate_swings(pivots))
    events, sweeps, trend = detect_structure_breaks(df, pivots)
    liquidity = find_liquidity(df, swings, cfg["equal_tol_atr"])
    zones = build_zones(df, swings, cfg["zone_tol_atr"], cfg["zone_min_touches"], cfg["max_zones"])
    fvgs = find_fvgs(df, cfg["min_fvg_atr"])
    flags, patterns = detect_candles(df, cfg["pattern_trend_bars"])
    df["trend"] = trend
    return df, dict(pivots=pivots, swings=swings, events=events, sweeps=sweeps, trend=trend,
                    liquidity=liquidity, zones=zones, fvgs=fvgs, pattern_flags=flags, patterns=patterns)

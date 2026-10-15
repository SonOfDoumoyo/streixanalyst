"""guru_levels.py: what an experienced discretionary trader marks on a chart, computed from candles.

Inputs are candles that went through structure_engine.analyze (they carry an `atr` column) and the engine's
analysis dict A (pivots, swings, events, sweeps, liquidity, zones, fvgs, patterns).
Every function returns plain dicts/lists with bar indices (positions in the candle frame) and prices.
"""
import math

import numpy as np
import pandas as pd

KILLZONES = (("Asian session", 20.0, 24.0), ("London killzone", 2.0, 5.0), ("New York AM killzone", 7.0, 10.0),
             ("London close", 10.0, 12.0), ("New York PM session", 13.5, 16.0))
SILVER_BULLETS = (("London silver bullet", 3.0, 4.0), ("NY AM silver bullet", 10.0, 11.0),
                  ("NY PM silver bullet", 14.0, 15.0))


# ───────────────────────────── indicators ─────────────────────────────
def rsi(close, n=14):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    out = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    return out.fillna(50.0)


def ema(close, n):
    return close.ewm(span=n, adjust=False).mean()


def adx(df, n=14):
    h, l, c = df["high"], df["low"], df["close"]
    up, dn = h.diff(), -l.diff()
    plus = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    minus = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / n, adjust=False).mean().replace(0, np.nan)
    pdi = 100 * plus.ewm(alpha=1 / n, adjust=False).mean() / atr
    mdi = 100 * minus.ewm(alpha=1 / n, adjust=False).mean() / atr
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean().fillna(0.0), pdi.fillna(0.0), mdi.fillna(0.0)


def efficiency_ratio(close, n=50):
    move = (close - close.shift(n)).abs()
    path = close.diff().abs().rolling(n, min_periods=n).sum()
    return (move / path.replace(0, np.nan)).fillna(0.0)


def bb_width(close, n=20, k=2.0):
    mid = close.rolling(n, min_periods=n).mean()
    sd = close.rolling(n, min_periods=n).std()
    return (2 * k * sd / mid.replace(0, np.nan))


def pct_rank(s, window=250, min_periods=50):
    return s.rolling(window, min_periods=min_periods).rank(pct=True)


def _atr_ref(df, k=200):
    a = df["atr"].to_numpy()[-k:]
    a = a[np.isfinite(a) & (a > 0)]
    return float(np.median(a)) if len(a) else float((df["high"] - df["low"]).median())


# ───────────────────────────── order blocks ─────────────────────────────
def order_blocks(df, A, keep=3, max_scan=6):
    """Order block = the last opposite-colour candle before the impulse that broke structure.
    status: fresh (untouched) / tested (price came back into it) / breaker (a close through it: role flips)."""
    o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
    n = len(df)
    found = []
    for e in A["events"]:
        i, j0 = e["idx"], e["from_idx"]
        if i - j0 < 1:
            continue
        bull = e["direction"] == "bullish"
        origin = j0 + int(np.argmin(l[j0:i + 1]) if bull else np.argmax(h[j0:i + 1]))
        k = None
        for j in range(origin, max(origin - max_scan, -1), -1):
            if (c[j] < o[j]) if bull else (c[j] > o[j]):
                k = j
                break
        k = origin if k is None else k
        top, bot = float(h[k]), float(l[k])
        t_idx = b_idx = None
        if i + 1 < n:
            if bull:
                hit, brk = np.flatnonzero(l[i + 1:] <= top), np.flatnonzero(c[i + 1:] < bot)
            else:
                hit, brk = np.flatnonzero(h[i + 1:] >= bot), np.flatnonzero(c[i + 1:] > top)
            b_idx = i + 1 + int(brk[0]) if len(brk) else None
            t_idx = i + 1 + int(hit[0]) if len(hit) else None
        status = "breaker" if b_idx is not None else ("tested" if t_idx is not None else "fresh")
        if status == "breaker":
            role = "supply" if bull else "demand"            # a failed demand block becomes resistance
        else:
            role = "demand" if bull else "supply"
        found.append(dict(direction="bullish" if bull else "bearish", role=role, idx=int(k), event_idx=int(i),
                          event_kind=e["kind"], top=top, bottom=bot, status=status, touched_idx=t_idx,
                          broken_idx=b_idx))
    price = float(c[-1])
    uniq = {}
    for ob in found:                                          # one event can't produce two identical blocks
        uniq[(ob["idx"], ob["role"], ob["status"] == "breaker")] = ob
    found = sorted(uniq.values(), key=lambda b: b["event_idx"])
    demand = [b for b in found if b["role"] == "demand" and b["status"] != "breaker" and b["bottom"] < price]
    supply = [b for b in found if b["role"] == "supply" and b["status"] != "breaker" and b["top"] > price]
    breakers = [b for b in found if b["status"] == "breaker" and b["broken_idx"] is not None
                and n - 1 - b["broken_idx"] <= 200]
    pick = lambda xs: sorted(xs, key=lambda b: (b["status"] != "fresh", -b["event_idx"]))[:keep]
    return pick(demand) + pick(supply) + sorted(breakers, key=lambda b: -b["broken_idx"])[:2]


# ───────────────────────────── ranges, legs, fibs ─────────────────────────────
def dealing_range(df, A):
    """Current dealing range: last confirmed swing low → last swing high (stretched by any price beyond them).
    Above 50% = premium (sell zone for SMC traders), below = discount (buy zone). OTE = 62–79% retracement."""
    h, l, c = df["high"].to_numpy(), df["low"].to_numpy(), float(df["close"].iloc[-1])
    sw = A["swings"]
    highs = [s for s in sw if s["type"] == "high"]
    lows = [s for s in sw if s["type"] == "low"]
    if not highs or not lows:
        return None
    hs, ls = highs[-1], lows[-1]
    ti = hs["idx"] + int(np.argmax(h[hs["idx"]:]))
    bi = ls["idx"] + int(np.argmin(l[ls["idx"]:]))
    top, bot = max(hs["price"], float(h[ti])), min(ls["price"], float(l[bi]))
    if top <= bot:
        return None
    rng = top - bot
    trend = int(A["trend"][-1]) if len(A["trend"]) else 0
    leg = "up" if trend == 1 or (trend == 0 and bi < ti) else "down"
    pos = (c - bot) / rng
    zone = "equilibrium" if abs(pos - 0.5) < 0.05 else ("premium" if pos > 0.5 else "discount")
    return dict(top=float(top), bottom=float(bot), top_idx=int(ti), bottom_idx=int(bi), eq=float(bot + rng / 2),
                pos=float(pos), zone=zone, leg=leg,
                ote_long=(float(top - 0.79 * rng), float(top - 0.62 * rng)),
                ote_short=(float(bot + 0.62 * rng), float(bot + 0.79 * rng)))


def impulse_leg(df, A):
    """The latest impulse in the direction of structure: from the origin of the last break to its extreme."""
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    n = len(df)
    trend = int(A["trend"][-1]) if len(A["trend"]) else 0
    if trend == 0 or not A["events"]:
        return None
    want = "bullish" if trend == 1 else "bearish"
    evs = [e for e in A["events"] if e["direction"] == want]
    if not evs:
        return None
    e = evs[-1]
    j0, i = e["from_idx"], e["idx"]
    if trend == 1:
        oi = j0 + int(np.argmin(l[j0:i + 1]))
        xi = oi + int(np.argmax(h[oi:]))
        origin, ext = float(l[oi]), float(h[xi])
    else:
        oi = j0 + int(np.argmax(h[j0:i + 1]))
        xi = oi + int(np.argmin(l[oi:]))
        origin, ext = float(h[oi]), float(l[xi])
    L = ext - origin                       # signed: + for bullish legs
    if abs(L) <= 0:
        return None
    retr = {r: ext - r * L for r in (0.236, 0.382, 0.5, 0.618, 0.705, 0.786)}
    exts = {x: origin + x * L for x in (1.272, 1.618, 2.0)}
    return dict(direction=1 if trend == 1 else -1, origin=origin, origin_idx=int(oi), extreme=ext,
                extreme_idx=int(xi), event_idx=int(i), event_kind=e["kind"], length=float(abs(L)),
                retracements={str(k): float(v) for k, v in retr.items()},
                extensions={str(k): float(v) for k, v in exts.items()}, bars_old=int(n - 1 - i))


# ───────────────────────────── trendlines & chart patterns ─────────────────────────────
def fit_lines(df, A, kind, tol_atr=0.25, max_pivots=12, min_span=6):
    """Candidate trendlines through two swing pivots that price respected (no close beyond) between them.
    Lines broken more than 10 candles ago are dropped. Sorted best first (touches, then recency)."""
    c = df["close"].to_numpy()
    n = len(df)
    tol = tol_atr * _atr_ref(df)
    typ = "low" if kind == "support" else "high"
    piv = [p for p in A["pivots"] if p["type"] == typ][-max_pivots:]
    lines = []
    for a in range(len(piv)):
        for b in range(a + 1, len(piv)):
            pa, pb = piv[a], piv[b]
            span = pb["idx"] - pa["idx"]
            if span < min_span:
                continue
            slope = (pb["price"] - pa["price"]) / span
            x = np.arange(pa["idx"], n)
            line = pa["price"] + slope * (x - pa["idx"])
            seg = c[pa["idx"]:]
            viol = (seg < line - tol) if kind == "support" else (seg > line + tol)
            if viol[: span + 1].any():
                continue
            after = np.flatnonzero(viol[span + 1:])
            brk = None if len(after) == 0 else pb["idx"] + 1 + int(after[0])
            if brk is not None and n - 1 - brk > 10:
                continue
            end = brk if brk is not None else n - 1
            val = lambda i: pa["price"] + slope * (i - pa["idx"])
            touches = [p["idx"] for p in piv if pa["idx"] <= p["idx"] <= end and abs(p["price"] - val(p["idx"])) <= tol]
            lines.append(dict(kind=kind, i1=int(pa["idx"]), p1=float(pa["price"]), i2=int(n - 1),
                              p2=float(val(n - 1)), slope=float(slope), anchor2=int(pb["idx"]),
                              touches=len(touches), touch_idx=touches, broken_idx=brk,
                              status="broken" if brk is not None else "intact", span=int(end - pa["idx"])))
    lines.sort(key=lambda L: (-L["touches"], -L["anchor2"], -L["span"]))
    return lines


def line_value(L, i):
    return L["p1"] + L["slope"] * (i - L["i1"])


def trendlines(df, A, tol_atr=0.25):
    """Classic trendlines: rising support under higher lows, falling resistance over lower highs (+ channels)."""
    sup = fit_lines(df, A, "support", tol_atr)
    res = fit_lines(df, A, "resistance", tol_atr)
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    n, tol = len(df), tol_atr * _atr_ref(df)
    out = []
    up = next((L for L in sup if L["slope"] > 0), None)
    dn = next((L for L in res if L["slope"] < 0), None)
    for L, name in ((up, "Uptrend line"), (dn, "Downtrend line")):
        if L is None:
            continue
        L = dict(L, name=name)
        x = np.arange(L["i1"], n)
        base = L["p1"] + L["slope"] * (x - L["i1"])
        if L["kind"] == "support":                     # parallel channel line through the highest point above it
            off = float(np.max(h[L["i1"]:] - base))
            par_t = int(np.sum(np.abs(h[L["i1"]:] - (base + off)) <= tol))
        else:
            off = float(np.min(l[L["i1"]:] - base))
            par_t = int(np.sum(np.abs(l[L["i1"]:] - (base + off)) <= tol))
        if par_t >= 2 and L["status"] == "intact":
            L["channel_offset"] = off
        out.append(L)
    return out, sup, res


def chart_patterns(df, A, sup, res, tol_atr=0.25):
    """Triangles, wedges, channels, ranges, broadening formations (from the best support/resistance lines),
    double tops/bottoms and head & shoulders (from swings). Each has bias, breakout levels and a measured target."""
    c, h, l = df["close"].to_numpy(), df["high"].to_numpy(), df["low"].to_numpy()
    n, atr = len(df), _atr_ref(df)
    price = float(c[-1])
    pats = []
    s = next((L for L in sup if n - 1 - L["i1"] <= 160), None)
    r = next((L for L in res if n - 1 - L["i1"] <= 160), None)
    if s is not None and r is not None:
        start = max(s["i1"], r["i1"])
        span = n - 1 - start
        w0, w1 = line_value(r, start) - line_value(s, start), line_value(r, n - 1) - line_value(s, n - 1)
        if span >= 10 and w0 > 0.8 * atr and w1 > -0.2 * atr:
            s_ch, r_ch = s["slope"] * span / atr, r["slope"] * span / atr
            flat = 0.6
            if w1 < 0.8 * w0:
                if s_ch > flat and r_ch < -flat:
                    name, bias = "Symmetrical triangle", 0
                elif abs(r_ch) <= flat and s_ch > flat:
                    name, bias = "Ascending triangle", 1
                elif abs(s_ch) <= flat and r_ch < -flat:
                    name, bias = "Descending triangle", -1
                elif s_ch > flat and r_ch > flat:
                    name, bias = "Rising wedge", -1
                elif s_ch < -flat and r_ch < -flat:
                    name, bias = "Falling wedge", 1
                else:
                    name, bias = "Contracting range", 0
            elif w1 > 1.25 * w0:
                name, bias = "Broadening formation", 0
            else:
                if s_ch > flat and r_ch > flat:
                    name, bias = "Ascending channel", 1
                elif s_ch < -flat and r_ch < -flat:
                    name, bias = "Descending channel", -1
                else:
                    name, bias = "Range (rectangle)", 0
            up_lvl, dn_lvl = line_value(r, n - 1), line_value(s, n - 1)
            if r["status"] == "broken":
                status, bias_now = "broke up", 1
            elif s["status"] == "broken":
                status, bias_now = "broke down", -1
            else:
                status, bias_now = "forming", bias
            height = w0 if "triangle" in name.lower() or "wedge" in name.lower() else max(w1, 0.0)
            pats.append(dict(name=name, kind="lines", bias=int(bias), bias_now=int(bias_now), status=status,
                             start_idx=int(start), support=s, resistance=r, breakout_up=float(up_lvl),
                             breakout_down=float(dn_lvl), target_up=float(up_lvl + height),
                             target_down=float(dn_lvl - height), height=float(height)))
    sw = A["swings"]
    for typ in ("high", "low"):
        pts = [p for p in sw if p["type"] == typ]
        if len(pts) < 2:
            continue
        a, b = pts[-2], pts[-1]
        if not (abs(a["price"] - b["price"]) <= 0.35 * atr and b["idx"] - a["idx"] >= 5 and n - 1 - b["idx"] <= 80):
            continue
        if typ == "high":
            k = a["idx"] + int(np.argmin(l[a["idx"]:b["idx"] + 1]))
            neck, top = float(l[k]), max(a["price"], b["price"])
            height = top - neck
            if height < 1.2 * atr:
                continue
            after = c[b["idx"] + 1:]
            fail = np.flatnonzero(after > top + 0.25 * atr)
            brk = np.flatnonzero(after < neck)
            status = "failed" if len(fail) and (not len(brk) or fail[0] < brk[0]) else (
                "confirmed" if len(brk) else "forming")
            pats.append(dict(name="Double top", kind="double", bias=-1, bias_now=-1 if status != "failed" else 1,
                             status=status, points=[a["idx"], b["idx"]], prices=[a["price"], b["price"]],
                             neck=neck, neck_idx=int(k), trigger=neck, invalidation=float(top + 0.25 * atr),
                             target_down=float(neck - height), height=float(height),
                             break_idx=None if not len(brk) else int(b["idx"] + 1 + brk[0])))
        else:
            k = a["idx"] + int(np.argmax(h[a["idx"]:b["idx"] + 1]))
            neck, bot = float(h[k]), min(a["price"], b["price"])
            height = neck - bot
            if height < 1.2 * atr:
                continue
            after = c[b["idx"] + 1:]
            fail = np.flatnonzero(after < bot - 0.25 * atr)
            brk = np.flatnonzero(after > neck)
            status = "failed" if len(fail) and (not len(brk) or fail[0] < brk[0]) else (
                "confirmed" if len(brk) else "forming")
            pats.append(dict(name="Double bottom", kind="double", bias=1, bias_now=1 if status != "failed" else -1,
                             status=status, points=[a["idx"], b["idx"]], prices=[a["price"], b["price"]],
                             neck=neck, neck_idx=int(k), trigger=neck, invalidation=float(bot - 0.25 * atr),
                             target_up=float(neck + height), height=float(height),
                             break_idx=None if not len(brk) else int(b["idx"] + 1 + brk[0])))
    for typ in ("high", "low"):                                   # head & shoulders / inverse
        pts = [p for p in sw if p["type"] == typ]
        opp = [p for p in sw if p["type"] != typ]
        if len(pts) < 3:
            continue
        s1, hd, s2 = pts[-3], pts[-2], pts[-1]
        sign = 1 if typ == "high" else -1
        if n - 1 - s2["idx"] > 80:
            continue
        prom = sign * (hd["price"] - (max if sign == 1 else min)(s1["price"], s2["price"]))
        if prom < 0.5 * atr or abs(s1["price"] - s2["price"]) > max(0.6 * atr, 0.35 * abs(hd["price"] - s1["price"])):
            continue
        t1 = [p for p in opp if s1["idx"] < p["idx"] < hd["idx"]]
        t2 = [p for p in opp if hd["idx"] < p["idx"] < s2["idx"]]
        if not t1 or not t2:
            continue
        a, b = t1[-1], t2[-1]
        slope = (b["price"] - a["price"]) / max(1, b["idx"] - a["idx"])
        neck_now = a["price"] + slope * (n - 1 - a["idx"])
        neck_head = a["price"] + slope * (hd["idx"] - a["idx"])
        height = abs(hd["price"] - neck_head)
        after = np.arange(s2["idx"] + 1, n)
        nl = a["price"] + slope * (after - a["idx"])
        brk = np.flatnonzero(c[after] < nl) if sign == 1 else np.flatnonzero(c[after] > nl)
        status = "confirmed" if len(brk) else "forming"
        pats.append(dict(name="Head & shoulders" if sign == 1 else "Inverse head & shoulders", kind="hs",
                         bias=-sign, bias_now=-sign, status=status,
                         points=[s1["idx"], hd["idx"], s2["idx"]], prices=[s1["price"], hd["price"], s2["price"]],
                         neck_points=[a["idx"], b["idx"]], neck_prices=[a["price"], b["price"]],
                         neck_slope=float(slope), trigger=float(neck_now), height=float(height),
                         invalidation=float(hd["price"] + sign * 0.25 * atr),
                         **({"target_down": float(neck_now - height)} if sign == 1 else
                            {"target_up": float(neck_now + height)}),
                         break_idx=None if not len(brk) else int(after[brk[0]])))
    return pats


# ───────────────────────────── momentum, volume ─────────────────────────────
def rsi_divergences(df, A, r, lookback=60):
    """Regular divergence (price makes a new extreme, RSI doesn't) warns of a turn; hidden divergence
    (price holds a higher low / lower high, RSI overshoots) supports trend continuation."""
    n = len(df)
    rv = np.asarray(r, dtype=float)
    out = []
    sw = A["swings"]
    for typ in ("high", "low"):
        pts = [p for p in sw if p["type"] == typ]
        if len(pts) < 2:
            continue
        a, b = pts[-2], pts[-1]
        if n - 1 - b["idx"] > lookback:
            continue
        ra, rb = rv[a["idx"]], rv[b["idx"]]
        kind = None
        if typ == "high":
            if b["price"] > a["price"] and rb < ra - 2:
                kind, bias = "Bearish regular divergence", -1
            elif b["price"] < a["price"] and rb > ra + 2:
                kind, bias = "Bearish hidden divergence", -1
        else:
            if b["price"] < a["price"] and rb > ra + 2:
                kind, bias = "Bullish regular divergence", 1
            elif b["price"] > a["price"] and rb < ra - 2:
                kind, bias = "Bullish hidden divergence", 1
        if kind:
            out.append(dict(name=kind, bias=bias, i1=int(a["idx"]), p1=float(a["price"]), i2=int(b["idx"]),
                            p2=float(b["price"]), rsi1=float(ra), rsi2=float(rb), bars_ago=int(n - 1 - b["idx"])))
    return out


def volume_profile(df, window=300, bins=40):
    """Volume at price over the last `window` candles: POC (most traded price) and the 70% value area."""
    d = df.iloc[-window:]
    v = d["volume"].to_numpy()
    if len(d) < 20 or not np.isfinite(v).all() or v.sum() <= 0:
        return None
    lo, hi = float(d["low"].min()), float(d["high"].max())
    if hi <= lo:
        return None
    edges = np.linspace(lo, hi, bins + 1)
    hist = np.zeros(bins)
    i0 = np.clip(np.searchsorted(edges, d["low"].to_numpy(), "right") - 1, 0, bins - 1)
    i1 = np.clip(np.searchsorted(edges, d["high"].to_numpy(), "left") - 1, 0, bins - 1)
    for a, b, vol in zip(i0, i1, v):
        b = max(a, b)
        hist[a:b + 1] += vol / (b - a + 1)
    poc = int(np.argmax(hist))
    lo_i = hi_i = poc
    total, acc = hist.sum(), hist[poc]
    while acc < 0.7 * total and (lo_i > 0 or hi_i < bins - 1):
        down = hist[lo_i - 1] if lo_i > 0 else -1
        up = hist[hi_i + 1] if hi_i < bins - 1 else -1
        if up >= down:
            hi_i += 1
            acc += hist[hi_i]
        else:
            lo_i -= 1
            acc += hist[lo_i]
    mids = (edges[:-1] + edges[1:]) / 2
    return dict(poc=float(mids[poc]), vah=float(edges[hi_i + 1]), val=float(edges[lo_i]), start_idx=int(len(df) - len(d)),
                bins=[[float(m), float(x)] for m, x in zip(mids, hist)])


def vwap_daily(df):
    """Session VWAP (resets at 00:00 UTC) for intraday charts."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    v = df["volume"].where(df["volume"] > 0, 1.0)
    day = df.index.floor("1D")
    num = (tp * v).groupby(day).cumsum()
    den = v.groupby(day).cumsum()
    return num / den


# ───────────────────────────── time: sessions, killzones, period levels ─────────────────────────────
def sessions(df, now=None):
    """ICT killzones (New York time) and the latest completed Asian range, for intraday charts."""
    now = now or pd.Timestamp.now(tz="UTC")
    ny = now.tz_convert("America/New_York")
    hh = ny.hour + ny.minute / 60
    current = [k for k, a, b in KILLZONES if a <= hh < b]
    silver = [k for k, a, b in SILVER_BULLETS if a <= hh < b]
    nxt, mins = None, None
    for k, a, b in KILLZONES:
        d = (a - hh) % 24 * 60
        if d > 0 and (mins is None or d < mins):
            nxt, mins = k, d
    out = dict(ny_time=ny.strftime("%H:%M"), ny_weekday=ny.strftime("%A"), active=current, silver_bullet=silver,
               next_killzone=nxt, minutes_to_next=None if mins is None else int(round(mins)))
    if len(df) == 0:
        return out
    idx_ny = df.index.tz_convert("America/New_York")
    midnight = ny.normalize()
    mo = df.index[idx_ny >= midnight]
    out["midnight_open"] = float(df.loc[mo[0], "open"]) if len(mo) else None
    out["midnight_open_idx"] = int(np.flatnonzero(idx_ny >= midnight)[0]) if len(mo) else None
    for back in range(0, 4):
        end = midnight - pd.Timedelta(days=back)
        mask = (idx_ny >= end - pd.Timedelta(hours=4)) & (idx_ny < end)
        if mask.sum() >= 2:
            sel = df[mask]
            hi, lo = float(sel["high"].max()), float(sel["low"].min())
            pos = np.flatnonzero(mask)
            later = df.iloc[pos[-1] + 1:]
            out["asia"] = dict(high=hi, low=lo, i1=int(pos[0]), i2=int(pos[-1]),
                               high_swept=bool(len(later) and later["high"].max() > hi),
                               low_swept=bool(len(later) and later["low"].min() < lo))
            break
    return out


def period_levels(daily, forming=None):
    """Previous day / week / month highs & lows and the current day / week / month opens (from daily candles)."""
    if daily is None or len(daily) < 2:
        return {}
    d = daily
    cur = forming.name if forming is not None else d.index[-1] + pd.Timedelta(days=1)
    out = dict(pdh=float(d["high"].iloc[-1]), pdl=float(d["low"].iloc[-1]), pd_date=str(d.index[-1].date()),
               day_open=float(forming["open"]) if forming is not None else None)
    ws = cur.normalize() - pd.Timedelta(days=int(cur.dayofweek))
    pw = d[(d.index >= ws - pd.Timedelta(days=7)) & (d.index < ws)]
    if len(pw):
        out.update(pwh=float(pw["high"].max()), pwl=float(pw["low"].min()))
    tw = d[d.index >= ws]
    out["week_open"] = float(tw["open"].iloc[0]) if len(tw) else out["day_open"]
    ms = cur.normalize() - pd.Timedelta(days=int(cur.day) - 1)
    pm_start = (ms - pd.Timedelta(days=1)).normalize()
    pm_start = pm_start - pd.Timedelta(days=int(pm_start.day) - 1)
    pm = d[(d.index >= pm_start) & (d.index < ms)]
    if len(pm):
        out.update(pmh=float(pm["high"].max()), pml=float(pm["low"].min()))
    tm = d[d.index >= ms]
    out["month_open"] = float(tm["open"].iloc[0]) if len(tm) else out["day_open"]
    return out


def round_levels(price, ref_atr, n=2):
    """Psychological round numbers: the step is the 1-2-2.5-5 × 10^k size closest to a day's range."""
    if not (ref_atr and ref_atr > 0 and price > 0):
        return []
    k = math.floor(math.log10(ref_atr))
    cands = [m * 10 ** e for e in (k - 1, k, k + 1) for m in (1, 2, 2.5, 5)]
    step = min(cands, key=lambda s: abs(math.log(s / ref_atr)))
    base = math.floor(price / step) * step
    lv = [base + j * step for j in range(-n + 1, n + 1)]
    return [dict(price=float(round(x, 12)), step=float(step)) for x in lv if x > 0]


# ───────────────────────────── regime ─────────────────────────────
def market_phase(df, A):
    """Trend / range / compression / expansion, with the numbers behind it."""
    c = df["close"]
    ax, pdi, mdi = adx(df)
    er = efficiency_ratio(c, 50)
    bw = bb_width(c)
    bw_pct = pct_rank(bw, 250, 50)
    atr = df["atr"]
    atr_ratio = atr / atr.rolling(200, min_periods=50).mean()
    t = int(A["trend"][-1]) if len(A["trend"]) else 0
    a_, e_, b_, r_ = float(ax.iloc[-1]), float(er.iloc[-1]), bw_pct.iloc[-1], atr_ratio.iloc[-1]
    b_ = float(b_) if np.isfinite(b_) else 0.5
    r_ = float(r_) if np.isfinite(r_) else 1.0
    strong = a_ >= 25 or e_ >= 0.35
    if t == 1:
        label = "Strong uptrend" if strong else "Uptrend (choppy)"
    elif t == -1:
        label = "Strong downtrend" if strong else "Downtrend (choppy)"
    else:
        label = "Range / no clear structure"
    notes = []
    if b_ <= 0.12:
        notes.append("volatility squeeze: Bollinger width in its lowest 12% of the last 250 candles; a breakout is"
                     " building, direction unknown")
    if r_ >= 1.6:
        notes.append(f"volatility expansion: ATR is {r_:.1f}× its 200-candle average; stops need room and"
                     " position size should be smaller")
    elif r_ <= 0.7:
        notes.append(f"quiet market: ATR is only {r_:.1f}× its average")
    return dict(label=label, trend=t, adx=a_, er=e_, bbw_pct=b_, atr_ratio=r_, notes=notes,
                di_plus=float(pdi.iloc[-1]), di_minus=float(mdi.iloc[-1]))

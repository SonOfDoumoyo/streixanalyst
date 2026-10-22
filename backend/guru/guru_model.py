"""guru_model.py: the analyst's experience. Probability models trained on many markets and timeframes.

Everything here is point-in-time: a candle only ever sees what was known when it closed.

Three models (gradient-boosted trees, scikit-learn):
  * race       For a trade entered now, with the target `a` ATR away and the stop `b` ATR away:
               P(target first), P(stop first) within 100 candles. Works for any plan, including the user's own.
  * touch      P(price reaches a level `d` ATR away within the next 24 candles). Gives the probability of every
               level on the chart, the fill odds of limit/stop orders and the expected range.
  * direction  Up / down / neither: which of ±k ATR is hit first within the next 24 candles.
Plus two tables learned from history:
  * setup evidence   How the SMC/ICT setups (trend pullback to OTE, liquidity sweep → MSS → FVG) actually did,
                     against what their geometry alone predicts. This shows whether the setups add any edge.
  * level reactions  When price reaches a swing high/low, equal highs/lows, PDH/PDL or an FVG: how often it
                     breaks through vs rejects, per asset class and timeframe group.
"""
import bisect
import math
import time
import warnings

import numpy as np
import pandas as pd

import guru_levels as gl
import market_data as md
import structure_engine as se

VERSION = "6.1"          # 6.1: adds the calibrated bull/bear bar (range and lean views)
LADDER = {"1m": ("15m", "1h", "4h"), "5m": ("1h", "4h", "1D"), "15m": ("1h", "4h", "1D"),
          "30m": ("4h", "1D", "1W"), "1h": ("4h", "1D", "1W"), "4h": ("1D", "1W", "1M"), "1D": ("1W", "1M"),
          "3D": ("1W", "1M"), "1W": ("1M",), "1M": ()}
H_RACE, H_TOUCH, H_DIR, EXPIRY = 100, 24, 24, 24
B_GRID = np.array([0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0])
RR_GRID = np.array([0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0])
D_GRID = np.array([0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0])
K_GRID = np.round(np.arange(1.0, 6.01, 0.25), 2)
WARMUP = 300

# round-trip cost (spread + fees) and extra slippage when a stop is hit, as fractions of price
COSTS = {"fx_major": (1.2e-4, 0.3e-4), "fx_cross": (2.5e-4, 0.5e-4), "fx_exotic": (15e-4, 3e-4),
         "gold": (2.0e-4, 0.5e-4), "silver": (6e-4, 1.5e-4), "metal": (6e-4, 1.5e-4), "index": (1.5e-4, 0.5e-4),
         "energy": (5e-4, 1e-4), "commodity": (10e-4, 2e-4), "crypto_major": (11e-4, 3e-4),
         "crypto_alt": (16e-4, 6e-4), "stock": (5e-4, 2e-4), "other": (5e-4, 2e-4)}

CLASS_COLS = ["cls_fx", "cls_metal", "cls_index", "cls_energy", "cls_crypto", "cls_stock"]
UNSIGNED = ["tf_log"] + CLASS_COLS + ["atr_pct", "atr_ratio", "vol_pct", "bbw_pct", "er50", "hour_sin", "hour_cos",
                                      "dow_sin", "dow_cos", "vol_z", "since_break", "break_choch"]
SIGNED = ["ret_1", "ret_4", "ret_16", "ret_64", "rsi_c", "ema20_d", "ema50_d", "ema200_d", "ema50_slope", "trend",
          "htf1_trend", "htf2_trend", "break_dir", "range_pos_c", "dealing_pos_c", "body"]
PAIRS = [("dist_bsl", "dist_ssl", "tgt_liq", "stp_liq"),
         ("since_bsl_sweep", "since_ssl_sweep", "since_tgt_sweep", "since_stp_sweep"),
         ("upper_wick", "lower_wick", "wick_against", "wick_with"),
         ("pdh_dist", "pdl_dist", "tgt_pd", "stp_pd")]
RAW_COLS = UNSIGNED + SIGNED + [p[0] for p in PAIRS] + [p[1] for p in PAIRS]
ALIGNED = UNSIGNED + SIGNED + [p[2] for p in PAIRS] + [p[3] for p in PAIRS]
GEO = ["a_atr", "b_atr", "implied", "log_rr"]
RACE_COLS = ALIGNED + GEO
TOUCH_COLS = ALIGNED + ["d_atr"]
DIR_COLS = ALIGNED
GEO_BASE = GEO + ["tf_log"] + CLASS_COLS
TOUCH_BASE = ["d_atr", "tf_log"] + CLASS_COLS
TF_GROUP = {"1m": "scalp", "5m": "scalp", "15m": "intraday", "30m": "intraday", "1h": "intraday", "4h": "swing",
            "1D": "swing", "3D": "position", "1W": "position", "1M": "position"}
LEVEL_TYPES = ("swing_high", "swing_low", "eqh", "eql", "pdh", "pdl", "fvg_bull", "fvg_bear", "random")


def cost_of(sub):
    return COSTS.get(sub, COSTS["other"])


def class_onehot(asset_class):
    return {"cls_fx": float(asset_class == "fx"), "cls_metal": float(asset_class == "metal"),
            "cls_index": float(asset_class == "index"),
            "cls_energy": float(asset_class in ("energy", "commodity")),
            "cls_crypto": float(asset_class == "crypto"), "cls_stock": float(asset_class in ("stock", "other"))}


# ───────────────────────────── point-in-time features ─────────────────────────────
def _structure_state(df, pivots, events, sweeps):
    """Per candle, using only swings confirmed by that candle's close: nearest untaken buy/sell-side liquidity,
    time since the last BOS/CHoCH and since each side was swept, position inside the dealing range."""
    n = len(df)
    h, l, c, a = (df[k].to_numpy(dtype=float) for k in ("high", "low", "close", "atr"))
    by_conf = {}
    for p in pivots:
        by_conf.setdefault(p["confirmed_idx"], []).append(p)
    ev_at = {e["idx"]: e for e in events}
    sw_at = {}
    for s in sweeps:
        sw_at.setdefault(s["idx"], []).append(s["side"])
    out = {k: np.full(n, np.nan) for k in ("dist_bsl", "dist_ssl", "dealing_pos")}
    for k in ("since_break", "break_dir", "break_choch", "since_bsl_sweep", "since_ssl_sweep"):
        out[k] = np.zeros(n)
    highs, lows = [], []
    top = bot = np.nan
    brk_i = bsl_i = ssl_i = -1
    bdir = bch = 0
    for i in range(n):
        for p in by_conf.get(i, ()):
            if p["type"] == "high":
                bisect.insort(highs, p["price"])
                top = p["price"]
            else:
                bisect.insort(lows, p["price"])
                bot = p["price"]
        if top == top:
            top = max(top, h[i])
        if bot == bot:
            bot = min(bot, l[i])
        if highs:
            k = bisect.bisect_left(highs, h[i])
            if k:
                del highs[:k]
            if len(highs) > 200:
                del highs[200:]
        if lows:
            k = bisect.bisect_right(lows, l[i])
            if k < len(lows):
                del lows[k:]
            if len(lows) > 200:
                del lows[:-200]
        e = ev_at.get(i)
        if e is not None:
            brk_i, bdir, bch = i, (1 if e["direction"] == "bullish" else -1), int(e["kind"] == "CHoCH")
        for side in sw_at.get(i, ()):
            if side == "buy-side":
                bsl_i = i
            else:
                ssl_i = i
        ai = a[i] if a[i] > 0 else np.nan
        if highs:
            out["dist_bsl"][i] = min(30.0, (highs[0] - c[i]) / ai)
        if lows:
            out["dist_ssl"][i] = min(30.0, (c[i] - lows[-1]) / ai)
        out["since_break"][i] = min(300, i - brk_i) if brk_i >= 0 else 300
        out["break_dir"][i], out["break_choch"][i] = bdir, bch
        out["since_bsl_sweep"][i] = min(300, i - bsl_i) if bsl_i >= 0 else 300
        out["since_ssl_sweep"][i] = min(300, i - ssl_i) if ssl_i >= 0 else 300
        if top == top and bot == bot and top > bot:
            out["dealing_pos"][i] = (c[i] - bot) / (top - bot)
    return out


def _known_series(values, known_at, query_times):
    """Value of a higher-timeframe series as known at each query time (last value whose candle had closed)."""
    s = pd.Series(np.asarray(values, dtype=float), index=pd.DatetimeIndex(known_at))
    s = s[~s.index.duplicated(keep="last")].sort_index()
    if len(s) == 0:
        return np.full(len(query_times), np.nan)
    pos = s.index.searchsorted(pd.DatetimeIndex(query_times), side="right") - 1
    vals = s.to_numpy()
    return np.where(pos >= 0, vals[np.clip(pos, 0, None)], np.nan)


def htf_trend_on(df, tf, hdf, htf):
    """Structure trend of the higher timeframe as known at the close of each candle of df."""
    if hdf is None or len(hdf) < 30:
        return np.full(len(df), np.nan)
    hd = hdf if "atr" in hdf.columns else se.add_atr(hdf[["open", "high", "low", "close", "volume"]].astype(float).copy())
    piv = se.find_pivots(hd, 3, 3)
    _, _, tr = se.detect_structure_breaks(hd, piv)
    return _known_series(tr, md.close_times(hd.index, htf), md.close_times(df.index, tf))


def daily_from_intraday(df, tf):
    """UTC daily candles built from intraday candles; stub days (< 25% of a normal day) are dropped."""
    key = df.index.floor("1D")
    g = df.groupby(key)
    d = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                      "close": g["close"].last(), "volume": g["volume"].sum(), "n": g["close"].count()})
    d = d[d["n"] >= 0.25 * 1440 / md.TF_MIN[tf]].drop(columns="n")
    d.index = md.to_utc_index(d.index)
    return d


def htf_frames_from(df, tf, asset_class):
    """Higher-timeframe candles built from df itself (training: keeps every timeframe consistent)."""
    out = {}
    for htf in LADDER[tf][:2]:
        try:
            if htf in md.INTRADAY:
                out[htf] = md.resample(df, htf, tf)
            else:
                d = daily_from_intraday(df, tf) if tf in md.INTRADAY else df
                if asset_class != "crypto":
                    d = md.trading_days(d)
                out[htf] = d if htf == "1D" else md.resample(d, htf, "1D")
        except Exception:
            out[htf] = None
    return out


def raw_features(df, tf, asset_class, htf=None, daily=None):
    """Feature frame (one row per candle, long-signed) + context (pivots, events, sweeps, trend, fvgs).
    htf: {timeframe: candles} for the ladder of `tf` (missing ones → NaN). daily: daily candles for PDH/PDL
    on intraday charts (None → built from df)."""
    if "atr" not in df.columns:
        df = se.add_atr(df[["open", "high", "low", "close", "volume"]].astype(float).copy())
    n = len(df)
    pivots = se.find_pivots(df, 3, 3)
    events, sweeps, trend = se.detect_structure_breaks(df, pivots)
    st = _structure_state(df, pivots, events, sweeps)
    cs, op, hi, lo, vol = df["close"], df["open"], df["high"], df["low"], df["volume"]
    atr = df["atr"].where(df["atr"] > 0)
    F = pd.DataFrame(index=df.index)
    F["tf_log"] = math.log(md.TF_MIN[tf])
    for k, val in class_onehot(asset_class).items():
        F[k] = val
    F["atr_pct"] = atr / cs * 100
    F["atr_ratio"] = atr / atr.rolling(200, min_periods=50).mean()
    F["vol_pct"] = (atr / cs).rolling(500, min_periods=100).rank(pct=True)
    F["bbw_pct"] = gl.pct_rank(gl.bb_width(cs), 500, 100)
    F["er50"] = gl.efficiency_ratio(cs, 50)
    idx = df.index
    if md.TF_MIN[tf] < 1440:
        hr = np.asarray(idx.hour + idx.minute / 60.0, dtype=float)
        F["hour_sin"], F["hour_cos"] = np.sin(2 * np.pi * hr / 24), np.cos(2 * np.pi * hr / 24)
    else:
        F["hour_sin"] = F["hour_cos"] = 0.0
    if md.TF_MIN[tf] <= 1440:
        dw = np.asarray(idx.dayofweek, dtype=float)
        F["dow_sin"], F["dow_cos"] = np.sin(2 * np.pi * dw / 7), np.cos(2 * np.pi * dw / 7)
    else:
        F["dow_sin"] = F["dow_cos"] = 0.0
    if float(vol.sum()) > 0:
        vm, vs = vol.rolling(96, min_periods=20).mean(), vol.rolling(96, min_periods=20).std()
        F["vol_z"] = ((vol - vm) / vs.replace(0, np.nan)).clip(-5, 5).fillna(0.0)
    else:
        F["vol_z"] = 0.0
    F["since_break"], F["break_choch"] = st["since_break"], st["break_choch"]
    for k in (1, 4, 16, 64):
        F[f"ret_{k}"] = ((cs - cs.shift(k)) / atr).clip(-30, 30)
    F["rsi_c"] = gl.rsi(cs) - 50.0
    for span in (20, 50, 200):
        e = gl.ema(cs, span)
        F[f"ema{span}_d"] = ((cs - e) / atr).clip(-30, 30)
        if span == 50:
            F["ema50_slope"] = ((e - e.shift(4)) / atr).clip(-10, 10)
    F["trend"] = np.asarray(trend, dtype=float)
    ladder = LADDER[tf]
    htf = htf or {}
    F["htf1_trend"] = htf_trend_on(df, tf, htf.get(ladder[0]), ladder[0]) if len(ladder) > 0 else np.nan
    F["htf2_trend"] = htf_trend_on(df, tf, htf.get(ladder[1]), ladder[1]) if len(ladder) > 1 else np.nan
    F["break_dir"] = st["break_dir"]
    lo96, hi96 = lo.rolling(96, min_periods=10).min(), hi.rolling(96, min_periods=10).max()
    F["range_pos_c"] = (cs - lo96) / (hi96 - lo96).replace(0, np.nan) - 0.5
    F["dealing_pos_c"] = st["dealing_pos"] - 0.5
    rng = (hi - lo).replace(0, np.nan)
    F["body"] = (cs - op) / rng
    F["upper_wick"] = (hi - np.maximum(op, cs)) / rng
    F["lower_wick"] = (np.minimum(op, cs) - lo) / rng
    F["dist_bsl"], F["dist_ssl"] = st["dist_bsl"], st["dist_ssl"]
    F["since_bsl_sweep"], F["since_ssl_sweep"] = st["since_bsl_sweep"], st["since_ssl_sweep"]
    if md.TF_MIN[tf] < 1440:
        d = daily if daily is not None and len(daily) > 2 else daily_from_intraday(df, tf)
        known = md.close_times(d.index, "1D")
        q = md.close_times(df.index, tf)
        pdh, pdl = _known_series(d["high"], known, q), _known_series(d["low"], known, q)
        F["pdh_dist"] = np.clip((pdh - cs.to_numpy()) / atr.to_numpy(), -50, 50)
        F["pdl_dist"] = np.clip((cs.to_numpy() - pdl) / atr.to_numpy(), -50, 50)
    else:
        F["pdh_dist"] = F["pdl_dist"] = np.nan
    F = F[RAW_COLS].replace([np.inf, -np.inf], np.nan)
    ctx = dict(df=df, pivots=pivots, events=events, sweeps=sweeps, trend=np.asarray(trend))
    return F, ctx


def align(F, s):
    """Features from the point of view of a trade/level in direction s (+1 long/up, -1 short/down).
    Signed features flip; paired features swap (e.g. distance to target-side vs stop-side liquidity)."""
    s = np.broadcast_to(np.asarray(s, dtype=float), (len(F),))
    out = {k: F[k].to_numpy(dtype=float) for k in UNSIGNED}
    for k in SIGNED:
        out[k] = F[k].to_numpy(dtype=float) * s
    for a_, b_, na, nb in PAIRS:
        A_, B_ = F[a_].to_numpy(dtype=float), F[b_].to_numpy(dtype=float)
        out[na] = np.where(s > 0, A_, B_)
        out[nb] = np.where(s > 0, B_, A_)
    return pd.DataFrame(out, index=F.index)[ALIGNED]


def flip_aligned(X):
    """Aligned features for direction s → the same features for direction -s."""
    Y = X.copy()
    for k in SIGNED:
        Y[k] = -X[k]
    for _, _, na, nb in PAIRS:
        Y[na], Y[nb] = X[nb], X[na]
    return Y


def align_row(row, sides):
    """One feature row (Series), repeated for several directions."""
    sides = np.atleast_1d(np.asarray(sides, dtype=float))
    F = pd.DataFrame([row[RAW_COLS].to_numpy(dtype=float)] * len(sides), columns=RAW_COLS)
    return align(F, sides).reset_index(drop=True)


# ───────────────────────────── setups (point-in-time) ─────────────────────────────
def find_setups(ctx, cost_frac, min_leg_atr=1.5, sweep_window=30):
    """The two SMC/ICT setups, detected candle by candle with only what was known at each close.
      pullback (OTE): after a BOS/CHoCH, limit at the 61.8% retracement of the impulse leg; stop 0.1 ATR beyond
                      the leg origin.
      sweep (MSS+FVG): a liquidity sweep, then a structure break the other way within 30 candles that leaves an
                      FVG; limit at the FVG edge; stop 0.1 ATR beyond the sweep extreme.
    Target for both: nearest untaken liquidity giving 2–6R, otherwise a fixed 2R."""
    df = ctx["df"]
    n = len(df)
    o, h, l, c, a = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close", "atr"))
    by_conf = {}
    for p in ctx["pivots"]:
        by_conf.setdefault(p["confirmed_idx"], []).append(p)
    ev_at = {}
    for e in ctx["events"]:
        ev_at.setdefault(e["idx"], []).append(e)
    fvgs = ctx.get("fvgs")
    if fvgs is None:
        fvgs = ctx["fvgs"] = se.find_fvgs(df, 0.25)
    fvg_at = {}
    for g in fvgs:
        fvg_at.setdefault(g["idx"], []).append(g)
    sw = {"sell-side": [s for s in ctx["sweeps"] if s["side"] == "sell-side"],
          "buy-side": [s for s in ctx["sweeps"] if s["side"] == "buy-side"]}
    sw_idx = {k: [s["idx"] for s in v] for k, v in sw.items()}
    highs, lows, out = [], [], []

    def target(d, entry, risk):
        lv = highs[bisect.bisect_right(highs, entry):] if d == 1 else lows[:bisect.bisect_left(lows, entry)][::-1]
        for x in lv:
            rr = abs(x - entry) / risk
            if rr >= 2.0:
                return (x, "liquidity") if rr <= 6.0 else (entry + d * 2.0 * risk, "fixed")
        return entry + d * 2.0 * risk, "fixed"

    for i in range(n):
        for p in by_conf.get(i, ()):
            if p["type"] == "high":
                bisect.insort(highs, p["price"])
            else:
                bisect.insort(lows, p["price"])
        if highs:
            k = bisect.bisect_left(highs, h[i])
            if k:
                del highs[:k]
        if lows:
            k = bisect.bisect_right(lows, l[i])
            if k < len(lows):
                del lows[k:]
        for e in ev_at.get(i, ()):
            ai = a[i]
            if not ai > 0:
                continue
            d = 1 if e["direction"] == "bullish" else -1
            j0 = e["from_idx"]
            # ── pullback to OTE
            if d == 1:
                oi = j0 + int(np.argmin(l[j0:i + 1]))
                origin, ext = l[oi], float(np.max(h[oi:i + 1]))
            else:
                oi = j0 + int(np.argmax(h[j0:i + 1]))
                origin, ext = h[oi], float(np.min(l[oi:i + 1]))
            L = abs(ext - origin)
            if L >= min_leg_atr * ai:
                entry = ext - d * 0.618 * L
                sl = origin - d * 0.1 * ai
                risk = d * (entry - sl)
                if d * (c[i] - entry) > 0 and risk >= 0.5 * ai and cost_frac * entry / risk <= 0.15:
                    tp, kind = target(d, entry, risk)
                    out.append(dict(family="pullback", idx=i, dir=d, entry=float(entry), sl=float(sl), tp=float(tp),
                                    risk=float(risk), target=kind, event_kind=e["kind"]))
            # ── liquidity sweep → MSS → FVG
            side = "sell-side" if d == 1 else "buy-side"
            k = bisect.bisect_left(sw_idx[side], i) - 1
            if k < 0 or i - sw_idx[side][k] > sweep_window:
                continue
            s0 = sw_idx[side][k]
            if (np.argmin(l[s0:i + 1]) if d == 1 else np.argmax(h[s0:i + 1])) != 0:
                continue
            gaps = [g for j in range(s0, i) for g in fvg_at.get(j, ())
                    if g["direction"] == e["direction"] and (g["filled_idx"] is None or g["filled_idx"] > i)]
            if not gaps:
                continue
            if d == 1:
                g = max(gaps, key=lambda g: g["top"])
                entry, sl = g["top"], float(np.min(l[s0:i + 1])) - 0.1 * ai
            else:
                g = min(gaps, key=lambda g: g["bottom"])
                entry, sl = g["bottom"], float(np.max(h[s0:i + 1])) + 0.1 * ai
            risk = d * (entry - sl)
            if d * (c[i] - entry) <= 0 or risk < 0.5 * ai or cost_frac * entry / risk > 0.15:
                continue
            tp, kind = target(d, entry, risk)
            out.append(dict(family="sweep", idx=i, dir=d, entry=float(entry), sl=float(sl), tp=float(tp),
                            risk=float(risk), target=kind, event_kind=e["kind"], sweep_idx=int(s0),
                            fvg_top=float(g["top"]), fvg_bottom=float(g["bottom"])))
    return out


def simulate(df, s, cost_frac, slip_frac, expiry=EXPIRY, max_hold=H_RACE):
    """Limit order at s['entry'] valid `expiry` candles (cancelled if the target trades first). After the fill:
    stop wins when stop and target share a candle; only the stop can trigger on the fill candle; gaps through the
    stop fill at the open; closed at market after `max_hold` candles. R is after costs."""
    o, h, l, c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    n, d = len(c), s["dir"]
    entry, sl, tp, risk = s["entry"], s["sl"], s["tp"], s["risk"]
    last = min(s["idx"] + expiry, n - 1)
    fill = None
    for j in range(s["idx"] + 1, last + 1):
        if (l[j] <= entry) if d == 1 else (h[j] >= entry):
            fill = j
            break
        if (h[j] >= tp) if d == 1 else (l[j] <= tp):
            return dict(status="missed")
    if fill is None:
        return dict(status="pending" if s["idx"] + expiry > n - 1 else "expired")
    end = fill + max_hold
    cost = cost_frac * entry
    for k in range(fill, min(end, n - 1) + 1):
        if (l[k] <= sl) if d == 1 else (h[k] >= sl):
            px = o[k] if k > fill and ((o[k] < sl) if d == 1 else (o[k] > sl)) else sl
            return dict(status="closed", outcome="sl", fill=fill, exit=k,
                        r=float(d * (px - entry) / risk - (cost + slip_frac * entry) / risk))
        if k > fill and ((h[k] >= tp) if d == 1 else (l[k] <= tp)):
            return dict(status="closed", outcome="tp", fill=fill, exit=k, r=float(d * (tp - entry) / risk - cost / risk))
    if end <= n - 1:
        return dict(status="closed", outcome="time", fill=fill, exit=end,
                    r=float(d * (c[end] - entry) / risk - cost / risk))
    return dict(status="open", fill=fill)


def hist_factors(af, rr, tf, ny_hour=None):
    """Confluence factors that can be checked in history too (af = aligned features of the setup candle)."""
    g = lambda k: af.get(k, np.nan)
    f = {"htf1_with": g("htf1_trend") > 0, "htf2_with": g("htf2_trend") > 0, "structure_with": g("trend") > 0,
         "discount_premium": g("dealing_pos_c") < 0, "recent_stop_side_sweep": g("since_stp_sweep") <= 30,
         "rr_2_5": rr >= 2.5}
    if md.TF_MIN[tf] < 240 and ny_hour is not None:
        f["killzone"] = (2 <= ny_hour < 5) or (7 <= ny_hour < 10) or (13.5 <= ny_hour < 16)
    return f


def grade_of(score):
    return "A" if score >= 5 else ("B" if score >= 3 else "C")


# ───────────────────────────── level reactions ─────────────────────────────
def _first_touch(arr, start, level, above):
    j, step, n = start, 64, len(arr)
    while j < n:
        seg = arr[j:j + step] >= level if above else arr[j:j + step] <= level
        hit = np.flatnonzero(seg)
        if len(hit):
            return j + int(hit[0])
        j, step = j + step, step * 2
    return None


def level_events(ctx, tf, horizon=H_TOUCH):
    """For every liquidity level as it became known: first touch, then break (close 0.25 ATR beyond) vs reject
    (1 ATR move away) within `horizon` candles."""
    df = ctx["df"]
    o, h, l, c, a = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close", "atr"))
    n = len(df)
    lv = []
    tol_eq = 0.15
    last_hi, last_lo = [], []
    for p in sorted(ctx["pivots"], key=lambda p: p["confirmed_idx"]):
        k0 = p["confirmed_idx"]
        if k0 >= n - 2 or not a[k0] > 0:
            continue
        if p["type"] == "high":
            eq = any(abs(p["price"] - x) <= tol_eq * a[k0] for x in last_hi[-5:])
            lv.append(("eqh" if eq else "swing_high", p["price"], k0, 1))
            last_hi.append(p["price"])
        else:
            eq = any(abs(p["price"] - x) <= tol_eq * a[k0] for x in last_lo[-5:])
            lv.append(("eql" if eq else "swing_low", p["price"], k0, -1))
            last_lo.append(p["price"])
    for g in ctx.get("fvgs") or []:
        k0 = g["idx"] + 1
        if k0 < n - 2:
            lv.append(("fvg_bull", g["top"], k0, -1) if g["direction"] == "bullish" else ("fvg_bear", g["bottom"], k0, 1))
    if md.TF_MIN[tf] < 1440:
        d = daily_from_intraday(df, tf)
        ends = md.close_times(d.index, "1D")
        kpos = df.index.searchsorted(ends)
        for (dh, dl), k0 in zip(d[["high", "low"]].to_numpy(), kpos):
            if 1 < k0 < n - 2:
                lv.append(("pdh", float(dh), int(k0) - 1, 1))
                lv.append(("pdl", float(dl), int(k0) - 1, -1))
    rng = np.random.default_rng(len(df))                      # baseline: random levels near price
    for k0 in rng.integers(WARMUP, max(WARMUP + 1, n - 2), size=max(50, len(lv) // 4)):
        if a[k0] > 0:
            side = 1 if rng.random() < 0.5 else -1
            lv.append(("random", float(c[k0] + side * rng.uniform(0.5, 3.0) * a[k0]), int(k0), side))
    rows = []
    for typ, price, k0, side in lv:
        t = _first_touch(h if side == 1 else l, k0 + 1, price, side == 1)
        if t is None or t >= n - 1:
            continue
        at = a[t] if a[t] > 0 else a[k0]
        seg = slice(t, min(n, t + horizon))
        if side == 1:
            br = np.flatnonzero(c[seg] >= price + 0.25 * at)
            rj = np.flatnonzero(l[seg] <= price - 1.0 * at)
        else:
            br = np.flatnonzero(c[seg] <= price - 0.25 * at)
            rj = np.flatnonzero(h[seg] >= price + 1.0 * at)
        tb = br[0] if len(br) else None
        tr = rj[0] if len(rj) else None
        if tb is None and tr is None:
            res = "unresolved"
        elif tr is None or (tb is not None and tb <= tr):
            res = "break"
        else:
            res = "reject"
        rows.append((typ, res))
    return rows


# ───────────────────────────── training samples ─────────────────────────────
def make_samples(F, ctx, meta, rng, n_rows, test_frac=0.3):
    """Random entry points with random stop/target/level geometry, labelled by what price did next."""
    df = ctx["df"]
    n = len(df)
    o, h, l, c, a = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close", "atr"))
    lo_, hi_ = min(WARMUP, max(150, n // 5)), n - H_RACE - 2
    if hi_ - lo_ < 150:
        return None
    rows = np.sort(rng.choice(np.arange(lo_, hi_), size=min(n_rows, hi_ - lo_), replace=False))
    split = int(n * (1 - test_frac))
    rows = rows[(rows >= split) | (rows < split - H_RACE)]                # purge: no label crosses the split
    rows = rows[np.isfinite(a[rows]) & (a[rows] > 0)]
    m = len(rows)
    if m < 50:
        return None
    test = rows >= split
    a0, c0, e0 = a[rows], c[rows], o[rows + 1]
    W = rows[:, None] + 1 + np.arange(H_RACE)[None, :]
    HH, LL = h[W], l[W]
    t_idx = df.index[rows]
    base = dict(test=test, t=t_idx, bar=rows, sid=meta["sid"], tf=meta["tf"], asset_class=meta["asset_class"])
    # race
    s = rng.choice([-1.0, 1.0], m)
    b = rng.choice(B_GRID, m)
    rr = rng.choice(RR_GRID, m)
    A_ = b * rr
    up, dn = (HH - e0[:, None]) / a0[:, None], (e0[:, None] - LL) / a0[:, None]
    fav, adv = np.where(s[:, None] > 0, up, dn), np.where(s[:, None] > 0, dn, up)
    t_tp = (np.maximum.accumulate(fav, 1) < A_[:, None]).sum(1)
    t_sl = (np.maximum.accumulate(adv, 1) < b[:, None]).sum(1)
    sl_first = (t_sl < H_RACE) & (t_sl <= t_tp)
    tp_first = (t_tp < H_RACE) & ~sl_first
    j = np.minimum(t_sl, H_RACE - 1)
    adv_open = s * (e0 - o[rows + 1 + j]) / a0
    r_sl = np.where((j >= 1) & (adv_open > b), -adv_open / b, -1.0)
    r_to = s * (c[rows + H_RACE] - e0) / (b * a0)
    R = np.where(tp_first, rr, np.where(sl_first, r_sl, r_to))
    cost_r = (meta["cost"] * e0 + np.where(sl_first, meta["slip"] * e0, 0.0)) / (b * a0)
    Fr = F.iloc[rows]
    race = align(Fr, s).assign(a_atr=A_, b_atr=b, implied=b / (A_ + b), log_rr=np.log(rr), y_tp=tp_first,
                               y_sl=sl_first, R=R, cost_r=cost_r, **base)
    # touch
    s2 = rng.choice([-1.0, 1.0], m)
    dd = rng.choice(D_GRID, m)
    up2 = (HH[:, :H_TOUCH] - c0[:, None]) / a0[:, None]
    dn2 = (c0[:, None] - LL[:, :H_TOUCH]) / a0[:, None]
    reach = np.where(s2 > 0, up2.max(1), dn2.max(1))
    touch = align(Fr, s2).assign(d_atr=dd, y=reach >= dd, **base)
    # direction (labels assigned later, once the barrier k is chosen on all data)
    upr = np.maximum.accumulate(up2[:, :H_DIR], 1)
    dnr = np.maximum.accumulate(dn2[:, :H_DIR], 1)
    t_up = np.stack([(upr < k).sum(1) for k in K_GRID], 1).astype(np.int16)
    t_dn = np.stack([(dnr < k).sum(1) for k in K_GRID], 1).astype(np.int16)
    dirs = align(Fr, 1.0).assign(**base)
    to32 = lambda X: X.astype({k: np.float32 for k in X.columns if X[k].dtype == np.float64})
    return dict(race=to32(race), touch=to32(touch), dir=to32(dirs), t_up=t_up, t_dn=t_dn)


def series_dataset(df, tf, asset_class, sub, sid, rng, n_rows, htf=None):
    """Features, random-entry samples, historical setups and level reactions for one market/timeframe."""
    df = se.add_atr(df[["open", "high", "low", "close", "volume"]].astype(float).copy())
    htf = htf if htf is not None else htf_frames_from(df, tf, asset_class)
    F, ctx = raw_features(df, tf, asset_class, htf=htf)
    ctx["fvgs"] = se.find_fvgs(df, 0.25)
    cost, slip = cost_of(sub)
    meta = dict(sid=sid, tf=tf, asset_class=asset_class, cost=cost, slip=slip)
    S = make_samples(F, ctx, meta, rng, n_rows)
    setups = []
    split = int(len(df) * 0.7)
    ny = df.index.tz_convert("America/New_York")
    for s in find_setups(ctx, cost):
        if s["idx"] < WARMUP:
            continue
        res = simulate(df, s, cost, slip)
        if res["status"] in ("pending", "open"):
            continue
        i, d = s["idx"], s["dir"]
        ai = float(df["atr"].iat[i])
        af = align(F.iloc[[i]], d).iloc[0]
        rr = abs(s["tp"] - s["entry"]) / s["risk"]
        fac = hist_factors(af, rr, tf, ny[i].hour + ny[i].minute / 60)
        rec = dict(sid=sid, tf=tf, asset_class=asset_class, family=s["family"], t=df.index[i], bar=i, test=i >= split,
                   dir=d, a_atr=abs(s["tp"] - s["entry"]) / ai, b_atr=s["risk"] / ai,
                   dist_atr=abs(float(df["close"].iat[i]) - s["entry"]) / ai, rr=rr,
                   cost_r=cost * s["entry"] / s["risk"], status=res["status"],
                   filled=res["status"] == "closed", outcome=res.get("outcome"), r=res.get("r", np.nan),
                   score=int(sum(bool(v) for v in fac.values())), **{f"f_{k}": bool(v) for k, v in fac.items()})
        rec.update({k: float(af[k]) for k in ALIGNED})
        setups.append(rec)
    lev = level_events(ctx, tf)
    return S, setups, lev, len(df)


def build_dataset(series, budget=dict(rows=450_000), seed=0, log=print):
    """series: list of dict(symbol, tf, asset_class, sub, df). Returns pooled training data."""
    rng = np.random.default_rng(seed)
    per = max(400, int(budget["rows"] / max(1, len(series))))
    race, touch, dirs, tups, tdns, setups, levels, info = [], [], [], [], [], [], [], []
    t0 = time.time()
    for k, sr in enumerate(series):
        sid = f"{sr['symbol']}|{sr['tf']}"
        try:
            S, st, lev, nbar = series_dataset(sr["df"], sr["tf"], sr["asset_class"], sr["sub"], sid, rng, per)
        except Exception as e:                                   # one bad series must not stop training
            log(f"  ⚠️ {sid}: {type(e).__name__}: {e}")
            continue
        if S is not None:
            race.append(S["race"])
            touch.append(S["touch"])
            dirs.append(S["dir"])
            tups.append(S["t_up"])
            tdns.append(S["t_dn"])
        setups.extend(st)
        for typ, res in lev:
            levels.append((sr["asset_class"], TF_GROUP[sr["tf"]], typ, res))
        info.append(dict(series=sid, asset_class=sr["asset_class"], tf=sr["tf"], candles=nbar,
                         samples=0 if S is None else len(S["race"]), setups=len(st), level_events=len(lev)))
        log(f"  [{k + 1}/{len(series)}] {sid:22s} {nbar:>8,} candles → {info[-1]['samples']:>6,} samples, "
            f"{len(st):>5,} setups ({time.time() - t0:.0f}s)")
    D = dict(race=pd.concat(race, ignore_index=True), touch=pd.concat(touch, ignore_index=True),
             dir=pd.concat(dirs, ignore_index=True), t_up=np.concatenate(tups), t_dn=np.concatenate(tdns),
             setups=pd.DataFrame(setups),
             levels=pd.DataFrame(levels, columns=["asset_class", "tf_group", "type", "result"]),
             info=pd.DataFrame(info))
    return D


# ───────────────────────────── models ─────────────────────────────
def _hgb(cols, mono=None, max_iter=300):
    from sklearn.ensemble import HistGradientBoostingClassifier
    cst = None
    if mono:
        cst = [int(mono.get(c, 0)) for c in cols]
    return HistGradientBoostingClassifier(max_iter=max_iter, learning_rate=0.08, max_leaf_nodes=31,
                                          min_samples_leaf=400, l2_regularization=1.0, early_stopping=True,
                                          validation_fraction=0.1, n_iter_no_change=15, random_state=0,
                                          monotonic_cst=cst)


MONO_TP = {"a_atr": -1, "b_atr": 1, "implied": 1, "log_rr": -1}
MONO_SL = {"a_atr": 1, "b_atr": -1, "implied": -1, "log_rr": 1}
MONO_TOUCH = {"d_atr": -1}


def _fit(X, y, cols, mono=None):
    m = _hgb(cols, mono)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        m.fit(X[cols].to_numpy(dtype=np.float32), np.asarray(y).astype(int))
    m.feature_names_ = list(cols)
    return m


def _p(m, X):
    return m.predict_proba(X[m.feature_names_].to_numpy(dtype=np.float32))


def choose_k(t_up, t_dn, target=1 / 3):
    neither = ((t_up >= H_DIR) & (t_dn >= H_DIR)).mean(0)
    j = int(np.argmin(np.abs(neither - target)))
    return float(K_GRID[j]), j


def dir_labels(t_up, t_dn, j):
    u, d = t_up[:, j], t_dn[:, j]
    return np.where((u < H_DIR) & (u < d), 0, np.where((d < H_DIR) & (d < u), 1, 2))


def _brier(p, y):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def _logloss(p, y):
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    y = np.asarray(y, dtype=float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def _auc(p, y):
    from sklearn.metrics import roc_auc_score
    y = np.asarray(y).astype(int)
    return float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else float("nan")


def calibration(p, y, bins=10):
    p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float)
    q = np.unique(np.quantile(p, np.linspace(0, 1, bins + 1)))
    if len(q) < 3:
        return pd.DataFrame(columns=["predicted", "actual", "n"])
    k = np.clip(np.searchsorted(q, p, side="right") - 1, 0, len(q) - 2)
    t = pd.DataFrame({"k": k, "p": p, "y": y}).groupby("k").agg(predicted=("p", "mean"), actual=("y", "mean"),
                                                                 n=("y", "size"))
    return t.reset_index(drop=True).round(4)


def fit_direction_cal(P, y):
    """Isotonic calibration, one curve per outcome: up, down and sideways (range). Fitted on held-out predictions.

    Why: the raw shares are too spread out (the model is too confident at the top). The curves pull them back to the
    rate that actually happened. They cannot create skill that the model does not have."""
    from sklearn.isotonic import IsotonicRegression
    cal = {}
    for i, name in enumerate(("up", "down", "sideways")):
        cal[name] = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(
            np.asarray(P[:, i], dtype=float), (np.asarray(y) == i).astype(float))
    return cal


def _cal_all(cal, P):
    """Calibrated up / down / sideways for each row (each curve's own output), and the same three scaled to 100%."""
    raw = np.stack([cal["up"].predict(P[:, 0]), cal["down"].predict(P[:, 1]), cal["sideways"].predict(P[:, 2])], 1)
    tot = raw.sum(1, keepdims=True)
    return raw, raw / np.where(tot > 0, tot, 1.0)


def _ll3(P, y):
    return float(-np.mean(np.log(np.clip(P[np.arange(len(y)), y], 1e-6, 1))))


def _f(x):
    return None if x is None else float(x)


def direction_view(cal, raw, direction_card):
    """What the app's bull/bear bar shows. `cal` is the brain's calibration (None for brains saved before it existed).
    `direction_card` is the model card's direction block. Its test numbers travel with each view, so the app can say
    how much skill sits behind it.
    Range uses the model's own sideways share: on data it never trained on, the calibrated version was further off at
    the top end, so the raw share is what the app shows. Lean uses the calibration, which helped in testing."""
    if not cal:
        return dict(calibrated=False)
    dc = direction_card or {}
    prior = dc.get("prior") or [None, None, None]
    raw_arr = np.asarray(raw, dtype=float).reshape(1, 3)
    _, lean = _cal_all(cal, raw_arr)
    return dict(calibrated=True,
                range=dict(p=_f(raw_arr[0, 2]), base=_f(prior[2]), skill_auc=_f(dc.get("auc_neither"))),
                lean=dict(up=_f(lean[0, 0]), down=_f(lean[0, 1]), sideways=_f(lean[0, 2]),
                          skill_auc=_f(dc.get("auc_up_vs_down"))))


def block_keys(X, size=2 * H_RACE):
    """Independent-ish blocks: per series, consecutive stretches of 200 candles (a trade lasts up to 100)."""
    return X["sid"].astype(str).to_numpy() + "|" + (np.asarray(X["bar"]) // size).astype(str)


def block_t(values, keys):
    """t-stat of the mean, treating each block of candles as one observation (trades overlap in time)."""
    s = pd.Series(np.asarray(values, dtype=float)).groupby(np.asarray(keys)).mean()
    if len(s) < 3 or s.std() == 0:
        return float("nan")
    return float(s.mean() / s.std() * np.sqrt(len(s)))


def ev_r(p_tp, p_sl, rr, cost_r):
    """Expected R of a trade (timeouts counted as 0R) after costs."""
    return p_tp * rr - p_sl - cost_r


def train(D, log=print):
    """Walk-forward evaluation (train on the first 70% of every series, test on the last 30%), then final
    models on everything. Returns the bundle: models + model card + experience tables."""
    t0 = time.time()
    R, T, Dd = D["race"], D["touch"], D["dir"]
    k_dir, kj = choose_k(D["t_up"][~Dd["test"].to_numpy()], D["t_dn"][~Dd["test"].to_numpy()])
    Dd = Dd.assign(y=dir_labels(D["t_up"], D["t_dn"], kj))
    card = dict(rows=dict(race=len(R), touch=len(T), direction=len(Dd)), k_dir=k_dir)
    tr, te = ~R["test"].to_numpy(), R["test"].to_numpy()
    log(f"Evaluating on the last 30% of every series ({te.sum():,} race / {T['test'].sum():,} touch rows)...")
    m_tp = _fit(R[tr], R["y_tp"][tr], RACE_COLS, MONO_TP)
    m_sl = _fit(R[tr], R["y_sl"][tr], RACE_COLS, MONO_SL)
    m_geo = _fit(R[tr], R["y_tp"][tr], GEO_BASE, MONO_TP)
    Rt = R[te]
    p_tp, p_sl, p_geo = _p(m_tp, Rt)[:, 1], _p(m_sl, Rt)[:, 1], _p(m_geo, Rt)[:, 1]
    p_rw = Rt["b_atr"] / (Rt["a_atr"] + Rt["b_atr"])
    y = Rt["y_tp"].to_numpy().astype(float)
    rr = Rt["a_atr"] / Rt["b_atr"]
    net = Rt["R"] - Rt["cost_r"]
    blocks = block_keys(Rt)
    ev_m, ev_g = ev_r(p_tp, p_sl, rr, Rt["cost_r"]), ev_r(p_geo, 1 - p_geo, rr, Rt["cost_r"])
    rows = []
    for name, mask in (("every trade", np.ones(len(Rt), bool)), ("model EV > 0", ev_m > 0),
                       ("model EV > +0.10R", ev_m > 0.10), ("geometry-only EV > 0", ev_g > 0)):
        rows.append(dict(selection=name, trades=int(mask.sum()), avg_net_R=float(net[mask].mean()) if mask.any() else np.nan,
                         t_stat=block_t(net[mask], blocks[mask]) if mask.sum() > 30 else np.nan))
    card["race"] = dict(brier_model=_brier(p_tp, y), brier_geometry=_brier(p_geo, y), brier_random_walk=_brier(p_rw, y),
                        logloss_model=_logloss(p_tp, y), logloss_geometry=_logloss(p_geo, y),
                        auc_model=_auc(p_tp, y), auc_geometry=_auc(p_geo, y),
                        skill_vs_geometry=1 - _brier(p_tp, y) / _brier(p_geo, y),
                        sl_brier_model=_brier(p_sl, Rt["y_sl"]), calibration=calibration(p_tp, y),
                        ev_test=pd.DataFrame(rows))
    by = []
    for (cls, tf_), g in Rt.assign(p=p_tp, pg=p_geo).groupby(["asset_class", "tf"]):
        if len(g) >= 300:
            yy = g["y_tp"].astype(float)
            by.append(dict(asset_class=cls, tf=tf_, rows=len(g), win_rate=float(yy.mean()),
                           skill_vs_geometry=1 - _brier(g["p"], yy) / _brier(g["pg"], yy)))
    card["race_by_market"] = pd.DataFrame(by)
    trT, teT = ~T["test"].to_numpy(), T["test"].to_numpy()
    m_touch = _fit(T[trT], T["y"][trT], TOUCH_COLS, MONO_TOUCH)
    m_tbase = _fit(T[trT], T["y"][trT], TOUCH_BASE, MONO_TOUCH)
    Tt = T[teT]
    pt, pb = _p(m_touch, Tt)[:, 1], _p(m_tbase, Tt)[:, 1]
    yt = Tt["y"].to_numpy().astype(float)
    card["touch"] = dict(brier_model=_brier(pt, yt), brier_distance_only=_brier(pb, yt), auc_model=_auc(pt, yt),
                         auc_distance_only=_auc(pb, yt), skill_vs_distance=1 - _brier(pt, yt) / _brier(pb, yt),
                         calibration=calibration(pt, yt))
    trD, teD = ~Dd["test"].to_numpy(), Dd["test"].to_numpy()
    m_dir = _fit(Dd[trD], Dd["y"][trD], DIR_COLS)
    Dt = Dd[teD]
    pdir = _p(m_dir, Dt)
    yd = Dt["y"].to_numpy()
    prior = np.bincount(Dd["y"][trD], minlength=3) / trD.sum()
    ll = lambda P: float(-np.mean(np.log(np.clip(P[np.arange(len(yd)), yd], 1e-6, 1))))
    card["direction"] = dict(k_atr=k_dir, horizon=H_DIR, prior=prior.round(4).tolist(),
                             logloss_model=ll(pdir), logloss_prior=ll(np.tile(prior, (len(yd), 1))),
                             auc_up=_auc(pdir[:, 0], yd == 0), auc_down=_auc(pdir[:, 1], yd == 1),
                             auc_neither=_auc(pdir[:, 2], yd == 2), calibration_up=calibration(pdir[:, 0], yd == 0))
    card["direction"]["skill_vs_prior"] = 1 - card["direction"]["logloss_model"] / card["direction"]["logloss_prior"]
    resolved = yd != 2                                            # pure direction skill: up vs down only
    card["direction"]["auc_up_vs_down"] = _auc(pdir[resolved, 0] / (pdir[resolved, 0] + pdir[resolved, 1]),
                                               yd[resolved] == 0)
    # Calibration for the bull/bear bar. Fit on the first half of every series' test period, then check on the second
    # half, which the curves never saw. The card records both, so the result can be judged, not assumed.
    fit_side = (Dt["bar"] <= Dt.groupby("sid")["bar"].transform("median")).to_numpy()
    cal = fit_direction_cal(pdir[fit_side], yd[fit_side])
    ev_P, ev_y = pdir[~fit_side], yd[~fit_side]
    cal_raw, cal_lean = _cal_all(cal, ev_P)
    card["direction_cal"] = dict(
        fit_rows=int(fit_side.sum()), eval_rows=int((~fit_side).sum()),
        logloss_raw=_ll3(ev_P, ev_y), logloss_cal=_ll3(cal_lean, ev_y),
        up_before=calibration(ev_P[:, 0], ev_y == 0), up_after=calibration(cal_raw[:, 0], ev_y == 0),
        sideways_before=calibration(ev_P[:, 2], ev_y == 2), sideways_after=calibration(cal_raw[:, 2], ev_y == 2))
    # setup evidence (test period only, predictions from the walk-forward models)
    S = D["setups"]
    ev_rows, grade_rows = [], []
    if len(S):
        St = S[S["test"]].copy()
        if len(St):
            St["p_tp"] = _p(m_tp, St.assign(implied=St["b_atr"] / (St["a_atr"] + St["b_atr"]),
                                             log_rr=np.log(St["a_atr"] / St["b_atr"])))[:, 1]
            St["p_fill"] = _p(m_touch, flip_aligned(St[ALIGNED]).assign(d_atr=St["dist_atr"].to_numpy()))[:, 1]
            St["grade"] = St["score"].map(grade_of)
            St["win"] = (St["outcome"] == "tp").astype(float)
            St["blk"] = block_keys(St)
            for keys, g in [(("ALL",), St)] + [((f,), g) for f, g in St.groupby("family")]:
                f_ = g[g["filled"]]
                ev_rows.append(dict(family=keys[0], setups=len(g), fill_rate=float(g["filled"].mean()),
                                    predicted_fill=float(g["p_fill"].mean()), filled=len(f_),
                                    win_rate=float(f_["win"].mean()) if len(f_) else np.nan,
                                    predicted_win=float(f_["p_tp"].mean()) if len(f_) else np.nan,
                                    excess_win=float((f_["win"] - f_["p_tp"]).mean()) if len(f_) else np.nan,
                                    excess_t=block_t(f_["win"] - f_["p_tp"], f_["blk"]) if len(f_) > 30 else np.nan,
                                    avg_net_R=float(f_["r"].mean()) if len(f_) else np.nan,
                                    t_stat=block_t(f_["r"], f_["blk"]) if len(f_) > 30 else np.nan))
            for (fam, gr), g in St[St["filled"]].groupby(["family", "grade"]):
                grade_rows.append(dict(family=fam, grade=gr, trades=len(g), win_rate=float(g["win"].mean()),
                                       predicted_win=float(g["p_tp"].mean()),
                                       excess_win=float((g["win"] - g["p_tp"]).mean()),
                                       avg_net_R=float(g["r"].mean()),
                                       t_stat=block_t(g["r"], g["blk"]) if len(g) > 30 else np.nan))
    card["setups"] = pd.DataFrame(ev_rows)
    card["setup_grades"] = pd.DataFrame(grade_rows)
    log(f"  evaluation done ({time.time() - t0:.0f}s). Training the final models on all data...")
    final = dict(p_tp=_fit(R, R["y_tp"], RACE_COLS, MONO_TP), p_sl=_fit(R, R["y_sl"], RACE_COLS, MONO_SL),
                 p_touch=_fit(T, T["y"], TOUCH_COLS, MONO_TOUCH), p_dir=_fit(Dd, Dd["y"], DIR_COLS))
    L = D["levels"]
    lev = pd.DataFrame()
    if len(L):
        lev = (L.groupby(["asset_class", "tf_group", "type"])["result"].value_counts(normalize=False)
               .unstack(fill_value=0).reset_index())
        for col in ("break", "reject", "unresolved"):
            if col not in lev:
                lev[col] = 0
        lev["n"] = lev[["break", "reject", "unresolved"]].sum(1)
        for col in ("break", "reject", "unresolved"):
            lev[f"p_{col}"] = lev[col] / lev["n"]
    setup_tab = pd.DataFrame()
    if len(S):
        Sf = S[S["filled"]].assign(win=lambda x: (x["outcome"] == "tp").astype(float),
                                   tf_group=lambda x: x["tf"].map(TF_GROUP), grade=lambda x: x["score"].map(grade_of))
        setup_tab = (Sf.groupby(["family", "asset_class", "tf_group", "grade"])
                     .agg(trades=("win", "size"), win_rate=("win", "mean"), avg_net_R=("r", "mean")).reset_index())
    fill_ratio = 1.0
    if len(card["setups"]) and card["setups"]["predicted_fill"].iloc[0] > 0:
        fill_ratio = float(np.clip(card["setups"]["fill_rate"].iloc[0] / card["setups"]["predicted_fill"].iloc[0],
                                   0.5, 1.2))
    card["fill_ratio"] = fill_ratio
    card["seconds"] = round(time.time() - t0, 1)
    log(f"  done in {card['seconds']:.0f}s")
    return dict(version=VERSION, created=str(pd.Timestamp.now(tz="UTC")), models=final, card=card,
                k_dir=k_dir, fill_ratio=fill_ratio, level_stats=lev, setup_stats=setup_tab, info=D["info"],
                direction_cal=cal, cols=dict(race=RACE_COLS, touch=TOUCH_COLS, dir=DIR_COLS))


def save(bundle, path):
    import joblib
    joblib.dump(bundle, path, compress=3)


def load(path):
    import joblib
    return joblib.load(path)


# ───────────────────────────── live predictions ─────────────────────────────
class Brain:
    """Thin wrapper the analyst uses: probabilities for a feature row (see raw_features)."""

    untrained = False

    def __init__(self, bundle):
        self.b = bundle
        self.m = bundle["models"]
        self.k_dir = bundle["k_dir"]
        # heads trained in Notebook 10 (None in older brains): liquidity (liquidity_head.py), strategies
        # (strategy_head.py)
        self.liq = bundle.get("liquidity_head")
        self.strat = bundle.get("strategy_head")

    def race(self, row, sides, a_atr, b_atr):
        sides, a_atr, b_atr = np.broadcast_arrays(np.atleast_1d(np.asarray(sides, dtype=float)),
                                                  np.atleast_1d(np.asarray(a_atr, dtype=float)),
                                                  np.atleast_1d(np.asarray(b_atr, dtype=float)))
        # stay inside the geometry the model was trained on (stops 0.5–4 ATR, R:R 0.5–5)
        rr = np.clip(np.maximum(a_atr, 1e-9) / np.maximum(b_atr, 1e-9), RR_GRID.min(), RR_GRID.max())
        b_atr = np.clip(b_atr, B_GRID.min(), B_GRID.max())
        a_atr = b_atr * rr
        X = align_row(row, sides).assign(a_atr=a_atr, b_atr=b_atr, implied=b_atr / (a_atr + b_atr),
                                         log_rr=np.log(a_atr / b_atr))
        p_tp, p_sl = _p(self.m["p_tp"], X)[:, 1], _p(self.m["p_sl"], X)[:, 1]
        tot = p_tp + p_sl
        scale = np.where(tot > 1, 1 / tot, 1.0)
        p_tp, p_sl = p_tp * scale, p_sl * scale
        return p_tp, p_sl, np.clip(1 - p_tp - p_sl, 0, 1)

    def touch(self, row, sides, d_atr):
        sides, d_atr = np.broadcast_arrays(np.atleast_1d(np.asarray(sides, dtype=float)),
                                           np.atleast_1d(np.asarray(d_atr, dtype=float)))
        X = align_row(row, sides).assign(d_atr=np.clip(np.abs(d_atr), 0.0, 12.0))
        p = _p(self.m["p_touch"], X)[:, 1]
        return np.where(np.abs(d_atr) <= 0.02, 1.0, p)

    def direction(self, row):
        X = align_row(row, [1.0])
        return _p(self.m["p_dir"], X)[0]

    def direction_bar(self, row, raw=None):
        """The bull/bear bar's numbers: a calibrated range view and a calibrated lean view (see direction_view)."""
        raw = self.direction(row) if raw is None else raw
        return direction_view(self.b.get("direction_cal"), raw, self.b.get("card", {}).get("direction"))

    def expected_range(self, row, q=0.15):
        """Distances (ATR) up and down that price reaches with probability q within 24 candles."""
        grid = np.round(np.arange(0.1, 12.01, 0.05), 3)
        out = {}
        for side, name in ((1.0, "up"), (-1.0, "down")):
            p = self.touch(row, np.full(len(grid), side), grid)
            p = np.minimum.accumulate(p)
            k = np.flatnonzero(p <= q)
            out[name] = float(grid[k[0]]) if len(k) else float(grid[-1])
        return out


class FallbackBrain:
    """Random-walk approximations, used only when no trained bundle is loaded (flagged as 'untrained')."""
    k_dir = 3.0
    untrained = True
    liq = None
    strat = None

    def __init__(self):
        self.b = dict(card={}, level_stats=pd.DataFrame(), setup_stats=pd.DataFrame(), fill_ratio=0.85)

    def race(self, row, sides, a_atr, b_atr):
        a_atr, b_atr = np.broadcast_arrays(np.atleast_1d(np.asarray(a_atr, dtype=float)),
                                           np.atleast_1d(np.asarray(b_atr, dtype=float)))
        p_to = np.clip((a_atr + b_atr) ** 2 / 400, 0, 0.6)          # rough share of trades still open after 100 candles
        p_tp = (1 - p_to) * b_atr / (a_atr + b_atr)
        return p_tp, (1 - p_to) * a_atr / (a_atr + b_atr), p_to

    def touch(self, row, sides, d_atr):
        from math import erf, sqrt
        d = np.abs(np.atleast_1d(np.asarray(d_atr, dtype=float)))
        z = d / (0.8 * np.sqrt(H_TOUCH))
        return np.array([min(1.0, 2 * (1 - 0.5 * (1 + erf(x / sqrt(2))))) for x in z])

    def direction(self, row):
        return np.array([1 / 3, 1 / 3, 1 / 3])

    def direction_bar(self, row, raw=None):
        return dict(calibrated=False)          # no trained brain: the app shows no bar numbers

    def expected_range(self, row, q=0.15):
        from statistics import NormalDist
        d = NormalDist().inv_cdf(1 - q / 2) * 0.8 * np.sqrt(H_TOUCH)
        return {"up": float(d), "down": float(d)}

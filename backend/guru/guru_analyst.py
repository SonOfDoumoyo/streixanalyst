"""guru_analyst.py: the analyst. analyze("BTCUSDT", "1h") returns a full top-down analysis:

  * multi-timeframe bias, structure (HH/HL/LH/LL, BOS/CHoCH), market phase
  * key levels with their probability of being reached, and how such levels historically react
  * liquidity (BSL/SSL, equal highs/lows, sweeps), FVGs, order blocks, breakers, OTE, premium/discount
  * trendlines, channels, triangles/wedges, double tops/bottoms, head & shoulders, RSI divergences,
    volume profile, VWAP, sessions & ICT killzones, previous day/week/month levels, round numbers
  * trade plans (EP / SL / TP1-3) graded with a confluence checklist, their probabilities from the trained
    models, the historical evidence for that setup type, position size, leverage and liquidation price
  * a written report in the long step-by-step format (pro and beginner versions), and a JSON list of
    drawings the web app can draw on the chart one by one.

Research tool, not financial advice. Probabilities are calibrated estimates, not promises.
"""
import math
import time

import numpy as np
import pandas as pd

import guru_levels as gl
import guru_model as gm
import market_data as md
import structure_engine as se

BARS = {"1m": 1500, "5m": 1500, "15m": 1500, "30m": 1500, "1h": 1500, "4h": 1500, "1D": 1500, "3D": 800,
        "1W": 600, "1M": 300}
HTF_BARS = 600
SHOW_BARS = 300
USD_LIKE = {"USD", "USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI"}
SPECS = {"fx": dict(unit="units", lot=100_000, min_lot=0.01, step=0.01),
         "gold": dict(unit="oz", lot=100, min_lot=0.01, step=0.01),
         "silver": dict(unit="oz", lot=5000, min_lot=0.01, step=0.01),
         "metal": dict(unit="units", lot=1, min_lot=0.01, step=0.01),
         "index": dict(unit="index units", lot=1, min_lot=0.01, step=0.01),
         "energy": dict(unit="barrels", lot=1000, min_lot=0.01, step=0.01),
         "commodity": dict(unit="units", lot=1, min_lot=0.01, step=0.01),
         "stock": dict(unit="shares", lot=1, min_lot=1, step=1),
         "other": dict(unit="units", lot=1, min_lot=0.01, step=0.01),
         "crypto": dict(unit="coins", lot=None, min_notional=5.0)}
MAX_LEV = {"fx_major": 500, "fx_cross": 500, "fx_exotic": 100, "gold": 400, "silver": 200, "metal": 100,
           "index": 200, "energy": 100, "commodity": 50, "crypto_major": 125, "crypto_alt": 50, "stock": 20,
           "other": 20}
MMR = {"crypto_major": 0.005, "crypto_alt": 0.015}
STD_LEV = (1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100, 125)
COL = dict(up="#26a69a", down="#ef5350", text="#d1d4dc", choch="#f5c542", liq="#b388ff", sup="rgba(38,166,154,0.16)",
           res="rgba(239,83,80,0.16)", mid="rgba(209,212,220,0.10)", fvg_bull="rgba(41,98,255,0.20)",
           fvg_bear="rgba(255,152,0,0.20)", ob_bull="rgba(0,188,212,0.20)", ob_bear="rgba(233,30,99,0.20)",
           fib="#ffb74d", ote="rgba(255,183,77,0.13)", zig="rgba(209,212,220,0.45)", period="#90caf9",
           round="rgba(209,212,220,0.25)", trend="#4dd0e1", pattern="#ce93d8", user="#ffeb3b", vwap="#ff9800",
           ema20="#ffffff", ema50="#ffd54f", ema200="#7e57c2", poc="#f06292")
_STATE = {"brain": None}


def use_brain(bundle_or_brain):
    """Load the trained models (bundle dict, path or Brain) for every later analysis."""
    if isinstance(bundle_or_brain, str):
        bundle_or_brain = gm.load(bundle_or_brain)
    if isinstance(bundle_or_brain, dict):
        bundle_or_brain = gm.Brain(bundle_or_brain)
    _STATE["brain"] = bundle_or_brain
    return bundle_or_brain


# ───────────────────────────── formatting ─────────────────────────────
class Fmt:
    def __init__(self, dec):
        self.dec = int(dec)

    def p(self, x):
        if x is None or not np.isfinite(x):
            return "—"
        return f"{x:,.{self.dec}f}" if abs(x) >= 1000 else f"{x:.{self.dec}f}"

    def r(self, x):
        return "—" if x is None or not np.isfinite(x) else f"{x:.2f}".rstrip("0").rstrip(".")


def pct(x, d=0):
    return "—" if x is None or not np.isfinite(x) else f"{100 * x:.{d}f}%"


def money(x):
    if x is None or not np.isfinite(x):
        return "—"
    return f"${x:,.2f}" if abs(x) < 100_000 else f"${x:,.0f}"


def qty(x):
    if not np.isfinite(x) or x == 0:
        return "0"
    mag = math.floor(math.log10(abs(x)))
    dec = max(0, 3 - mag) if mag < 3 else 0
    s = f"{x:,.{min(dec, 8)}f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def level_history(d_, lo, hi, atr, horizon=24):
    """How price behaved at a level/zone in the loaded history: tests, holds (1 ATR rejection first) and breaks
    (a close 0.25 ATR through first). A new test needs 5 candles away from the level."""
    h, l, c = d_["high"].to_numpy(), d_["low"].to_numpy(), d_["close"].to_numpy()
    tol = 0.1 * atr
    touch = np.flatnonzero((l <= hi + tol) & (h >= lo - tol))
    tests, held, broke, last = 0, 0, 0, -10
    for i in touch:
        if i - last < 5 or i < 1 or i >= len(c) - 1:
            last = i if i - last < 5 else last
            continue
        last = i
        from_above = c[i - 1] > hi
        seg = slice(i, min(len(c), i + horizon))
        if from_above:
            brk = np.flatnonzero(c[seg] < lo - 0.25 * atr)
            rej = np.flatnonzero(h[seg] > hi + atr)
        else:
            brk = np.flatnonzero(c[seg] > hi + 0.25 * atr)
            rej = np.flatnonzero(l[seg] < lo - atr)
        tests += 1
        tb = brk[0] if len(brk) else None
        tr = rej[0] if len(rej) else None
        if tb is not None and (tr is None or tb <= tr):
            broke += 1
        elif tr is not None:
            held += 1
    return dict(tests=tests, held=held, broke=broke)


def ago(bars, tf):
    if bars is None:
        return ""
    if bars <= 0:
        return "on the last closed candle"
    m = bars * md.TF_MIN[tf]
    if m < 120:
        span = f"{m} min"
    elif m < 2880:
        span = f"{m / 60:.0f} h"
    elif m < 60 * 24 * 60:
        span = f"{m / 1440:.0f} days"
    else:
        span = f"{m / 43830:.0f} months"
    return f"{bars} candle{'s' if bars != 1 else ''} ago (~{span})"


def _safe(fn, default, notes, label):
    try:
        return fn()
    except Exception as e:                                   # one broken tool must not kill the analysis
        notes.append(f"{label} skipped ({type(e).__name__}: {str(e)[:80]})")
        return default


# ───────────────────────────── data & context ─────────────────────────────
def quote_to_usd(C, end=None):
    q, b = C["quote"], C["base"]
    if q in USD_LIKE:
        return 1.0, None
    if q == "USX":                                                  # quoted in US cents
        return 0.01, None
    if b in USD_LIKE:
        return 1.0 / C["price"], None
    order = ((f"{q}USD", False), (f"USD{q}", True)) if q in ("EUR", "GBP", "AUD", "NZD") else \
        ((f"USD{q}", True), (f"{q}USD", False))
    for sym, inv in order + ((f"{q}USDT", False),):
        try:
            p = md.get_candles(sym, "1D", bars=10, min_bars=2, end=end)["price"]
            return (1.0 / p if inv else p), None
        except Exception:
            continue
    return 1.0, f"couldn't convert {q} to USD: sizes below assume 1 {q} = $1"


def _htf_summary(h, d, A, brain, asset_class, frames):
    t = int(A["trend"][-1])
    ev = A["events"][-1] if A["events"] else None
    n = len(d)
    dr = gl.dealing_range(d, A)
    ph = gl.market_phase(d, A)
    out = dict(tf=h, trend=t, trend_word={1: "bullish", -1: "bearish", 0: "no clear trend"}[t],
               phase=ph["label"], last_event=None if ev is None else dict(kind=ev["kind"], direction=ev["direction"],
                                                                         level=ev["level"], bars_ago=n - 1 - ev["idx"]),
               swings=[s["label"] for s in A["swings"][-6:]], zone=None if dr is None else dr["zone"],
               range_pos=None if dr is None else dr["pos"])
    try:
        lad = gm.LADDER[h]
        F, _ = gm.raw_features(d, h, asset_class, htf={k: frames[k] for k in lad[:2] if k in frames})
        p = brain.direction(F.iloc[-1])
        out["p_up"], out["p_down"], out["p_flat"] = map(float, p)
    except Exception:
        pass
    return out


BULL_KW = ("support", "bullish", "demand", "sell-side", "pdl", "pwl", "pml", "range low", "uptrend line", "swing low",
           "equal lows")
BEAR_KW = ("resistance", "bearish", "supply", "buy-side", "pdh", "pwh", "pmh", "range high", "downtrend line",
           "swing high", "equal highs")


def polarity(label):
    """+1 = a buyer's level (support, demand, sell-side liquidity), -1 = a seller's level, 0 = neutral."""
    lab = label.lower()
    b, s = any(k in lab for k in BULL_KW), any(k in lab for k in BEAR_KW)
    return 1 if b and not s else (-1 if s and not b else 0)


def collect_levels(price, atr, items, merge_atr=0.2):
    """Merge levels within 0.2 ATR into one cluster; confluence = how many different things sit there."""
    items = [x for x in items if x.get("price") is not None and np.isfinite(x["price"])]
    items.sort(key=lambda x: x["price"])
    clusters = []
    for it in items:
        if clusters and it["price"] - clusters[-1]["hi"] <= merge_atr * atr:
            c = clusters[-1]
            c["items"].append(it)
            c["hi"] = max(c["hi"], it["price"])
        else:
            clusters.append(dict(items=[it], lo=it["price"], hi=it["price"]))
    out = []
    for c in clusters:
        its = c["items"]
        w = np.array([max(0.5, x.get("weight", 1.0)) for x in its])
        px = float(np.average([x["price"] for x in its], weights=w))
        kinds = []
        for x in its:
            if x["label"] not in kinds:
                kinds.append(x["label"])
        pol = float(sum(polarity(x["label"]) * max(0.5, x.get("weight", 1.0)) for x in its))
        out.append(dict(price=px, lo=c["lo"], hi=c["hi"], labels=kinds, types=sorted({x["type"] for x in its}),
                        strength=float(w.sum()), polarity=pol, side="above" if px > price else "below",
                        dist_atr=(px - price) / atr, start_idx=min(x.get("idx", 10 ** 9) for x in its)))
    return out


def reaction_stats(brain, asset_class, tf, typ):
    tab = brain.b.get("level_stats") if hasattr(brain, "b") else None
    if tab is None or len(tab) == 0:
        return None
    g = gm.TF_GROUP[tf]
    rows = tab[(tab["asset_class"] == asset_class) & (tab["tf_group"] == g)]
    if not len(rows):
        rows = tab[tab["tf_group"] == g]
    if not len(rows):
        return None

    def agg(t):
        r = rows[rows["type"] == t]
        if not len(r):
            return None
        n = float(r["n"].sum())
        return dict(n=int(n), p_break=float(r["break"].sum() / n), p_reject=float(r["reject"].sum() / n)) if n >= 30 else None

    s, base = agg(typ), agg("random")
    return None if s is None else dict(s, base_break=None if base is None else base["p_break"],
                                       base_reject=None if base is None else base["p_reject"])


# ───────────────────────────── plans ─────────────────────────────
def _targets(clusters, entry, sl, d, atr, extra=()):
    """TP1 = first level ≥ 1R, TP2 = first level ≥ 2R (else a fixed 2R), TP3 = the next one ≥ 3R (optional).
    Targets sit 3% of an ATR before the level, so they fill when the level is merely tagged."""
    risk = abs(entry - sl)
    # a target must be on the far side of the trade and be something the other side defends / liquidity rests at
    cands = [(c["price"], " + ".join(c["labels"][:2])) for c in clusters
             if d * (c["price"] - entry) > 0.3 * risk and d * c.get("polarity", 0) <= 0]
    cands += [(p, lab) for p, lab in extra if p is not None and d * (p - entry) > 0.3 * risk]
    cands.sort(key=lambda x: d * (x[0] - entry))
    tps = []
    for need, max_atr, fallback in ((1.0, 8.0, 1.5), (2.0, 10.0, 2.0), (3.0, 14.0, None)):
        pick = None
        last = tps[-1][0] if tps else entry
        for p, lab in cands:
            rr = d * (p - entry) / risk
            if rr >= need and abs(p - entry) <= max_atr * atr and d * (p - last) > 0.5 * risk:
                pick = (p - d * 0.03 * atr, lab)
                break
        if pick is None and fallback is not None:
            r_ = max(fallback, d * (last - entry) / risk + 0.75)
            if r_ * risk <= max_atr * atr:
                pick = (entry + d * r_ * risk, f"{r_:.1f}R (no level closer)")
        if pick is not None:
            tps.append(pick)
    return tps


def _plan(side, kind, setup, entry, sl, tps, why, invalid, expiry, family=None, extra=None):
    d = 1 if side == "long" else -1
    if not (d * (entry - sl) > 0) or not tps:
        return None
    tps = [t for t in tps if d * (t[0] - entry) > 0]
    if not tps:
        return None
    risk = abs(entry - sl)
    p = dict(side=side, dir=d, type=kind, setup=setup, family=family, entry=float(entry), sl=float(sl),
             tps=[float(t[0]) for t in tps], tp_labels=[t[1] for t in tps], risk=float(risk),
             rr=[abs(t[0] - entry) / risk for t in tps], why=list(why), invalidation=invalid, expiry=int(expiry))
    if extra:
        p.update(extra)
    return p


def make_plans(X):
    """Trade plans for both directions. Stops are widened to ≥ 0.5 ATR and ≥ 8× round-trip costs; if costs make that
    impossible (e.g. 1m charts), the unwidened plans are kept and flagged, so EP/SL/TP are always stated."""
    raw = _candidate_plans(X)
    if not raw:
        raw = _candidate_plans(X, max_trig_atr=60.0)
    out = _finalize_plans(raw, X)
    if not out:
        X["notes"].append("costs are too large relative to normal stops on this timeframe: plans shown with tight "
                          "stops are for reference only")
        out = _finalize_plans(raw, X, widen=False)
    return out


def _candidate_plans(X, max_trig_atr=5.0):
    """Candidate trade plans for both directions from everything the analysis found."""
    price, atr, clusters, A, d_ = X["price"], X["atr"], X["clusters"], X["A"], X["df"]
    plans = []
    liq = A["liquidity"]
    leg = X["leg"]
    above = [c for c in clusters if c["side"] == "above"]
    below = [c for c in clusters if c["side"] == "below"]
    # 1) trend pullback into OTE (ICT optimal trade entry)
    if leg is not None and leg["bars_old"] <= 150:
        d = leg["direction"]
        side = "long" if d == 1 else "short"
        L, ext, origin = leg["length"], leg["extreme"], leg["origin"]
        z_near, z_far = ext - d * 0.618 * L, ext - d * 0.786 * L
        if d * (price - origin) > 0.2 * atr and d * (price - z_far) > 0:
            inside = d * (price - z_near) <= 0
            entry = price if inside else z_near
            sl = origin - d * 0.1 * atr
            ext_lv = [(ext, "leg extreme (old high)" if d == 1 else "leg extreme (old low)"),
                      (origin + d * 1.272 * L, "1.272 extension"), (origin + d * 1.618 * L, "1.618 extension")]
            tps = _targets(clusters, entry, sl, d, atr, extra=ext_lv)
            p = _plan(side, "market" if inside else "limit", "Trend pullback into OTE (61.8–78.6% retracement)",
                      entry, sl, tps,
                      [f"{leg['event_kind']} {'up' if d == 1 else 'down'} {leg['bars_old']} candles ago started a "
                       f"{'bullish' if d == 1 else 'bearish'} leg of {L / atr:.1f} ATR",
                       "OTE = where ICT/SMC traders join the trend after a retracement"],
                      f"a close {'below' if d == 1 else 'above'} the leg origin {X['f'].p(origin)}", gm.EXPIRY,
                      family="pullback", extra=dict(zone=(min(z_near, z_far), max(z_near, z_far))))
            if p:
                plans.append(p)
    # 2) liquidity sweep → MSS → FVG (ICT / SMC reversal), from the same point-in-time detector as training
    for s in X["setups"][::-1][:6]:
        if s["family"] != "sweep" or s["idx"] < len(d_) - 1 - gm.EXPIRY:
            continue
        res = gm.simulate(d_, s, X["cost"], X["slip"])
        if res["status"] != "pending":
            continue
        d = s["dir"]
        if d * (price - s["entry"]) <= 0:
            continue
        tps = _targets(clusters, s["entry"], s["sl"], d, atr, extra=[(s["tp"], "liquidity target")])
        p = _plan("long" if d == 1 else "short", "limit", "Liquidity sweep → market structure shift → FVG entry",
                  s["entry"], s["sl"], tps,
                  [f"{'sell' if d == 1 else 'buy'}-side liquidity was swept {len(d_) - 1 - s['sweep_idx']} candles ago,"
                   f" then a {s['event_kind']} {'up' if d == 1 else 'down'} left an FVG "
                   f"{X['f'].p(s['fvg_bottom'])}–{X['f'].p(s['fvg_top'])}"],
                  f"price trading beyond the sweep extreme ({X['f'].p(s['sl'])})",
                  gm.EXPIRY - (len(d_) - 1 - s["idx"]), family="sweep",
                  extra=dict(zone=(s["fvg_bottom"], s["fvg_top"])))
        if p:
            plans.append(p)
        break
    # 3) reaction at the nearest demand / supply (zone, order block, FVG, HTF zone)
    for d, pool in ((1, below), (-1, above)):
        cands = [c for c in pool if abs(c["dist_atr"]) <= 4.0 and d * c.get("polarity", 0) > 0 and
                 any(t in c["types"] for t in ("zone", "ob", "fvg", "htf_zone", "user")) and
                 (c["hi"] - c["lo"]) <= 2.5 * atr]
        if not cands:
            continue
        c = max(cands, key=lambda c: c["strength"] - 0.3 * abs(c["dist_atr"]))
        if d == 1:
            entry, sl = c["hi"], c["lo"] - 0.15 * atr
        else:
            entry, sl = c["lo"], c["hi"] + 0.15 * atr
        if abs(entry - sl) < 0.3 * atr:
            sl = entry - d * 0.5 * atr
        if d * (price - entry) < 0:
            continue
        tps = _targets(clusters, entry, sl, d, atr)
        p = _plan("long" if d == 1 else "short", "limit", f"Reaction at {'demand' if d == 1 else 'supply'}: "
                  + " + ".join(c["labels"][:3]), entry, sl, tps,
                  [f"{len(c['labels'])} thing{'s' if len(c['labels']) > 1 else ''} line up at "
                   f"{X['f'].p(c['lo'])}–{X['f'].p(c['hi'])}: " + ", ".join(c["labels"][:4])],
                  f"a close {'below' if d == 1 else 'above'} {X['f'].p(c['lo'] if d == 1 else c['hi'])}", gm.EXPIRY,
                  extra=dict(zone=(c["lo"], c["hi"])))
        if p:
            plans.append(p)
    # 4) breakout of the nearest untaken swing (stop order = the BOS trigger)
    for d in (1, -1):
        trig = liq["buy_side"][0] if d == 1 and liq["buy_side"] else (
            liq["sell_side"][0] if d == -1 and liq["sell_side"] else None)
        opp = liq["sell_side"][0] if d == 1 and liq["sell_side"] else (
            liq["buy_side"][0] if d == -1 and liq["buy_side"] else None)
        if trig is None or abs(trig["price"] - price) > max_trig_atr * atr:
            continue
        entry = trig["price"] + d * 0.1 * atr
        sl = (opp["price"] - d * 0.1 * atr) if opp is not None else entry - d * 1.5 * atr
        if abs(entry - sl) > 2.0 * atr:                                # structure too far: volatility stop
            sl = entry - d * 1.5 * atr
        tps = _targets(clusters, entry, sl, d, atr)
        p = _plan("long" if d == 1 else "short", "stop", f"Breakout: {'buy' if d == 1 else 'sell'} stop beyond the "
                  f"swing {'high' if d == 1 else 'low'} (BOS trigger)", entry, sl, tps,
                  [f"a close beyond {X['f'].p(trig['price'])} would be a "
                   f"{'BOS' if X['trend'] == d else 'CHoCH'} {'up' if d == 1 else 'down'}"],
                  f"price back {'below' if d == 1 else 'above'} {X['f'].p(sl)}", gm.EXPIRY)
        if p:
            plans.append(p)
    # 5) chart patterns
    for pat in X["patterns"]:
        if pat["status"] != "forming" or pat.get("bias", 0) == 0:
            continue
        d = pat["bias"]
        if pat["kind"] == "lines":
            trig = pat["breakout_up"] if d == 1 else pat["breakout_down"]
            tgt = pat["target_up"] if d == 1 else pat["target_down"]
            stop_ref = pat["breakout_down"] if d == 1 else pat["breakout_up"]
        else:
            trig, tgt = pat["trigger"], pat.get("target_up" if d == 1 else "target_down")
            stop_ref = pat["invalidation"]
        if tgt is None or abs(trig - price) > 4 * atr:
            continue
        entry = trig + d * 0.1 * atr
        sl = stop_ref - d * 0.1 * atr
        if not d * (entry - sl) > 0.3 * atr or abs(entry - sl) > 5 * atr:
            continue
        tps = _targets(clusters, entry, sl, d, atr, extra=[(tgt, f"{pat['name'].lower()} measured target")])
        p = _plan("long" if d == 1 else "short", "stop", f"{pat['name']} breakout", entry, sl, tps,
                  [f"{pat['name']} ({'bullish' if d == 1 else 'bearish'} pattern), measured move to {X['f'].p(tgt)}"],
                  f"price back inside the pattern beyond {X['f'].p(sl)}", gm.EXPIRY)
        if p:
            plans.append(p)
    return plans


def _finalize_plans(plans, X, widen=True):
    price, atr, clusters = X["price"], X["atr"], X["clusters"]
    min_risk = max(0.5 * atr, 8 * X["cost"] * price) if widen else 0.25 * atr   # costs ≤ 12.5% of the risk
    out = []
    for p in plans:
        if p["type"] == "stop" and p["dir"] * (price - p["entry"]) >= 0:
            # the breakout is already happening on the forming candle: don't chase, plan the retest instead
            trig = p["entry"] - p["dir"] * 0.1 * atr
            side_w = ("buy the retest of the broken swing high" if p["dir"] == 1 else
                      "sell the retest of the broken swing low")
            p = dict(p, type="limit", entry=float(trig),
                     setup=f"Breakout retest: {side_w}" if p["setup"].startswith("Breakout:") else p["setup"] + " (retest)",
                     why=p["why"] + ["price is already through the trigger: wait for the candle to close beyond it and "
                                     "buy/sell the retest instead of chasing"])
            p["risk"] = abs(p["entry"] - p["sl"])
            if not p["dir"] * (p["entry"] - p["sl"]) > 0:
                continue
            p["rr"] = [abs(t - p["entry"]) / p["risk"] for t in p["tps"]]
        if p["risk"] < min_risk:
            d = p["dir"]
            sl = p["entry"] - d * min_risk
            q = _plan(p["side"], p["type"], p["setup"], p["entry"], sl,
                      _targets(clusters, p["entry"], sl, d, atr, extra=list(zip(p["tps"], p["tp_labels"]))),
                      p["why"] + [f"stop widened to {min_risk / atr:.2f} ATR so noise and costs don't decide the trade"],
                      p["invalidation"], p["expiry"], p.get("family"), {k: p[k] for k in ("zone",) if k in p})
            if q is None:
                continue
            p = q
        out.append(p)
    return out


def evaluate_plan(p, X, brain):
    """Probabilities, costs, confluence checklist and grade for one plan."""
    price, atr, row = X["price"], X["atr"], X["row"]
    d, entry, sl = p["dir"], p["entry"], p["sl"]
    risk = abs(entry - sl)
    b_atr = risk / atr
    a_atrs = np.array([abs(t - entry) / atr for t in p["tps"]])
    p_tp, p_sl, p_to = brain.race(row, np.full(len(a_atrs), float(d)), a_atrs, np.full(len(a_atrs), b_atr))
    dist = abs(price - entry) / atr
    if p["type"] == "market" or dist < 0.05:
        p_fill = 1.0
    elif p["type"] == "limit":
        p_fill = float(brain.touch(row, [-d], [dist])[0]) * float(getattr(brain, "b", {}).get("fill_ratio", 1.0) or 1.0)
    else:
        p_fill = float(brain.touch(row, [d], [dist])[0])
    cost_r = X["cost"] * entry / risk
    rr = np.array(p["rr"])
    be = (1 + cost_r) / (1 + rr)
    ev = p_tp * rr - p_sl - cost_r
    p.update(p_fill=min(1.0, p_fill), p_tp=p_tp.tolist(), p_sl=p_sl.tolist(), p_open=p_to.tolist(),
             breakeven=be.tolist(), ev=ev.tolist(), cost_r=float(cost_r), risk_atr=float(b_atr),
             chase_limit=float((p["tps"][min(1, len(p["tps"]) - 1)] + 1.5 * sl) / 2.5))
    # confluence checklist
    chk = []

    def add(ok, text, w, bad=0.0):
        chk.append(dict(ok=bool(ok), text=text, w=w if ok else bad))

    for k, (h, w, bad) in enumerate(zip(X["ladder"][:2], (1.5, 1.0), (-1.0, -0.5))):
        hs = X["htf"].get(h)
        if hs is None:
            continue
        add(hs["trend"] == d, f"{h} trend {'agrees' if hs['trend'] == d else 'is ' + hs['trend_word']}", w,
            bad if hs["trend"] == -d else 0.0)
    add(X["trend"] == d, f"{X['tf']} structure {'agrees' if X['trend'] == d else 'does not agree'}", 1.0)
    dr = X["dr"]
    if dr is not None:
        good = (entry <= dr["eq"]) if d == 1 else (entry >= dr["eq"])
        add(good, f"entry in {'discount' if d == 1 else 'premium'} (below/above 50% of the range)" if good else
            f"entry in {'premium' if d == 1 else 'discount'}: buying high / selling low in the range", 1.0)
    near = [c for c in X["clusters"] if c["lo"] - 0.3 * atr <= entry <= c["hi"] + 0.3 * atr]
    if p["type"] == "stop":
        room = [c for c in X["clusters"] if d * (c["price"] - entry) > 0.1 * atr and d * c.get("polarity", 0) < 0
                and abs(c["price"] - entry) < abs(entry - sl)]
        add(not room, "room to run after the breakout (no opposing level within 1R)" if not room else
            f"opposing level only {abs(room[0]['price'] - entry) / atr:.1f} ATR past the trigger", 1.0, -0.5)
    else:
        good = sorted({lab for c in near for lab in c["labels"] if polarity(lab) in (0, d)} -
                      {"round number", "daily open", "weekly open", "monthly open"})[:4]
        bad = sorted({lab for c in near for lab in c["labels"] if polarity(lab) == -d})[:2]
        if good and not bad:
            add(True, "entry at a key level: " + ", ".join(good), 1.5 if len(good) >= 2 else 1.0)
        elif bad:
            add(False, f"entry is into {'supply / resistance' if d == 1 else 'demand / support'}: " + ", ".join(bad),
                0.0, -0.5)
        else:
            add(False, "entry not at a key level", 0.0)
    sw = [s for s in X["A"]["sweeps"] if s["side"] == ("sell-side" if d == 1 else "buy-side")
          and len(X["df"]) - 1 - s["idx"] <= 30]
    add(bool(sw), f"{'sell' if d == 1 else 'buy'}-side liquidity swept recently (stop hunt done)" if sw else
        "no recent liquidity sweep in your favour", 1.0)
    tgt_liq = any("liquidity" in lab.lower() or "equal" in lab.lower() or lab.startswith(("PDH", "PDL", "PWH", "PWL"))
                  for lab in p["tp_labels"][:2])
    add(tgt_liq, "target is resting liquidity (draw on liquidity)" if tgt_liq else "target isn't a liquidity pool", 0.5)
    rsi = X["rsi"]
    mom_ok = (40 <= rsi <= 72) if d == 1 else (28 <= rsi <= 60)
    divs = [v for v in X["divs"] if v["bias"] == d]
    add(mom_ok or bool(divs), f"momentum fits (RSI {rsi:.0f}{', ' + divs[0]['name'].lower() if divs else ''})"
        if (mom_ok or divs) else f"RSI {rsi:.0f} is stretched {'up' if d == 1 else 'down'}", 0.5)
    pats = [q for q in X["patterns"] if q.get("bias_now") == d]
    if pats:
        add(True, f"pattern agrees: {pats[0]['name'].lower()}", 0.5)
    if X["intraday"] and X["asset_class"] != "crypto":
        s = X["session"]
        ok = bool([k for k in s.get("active", []) if "killzone" in k or "New York" in k]) or (
            s.get("minutes_to_next") is not None and s["minutes_to_next"] <= 60)
        add(ok, "inside / just before a London or New York killzone" if ok else
            f"outside the killzones (next: {s.get('next_killzone')} in {s.get('minutes_to_next')} min)", 0.5)
    rr2 = p["rr"][1] if len(p["rr"]) > 1 else p["rr"][0]
    add(rr2 >= 2.5, f"reward:risk {rr2:.1f} to TP2" + (" ≥ 2.5" if rr2 >= 2.5 else ""), 0.5)
    first = p["tps"][0]
    block = [c for c in X["clusters"] if c["strength"] >= 2.5 and d * (c["price"] - entry) > 0.1 * atr
             and d * (first - c["price"]) > 0.6 * abs(first - entry)]
    add(not block, "clear path to TP1" if not block else f"strong level in the way at {X['f'].p(block[0]['price'])}",
        0.5, -0.5)
    add(cost_r <= 0.10, f"costs {pct(cost_r)} of the risk" + (" (fine)" if cost_r <= 0.10 else
                                                             " (too high for this timeframe)"), 0.5,
        -1.0 if cost_r > 0.25 else 0.0)
    score = float(sum(c["w"] for c in chk))
    grade = "A+" if score >= 8 else "A" if score >= 6.5 else "B" if score >= 5 else "C" if score >= 3.5 else "D"
    ny = X["df"].index[-1].tz_convert("America/New_York")
    hf = gm.hist_factors(gm.align_row(row, [d]).iloc[0], rr2, X["tf"], ny.hour + ny.minute / 60)
    hgrade = gm.grade_of(sum(bool(v) for v in hf.values()))
    p.update(checklist=chk, score=score, grade=grade, hist_grade=hgrade, evidence=_evidence(p, X, brain, hgrade))
    return p


def _evidence(p, X, brain, hgrade):
    tab = brain.b.get("setup_stats") if hasattr(brain, "b") else None
    if p.get("family") is None or tab is None or len(tab) == 0:
        return None
    g = gm.TF_GROUP[X["tf"]]
    r = tab[(tab["family"] == p["family"]) & (tab["asset_class"] == X["asset_class"]) & (tab["tf_group"] == g)]
    scope = f"{X['asset_class']} {g}"
    if r["trades"].sum() < 50:
        r = tab[(tab["family"] == p["family"]) & (tab["tf_group"] == g)]
        scope = f"all markets, {g}"
    if r["trades"].sum() < 30:
        return None
    rg = r[r["grade"] == hgrade]
    n = float(r["trades"].sum())
    out = dict(scope=scope, trades=int(n), win_rate=float((r["win_rate"] * r["trades"]).sum() / n),
               avg_R=float((r["avg_net_R"] * r["trades"]).sum() / n), grade=hgrade)
    if rg["trades"].sum() >= 30:
        m = float(rg["trades"].sum())
        out.update(grade_trades=int(m), grade_win=float((rg["win_rate"] * rg["trades"]).sum() / m),
                   grade_R=float((rg["avg_net_R"] * rg["trades"]).sum() / m))
    return out


def size_position(p, X, account, risk_pct, leverage=None):
    """Units/lots for a fixed % risk, notional, fees, leverage band and (crypto) liquidation price."""
    C = X["C"]
    entry, sl, d = p["entry"], p["sl"], p["dir"]
    q2usd, warn = X["q2usd"]
    risk_amt = account * risk_pct / 100.0
    per_unit = abs(entry - sl) * q2usd
    units = risk_amt / per_unit
    notional = units * entry * q2usd
    cls, sub = C["asset_class"], C["sub"]
    spec = SPECS["crypto"] if cls == "crypto" else SPECS.get(sub if sub in ("gold", "silver") else cls, SPECS["other"])
    out = dict(account=account, risk_pct=risk_pct, risk_amount=risk_amt, units=units, unit=spec["unit"],
               notional=notional, fees=X["cost"] * notional, warn=warn)
    if cls == "crypto":
        min_units = spec["min_notional"] / (entry * q2usd)
        out.update(min_units=min_units, too_small=units < min_units)
    else:
        lots = units / spec["lot"]
        step = spec["step"]
        lots_r = math.floor(lots / step + 1e-9) * step
        min_units = spec["min_lot"] * spec["lot"]
        out.update(lot_size=spec["lot"], lots=lots, lots_rounded=lots_r, min_units=min_units,
                   too_small=lots_r < spec["min_lot"], risk_at_rounded=lots_r * spec["lot"] * per_unit)
    out["min_capital"] = min_units * per_unit / (risk_pct / 100.0)
    lev_needed = notional / account
    out["leverage_needed"] = lev_needed
    maxlev = MAX_LEV.get(sub, 20)
    if cls == "crypto":
        mmr = MMR.get(sub, 0.01)
        sl_frac = abs(entry - sl) / entry
        safe = max(1, min(maxlev, int(1.0 / (1.5 * sl_frac + mmr))))
        want = max(1.0, lev_needed, notional / (0.25 * account))
        rec = next((L for L in STD_LEV if want <= L <= safe), None)
        if rec is None:
            rec = max([L for L in STD_LEV if L <= safe] or [1])
        liq = lambda L: entry * (1 - 1.0 / L + mmr) if d == 1 else entry * (1 + 1.0 / L - mmr)
        out.update(mode="isolated", mmr=mmr, max_safe_leverage=safe, leverage=rec, margin=notional / rec,
                   margin_pct=notional / rec / account, liquidation=liq(rec),
                   liq_beyond_stop=(liq(rec) < sl) if d == 1 else (liq(rec) > sl))
        if leverage:
            L = float(leverage)
            out["user_leverage"] = dict(leverage=L, margin=notional / L, liquidation=liq(L),
                                        safe=(liq(L) < sl) if d == 1 else (liq(L) > sl))
    else:
        out.update(mode="cross (CFD/forex)", broker_max_leverage=maxlev,
                   margin_at={f"1:{L}": notional / L for L in (30, 100, 500) if L <= max(500, maxlev)},
                   leverage=max(1, math.ceil(lev_needed)))
    return out


# ───────────────────────────── user drawings ─────────────────────────────
def analyze_user_drawings(items, X, brain):
    """The user's own levels, zones and trendlines: where they are now, how often price reacted there, odds."""
    out, levels = [], []
    d_, atr, price = X["df"], X["atr"], X["price"]
    h, l, c = d_["high"].to_numpy(), d_["low"].to_numpy(), d_["close"].to_numpy()
    piv = X["A"]["pivots"]
    ts = md.epoch_s(d_.index)
    for k, it in enumerate(items or []):
        it = dict(it)
        typ = it.get("type", "hline")
        lab = it.get("label") or it.get("text") or f"your {typ}"
        res = dict(it, id=it.get("id", f"user{k}"))
        try:
            if typ in ("hline", "level"):
                lv = float(it["price"])
                lo = hi = lv
            elif typ == "zone":
                lo, hi = sorted([float(it["bottom"]), float(it["top"])])
                lv = (lo + hi) / 2
            elif typ == "trendline":
                t1, t2, p1, p2 = float(it["t1"]), float(it["t2"]), float(it["p1"]), float(it["p2"])
                slope = (p2 - p1) / (t2 - t1) if t2 != t1 else 0.0
                lv = p1 + slope * (ts[-1] - t1)
                lo = hi = lv
                line = p1 + slope * (ts - t1)
                tol = 0.25 * atr
                tch = [q for q in piv if abs(q["price"] - line[q["idx"]]) <= tol and ts[q["idx"]] >= min(t1, t2)]
                side_now = np.sign(c[-1] - line[-1])
                cross = np.flatnonzero(np.sign(c - line)[-30:] != side_now)
                res.update(value_now=float(lv), touches=len(tch),
                           status="broken recently" if len(cross) else
                           ("price above it" if side_now > 0 else "price below it"))
            else:
                out.append(res)
                continue
            tol = 0.25 * atr
            turns = len([q for q in piv if lo - tol <= q["price"] <= hi + tol])
            hist = level_history(d_, lo, hi, atr) if typ != "trendline" else dict(tests=0, held=0, broke=0)
            dist = (lv - price) / atr
            side = 1.0 if lv > price else -1.0
            p_touch = float(brain.touch(X["row"], [side], [abs(dist)])[0])
            conf = [cl for cl in X["clusters"] if cl["lo"] - 0.3 * atr <= hi and cl["hi"] + 0.3 * atr >= lo
                    and "user" not in cl["types"]]
            res.update(level=float(lv), distance_atr=float(dist), p_touch_24=p_touch, past_turns=turns,
                       tests=hist["tests"], held=hist["held"], broke=hist["broke"],
                       confluence=sorted({x for cl in conf for x in cl["labels"]})[:5],
                       role="resistance" if lv > price else "support")
            levels.append(dict(price=lo, label=f"{lab}", type="user", weight=2.0, idx=0))
            if hi != lo:
                levels.append(dict(price=hi, label=f"{lab}", type="user", weight=2.0, idx=0))
        except Exception as e:
            res["error"] = f"couldn't read this drawing: {e}"
        out.append(res)
    return out, levels


# ───────────────────────────── main ─────────────────────────────
def analyze(symbol, tf="1h", account=1000.0, risk_pct=1.0, mode="pro", user_drawings=None, brain=None,
            leverage=None, now=None, show_bars=SHOW_BARS, data=None, asof=None):
    """Full analysis of `symbol` on timeframe `tf` (1m 5m 15m 30m 1h 4h 1D 3D 1W 1M).
    `asof` (a replay): the analysis is run as it would have been at that moment. Every candle it reads, on every
    timeframe, had closed by then, and the clock is that moment."""
    t_start = time.time()
    brain = brain or _STATE["brain"] or gm.FallbackBrain()
    tf = md.norm_tf(tf)
    now = asof or now or md.utcnow()
    notes = []
    C = data or md.get_candles(symbol, tf, bars=BARS[tf])
    need = 60 if tf in ("3D", "1W", "1M") else 120
    if len(C["df"]) < need:
        alt = {"1M": "1W", "1W": "1D", "3D": "1D"}.get(tf, "a higher timeframe")
        raise ValueError(f"Only {len(C['df'])} closed {tf} candles for {C['symbol']} (need {need}). "
                         f"Try {alt}.")
    dfe, A = se.analyze(C["df"])
    n = len(dfe)
    ladder = gm.LADDER[tf]
    HT = {}
    for h in ladder:
        try:
            Ch = md.get_candles(symbol, h, bars=HTF_BARS, end=asof)
            if len(Ch["df"]) >= 40:
                dh, Ah = se.analyze(Ch["df"])
                HT[h] = dict(C=Ch, df=dh, A=Ah)
        except Exception as e:
            notes.append(f"{h} candles unavailable ({str(e)[:80]})")
    daily = HT["1D"]["C"] if "1D" in HT else None
    if daily is None and md.TF_MIN[tf] < 43830:
        daily = _safe(lambda: md.get_candles(symbol, "1D", bars=400, min_bars=5, end=asof), None, notes, "daily candles")
    intraday = md.TF_MIN[tf] < 1440
    frames = {h: v["C"]["df"] for h, v in HT.items()}
    F, ctx = gm.raw_features(dfe, tf, C["asset_class"], htf=frames,
                             daily=daily["df"] if (daily is not None and intraday) else None)
    ctx["fvgs"] = A["fvgs"]
    row = F.iloc[-1]
    price, atr = float(C["price"]), float(dfe["atr"].iloc[-1])
    f = Fmt(C["decimals"])
    cost, slip = gm.cost_of(C["sub"])
    X = dict(C=C, df=dfe, A=A, tf=tf, ladder=ladder, price=price, atr=atr, f=f, row=row, cost=cost, slip=slip,
             asset_class=C["asset_class"], intraday=intraday, trend=int(A["trend"][-1]), brain=brain)
    # ── tools
    X["htf"] = {h: _safe(lambda h=h: _htf_summary(h, HT[h]["df"], HT[h]["A"], brain, C["asset_class"], frames),
                         None, notes, f"{h} summary") for h in HT}
    X["htf"] = {k: v for k, v in X["htf"].items() if v is not None}
    X["phase"] = _safe(lambda: gl.market_phase(dfe, A), dict(label="?", notes=[], adx=0, er=0, atr_ratio=1, bbw_pct=.5),
                       notes, "market phase")
    X["dr"] = _safe(lambda: gl.dealing_range(dfe, A), None, notes, "dealing range")
    X["leg"] = _safe(lambda: gl.impulse_leg(dfe, A), None, notes, "impulse leg")
    X["obs"] = _safe(lambda: gl.order_blocks(dfe, A), [], notes, "order blocks")
    tl = _safe(lambda: gl.trendlines(dfe, A), ([], [], []), notes, "trendlines")
    X["lines"] = tl[0]
    X["patterns"] = _safe(lambda: gl.chart_patterns(dfe, A, tl[1], tl[2]), [], notes, "chart patterns")
    rs = gl.rsi(dfe["close"])
    X["rsi"] = float(rs.iloc[-1])
    X["divs"] = _safe(lambda: gl.rsi_divergences(dfe, A, rs), [], notes, "divergences")
    X["vp"] = _safe(lambda: gl.volume_profile(dfe), None, notes, "volume profile")
    X["emas"] = {k: gl.ema(dfe["close"], k) for k in (20, 50, 200)}
    X["vwap"] = _safe(lambda: gl.vwap_daily(dfe), None, notes, "VWAP") if md.TF_MIN[tf] <= 60 else None
    X["session"] = gl.sessions(dfe, now) if md.TF_MIN[tf] <= 60 else {}
    X["period"] = _safe(lambda: gl.period_levels(daily["df"], daily["forming"]), {}, notes, "period levels") \
        if daily is not None else {}
    d_atr = float(daily["df"]["high"].sub(daily["df"]["low"]).tail(20).mean()) if daily is not None else \
        atr * math.sqrt(1440 / md.TF_MIN[tf])
    X["rounds"] = gl.round_levels(price, d_atr)
    X["setups"] = _safe(lambda: gm.find_setups(ctx, cost), [], notes, "setup detector")
    X["q2usd"] = quote_to_usd(C, asof)
    # ── key levels
    items = []
    add = lambda price_, label, typ, w=1.0, idx=0: items.append(dict(price=float(price_), label=label, type=typ,
                                                                     weight=w, idx=int(idx)))
    for z in A["zones"]:
        lab = f"{tf} {'support' if z['role'] == 'support' else 'resistance' if z['role'] == 'resistance' else 'S/R'} zone ×{z['touches']}"
        add(z["bottom"], lab, "zone", 0.5 + 0.25 * z["touches"], z["first_idx"])
        add(z["top"], lab, "zone", 0.5 + 0.25 * z["touches"], z["first_idx"])
    for h, v in HT.items():
        for z in v["A"]["zones"][:4]:
            lab = (f"{h} support zone" if z["top"] < price else f"{h} resistance zone" if z["bottom"] > price
                   else f"{h} zone (price inside)")
            add(z["bottom"], lab, "htf_zone", 1.5)
            add(z["top"], lab, "htf_zone", 1.5)
        for s in v["A"]["liquidity"]["buy_side"][:2]:
            add(s["price"], f"{h} swing high (buy-side liquidity)", "htf_liq", 1.5)
        for s in v["A"]["liquidity"]["sell_side"][:2]:
            add(s["price"], f"{h} swing low (sell-side liquidity)", "htf_liq", 1.5)
    for ob in X["obs"]:
        lab = (f"{'bullish' if ob['role'] == 'demand' else 'bearish'} breaker" if ob["status"] == "breaker" else
               f"{'bullish' if ob['direction'] == 'bullish' else 'bearish'} OB ({ob['status']})")
        add(ob["bottom"], lab, "ob", 1.2, ob["idx"])
        add(ob["top"], lab, "ob", 1.2, ob["idx"])
    open_fvg = sorted([g for g in A["fvgs"] if g["filled_idx"] is None],
                      key=lambda g: abs((g["top"] + g["bottom"]) / 2 - price))[:6]
    for g in open_fvg:
        lab = f"{g['direction']} FVG"
        add(g["bottom"], lab, "fvg", 1.0, g["idx"])
        add(g["top"], lab, "fvg", 1.0, g["idx"])
    for s in A["liquidity"]["buy_side"][:4]:
        add(s["price"], "buy-side liquidity (swing high)", "liq", 1.0, s["idx"])
    for s in A["liquidity"]["sell_side"][:4]:
        add(s["price"], "sell-side liquidity (swing low)", "liq", 1.0, s["idx"])
    for pl in A["liquidity"]["pools"]:
        if not pl["taken"] and n - 1 - pl["idx_b"] <= 300:
            add(pl["level"], "equal highs (liquidity)" if pl["kind"] == "EQH" else "equal lows (liquidity)", "liq",
                1.5, pl["idx_a"])
    P = X["period"]
    for k, lab in (("pdh", "PDH (previous day high)"), ("pdl", "PDL (previous day low)"),
                   ("pwh", "PWH (previous week high)"), ("pwl", "PWL (previous week low)"),
                   ("pmh", "PMH (previous month high)"), ("pml", "PML (previous month low)")):
        if P.get(k) is not None and (intraday or k[1] in "wm"):
            add(P[k], lab, "period", 1.5 if k[1] != "d" else 1.2)
    for k, lab in (("day_open", "daily open"), ("week_open", "weekly open"), ("month_open", "monthly open")):
        if P.get(k) is not None and (intraday or k != "day_open"):
            add(P[k], lab, "open", 0.6)
    S_ = X["session"]
    if S_.get("asia"):
        add(S_["asia"]["high"], "Asian range high", "session", 0.8, S_["asia"]["i1"])
        add(S_["asia"]["low"], "Asian range low", "session", 0.8, S_["asia"]["i1"])
    if S_.get("midnight_open") is not None and X["asset_class"] != "crypto":
        add(S_["midnight_open"], "NY midnight open", "open", 0.6)
    for r_ in X["rounds"]:
        add(r_["price"], "round number", "round", 0.5)
    add(float(X["emas"][200].iloc[-1]), "EMA 200", "ema", 0.6)
    if X["vwap"] is not None:
        add(float(X["vwap"].iloc[-1]), "VWAP", "vwap", 0.6)
    if X["vp"] is not None:
        add(X["vp"]["poc"], "volume POC", "vp", 0.8)
    if X["dr"] is not None:
        add(X["dr"]["eq"], "equilibrium (50% of range)", "eq", 0.5)
    for L in X["lines"]:
        add(L["p2"], L["name"].lower(), "trendline", 1.0)
    X["user"], ulev = analyze_user_drawings(user_drawings, dict(X, clusters=[]), brain)
    items.extend(ulev)
    clusters = collect_levels(price, atr, items)
    # probability for every level (only those within 12 ATR are meaningful in 24 candles)
    near = [c for c in clusters if abs(c["dist_atr"]) <= 12]
    if near:
        pr = brain.touch(row, [1.0 if c["dist_atr"] > 0 else -1.0 for c in near], [abs(c["dist_atr"]) for c in near])
        for c, p_ in zip(near, pr):
            c["p_touch"] = float(p_)
    for c in clusters:
        typ = None
        labs = " ".join(c["labels"]).lower()
        if "equal highs" in labs:
            typ = "eqh"
        elif "equal lows" in labs:
            typ = "eql"
        elif "pdh" in labs:
            typ = "pdh"
        elif "pdl" in labs:
            typ = "pdl"
        elif "buy-side" in labs:
            typ = "swing_high"
        elif "sell-side" in labs:
            typ = "swing_low"
        elif "fvg" in labs:
            typ = "fvg_bull" if c["side"] == "below" else "fvg_bear"
        c["reaction"] = reaction_stats(brain, X["asset_class"], tf, typ) if typ else None
    X["clusters"] = clusters
    X["user"], _ = analyze_user_drawings(user_drawings, X, brain)
    # ── probabilities
    pdir = brain.direction(row)
    rng = brain.expected_range(row, 0.15)
    rng50 = brain.expected_range(row, 0.5)
    k = float(brain.k_dir)
    X["prob"] = dict(p_up=float(pdir[0]), p_down=float(pdir[1]), p_flat=float(pdir[2]), k_atr=k,
                     up_level=price + k * atr, down_level=price - k * atr, horizon=gm.H_TOUCH,
                     range70=(price - rng["down"] * atr, price + rng["up"] * atr),
                     range50=(price - rng50["down"] * atr, price + rng50["up"] * atr))
    X["prob"]["bar"] = brain.direction_bar(row, raw=pdir)     # the bull/bear bar: range and lean views
    # ── plans
    X["notes"] = notes
    plans = [evaluate_plan(p, X, brain) for p in make_plans(X)]
    plans = [p for p in plans if p["rr"][0] >= 0.8]
    best = {}
    for p in plans:
        key = p["side"]
        j = min(1, len(p["ev"]) - 1)
        val = p["score"] + 4 * float(np.clip(p["ev"][j], -0.5, 0.5)) * max(0.3, p["p_fill"])
        p["rank"] = val
        if key not in best or val > best[key]["rank"]:
            best[key] = p
    order = sorted(best.values(), key=lambda p: -p["rank"])
    primary = order[0] if order else None
    alternative = order[1] if len(order) > 1 else None
    for p in plans:
        p["sizing"] = size_position(p, X, account, risk_pct, leverage)
    X["plans"], X["primary"], X["alternative"] = plans, primary, alternative
    X["verdict"] = _verdict(primary, X)
    X["skill"] = model_skill(brain)
    X["notes"] = notes
    result = dict(
        symbol=C["symbol"], query=C["query"], tf=tf, tf_label=md.TF_LABEL[tf], source=C["source"],
        asset_class=C["asset_class"], sub=C["sub"], time=str(dfe.index[-1]), now=str(now), price=price,
        decimals=C["decimals"], atr=atr, data_age_minutes=C["age_minutes"], forming=C["forming"] is not None,
        verdict=X["verdict"], plan=_public_plan(primary, f), alternative=_public_plan(alternative, f),
        plans=[_public_plan(p, f) for p in sorted(plans, key=lambda p: -p["rank"])],
        timeframes=[dict(X["htf"][h]) for h in ladder if h in X["htf"]],
        structure=dict(trend=X["trend"], phase=X["phase"], dealing_range=X["dr"], leg=X["leg"],
                       swings=[dict(label=s["label"], price=s["price"]) for s in A["swings"][-8:]],
                       last_event=None if not A["events"] else {k_: A["events"][-1][k_] for k_ in
                                                                ("kind", "direction", "level")}),
        levels=[{k_: v for k_, v in c.items()} for c in clusters if abs(c["dist_atr"]) <= 15],
        patterns=[{k_: v for k_, v in q.items() if k_ not in ("support", "resistance")} for q in X["patterns"]],
        divergences=X["divs"], session=X["session"], period_levels=X["period"], rsi=X["rsi"],
        probabilities=X["prob"], model=X["skill"], user_drawings=X["user"], notes=notes,
        disclaimer="Research tool, not financial advice. Probabilities are calibrated estimates from history; "
                   "markets change. Paper-trade first and never risk money you can't afford to lose.")
    result["report_pro"] = report(X, beginner=False)
    result["report_beginner"] = report(X, beginner=True)
    result["report"] = result["report_beginner"] if mode == "beginner" else result["report_pro"]
    cd = chart_data(X, show_bars)
    result["candles"], result["drawings"], result["indicators"] = cd["candles"], cd["drawings"], cd["indicators"]
    result["view"] = cd["view"]
    result["seconds"] = round(time.time() - t_start, 2)
    ctxs = _STATE.setdefault("ctx", {})
    ctxs[(result["symbol"], tf)] = X                                # kept for review_trade()
    while len(ctxs) > 20:
        ctxs.pop(next(iter(ctxs)))
    return result


def jsonable(x):
    """Plain-Python copy of an analysis (numpy types → int/float/list), ready for json.dumps / a web app."""
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        v = float(x)
        return v if math.isfinite(v) else None
    if isinstance(x, np.ndarray):
        return [jsonable(v) for v in x.tolist()]
    if isinstance(x, (np.bool_,)):
        return bool(x)
    if isinstance(x, (pd.Timestamp,)):
        return str(x)
    if isinstance(x, pd.DataFrame):
        return x.to_dict("records")
    return x


def _public_plan(p, f):
    if p is None:
        return None
    keep = ("side", "type", "setup", "family", "entry", "sl", "tps", "tp_labels", "rr", "p_fill", "p_tp", "p_sl",
            "p_open", "breakeven", "ev", "cost_r", "risk_atr", "chase_limit", "score", "grade", "hist_grade",
            "evidence", "checklist", "why", "invalidation", "expiry", "sizing", "zone")
    out = {k: p.get(k) for k in keep}
    out["text"] = (f"{'BUY' if p['dir'] == 1 else 'SELL'} {p['type'].upper()} EP {f.p(p['entry'])} | SL {f.p(p['sl'])} | "
                   + " | ".join(f"TP{i + 1} {f.p(t)}" for i, t in enumerate(p["tps"])))
    return out


def model_skill(brain):
    card = brain.b.get("card", {}) if hasattr(brain, "b") else {}
    if not card:
        return dict(trained=False, summary="untrained: probabilities are random-walk approximations")
    ev = card["race"]["ev_test"].set_index("selection")
    pick = ev.loc["model EV > 0"] if "model EV > 0" in ev.index else None
    geo = ev.loc["geometry-only EV > 0"] if "geometry-only EV > 0" in ev.index else None
    skill = card["race"]["skill_vs_geometry"]
    # an edge must come from the model's reading of the chart, not from stop/target geometry alone
    # (geometry can't beat a fair market; if it seems to, the fill assumptions are too kind)
    proven = (pick is not None and pick["trades"] >= 300 and pick["avg_net_R"] > 0 and (pick["t_stat"] or 0) >= 3
              and skill >= 0.01 and (geo is None or pick["avg_net_R"] > (geo["avg_net_R"] or 0) + 0.02))
    d = card["direction"]
    return dict(trained=True, created=brain.b.get("created"), rows=card["rows"],
                race_skill=card["race"]["skill_vs_geometry"], touch_skill=card["touch"]["skill_vs_distance"],
                direction_auc=d.get("auc_up_vs_down"), direction_skill=d["skill_vs_prior"],
                model_trades=None if pick is None else int(pick["trades"]),
                model_avg_R=None if pick is None else float(pick["avg_net_R"]),
                model_t=None if pick is None else float(pick["t_stat"]), edge_proven=bool(proven),
                geometry_avg_R=None if geo is None else float(geo["avg_net_R"]))


def _verdict(p, X):
    f = X["f"]
    if p is None:
        return dict(action="NO TRADE", grade="—", headline="No valid plan: structure is unclear and no level offers "
                    "a sensible stop and target. Wait for a break of structure.")
    word = "BUY" if p["dir"] == 1 else "SELL"
    j = min(1, len(p["tps"]) - 1)
    gross = p["ev"][j] + p["cost_r"]
    untrained = getattr(X.get("brain"), "untrained", False)
    odds_ok = untrained or (gross >= -0.05 and p["ev"][j] >= -0.15)
    trade = p["grade"] in ("A+", "A", "B") and odds_ok and p["cost_r"] <= 0.30
    why_not = None
    if p["grade"] in ("A+", "A", "B") and not trade:
        why_not = ("costs are too large for this timeframe" if p["cost_r"] > 0.30 else
                   f"the odds don't support it (EV {p['ev'][j]:+.2f}R)")
    if trade:
        act = f"{word} NOW (market)" if p["type"] == "market" else f"{word} {p['type'].upper()}"
    else:
        act = "NO TRADE (wait)"
    j = min(1, len(p["tps"]) - 1)
    if trade:
        head = f"{act} · grade {p['grade']} ({p['score']:.1f}/10) · {p['setup']}"
    elif why_not:
        head = (f"NO TRADE: the best idea is grade {p['grade']} on the chart, but {why_not}. Conditional plan: {word} "
                f"{p['type']} {f.p(p['entry'])} only if conditions improve")
    else:
        head = (f"NO TRADE: the best idea is only grade {p['grade']} ({p['score']:.1f}/10). Conditional plan: {word} "
                f"{p['type']} {f.p(p['entry'])} only if conditions improve")
    return dict(action=act, side=p["side"] if trade else None, grade=p["grade"], score=p["score"], headline=head,
                trade=trade, ep=p["entry"], sl=p["sl"], tp=p["tps"][j], tps=p["tps"])


# ───────────────────────────── the written report ─────────────────────────────
GLOSSARY = {
    "BOS": "Break of structure: a candle closes beyond the last swing high (up) or low (down) in the trend's direction.",
    "CHoCH": "Change of character: the first break against the trend, an early sign it may be turning.",
    "HH/HL": "Higher high / higher low: the stair-step of an uptrend. LH/LL (lower high / lower low) = downtrend.",
    "liquidity": "Clusters of stop orders above swing highs (buy-side) and below swing lows (sell-side). Price "
                 "is often drawn to them.",
    "sweep": "A wick through a swing high/low that closes back inside: stops were taken, then price reversed.",
    "FVG": "Fair value gap: a 3-candle imbalance where candle 1 and candle 3 don't overlap. Price often returns to it.",
    "OB": "Order block: the last opposite-colour candle before a strong move that broke structure.",
    "breaker": "An order block that failed (price closed through it); it often flips to the opposite role.",
    "OTE": "Optimal trade entry: the 62–79% retracement of the last impulse (ICT).",
    "premium/discount": "Above 50% of the current range = premium (expensive), below = discount (cheap).",
    "killzone": "The busiest hours: London 02:00–05:00 and New York 07:00–10:00 (New York time).",
    "ATR": "Average true range: the typical size of one candle. Distances are measured in ATRs.",
    "R:R": "Reward-to-risk: how many times your risk the target pays (2R = twice what you risk).",
    "EV": "Expected value: the average result per trade if this exact situation repeated many times, in R.",
    "break-even": "The win rate you need for a strategy with this R:R and costs to stop losing money.",
    "liquidation": "With leverage, the price where the exchange closes your position for you. It must be beyond your stop.",
    "PDH/PDL": "Previous day high / low (PWH/PWL = previous week, PMH/PML = previous month).",
    "EQH/EQL": "Equal highs / equal lows: obvious double tops/bottoms where stops pile up.",
}


def _lvl_line(c, f, tf, beginner, last_close=None, price=None):
    dist = f"{abs(c['dist_atr']):.1f} ATR {'above' if c['dist_atr'] > 0 else 'below'}"
    s = f"{f.p(c['price'])}: " + " + ".join(c["labels"][:4]) + f" ({dist}"
    if last_close is not None and min(last_close, price) < c["price"] < max(last_close, price):
        s += ", price is trading through it right now"
    if c.get("p_touch") is not None:
        s += f", {pct(c['p_touch'])} chance to be reached in 24 candles"
    s += ")"
    r = c.get("reaction")
    if r:
        s += (f". Historically when reached: breaks {pct(r['p_break'])} / rejects {pct(r['p_reject'])}"
              + (f" (a random level: {pct(r['base_break'])} / {pct(r['base_reject'])})" if r.get("base_break") is not None
                 else ""))
    return s


def report(X, beginner=False):
    f, tf, C, price, atr = X["f"], X["tf"], X["C"], X["price"], X["atr"]
    A, p, alt, v = X["A"], X["primary"], X["alternative"], X["verdict"]
    L = []
    w = L.append
    t_last = X["df"].index[-1]
    w(f"━━━ {C['symbol']} · {tf} · last closed candle {t_last:%Y-%m-%d %H:%M} UTC · price {f.p(price)} ━━━")
    w(f"VERDICT: {v['headline']}")
    if p is not None:
        tps = " · ".join(f"TP{i + 1} {f.p(t)}" for i, t in enumerate(p["tps"]))
        w(f"EP {f.p(p['entry'])} · SL {f.p(p['sl'])} · {tps}")
        rrs = " / ".join(f"{r:.1f}" for r in p["rr"])
        j = min(1, len(p["tps"]) - 1)
        w(f"R:R {rrs} · P(TP{j + 1} before SL) {pct(p['p_tp'][j])} vs {pct(p['breakeven'][j])} needed to break even"
          + ("" if p["type"] == "market" else f" · fill chance {pct(p['p_fill'])} within {p['expiry']} candles"))
        sz = p["sizing"]
        lev = (f"leverage {sz['leverage']}x isolated, margin {money(sz['margin'])}, liquidation {f.p(sz['liquidation'])}"
               if sz.get("mode") == "isolated" else f"effective leverage {sz['leverage_needed']:.1f}x")
        w(f"Size: {_size_txt(sz)} risking {money(sz['risk_amount'])} ({sz['risk_pct']:g}%) · {lev}")
    w("")
    # STEP 1
    w("STEP 1 — BIG PICTURE (higher timeframes)")
    if not X["htf"]:
        w("• No higher-timeframe data: reading this chart on its own.")
    for h in X["ladder"]:
        hs = X["htf"].get(h)
        if hs is None:
            continue
        ev = hs["last_event"]
        evs = "" if ev is None else (f"; last {ev['kind']} {'up' if ev['direction'] == 'bullish' else 'down'} through "
                                     f"{f.p(ev['level'])} {ago(ev['bars_ago'], h)}")
        zone = "" if hs["zone"] is None else f"; price in {hs['zone']} ({pct(hs['range_pos'])} of its range)"
        probs = "" if "p_up" not in hs else (f"; next 24 candles: ↑ {pct(hs['p_up'])} · ↓ {pct(hs['p_down'])} · "
                                             f"↔ {pct(hs['p_flat'])}")
        w(f"• {h}: {hs['trend_word'].upper()} ({hs['phase'].lower()}){evs}{zone}{probs}")
    w("• " + _top_down(X))
    w("")
    # STEP 2
    w(f"STEP 2 — STRUCTURE ON {tf}")
    tw = {1: "BULLISH (higher highs & higher lows)", -1: "BEARISH (lower highs & lower lows)",
          0: "UNCLEAR (no break of structure yet)"}[X["trend"]]
    w(f"• Trend: {tw}. Recent swings: {' → '.join(s['label'] + ' ' + f.p(s['price']) for s in A['swings'][-5:])}")
    if A["events"]:
        e = A["events"][-1]
        w(f"• Last break: {e['kind']} {'up' if e['direction'] == 'bullish' else 'down'} through {f.p(e['level'])} "
          f"{ago(len(X['df']) - 1 - e['idx'], tf)}"
          + (" (a CHoCH is an early reversal signal: it needs follow-through)" if e["kind"] == "CHoCH" else ""))
    ph = X["phase"]
    w(f"• Phase: {ph['label']} (ADX {ph['adx']:.0f}, efficiency {ph['er']:.2f})" +
      ("" if not ph["notes"] else "; " + "; ".join(ph["notes"])))
    dr = X["dr"]
    if dr is not None:
        w(f"• Dealing range {f.p(dr['bottom'])} – {f.p(dr['top'])}: price at {pct(dr['pos'])} → {dr['zone'].upper()}. "
          f"Equilibrium {f.p(dr['eq'])}. OTE for longs {f.p(dr['ote_long'][0])}–{f.p(dr['ote_long'][1])}, "
          f"for shorts {f.p(dr['ote_short'][0])}–{f.p(dr['ote_short'][1])}.")
    leg = X["leg"]
    if leg is not None:
        r = leg["retracements"]
        w(f"• Impulse leg {f.p(leg['origin'])} → {f.p(leg['extreme'])} ({leg['length'] / atr:.1f} ATR): 50% {f.p(r['0.5'])}"
          f", 61.8% {f.p(r['0.618'])}, 70.5% {f.p(r['0.705'])}, 78.6% {f.p(r['0.786'])}; extensions 1.272 "
          f"{f.p(leg['extensions']['1.272'])}, 1.618 {f.p(leg['extensions']['1.618'])}")
    if beginner:
        w("  What this means: trends move in steps. In an uptrend each pullback should hold above the last low; "
          "a close below it (CHoCH) is the first warning that buyers are losing control.")
    w("")
    # STEP 3
    w("STEP 3 — KEY LEVELS & LIQUIDITY")
    at = [c for c in X["clusters"] if abs(c["dist_atr"]) < 0.15]
    ab = sorted([c for c in X["clusters"] if c["dist_atr"] >= 0.15], key=lambda c: c["price"])[:5]
    be = sorted([c for c in X["clusters"] if c["dist_atr"] <= -0.15], key=lambda c: -c["price"])[:5]
    if at:
        w("At price right now: " + "; ".join(f"{f.p(c['price'])} " + " + ".join(c["labels"][:3]) for c in at))
    w("Above (resistance / buy-side liquidity):")
    for c in ab:
        w("  • " + _lvl_line(c, f, tf, beginner, float(X["df"]["close"].iloc[-1]), price))
    if not ab:
        w("  • nothing marked nearby: price is at the top of everything in view (price discovery)")
    w("Below (support / sell-side liquidity):")
    for c in be:
        w("  • " + _lvl_line(c, f, tf, beginner, float(X["df"]["close"].iloc[-1]), price))
    if not be:
        w("  • nothing marked nearby")
    sw = A["sweeps"][-1] if A["sweeps"] else None
    if sw is not None and len(X["df"]) - 1 - sw["idx"] <= 50:
        w(f"• Last liquidity sweep: {sw['side']} at {f.p(sw['level'])} {ago(len(X['df']) - 1 - sw['idx'], tf)} "
          f"(wick to {f.p(sw['wick'])}, closed back inside) → "
          + ("bullish hint (sell stops taken)" if sw["side"] == "sell-side" else "bearish hint (buy stops taken)"))
    obs = [o for o in X["obs"] if o["status"] != "breaker"][:3]
    if obs:
        w("• Order blocks: " + "; ".join(f"{o['direction']} {f.p(o['bottom'])}–{f.p(o['top'])} ({o['status']})" for o in obs))
    brk = [o for o in X["obs"] if o["status"] == "breaker"][:2]
    if brk:
        w("• Breakers (failed blocks, role flipped): " + "; ".join(
            f"{f.p(o['bottom'])}–{f.p(o['top'])} now {o['role']}" for o in brk))
    gaps = sorted([g for g in A["fvgs"] if g["filled_idx"] is None],
                  key=lambda g: abs((g["top"] + g["bottom"]) / 2 - price))[:3]
    if gaps:
        w("• Open FVGs: " + "; ".join(f"{g['direction']} {f.p(g['bottom'])}–{f.p(g['top'])}" for g in gaps))
    if X["user"]:
        w("• Your drawings:")
        for u in X["user"]:
            if "level" in u:
                w(f"  • {u.get('label') or u.get('type')}: {f.p(u['level'])} ({u['role']}, {abs(u['distance_atr']):.1f} ATR "
                  f"away, {pct(u['p_touch_24'])} to be reached in 24 candles). "
                  + (f"Tested {u['tests']}× in the loaded history: held {u['held']}, broke {u['broke']}"
                     if u.get("tests") else f"Swing points there: {u['past_turns']}")
                  + (f"; lines up with {', '.join(u['confluence'][:3])}" if u["confluence"] else
                     "; no other level confirms it") +
                  (f"; trendline: {u['status']}, {u['touches']} touches" if u.get("type") == "trendline" else ""))
            elif u.get("type") == "note":
                w(f"  • note: {u.get('text', '')}")
    w("")
    # STEP 4
    w("STEP 4 — PRICE ACTION, MOMENTUM & PATTERNS")
    recent = [q for q in A["patterns"] if q["idx"] >= len(X["df"]) - 3 and q["bias"] != "neutral"]
    if recent:
        w("• Last candles: " + ", ".join(f"{q['name']} ({ago(len(X['df']) - 1 - q['idx'], tf)})" for q in recent[-3:]))
    else:
        w("• Last candles: no strong reversal/continuation pattern on the last 3 candles")
    rsi = X["rsi"]
    rs_txt = "overbought (>70)" if rsi > 70 else "oversold (<30)" if rsi < 30 else (
        "bullish side (>50)" if rsi >= 50 else "bearish side (<50)")
    w(f"• RSI(14) {rsi:.0f}: {rs_txt}" + ("" if not X["divs"] else "; " + "; ".join(
        f"{dv['name']} ({ago(dv['bars_ago'], tf)})" for dv in X["divs"])))
    e20, e50, e200 = (float(X["emas"][k].iloc[-1]) for k in (20, 50, 200))
    stack = ("bullish stack (price > EMA20 > EMA50 > EMA200)" if price > e20 > e50 > e200 else
             "bearish stack (price < EMA20 < EMA50 < EMA200)" if price < e20 < e50 < e200 else "mixed (no clean stack)")
    w(f"• EMAs 20/50/200 {f.p(e20)} / {f.p(e50)} / {f.p(e200)}: {stack}")
    for q in X["patterns"]:
        if q["kind"] == "lines":
            w(f"• {q['name']} ({q['status']}): breakout ≥ {f.p(q['breakout_up'])} → {f.p(q['target_up'])}; "
              f"breakdown ≤ {f.p(q['breakout_down'])} → {f.p(q['target_down'])}")
        else:
            tgt = q.get("target_up", q.get("target_down"))
            w(f"• {q['name']} ({q['status']}): trigger {f.p(q['trigger'])}, measured target {f.p(tgt)}, "
              f"invalid beyond {f.p(q['invalidation'])}")
    for L_ in X["lines"]:
        w(f"• {L_['name']}: {L_['touches']} touches, now at {f.p(L_['p2'])} ({L_['status']})"
          + (" with a parallel channel line" if "channel_offset" in L_ else ""))
    if X["vp"] is not None:
        w(f"• Volume profile (last {min(300, len(X['df']))} candles): POC {f.p(X['vp']['poc'])}, value area "
          f"{f.p(X['vp']['val'])}–{f.p(X['vp']['vah'])}" + (" (price inside value: rotation more likely)"
                                                            if X['vp']['val'] <= price <= X['vp']['vah'] else
                                                            " (price outside value: trend/acceptance test)"))
    w("")
    # STEP 5
    w("STEP 5 — VOLATILITY & TIMING")
    pr = X["prob"]
    w(f"• ATR(14) {f.p(atr)} ({pct(atr / price, 2)} of price); volatility {X['phase']['atr_ratio']:.1f}× its usual level")
    w(f"• Expected range, next 24 candles: ≈70% {f.p(pr['range70'][0])} – {f.p(pr['range70'][1])}; typical (50%) "
      f"{f.p(pr['range50'][0])} – {f.p(pr['range50'][1])}")
    s = X["session"]
    if s:
        act = ", ".join(s["active"]) if s.get("active") else "no killzone active"
        w(f"• New York time {s['ny_time']} ({s['ny_weekday']}): {act}" + (
            f"; silver bullet window: {', '.join(s['silver_bullet'])}" if s.get("silver_bullet") else "") +
          (f"; next: {s['next_killzone']} in {s['minutes_to_next'] // 60}h {s['minutes_to_next'] % 60:02d}m"
           if s.get("next_killzone") else ""))
        if s.get("asia"):
            a_ = s["asia"]
            w(f"• Asian range {f.p(a_['low'])} – {f.p(a_['high'])}: high {'swept' if a_['high_swept'] else 'intact'}, "
              f"low {'swept' if a_['low_swept'] else 'intact'}")
        if C["asset_class"] == "crypto":
            w("• Crypto trades 24/7, but volume still peaks in the London/New York overlap; weekends are thinner")
    if C["age_minutes"] is not None and C["age_minutes"] > 3 * md.TF_MIN[tf] + 60 * 24:
        w(f"• Data note: the last closed candle is {C['age_minutes'] / 60:.0f} h old (market closed or data delayed)")
    w("")
    # STEP 6
    w("STEP 6 — PROBABILITIES (trained on many markets; out-of-sample calibrated)")
    w(f"• Next 24 candles, first move of ±{pr['k_atr']:.2f} ATR: ↑ to {f.p(pr['up_level'])} {pct(pr['p_up'])} · "
      f"↓ to {f.p(pr['down_level'])} {pct(pr['p_down'])} · neither (range) {pct(pr['p_flat'])}")
    sk = X["skill"]
    if sk.get("trained"):
        dauc = sk.get("direction_auc")
        dtxt = (f"direction skill AUC {dauc:.3f} (0.50 = coin flip, 0.55+ = useful)" if dauc is not None and
                np.isfinite(dauc) else f"direction skill {pct(sk['direction_skill'], 1)} better than base rates")
        w(f"• How much to trust them: {dtxt}; level/range odds beat distance-only by {pct(sk['touch_skill'], 1)}; "
          f"trade odds beat stop/target geometry alone by {pct(sk['race_skill'], 1)}.")
        if sk.get("model_trades") is not None:
            w(f"• Out-of-sample test of the model's own picks: {sk['model_trades']:,} trades, average "
              f"{sk['model_avg_R']:+.3f}R after costs (t = {sk['model_t']:.1f}) → "
              + ("EDGE SHOWN (still paper-trade it first)" if sk["edge_proven"] else
                 "NO PROVEN EDGE: treat the odds as honest estimates, not a money machine"
                 + (" (the picks look profitable, but no better than stop/target geometry alone, so that's a "
                    "backtest effect, not skill)" if (sk["model_avg_R"] or 0) > 0 and (sk["model_t"] or 0) >= 3 else "")))
    else:
        w("• Model not trained: odds below are random-walk approximations")
    w("")
    # STEP 7
    if p is not None:
        w("STEP 7 — TRADE PLAN" + ("" if v["trade"] else " (CONDITIONAL: only if conditions improve)"))
        w(f"• Setup: {p['setup']}. " + " ".join(x[0].upper() + x[1:] + ("" if x.endswith(".") else ".") for x in p["why"]))
        zone = p.get("zone")
        ztxt = "" if not zone else f" (zone {f.p(zone[0])}–{f.p(zone[1])})"
        w(f"• Entry: {'BUY' if p['dir'] == 1 else 'SELL'} {p['type'].upper()} {f.p(p['entry'])}{ztxt}"
          + (f". Don't chase beyond {f.p(p['chase_limit'])}: R:R to TP2 falls below 1.5 there" if p["type"] != "stop"
             else ""))
        w(f"• Stop loss: {f.p(p['sl'])} ({p['risk_atr']:.1f} ATR). The idea is wrong on {p['invalidation']}.")
        for i, (t, lab) in enumerate(zip(p["tps"], p["tp_labels"])):
            mgmt = (" → take 50% and move the stop to break-even" if i == 0 and len(p["tps"]) > 1 else
                    " → runner" if i == 2 else "")
            w(f"• TP{i + 1}: {f.p(t)} ({lab}; {p['rr'][i]:.1f}R): P(hit before SL) {pct(p['p_tp'][i])} vs "
              f"{pct(p['breakeven'][i])} break-even, EV {p['ev'][i]:+.2f}R{mgmt}")
        if p["type"] != "market":
            w(f"• Order valid {p['expiry']} candles (~{_dur(p['expiry'], tf)}); fill chance {pct(p['p_fill'])}. Cancel it "
              f"if price reaches TP1 first.")
        if p["cost_r"] > 0.15:
            w(f"• ⚠️ Costs eat {pct(p['cost_r'])} of the risk on this timeframe: use a higher timeframe or a bigger stop.")
        ev = p.get("evidence")
        if ev:
            w(f"• History of this setup ({ev['scope']}): {ev['trades']:,} trades, won {pct(ev['win_rate'])}, average "
              f"{ev['avg_R']:+.2f}R after costs" + (f"; grade-{ev['grade']} ones: {ev['grade_trades']:,} trades, "
                                                    f"{ev['grade_R']:+.2f}R" if "grade_trades" in ev else ""))
        w(f"• Checklist (grade {p['grade']}, {p['score']:.1f}/10):")
        for c in p["checklist"]:
            w(f"   {'✓' if c['ok'] else '✗'} {c['text']}")
        w("")
        w("STEP 8 — POSITION SIZE & LEVERAGE")
        for line in _sizing_lines(p, f):
            w("• " + line)
        w("")
    w("STEP 9 — ALTERNATIVE SCENARIO" if alt is not None else "STEP 9 — WHAT WOULD CHANGE THE PICTURE")
    if alt is not None:
        tps = " · ".join(f"TP{i + 1} {f.p(t)}" for i, t in enumerate(alt["tps"]))
        w(f"• {'BUY' if alt['dir'] == 1 else 'SELL'} {alt['type'].upper()} EP {f.p(alt['entry'])} · SL {f.p(alt['sl'])} · "
          f"{tps} (grade {alt['grade']}, {alt['setup'].lower()}). Valid only on {_trigger_text(alt, X)}.")
    liq = A["liquidity"]
    if liq["buy_side"]:
        w(f"• A close above {f.p(liq['buy_side'][0]['price'])} = "
          f"{'BOS up (trend continues)' if X['trend'] == 1 else 'CHoCH up (bullish shift)'}")
    if liq["sell_side"]:
        w(f"• A close below {f.p(liq['sell_side'][0]['price'])} = "
          f"{'BOS down (trend continues)' if X['trend'] == -1 else 'CHoCH down (bearish shift)'}")
    w("")
    w("GURU'S TAKE")
    w(_guru_take(X))
    w("")
    w("RISK RULES")
    for r_ in _advice(X):
        w("• " + r_)
    if beginner:
        import re
        body = "\n".join(L)

        def present(term):
            first = term.split("/")[0]
            if first.isupper() or first in ("CHoCH", "R:R"):
                return re.search(r"(?<![A-Za-z])" + re.escape(first) + r"(?![A-Za-z])", body) is not None
            return re.search(r"\b" + re.escape(first.lower()), body.lower()) is not None

        used = [k for k in GLOSSARY if present(k)]
        if used:
            w("")
            w("WORDS USED")
            for k in used:
                w(f"• {k}: {GLOSSARY[k]}")
    if X["notes"]:
        w("")
        w("Notes: " + "; ".join(X["notes"]))
    w("")
    w("Research tool, not financial advice. Paper-trade first.")
    return "\n".join(L)


def _dur(bars, tf):
    m = bars * md.TF_MIN[tf]
    return f"{m} min" if m < 120 else (f"{m / 60:.0f} h" if m < 2880 else f"{m / 1440:.0f} days")


def _size_txt(sz):
    if sz.get("too_small"):
        return (f"below the broker minimum size (you'd need ≥ {money(sz['min_capital'])} at {sz['risk_pct']:g}% risk; "
                f"exact size {qty(sz['units'])} {sz['unit']})")
    if "lots" in sz:
        u = sz["lots_rounded"] * sz["lot_size"]
        return (f"{sz['lots_rounded']:.2f} lots ({qty(u)} {sz['unit']}, notional "
                f"{money(sz['notional'] * u / sz['units'] if sz['units'] else 0)})")
    return f"{qty(sz['units'])} {sz['unit']} (notional {money(sz['notional'])})"


def _sizing_lines(p, f):
    sz = p["sizing"]
    out = []
    if sz.get("warn"):
        out.append("⚠️ " + sz["warn"])
    out.append(f"Account {money(sz['account'])}, risk {sz['risk_pct']:g}% = {money(sz['risk_amount'])} → "
               f"{_size_txt(sz)}; round-trip costs ≈ {money(sz['fees'])}")
    if sz.get("too_small"):
        out.append(f"⚠️ That's below the minimum order size: you'd need at least {money(sz['min_capital'])} in the "
                   f"account to take this trade at {sz['risk_pct']:g}% risk (or accept more risk, which I don't advise).")
    elif "lots" in sz:
        out.append(f"Rounded to {sz['lots_rounded']:.2f} lots, the risk is {money(sz['risk_at_rounded'])}. Minimum "
                   f"capital for this trade at {sz['risk_pct']:g}% risk: {money(sz['min_capital'])}.")
    if sz.get("mode") == "isolated":
        out.append(f"Leverage: {sz['leverage']}x isolated → margin {money(sz['margin'])} ({pct(sz['margin_pct'])} of the "
                   f"account), liquidation ≈ {f.p(sz['liquidation'])}: "
                   + ("your stop is hit first ✓" if sz["liq_beyond_stop"] else "⚠️ liquidation comes before the stop"))
        out.append(f"Max safe leverage {sz['max_safe_leverage']}x (liquidation stays beyond the stop with a buffer). "
                   f"More leverage doesn't raise the risk if the stop holds, it only locks up less margin. But "
                   f"it pushes liquidation closer, so never trade without the stop.")
        ul = sz.get("user_leverage")
        if ul:
            out.append(f"Your {ul['leverage']:g}x: margin {money(ul['margin'])}, liquidation {f.p(ul['liquidation'])} "
                       + ("(beyond the stop ✓)" if ul["safe"] else "⚠️ BEFORE your stop: lower the leverage"))
    else:
        m = sz["margin_at"]
        need = max(1, math.ceil(sz["leverage_needed"] * 2))
        nice = next((L for L in (10, 20, 30, 50, 100, 200, 500, 1000) if L >= need), need)
        out.append(f"This position is {sz['leverage_needed']:.1f}x your account. Margin needed: "
                   + ", ".join(f"{k} → {money(v)}" for k, v in m.items())
                   + f". Use an account leverage of at least 1:{nice} so this trade ties up ≤ 50% of your margin. "
                     "Leverage only sets the margin; your risk is fixed by the stop and the size.")
    return out


def _trigger_text(p, X):
    f = X["f"]
    if p["type"] == "stop":
        return f"a move through {f.p(p['entry'])}"
    if p["type"] == "limit":
        return f"a pullback to {f.p(p['entry'])} with the stop at {f.p(p['sl'])} still intact"
    return "current conditions"


def _top_down(X):
    ts = [X["htf"][h]["trend"] for h in X["ladder"] if h in X["htf"]]
    t = X["trend"]
    if ts and all(x == 1 for x in ts):
        base = "Higher timeframes all bullish → bias LONG; look for buys on pullbacks into discount."
    elif ts and all(x == -1 for x in ts):
        base = "Higher timeframes all bearish → bias SHORT; look for sells on rallies into premium."
    elif ts and ts[0] != 0 and (len(ts) < 2 or ts[0] == ts[1]):
        base = f"Higher-timeframe bias {'LONG' if ts[0] == 1 else 'SHORT'} ({X['ladder'][0]} and {X['ladder'][1] if len(ts) > 1 else ''} agree)."
    else:
        base = "Higher timeframes disagree → no strong bias; trade only A-grade setups or wait for alignment."
    if ts and t != 0 and ts[0] != 0 and t != ts[0]:
        base += f" {X['tf']} is moving against {X['ladder'][0]}: that's a pullback until it breaks structure."
    return base


def _guru_take(X):
    f, p, v, price = X["f"], X["primary"], X["verdict"], X["price"]
    dr, ts = X["dr"], [X["htf"][h]["trend"] for h in X["ladder"] if h in X["htf"]]
    bias = ts[0] if ts else X["trend"]
    who = {1: "Buyers are in control on the higher timeframe", -1: "Sellers are in control on the higher timeframe",
           0: "The higher timeframe is undecided"}[bias]
    parts = [who + "."]
    if dr is not None:
        parts.append(f"On the {X['tf']} price sits in {dr['zone']} ({pct(dr['pos'])} of the range), "
                     + ("so buying here means paying up." if dr["zone"] == "premium" and bias == 1 else
                        "so selling here means selling low." if dr["zone"] == "discount" and bias == -1 else
                        "a good place to look for entries in the trend's direction." if
                        (dr["zone"] == "discount" and bias == 1) or (dr["zone"] == "premium" and bias == -1) else
                        "nothing special about the location."))
    if p is not None:
        j = min(1, len(p["tps"]) - 1)
        if v["trade"]:
            act = ("I'd take it now" if p["type"] == "market" else
                   f"I'd let price come to me at {f.p(p['entry'])}" if p["type"] == "limit" else
                   f"I'd only join on a break through {f.p(p['entry'])}")
            parts.append(f"The best idea is a {p['side']}: {p['setup'].lower()}. {act}, stop {f.p(p['sl'])}, first target "
                         f"{f.p(p['tps'][0])}. If {p['invalidation']} happens, I'm wrong and I step aside.")
        else:
            parts.append(f"Nothing here is good enough. The best idea ({p['side']}, {p['setup'].lower()}) only scores "
                         f"{p['grade']}. Patience is a position: wait for the trigger in step 9.")
        edge = p["ev"][j]
        sk = X["skill"]
        parts.append(f"Edge check: {pct(p['p_tp'][j])} to reach TP{j + 1} vs {pct(p['breakeven'][j])} needed "
                     + ("→ positive on paper" if edge > 0 else "→ negative on paper")
                     + ("; the model's picks haven't proven an edge out-of-sample, so size small"
                        if sk.get("trained") and not sk.get("edge_proven") else "") + ".")
    return " ".join(parts)


def _advice(X):
    out = ["Risk 0.5–1% per trade. After 3 losses in a row, stop for the day.",
           "Put the stop in the order itself and never move it further away. Move it to break-even after TP1.",
           "Check the economic calendar: skip entries in the 15 minutes around high-impact news (CPI, NFP, FOMC)."]
    p = X["primary"]
    if p is not None:
        if p["cost_r"] > 0.15:
            out.insert(0, f"On {X['tf']} the costs are {pct(p['cost_r'])} of your risk. Lower timeframes look exciting "
                          "but fees decide the result: prefer 15m and above.")
        if any(X["htf"][h]["trend"] == -p["dir"] for h in X["ladder"][:1] if h in X["htf"]):
            out.insert(0, "This trade is against the higher-timeframe trend: half size at most.")
    if X["phase"]["atr_ratio"] >= 1.6:
        out.insert(0, "Volatility is unusually high: smaller size, wider stops, expect slippage.")
    if X["C"]["asset_class"] == "crypto":
        out.append("Crypto with leverage: use isolated margin, keep liquidation far beyond the stop, and keep "
                   "most of your capital off the exchange.")
    return out


# ───────────────────────────── drawings for the chart / web app ─────────────────────────────
def chart_data(X, show_bars=SHOW_BARS):
    """Candles + drawing instructions (JSON-friendly) for the chart / web app.
    x = candle index in `candles` (the forming candle, if any, is the last one), t = epoch seconds.
    order = the sequence to animate drawings in; prio = 1 essential, 2 normal, 3 detail (lets a viewer pick how busy
    the chart is); extend = "right" for levels that run to the right edge."""
    d_, A, f, price, atr = X["df"], X["A"], X["f"], X["price"], X["atr"]
    n = len(d_)
    s0 = max(0, n - show_bars)
    view = d_.iloc[s0:]
    ts = md.epoch_s(view.index)
    candles = [[int(t), float(o), float(h), float(l), float(c), float(v)] for t, o, h, l, c, v in
               zip(ts, view["open"], view["high"], view["low"], view["close"], view["volume"])]
    forming = X["C"]["forming"]
    if forming is not None:
        candles.append([int(md.epoch_s(pd.DatetimeIndex([forming.name]))[0]), float(forming["open"]),
                        float(forming["high"]), float(forming["low"]), float(forming["close"]),
                        float(forming["volume"])])
    last_x = len(candles) - 1
    right = last_x + 18
    step = int(md.TF_MIN[X["tf"]] * 60)
    tx = lambda i: max(0, int(i) - s0)
    tt = lambda x: candles[min(max(0, x), last_x)][0] if x <= last_x else candles[last_x][0] + (x - last_x) * step
    rec = view.iloc[-120:]
    lo_v, hi_v = float(rec["low"].min()), float(rec["high"].max())
    pad = max((hi_v - lo_v) * 0.35, 2 * atr)
    vis = lambda a, b=None: (b if b is not None else a) >= lo_v - pad and a <= hi_v + pad
    D = []

    def add(layer, kind, order, prio=2, **kw):
        kw.update(layer=layer, kind=kind, order=order, prio=prio, id=f"{layer}-{len(D)}")
        for k in ("x1", "x2"):
            if k in kw and kw[k] is not None:
                kw[k.replace("x", "t")] = tt(kw[k])
        D.append(kw)

    sw = [s for s in A["swings"] if s["idx"] >= s0]
    if len(sw) >= 2:
        add("structure", "path", 1, 1, points=[[tx(s["idx"]), float(s["price"])] for s in sw], color=COL["zig"], width=1)
    for k, s in enumerate(sw):
        col = COL["up"] if s["label"] in ("HH", "HL") else COL["down"] if s["label"] in ("LH", "LL") else COL["text"]
        add("structure", "label", 2, 1 if k >= len(sw) - 8 else 3, x1=tx(s["idx"]), y1=float(s["price"]),
            text=s["label"], color=col, anchor="above" if s["type"] == "high" else "below")
    evs = [e for e in A["events"] if e["idx"] >= s0]
    for k, e in enumerate(evs):
        col = COL["choch"] if e["kind"] == "CHoCH" else (COL["up"] if e["direction"] == "bullish" else COL["down"])
        add("structure", "line", 3, 1 if k >= len(evs) - 4 else 3, x1=tx(e["from_idx"]), x2=tx(e["idx"]),
            y1=e["level"], y2=e["level"], color=col, dash="dash" if e["kind"] == "BOS" else "dot", width=1.3,
            text=e["kind"], label_at="middle", anchor="above" if e["direction"] == "bullish" else "below")
    for side in ("support", "resistance"):
        zs = sorted([z for z in A["zones"] if z["role"] in (side, "at zone") and vis(z["bottom"], z["top"])],
                    key=lambda z: abs((z["top"] + z["bottom"]) / 2 - price))
        for k, z in enumerate(zs[:3]):
            fill = COL["sup"] if z["role"] == "support" else COL["res"] if z["role"] == "resistance" else COL["mid"]
            add("zones", "box", 4, 2 if k < 2 else 3, x1=tx(z["first_idx"]), x2=right, y1=z["bottom"], y2=z["top"],
                fill=fill, text=f"{z['role'].capitalize()} ×{z['touches']}", extend="right")
    for k, ob in enumerate([o for o in X["obs"] if vis(o["bottom"], o["top"])]):
        bull = ob["role"] == "demand"
        add("orderblocks", "box", 5, 3 if ob["status"] == "breaker" or k >= 3 else 2, x1=tx(ob["idx"]), x2=right,
            y1=ob["bottom"], y2=ob["top"], fill=COL["ob_bull"] if bull else COL["ob_bear"], extend="right",
            text=("Breaker" if ob["status"] == "breaker" else "OB") + (" ▲" if bull else " ▼"))
    gaps = sorted([g for g in A["fvgs"] if g["filled_idx"] is None and vis(g["bottom"], g["top"])],
                  key=lambda g: abs((g["top"] + g["bottom"]) / 2 - price))
    for k, g in enumerate(gaps[:5]):
        add("fvg", "box", 6, 2 if k < 3 else 3, x1=tx(g["idx"]), x2=right, y1=g["bottom"], y2=g["top"],
            fill=COL["fvg_bull"] if g["direction"] == "bullish" else COL["fvg_bear"], text="FVG", extend="right")
    liq = A["liquidity"]
    for tag, lvls in (("BSL", liq["buy_side"][:3]), ("SSL", liq["sell_side"][:3])):
        for k, s in enumerate(lvls):
            if vis(s["price"]):
                add("liquidity", "line", 7, 1 if k == 0 else 2, x1=tx(s["idx"]), x2=right, y1=s["price"],
                    y2=s["price"], color=COL["liq"], dash="dashdot", width=1, text=tag, extend="right")
    for pl in liq["pools"]:
        if not pl["taken"] and pl["idx_a"] >= s0 and vis(pl["level"]):
            add("liquidity", "line", 7, 2, x1=tx(pl["idx_a"]), x2=tx(pl["idx_b"]), y1=pl["level"], y2=pl["level"],
                color=COL["liq"], dash="dot", width=1, text=pl["kind"], label_at="end")
    for k, s in enumerate([s for s in A["sweeps"] if s["idx"] >= s0][-6:][::-1]):
        add("liquidity", "marker", 8, 2 if k < 3 else 3, x1=tx(s["idx"]), y1=s["wick"], symbol="x", color=COL["liq"],
            text=f"{s['side']} liquidity swept")
    P = X["period"]
    for k, lab in (("pdh", "PDH"), ("pdl", "PDL"), ("pwh", "PWH"), ("pwl", "PWL"), ("pmh", "PMH"), ("pml", "PML")):
        if P.get(k) is not None and vis(P[k]) and (X["intraday"] or k[1] in "wm"):
            add("period", "hline", 9, 2, x1=0, x2=right, y1=P[k], y2=P[k], color=COL["period"], dash="dot", width=1,
                text=lab, extend="right")
    for r_ in X["rounds"]:
        if vis(r_["price"]):
            add("round", "hline", 9, 3, x1=0, x2=right, y1=r_["price"], y2=r_["price"], color=COL["round"],
                dash="dot", width=0.8, text=f.p(r_["price"]), extend="right")
    S_ = X["session"]
    if S_.get("asia") and S_["asia"]["i1"] >= s0:
        a_ = S_["asia"]
        add("session", "box", 10, 2, x1=tx(a_["i1"]), x2=tx(a_["i2"]), y1=a_["low"], y2=a_["high"],
            fill="rgba(144,202,249,0.08)", text="Asia", label_at="start")
    for L_ in X["lines"]:
        x1 = tx(L_["i1"])
        y1 = L_["p1"] + L_["slope"] * (s0 + x1 - L_["i1"]) if L_["i1"] < s0 else L_["p1"]
        y2 = L_["p1"] + L_["slope"] * (s0 + right - L_["i1"])
        add("trendlines", "line", 11, 2, x1=x1, x2=right, y1=float(y1), y2=float(y2), color=COL["trend"], width=1.4,
            text=L_["name"])
        if "channel_offset" in L_:
            add("trendlines", "line", 11, 3, x1=x1, x2=right, y1=float(y1 + L_["channel_offset"]),
                y2=float(y2 + L_["channel_offset"]), color=COL["trend"], width=1, dash="dash", text="channel")
    for q in X["patterns"]:
        if q["kind"] == "lines":
            for side in ("support", "resistance"):
                Lq = q[side]
                x1 = max(tx(Lq["i1"]), tx(q["start_idx"]))
                gi = s0 + x1
                add("patterns", "line", 12, 2, x1=x1, x2=last_x, y1=float(Lq["p1"] + Lq["slope"] * (gi - Lq["i1"])),
                    y2=float(Lq["p1"] + Lq["slope"] * (n - 1 - Lq["i1"])), color=COL["pattern"], width=1.4,
                    text=q["name"] if side == "resistance" else None, label_at="start")
        else:
            pts = [[tx(i), float(pp)] for i, pp in zip(q["points"], q["prices"])]
            add("patterns", "path", 12, 2, points=pts, color=COL["pattern"], width=1.2, dash="dot", text=q["name"])
            add("patterns", "hline", 12, 2, x1=pts[0][0], x2=right, y1=q["trigger"], y2=q["trigger"],
                color=COL["pattern"], dash="dash", width=1, text=f"{q['name']} trigger")
    leg = X["leg"]
    if leg is not None and leg["origin_idx"] >= s0:
        x1 = tx(min(leg["origin_idx"], leg["extreme_idx"]))
        for r_, v in leg["retracements"].items():
            if r_ in ("0.5", "0.618", "0.705", "0.786"):
                add("fib", "line", 13, 3, x1=x1, x2=right, y1=v, y2=v, color=COL["fib"], width=0.8, dash="dot",
                    text=f"{float(r_) * 100:.1f}%".replace(".0%", "%"))
        r = leg["retracements"]
        add("fib", "box", 13, 2, x1=x1, x2=right, y1=min(r["0.618"], r["0.786"]), y2=max(r["0.618"], r["0.786"]),
            fill=COL["ote"], text="OTE")
    dr = X["dr"]
    if dr is not None:
        add("range", "hline", 14, 3, x1=tx(min(dr["top_idx"], dr["bottom_idx"])), x2=right, y1=dr["eq"], y2=dr["eq"],
            color="rgba(209,212,220,0.5)", dash="dash", width=0.8, text="EQ 50%")
    if X["vp"] is not None:
        for k, lab in (("poc", "POC"), ("vah", "VAH"), ("val", "VAL")):
            add("volume_profile", "hline", 15, 3, x1=tx(X["vp"]["start_idx"]), x2=right, y1=X["vp"][k],
                y2=X["vp"][k], color=COL["poc"], dash="dot" if k != "poc" else None, width=0.8, text=lab)
        add("volume_profile", "histogram", 15, 3, bins=X["vp"]["bins"], x_right=right, color="rgba(240,98,146,0.25)")
    pats = [q for q in A["patterns"] if q["idx"] >= n - 30 and q["bias"] != "neutral"]
    for q in pats[-6:]:
        bull = q["bias"] == "bullish"
        i = q["idx"]
        y = float(d_["low"].iat[i] - 0.4 * atr) if bull else float(d_["high"].iat[i] + 0.4 * atr)
        add("candles", "marker", 16, 3 if i < n - 5 else 2, x1=tx(i), y1=y,
            symbol="triangle-up" if bull else "triangle-down", color=COL["up"] if bull else COL["down"], text=q["name"])
    for dv in X["divs"]:
        if dv["i1"] >= s0:
            add("divergence", "line", 17, 2, x1=tx(dv["i1"]), x2=tx(dv["i2"]), y1=dv["p1"], y2=dv["p2"],
                color=COL["up"] if dv["bias"] == 1 else COL["down"], width=1.6, text=dv["name"], label_at="end")
    for k, (pl, dim) in enumerate(((X["primary"], False), (X["alternative"], True))):
        if pl is None:
            continue
        x1, x2 = (last_x + 2, last_x + 10) if not dim else (last_x + 11, right - 1)
        o, pr = 18 + k, 1 if not dim else 2
        tag = "plan" if not dim else "alternative"
        add("plan", "box", o, pr, x1=x1, x2=x2, y1=min(pl["entry"], pl["tps"][-1]), y2=max(pl["entry"], pl["tps"][-1]),
            fill="rgba(38,166,154,0.10)" if dim else "rgba(38,166,154,0.22)", plan=tag)
        add("plan", "box", o, pr, x1=x1, x2=x2, y1=min(pl["entry"], pl["sl"]), y2=max(pl["entry"], pl["sl"]),
            fill="rgba(239,83,80,0.10)" if dim else "rgba(239,83,80,0.22)", plan=tag)
        pre = "" if not dim else "alt "
        add("plan", "line", o, pr, x1=x1, x2=x2, y1=pl["entry"], y2=pl["entry"], color=COL["text"], width=1.5,
            text=f"{pre}EP {f.p(pl['entry'])}", label_at="plan", plan=tag)
        add("plan", "line", o, pr, x1=x1, x2=x2, y1=pl["sl"], y2=pl["sl"], color=COL["down"], width=1.5,
            text=f"{pre}SL {f.p(pl['sl'])}", label_at="plan", plan=tag)
        for i, t in enumerate(pl["tps"]):
            add("plan", "line", o, pr, x1=x1, x2=x2, y1=t, y2=t, color=COL["up"], width=1.2,
                text=f"{pre}TP{i + 1} {f.p(t)}", label_at="plan", plan=tag)
    add("price", "hline", 20, 1, x1=0, x2=right, y1=price, y2=price, color=COL["text"], dash="dot", width=0.8,
        text=f.p(price), extend="right")
    for u in X["user"]:
        if u.get("type") in ("hline", "level") and "level" in u:
            add("user", "hline", 21, 1, x1=0, x2=right, y1=u["level"], y2=u["level"], color=COL["user"], width=1.2,
                text=u.get("label") or "yours", extend="right")
        elif u.get("type") == "zone" and "level" in u:
            add("user", "box", 21, 1, x1=0, x2=right, y1=min(u["bottom"], u["top"]), y2=max(u["bottom"], u["top"]),
                fill="rgba(255,235,59,0.12)", text=u.get("label") or "your zone", extend="right")
        elif u.get("type") == "trendline" and "level" in u:
            t1, t2 = float(u["t1"]), float(u["t2"])
            slope = (float(u["p2"]) - float(u["p1"])) / (t2 - t1) if t2 != t1 else 0.0
            ya = float(u["p1"]) + slope * (candles[0][0] - t1)
            yb = float(u["p1"]) + slope * (tt(right) - t1)
            add("user", "line", 21, 1, x1=0, x2=right, y1=ya, y2=yb, color=COL["user"], width=1.2,
                text=u.get("label") or "your trendline")
        elif u.get("type") == "note" and u.get("t") is not None:
            x = int(np.searchsorted([c_[0] for c_ in candles], float(u["t"])))
            add("user", "label", 21, 1, x1=min(x, last_x), y1=float(u.get("price", price)), text=u.get("text", ""),
                color=COL["user"], anchor="above")
    ind = {"ema20": X["emas"][20].iloc[s0:].round(10).tolist(), "ema50": X["emas"][50].iloc[s0:].round(10).tolist(),
           "ema200": X["emas"][200].iloc[s0:].round(10).tolist(), "rsi": gl.rsi(d_["close"]).iloc[s0:].round(2).tolist()}
    if X["vwap"] is not None:
        ind["vwap"] = X["vwap"].iloc[s0:].round(10).tolist()
    focus = [lo_v, hi_v] + [v for pl in (X["primary"],) if pl for v in [pl["entry"], pl["sl"], pl["tps"][0]]]
    return dict(candles=candles, drawings=D, indicators=ind,
                view=dict(x_from=max(0, last_x - 150), x_to=right + 2, y_from=min(focus) - 0.6 * atr,
                          y_to=max(focus) + 0.6 * atr))


# ───────────────────────────── review the user's own trade ─────────────────────────────
def review_trade(symbol, tf, side, entry, sl, tp, tp2=None, account=1000.0, risk_pct=1.0, leverage=None,
                 analysis=None, brain=None, mode="pro"):
    """Grade a trade idea the user already has: odds, R:R, where the stop/target sit relative to liquidity and
    levels, position size and leverage, and concrete improvements."""
    brain = brain or _STATE["brain"] or gm.FallbackBrain()
    res = analysis or analyze(symbol, tf, account=account, risk_pct=risk_pct, brain=brain)
    X = _STATE.get("ctx", {}).get((res["symbol"], res["tf"]))
    if X is None:                                                      # rebuild the context from the analysis
        X = _context_for_review(symbol, tf, brain, res)
    d = 1 if str(side).lower() in ("long", "buy", "b", "1") else -1
    tps = [float(tp)] + ([float(tp2)] if tp2 is not None else [])
    if not d * (entry - sl) > 0:
        return dict(ok=False, text=f"The stop must be {'below' if d == 1 else 'above'} the entry for a "
                                   f"{'long' if d == 1 else 'short'}.")
    if not all(d * (t - entry) > 0 for t in tps):
        return dict(ok=False, text=f"The target must be {'above' if d == 1 else 'below'} the entry.")
    f, atr = X["f"], X["atr"]
    p = _plan("long" if d == 1 else "short", "market" if abs(entry - X["price"]) < 0.05 * atr else
              ("limit" if d * (X["price"] - entry) > 0 else "stop"), "Your trade", entry, sl,
              [(t, "your target") for t in tps], [], f"price reaching {f.p(sl)}", gm.EXPIRY)
    p = evaluate_plan(p, X, brain)
    p["sizing"] = size_position(p, X, account, risk_pct, leverage)
    issues, fixes = [], []
    risk = abs(entry - sl)
    if risk < 0.5 * atr:
        issues.append(f"Stop is only {risk / atr:.2f} ATR away: normal noise can hit it.")
        fixes.append(f"Give it at least 0.5–1 ATR ({f.p(entry - d * 0.75 * atr)}) or wait for a better entry.")
    pools = [c for c in X["clusters"] if ("liquidity" in " ".join(c["labels"]) or "equal" in " ".join(c["labels"]))]
    bad_sl = [c for c in pools if 0 <= d * (c["price"] - sl) <= 0.25 * atr]
    if bad_sl:
        lvl = bad_sl[0]["price"]
        better = lvl - d * 0.3 * atr
        issues.append(f"Your stop sits right at liquidity ({', '.join(bad_sl[0]['labels'][:2])} at {f.p(lvl)}): "
                      f"exactly where stop hunts happen.")
        fixes.append(f"Put the stop beyond the pool, e.g. {f.p(better)} (and size down to keep the same $ risk).")
    walls = [c for c in X["clusters"] if c["strength"] >= 2 and d * (c["price"] - entry) > 0.2 * atr
             and d * (tps[0] - c["price"]) > 0.15 * atr]
    if walls:
        w_ = walls[0] if d == 1 else walls[-1]
        issues.append(f"There's a strong level before your target: {', '.join(w_['labels'][:2])} at {f.p(w_['price'])}.")
        fixes.append(f"Take partial profit just before it ({f.p(w_['price'] - d * 0.05 * atr)}) or move the target there.")
    if p["rr"][0] < 1.5:
        issues.append(f"Reward:risk is only {p['rr'][0]:.2f}.")
        fixes.append("Aim for at least 1.5–2R, or skip it: low-R:R trades need a very high win rate.")
    for c in p["checklist"]:
        if not c["ok"] and c["w"] < 0 and not (walls and "in the way" in c["text"]):
            issues.append(c["text"][0].upper() + c["text"][1:] + ".")
    j = len(p["tps"]) - 1
    if risk < 0.5 * atr or p["rr"][j] > 5:
        issues.append("This geometry is outside what the model was trained on (stops 0.5–4 ATR, R:R up to 5): "
                      "the odds shown are for the nearest trained case and are probably optimistic.")
    verdict = ("GOOD TRADE" if p["grade"] in ("A+", "A") else "OK TRADE" if p["grade"] == "B" else
               "WEAK TRADE" if p["grade"] == "C" else "POOR TRADE")
    severe = risk < 0.4 * atr or p["cost_r"] > 0.20 or p["rr"][j] < 1.0 or p["ev"][j] < -0.15
    if severe and verdict in ("GOOD TRADE", "OK TRADE"):
        verdict = "WEAK TRADE"
    L = [f"YOUR TRADE: {'BUY' if d == 1 else 'SELL'} {f.p(entry)} · SL {f.p(sl)} · "
         + " · ".join(f"TP{i + 1} {f.p(t)}" for i, t in enumerate(p["tps"])),
         f"Verdict: {verdict} (grade {p['grade']}, {p['score']:.1f}/10) · R:R {p['rr'][j]:.2f} · "
         f"P(target before stop) {pct(p['p_tp'][j])} vs {pct(p['breakeven'][j])} break-even · EV {p['ev'][j]:+.2f}R",
         ""]
    L.append("Checklist:")
    L += [f"  {'✓' if c['ok'] else '✗'} {c['text']}" for c in p["checklist"]]
    if issues:
        L += ["", "Problems:"] + [f"  • {x}" for x in issues]
    if fixes:
        L += ["", "Improve it:"] + [f"  • {x}" for x in fixes]
    L += ["", "Size & leverage:"] + [f"  • {x}" for x in _sizing_lines(p, f)]
    return dict(ok=True, verdict=verdict, plan=_public_plan(p, f), issues=issues, fixes=fixes, text="\n".join(L))


def _context_for_review(symbol, tf, brain, res):
    """Minimal context rebuild for review_trade when only the public analysis dict is at hand."""
    tf = md.norm_tf(tf)
    C = md.get_candles(symbol, tf, bars=BARS[tf])
    dfe, A = se.analyze(C["df"])
    frames = {}
    for h in gm.LADDER[tf][:2]:
        try:
            frames[h] = md.get_candles(symbol, h, bars=HTF_BARS)["df"]
        except Exception:
            pass
    F, ctx = gm.raw_features(dfe, tf, C["asset_class"], htf=frames)
    cost, slip = gm.cost_of(C["sub"])
    X = dict(C=C, df=dfe, A=A, tf=tf, ladder=gm.LADDER[tf], price=float(C["price"]), atr=float(dfe["atr"].iloc[-1]),
             f=Fmt(C["decimals"]), row=F.iloc[-1], cost=cost, slip=slip, asset_class=C["asset_class"],
             intraday=md.TF_MIN[tf] < 1440, trend=int(A["trend"][-1]))
    X["htf"] = {t["tf"]: t for t in res.get("timeframes", [])}
    X["dr"] = gl.dealing_range(dfe, A)
    X["clusters"] = res.get("levels", [])
    X["rsi"] = float(res.get("rsi", 50))
    X["divs"] = res.get("divergences", [])
    X["patterns"] = res.get("patterns", [])
    X["session"] = res.get("session", {})
    X["q2usd"] = quote_to_usd(C)
    return X

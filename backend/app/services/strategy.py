"""Strategy mode: the user's own rules → a live check on the current chart + an honest backtest.

A strategy is plain JSON (see TEMPLATES): entry conditions that must all be true on a closed candle (mirrored for
shorts), a stop rule, a target rule and a maximum holding time. Signals use only information known at the close of
the signal candle; trades enter at the next candle's open. If a candle touches both the stop and the target, the
stop is assumed to come first. Costs (spread, fees, slippage) are charged on every trade."""
import json
import math
import re
from datetime import timezone

import numpy as np
import pandas as pd

import guru_model as gm
import market_data as md
import structure_engine as se

from . import streixai

CONDITIONS = {
    "trend_ema": dict(label="EMA trend", params=dict(fast=50, slow=200),
                      desc="Longs only when EMA {fast} is above EMA {slow} (shorts: below)"),
    "price_ema": dict(label="Price vs EMA", params=dict(period=200), desc="Longs when price closes above EMA {period} (shorts: below)"),
    "ema_cross": dict(label="EMA crossover", params=dict(fast=9, slow=21, within=1),
                      desc="EMA {fast} crossed above EMA {slow} (shorts: below) in the last {within} candle(s)"),
    "rsi": dict(label="RSI extreme", params=dict(period=14, long_below=30, short_above=70),
                desc="Longs when RSI {period} is below {long_below}; shorts when above {short_above}"),
    "rsi_cross": dict(label="RSI turns back", params=dict(period=14, level=30),
                      desc="Longs when RSI {period} crosses back above {level} (shorts: back below 100−{level})"),
    "breakout": dict(label="Breakout", params=dict(lookback=20),
                     desc="Close breaks the highest high of the last {lookback} candles (shorts: lowest low)"),
    "pullback_ema": dict(label="Pullback to EMA", params=dict(period=21, atr=0.3),
                         desc="Price dips to EMA {period} (within {atr} ATR) and closes back on the trend side"),
    "engulfing": dict(label="Engulfing candle", params={}, desc="A bullish engulfing candle (shorts: bearish engulfing)"),
    "structure": dict(label="Break of structure", params=dict(kind="any", within=3),
                      desc="A bullish {kind} break of structure (shorts: bearish) in the last {within} candles"),
    "sweep": dict(label="Liquidity sweep", params=dict(within=5),
                  desc="Sell-side liquidity swept (shorts: buy-side) in the last {within} candles"),
    "structure_trend": dict(label="Structure trend", params={}, desc="Market structure on this timeframe is bullish (shorts: bearish)"),
    "htf_trend": dict(label="Higher-timeframe trend", params={}, desc="Structure on the next higher timeframe agrees"),
    "session": dict(label="Session filter", params=dict(names=["london", "newyork"]),
                    desc="Only in the {names} killzone(s) (New York time)"),
    "volume": dict(label="Volume spike", params=dict(mult=1.5, period=20), desc="Volume above {mult}× its {period}-candle average"),
    "bb_touch": dict(label="Bollinger band touch", params=dict(period=20, mult=2.0),
                     desc="Low touches the lower band (shorts: high touches the upper band)"),
    "premium_discount": dict(label="Premium / discount", params=dict(lookback=50),
                             desc="Longs only in the discount half of the last {lookback} candles' range (shorts: the premium half)"),
}
STOPS = dict(atr=dict(mult=1.5), swing=dict(lookback=10, buffer_atr=0.2), percent=dict(value=1.0))
TARGETS = dict(rr=dict(value=2.0), atr=dict(mult=3.0), percent=dict(value=2.0))
SESSIONS = {"asia": (20, 24), "london": (2, 5), "newyork": (7, 10), "nyclose": (10, 12)}
LIMITS = dict(fast=(2, 400), slow=(2, 400), period=(2, 400), within=(1, 50), long_below=(1, 99), short_above=(1, 99),
              level=(1, 99), lookback=(2, 300), atr=(0.0, 3.0), mult=(0.1, 20.0), buffer_atr=(0.0, 3.0), value=(0.05, 50.0))

TEMPLATES = [
    dict(id="trend_pullback", name="Trend pullback", direction="both",
         description="Trade with the trend: EMA 50 above EMA 200, wait for a dip to EMA 21, stop 1.5 ATR, target 2R.",
         conditions=[dict(type="trend_ema", fast=50, slow=200), dict(type="pullback_ema", period=21, atr=0.3)],
         stop=dict(type="atr", mult=1.5), target=dict(type="rr", value=2.0), max_hold=48),
    dict(id="breakout", name="Breakout with volume", direction="both",
         description="Close above the 20-candle high on a volume spike, stop below the last swing, target 2R.",
         conditions=[dict(type="breakout", lookback=20), dict(type="volume", mult=1.5, period=20)],
         stop=dict(type="swing", lookback=10, buffer_atr=0.2), target=dict(type="rr", value=2.0), max_hold=48),
    dict(id="rsi_reversion", name="RSI dip in an uptrend", direction="long",
         description="Price above EMA 200 and RSI crosses back above 30: buy the dip, stop 1.5 ATR, target 1.5R.",
         conditions=[dict(type="price_ema", period=200), dict(type="rsi_cross", period=14, level=30)],
         stop=dict(type="atr", mult=1.5), target=dict(type="rr", value=1.5), max_hold=36),
    dict(id="ict_sweep_mss", name="ICT sweep + structure shift", direction="both",
         description="Liquidity sweep, then a break of structure the other way inside the London/NY killzones.",
         conditions=[dict(type="sweep", within=6), dict(type="structure", kind="any", within=3),
                     dict(type="session", names=["london", "newyork"])],
         stop=dict(type="swing", lookback=8, buffer_atr=0.2), target=dict(type="rr", value=2.5), max_hold=36),
    dict(id="ema_cross", name="EMA 9/21 crossover", direction="both",
         description="EMA 9 crosses EMA 21 in the direction of EMA 200, stop 1.2 ATR, target 2R.",
         conditions=[dict(type="ema_cross", fast=9, slow=21, within=1), dict(type="price_ema", period=200)],
         stop=dict(type="atr", mult=1.2), target=dict(type="rr", value=2.0), max_hold=48),
    dict(id="htf_bos", name="HTF trend + BOS", direction="both",
         description="Higher timeframe trend agrees and price breaks structure the same way. Stop at the swing, 2R.",
         conditions=[dict(type="htf_trend"), dict(type="structure", kind="BOS", within=2)],
         stop=dict(type="swing", lookback=10, buffer_atr=0.25), target=dict(type="rr", value=2.0), max_hold=60),
    # S.C.A.L.P.: a fixed clock window (London killzone), a liquidity sweep, a structure break the other way,
    # and entry only from the discount (longs) or premium (shorts) half of the recent range.
    dict(id="scalp_london", name="S.C.A.L.P. · London sweep", direction="both",
         description="In the London killzone (02:00–05:00 New York): a liquidity sweep, then a structure break the other way, "
                     "taken only from the discount half (longs) or premium half (shorts) of the last 50 candles. "
                     "Stop 1 ATR, target 3R, close after 24 candles.",
         conditions=[dict(type="session", names=["london"]), dict(type="sweep", within=6),
                     dict(type="structure", kind="any", within=3), dict(type="premium_discount", lookback=50)],
         stop=dict(type="atr", mult=1.0), target=dict(type="rr", value=3.0), max_hold=24),
]


class StrategyError(Exception):
    pass


# ───────────────────────────── spec cleaning ─────────────────────────────
def _num(v, key, default):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(x):
        return default
    lo, hi = LIMITS.get(key, (-1e9, 1e9))
    x = min(hi, max(lo, x))
    return int(round(x)) if key in ("fast", "slow", "period", "within", "lookback", "long_below", "short_above", "level") else x


def sanitize(spec):
    if not isinstance(spec, dict):
        raise StrategyError("A strategy must be an object.")
    out = dict(name=str(spec.get("name") or "My strategy")[:60], description=str(spec.get("description") or "")[:400])
    d = str(spec.get("direction") or "both").lower()
    out["direction"] = d if d in ("both", "long", "short") else "both"
    conds = []
    for c in (spec.get("conditions") or [])[:8]:
        if not isinstance(c, dict) or c.get("type") not in CONDITIONS:
            continue
        t = c["type"]
        base = CONDITIONS[t]["params"]
        cc = dict(type=t)
        for k, dv in base.items():
            if k == "names":
                names = [n for n in (c.get("names") or dv) if n in SESSIONS]
                cc["names"] = names or list(dv)
            elif k == "kind":
                kd = str(c.get("kind") or dv)
                cc["kind"] = kd if kd in ("any", "BOS", "CHoCH") else "any"
            else:
                cc[k] = _num(c.get(k, dv), k, dv)
        if t in ("trend_ema", "ema_cross") and cc["fast"] >= cc["slow"]:
            cc["fast"], cc["slow"] = min(cc["fast"], cc["slow"] - 1), max(cc["slow"], cc["fast"] + 1)
        conds.append(cc)
    if not conds:
        raise StrategyError("Add at least one entry condition.")
    out["conditions"] = conds
    st = spec.get("stop") or {}
    stype = st.get("type") if st.get("type") in STOPS else "atr"
    out["stop"] = dict(type=stype, **{k: _num(st.get(k, v), k, v) for k, v in STOPS[stype].items()})
    tg = spec.get("target") or {}
    ttype = tg.get("type") if tg.get("type") in TARGETS else "rr"
    out["target"] = dict(type=ttype, **{k: _num(tg.get(k, v), k, v) for k, v in TARGETS[ttype].items()})
    try:
        out["max_hold"] = int(min(500, max(2, int(spec.get("max_hold") or 48))))
    except (TypeError, ValueError):
        out["max_hold"] = 48
    return out


def describe(spec):
    lines = []
    for c in spec["conditions"]:
        meta = CONDITIONS[c["type"]]
        p = dict(c)
        if "names" in p:
            p["names"] = " / ".join(n.capitalize() for n in p["names"])
        if p.get("kind") == "any":
            p["kind"] = "BOS or CHoCH"
        try:
            lines.append(meta["desc"].format(**p))
        except (KeyError, IndexError):
            lines.append(meta["label"])
    s, t = spec["stop"], spec["target"]
    stop = (f"stop {s['mult']} ATR away" if s["type"] == "atr" else f"stop beyond the last {s['lookback']}-candle swing "
            f"(+{s['buffer_atr']} ATR)" if s["type"] == "swing" else f"stop {s['value']}% away")
    tgt = (f"target {t['value']}R" if t["type"] == "rr" else f"target {t['mult']} ATR" if t["type"] == "atr"
           else f"target {t['value']}%")
    side = {"both": "longs and shorts", "long": "longs only", "short": "shorts only"}[spec["direction"]]
    return dict(rules=lines, exits=f"{stop}, {tgt}, close after {spec['max_hold']} candles if neither is hit", side=side)


# ───────────────────────────── natural language → spec ─────────────────────────────
def parse_text_offline(text):
    t = " " + (text or "").lower().replace("-", " ") + " "
    conds, warn = [], []
    m = re.search(r"(?:ema|ma)\s*(\d+)\s*(?:is\s*|has\s*|stays?\s*)?((?:/|and|&|,|vs\.?|over|above|below|under|"
                  r"cross(?:es|ed|ing)?(?:\s*(?:over|above|below|under))?))\s*(?:the\s*)?(?:ema\s*|ma\s*)?(\d+)", t)
    if m:
        a, b = sorted([int(m.group(1)), int(m.group(3))])
        if "cross" in m.group(2):
            conds.append(dict(type="ema_cross", fast=a, slow=b, within=1))
        else:
            conds.append(dict(type="trend_ema", fast=a, slow=b))
    elif re.search(r"golden cross|death cross", t):
        conds.append(dict(type="ema_cross", fast=50, slow=200, within=1))
    used = {n for c in conds if c["type"] in ("trend_ema", "ema_cross") for n in (c["fast"], c["slow"])}
    pats = (r"(?:above|over|below|under|direction of|side of)\s*(?:the\s*)?(?:ema|ma|moving average)\s*(\d+)",
            r"(?:above|over|below|under|direction of|side of)\s*(?:the\s*)?(\d+)\s*(?:ema|ma|moving average)",
            r"(?:ema|ma)\s*(\d+)\s*(?:filter|trend)")
    periods = [int(x) for pat in pats for x in re.findall(pat, t)]
    free = [n for n in periods if n not in used]
    if free:
        conds.append(dict(type="price_ema", period=max(free)))
    m = re.search(r"rsi\s*(?:\(?\s*(\d+)\s*\)?)?\s*(?:is\s*)?(?:below|under|<|less than)\s*(\d+)", t)
    if m:
        lvl = int(m.group(2))
        conds.append(dict(type="rsi", period=int(m.group(1) or 14), long_below=lvl, short_above=100 - lvl))
    m2 = re.search(r"rsi\s*(?:\(?\s*(\d+)\s*\)?)?\s*(?:is\s*)?(?:above|over|>|greater than)\s*(\d+)", t)
    if m2 and not m:
        lvl = int(m2.group(2))
        conds.append(dict(type="rsi", period=int(m2.group(1) or 14), long_below=100 - lvl, short_above=lvl))
    if re.search(r"rsi.*(cross|back above|turns? up)", t) and not m and not m2:
        conds.append(dict(type="rsi_cross", period=14, level=30))
    m = re.search(r"(\d+)\s*(?:bar|candle|period|day)s?\s*(?:high|breakout|range)", t) or re.search(r"break(?:out|s)?\s*(?:of\s*)?(?:the\s*)?(\d+)", t)
    if m or re.search(r"breakout|break out", t):
        conds.append(dict(type="breakout", lookback=int(m.group(1)) if m else 20))
    m = re.search(r"pull ?back\s*(?:to|into)\s*(?:the\s*)?(?:ema|ma)\s*(\d+)", t)
    if m or re.search(r"pull ?back|dip", t) and not any(c["type"] == "rsi_cross" for c in conds):
        conds.append(dict(type="pullback_ema", period=int(m.group(1)) if m else 21, atr=0.3))
    if re.search(r"engulf", t):
        conds.append(dict(type="engulfing"))
    if re.search(r"\bchoch\b|change of character", t):
        conds.append(dict(type="structure", kind="CHoCH", within=3))
    elif re.search(r"\bbos\b|break of structure|structure break|\bmss\b|market structure shift", t):
        conds.append(dict(type="structure", kind="any" if "mss" in t else "BOS", within=3))
    if re.search(r"sweep|stop hunt|liquidity grab|liquidity raid|grab liquidity", t):
        conds.append(dict(type="sweep", within=6))
    if re.search(r"higher time ?frame|\bhtf\b|daily trend|4h trend|bigger trend", t):
        conds.append(dict(type="htf_trend"))
    if re.search(r"(market )?structure (is )?(bullish|bearish|trend)|higher highs|lower lows", t):
        conds.append(dict(type="structure_trend"))
    names = [n for n, pat in (("london", r"london"), ("newyork", r"new york|\bny\b"), ("asia", r"asia|tokyo")) if re.search(pat, t)]
    if names:
        conds.append(dict(type="session", names=names))
    m = re.search(r"volume\s*(?:spike|above|over|>)?\s*(\d+(?:\.\d+)?)\s*x", t)
    if m or re.search(r"volume (spike|surge|confirm)|high volume", t):
        conds.append(dict(type="volume", mult=float(m.group(1)) if m else 1.5, period=20))
    if re.search(r"bollinger|\bbb\b", t):
        conds.append(dict(type="bb_touch", period=20, mult=2.0))
    stop = dict(type="atr", mult=1.5)
    m = re.search(r"stop\w*\s*(?:loss\s*)?(?:of\s*|at\s*|=\s*)?(\d+(?:\.\d+)?)\s*(?:x\s*)?atr", t) or re.search(r"(\d+(?:\.\d+)?)\s*atr\s*stop", t)
    if m:
        stop = dict(type="atr", mult=float(m.group(1)))
    elif re.search(r"stop\w*.{0,30}(swing|structure|below the low|above the high|last low|last high)", t):
        stop = dict(type="swing", lookback=10, buffer_atr=0.2)
    else:
        m = re.search(r"stop\w*\s*(?:loss\s*)?(?:of\s*|at\s*)?(\d+(?:\.\d+)?)\s*%", t)
        if m:
            stop = dict(type="percent", value=float(m.group(1)))
    target = dict(type="rr", value=2.0)
    m = re.search(r"1\s*:\s*(\d+(?:\.\d+)?)", t) or re.search(r"(\d+(?:\.\d+)?)\s*r\b", t) or re.search(r"(?:rr|r:r|risk reward)\s*(?:of\s*)?(\d+(?:\.\d+)?)", t)
    if m:
        target = dict(type="rr", value=float(m.group(1)))
    else:
        m = re.search(r"(?:target|tp|take profit)\w*\s*(?:of\s*|at\s*)?(\d+(?:\.\d+)?)\s*atr", t)
        if m:
            target = dict(type="atr", mult=float(m.group(1)))
        else:
            m = re.search(r"(?:target|tp|take profit)\w*\s*(?:of\s*|at\s*)?(\d+(?:\.\d+)?)\s*%", t)
            if m:
                target = dict(type="percent", value=float(m.group(1)))
    wants_long = re.search(r"\b(buy|buying|long|longs|go long|bullish)\b", t)
    wants_short = re.search(r"\b(sell|selling|short|shorts|go short|bearish)\b", t)
    if re.search(r"only long|longs only|buy only|only buy", t) or (wants_long and not wants_short):
        direction = "long"
    elif re.search(r"only short|shorts only|sell only|only sell", t) or (wants_short and not wants_long):
        direction = "short"
    else:
        direction = "both"
    if re.search(r"(and|or|&) (the )?(opposite|reverse|mirror)|both (ways|directions|sides)|long (and|or|&) short|"
                 r"buy (and|or|&) sell", t):
        direction = "both"
    if not conds:
        warn.append("I couldn't find entry rules in that description, so I used a trend-pullback template. Try "
                    "naming indicators (EMA 50/200, RSI below 30), patterns (breakout, engulfing, sweep, BOS) or "
                    "sessions (London, New York).")
        conds = [dict(type="trend_ema", fast=50, slow=200), dict(type="pullback_ema", period=21, atr=0.3)]
    seen, uniq = set(), []
    for c in conds:
        k = c["type"]
        if k not in seen:
            seen.add(k)
            uniq.append(c)
    return dict(name="My strategy", description=text[:400], direction=direction, conditions=uniq, stop=stop,
                target=target, max_hold=48), warn


AI_SCHEMA_HINT = json.dumps(dict(name="string", direction="both|long|short",
                                 conditions=[dict(type=k, **v["params"]) for k, v in CONDITIONS.items()],
                                 stop=[dict(type=k, **v) for k, v in STOPS.items()],
                                 target=[dict(type=k, **v) for k, v in TARGETS.items()], max_hold=48))


def parse_text_ai(text):
    """Ask the configured model to map the description onto the condition library. Returns (spec, notes) or None."""
    if streixai.provider() == "offline":
        return None
    system = ("You convert a trader's description of a strategy into JSON for a backtester. Use ONLY these building "
              "blocks (condition types and their parameters, stop types, target types):\n" + AI_SCHEMA_HINT +
              "\nRules: conditions describe LONG entries; shorts are mirrored automatically. Pick 1–6 conditions. "
              "Output exactly one JSON object with keys name, direction, conditions, stop, target, max_hold, and "
              "'notes' (a list of short strings explaining anything you couldn't map). No prose, no code fences.")
    msgs = [{"role": "user", "content": text[:2000]}]
    out = streixai.complete(system, msgs, tier="free", max_tokens=700)
    if not out:
        return None
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return None
    try:
        spec = json.loads(m.group(0))
    except ValueError:
        return None
    notes = [str(n)[:200] for n in (spec.pop("notes", None) or [])][:5]
    spec["description"] = text[:400]
    return spec, notes


def parse_text(text):
    ai = parse_text_ai(text)
    if ai:
        try:
            return sanitize(ai[0]), ai[1], True
        except StrategyError:
            pass
    spec, warn = parse_text_offline(text)
    return sanitize(spec), warn, False


# ───────────────────────────── signals ─────────────────────────────
def _ema(x, n):
    return pd.Series(x).ewm(span=n, adjust=False, min_periods=n).mean().to_numpy()


def _rsi(x, n):
    d = np.diff(x, prepend=x[0])
    up = pd.Series(np.clip(d, 0, None)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = pd.Series(np.clip(-d, 0, None)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50).to_numpy()


def _recent(mask, within):
    """True if mask was true on this bar or any of the previous within-1 bars."""
    if within <= 1:
        return mask
    return pd.Series(mask.astype(float)).rolling(within, min_periods=1).max().to_numpy() > 0


class Context:
    def __init__(self, df, tf, htf_df=None, htf=None):
        if "atr" not in df.columns:
            df = se.add_atr(df[["open", "high", "low", "close", "volume"]].astype(float).copy())
        self.df, self.tf = df, tf
        self.o, self.h, self.l, self.c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
        self.v = df["volume"].to_numpy(dtype=float)
        self.atr = df["atr"].bfill().to_numpy(dtype=float)
        self.n = len(df)
        piv = se.find_pivots(df, 3, 3)
        self.events, self.sweeps, self.trend = se.detect_structure_breaks(df, piv)
        self.htf_trend = gm.htf_trend_on(df, tf, htf_df, htf) if htf_df is not None else np.full(self.n, np.nan)
        self._cache = {}

    def ema(self, n):
        k = ("ema", n)
        if k not in self._cache:
            self._cache[k] = _ema(self.c, n)
        return self._cache[k]


def condition_masks(ctx, c):
    """(long_ok, short_ok) boolean arrays for one condition, known at each candle's close."""
    t = c["type"]
    n = ctx.n
    C, H, L, O = ctx.c, ctx.h, ctx.l, ctx.o
    nan = lambda a: np.nan_to_num(a, nan=0.0)
    if t == "trend_ema":
        f, s = ctx.ema(c["fast"]), ctx.ema(c["slow"])
        ok = ~np.isnan(f) & ~np.isnan(s)
        return ok & (f > s), ok & (f < s)
    if t == "price_ema":
        e = ctx.ema(c["period"])
        ok = ~np.isnan(e)
        return ok & (C > e), ok & (C < e)
    if t == "ema_cross":
        f, s = ctx.ema(c["fast"]), ctx.ema(c["slow"])
        d = f - s
        prev = np.r_[np.nan, d[:-1]]
        up = (d > 0) & (prev <= 0)
        dn = (d < 0) & (prev >= 0)
        return _recent(nan(up) > 0, c["within"]), _recent(nan(dn) > 0, c["within"])
    if t == "rsi":
        r = _rsi(C, c["period"])
        return r < c["long_below"], r > c["short_above"]
    if t == "rsi_cross":
        r = _rsi(C, c["period"])
        pr = np.r_[50.0, r[:-1]]
        lv = c["level"]
        return (r > lv) & (pr <= lv), (r < 100 - lv) & (pr >= 100 - lv)
    if t == "breakout":
        lb = c["lookback"]
        hh = pd.Series(H).rolling(lb).max().shift(1).to_numpy()
        ll = pd.Series(L).rolling(lb).min().shift(1).to_numpy()
        return C > np.where(np.isnan(hh), np.inf, hh), C < np.where(np.isnan(ll), -np.inf, ll)
    if t == "pullback_ema":
        e = ctx.ema(c["period"])
        tol = c["atr"] * ctx.atr
        ok = ~np.isnan(e)
        lng = ok & (L <= e + tol) & (C > e)
        sht = ok & (H >= e - tol) & (C < e)
        return lng, sht
    if t == "engulfing":
        po, pc = np.r_[np.nan, O[:-1]], np.r_[np.nan, C[:-1]]
        bull = (pc < po) & (C > O) & (C >= po) & (O <= pc)
        bear = (pc > po) & (C < O) & (C <= po) & (O >= pc)
        return nan(bull) > 0, nan(bear) > 0
    if t == "structure":
        bull, bear = np.zeros(n, bool), np.zeros(n, bool)
        for e in ctx.events:
            if c["kind"] != "any" and e["kind"] != c["kind"]:
                continue
            (bull if e["direction"] == "bullish" else bear)[e["idx"]] = True
        return _recent(bull, c["within"]), _recent(bear, c["within"])
    if t == "sweep":
        ssl, bsl = np.zeros(n, bool), np.zeros(n, bool)
        for s_ in ctx.sweeps:
            (ssl if s_["side"] == "sell-side" else bsl)[s_["idx"]] = True
        return _recent(ssl, c["within"]), _recent(bsl, c["within"])
    if t == "structure_trend":
        return ctx.trend > 0, ctx.trend < 0
    if t == "htf_trend":
        ht = ctx.htf_trend
        return np.nan_to_num(ht) > 0, np.nan_to_num(ht) < 0
    if t == "session":
        ny = ctx.df.index.tz_convert("America/New_York")
        hh = ny.hour + ny.minute / 60.0
        ok = np.zeros(n, bool)
        for name in c["names"]:
            a, b = SESSIONS[name]
            ok |= (hh >= a) & (hh < b)
        return ok, ok
    if t == "volume":
        avg = pd.Series(ctx.v).rolling(c["period"]).mean().shift(1).to_numpy()
        ok = (avg > 0) & (ctx.v > c["mult"] * np.nan_to_num(avg))
        return ok, ok
    if t == "bb_touch":
        s = pd.Series(C)
        m = s.rolling(c["period"]).mean()
        sd = s.rolling(c["period"]).std(ddof=0)
        up, lo = (m + c["mult"] * sd).to_numpy(), (m - c["mult"] * sd).to_numpy()
        return (L <= np.nan_to_num(lo, nan=-np.inf)), (H >= np.nan_to_num(up, nan=np.inf))
    if t == "premium_discount":
        # the middle of the range of the last `lookback` candles (this candle included, known at its close)
        lb = c["lookback"]
        hh = pd.Series(H).rolling(lb).max().to_numpy()
        ll = pd.Series(L).rolling(lb).min().to_numpy()
        mid = (hh + ll) / 2
        ok = ~np.isnan(mid)
        return ok & (C < mid), ok & (C > mid)
    raise StrategyError(f"Unknown condition {t}")


def signals(ctx, spec):
    lng = np.ones(ctx.n, bool)
    sht = np.ones(ctx.n, bool)
    per = []
    for c in spec["conditions"]:
        a, b = condition_masks(ctx, c)
        a, b = np.asarray(a, bool), np.asarray(b, bool)
        per.append((c, a, b))
        lng &= a
        sht &= b
    if spec["direction"] == "long":
        sht[:] = False
    elif spec["direction"] == "short":
        lng[:] = False
    warm = 210 if any(c["type"] in ("trend_ema", "price_ema") and max(c.get("slow", 0), c.get("period", 0)) >= 150
                      for c in spec["conditions"]) else 60
    lng[:warm] = False
    sht[:warm] = False
    return lng, sht, per


def stop_target(ctx, spec, i, d, entry):
    s, t = spec["stop"], spec["target"]
    a = ctx.atr[i]
    if s["type"] == "atr":
        stop = entry - d * s["mult"] * a
    elif s["type"] == "swing":
        lb = s["lookback"]
        lo, hi = ctx.l[max(0, i - lb + 1): i + 1].min(), ctx.h[max(0, i - lb + 1): i + 1].max()
        stop = (lo - s["buffer_atr"] * a) if d == 1 else (hi + s["buffer_atr"] * a)
    else:
        stop = entry * (1 - d * s["value"] / 100)
    risk = d * (entry - stop)
    if not (risk > 0) or risk < 0.05 * a:
        return None
    if t["type"] == "rr":
        target = entry + d * t["value"] * risk
    elif t["type"] == "atr":
        target = entry + d * t["mult"] * a
    else:
        target = entry * (1 + d * t["value"] / 100)
    if not d * (target - entry) > 0:
        return None
    return stop, target, risk


def backtest(ctx, spec, cost_frac, slip_frac):
    lng, sht, per = signals(ctx, spec)
    O, H, L, C = ctx.o, ctx.h, ctx.l, ctx.c
    times = md.epoch_s(ctx.df.index)
    trades = []
    i = 0
    n = ctx.n
    while i < n - 1:
        d = 1 if lng[i] else -1 if sht[i] else 0
        if d == 0:
            i += 1
            continue
        e = i + 1
        entry = O[e]
        st = stop_target(ctx, spec, i, d, entry)
        if st is None:
            i += 1
            continue
        stop, target, risk = st
        exit_px, reason, j = None, None, e
        last = min(n - 1, e + spec["max_hold"] - 1)
        for j in range(e, last + 1):
            hit_stop = L[j] <= stop if d == 1 else H[j] >= stop
            hit_tp = H[j] >= target if d == 1 else L[j] <= target
            if hit_stop:
                gap = (O[j] < stop) if d == 1 else (O[j] > stop)
                exit_px = (O[j] if gap else stop) - d * slip_frac * entry
                reason = "stop"
                break
            if hit_tp:
                exit_px, reason = target, "target"
                break
        if exit_px is None:
            if last >= n - 1 and j == n - 1 and n - 1 - e < spec["max_hold"] - 1:
                trades.append(dict(open=True, side="long" if d == 1 else "short", entry_t=int(times[e]), entry=float(entry),
                                   stop=float(stop), target=float(target)))
                break
            exit_px, reason = C[last], "time"
            j = last
        r = d * (exit_px - entry) / risk - cost_frac * entry / risk
        trades.append(dict(open=False, side="long" if d == 1 else "short", signal_t=int(times[i]), entry_t=int(times[e]),
                           exit_t=int(times[j]), entry=float(entry), stop=float(stop), target=float(target),
                           exit=float(exit_px), reason=reason, r=float(r), bars=int(j - e + 1)))
        i = j + 1
    return trades, (lng, sht, per)


def stats(trades):
    closed = [t for t in trades if not t["open"]]
    rs = np.array([t["r"] for t in closed], dtype=float)
    n = len(rs)
    if n == 0:
        return dict(trades=0)
    wins = rs[rs > 0]
    losses = rs[rs <= 0]
    eq = np.cumsum(rs)
    peak = np.maximum.accumulate(np.r_[0.0, eq])[1:]
    dd = float((eq - peak).min()) if n else 0.0
    sd = float(rs.std(ddof=1)) if n > 1 else 0.0
    streak = cur = 0
    for r in rs:
        cur = cur + 1 if r <= 0 else 0
        streak = max(streak, cur)
    by = {}
    for side in ("long", "short"):
        sr = np.array([t["r"] for t in closed if t["side"] == side], dtype=float)
        if len(sr):
            by[side] = dict(trades=int(len(sr)), win_rate=float((sr > 0).mean()), avg_r=float(sr.mean()), total_r=float(sr.sum()))
    t_stat = float(rs.mean() / sd * math.sqrt(n)) if sd > 0 else None
    verdict = ("not enough trades to judge (need 30+)" if n < 30 else
               "promising: positive and statistically meaningful" if t_stat and t_stat >= 2 and rs.mean() > 0 else
               "positive but could easily be luck" if rs.mean() > 0 else "loses money after costs on this data")
    return dict(trades=n, win_rate=float((rs > 0).mean()), avg_r=float(rs.mean()), median_r=float(np.median(rs)),
                total_r=float(rs.sum()), profit_factor=float(wins.sum() / -losses.sum()) if losses.sum() < 0 else None,
                max_drawdown_r=dd, t_stat=t_stat, avg_bars=float(np.mean([t["bars"] for t in closed])),
                longest_losing_streak=int(streak), by_side=by, verdict=verdict,
                exits={k: int(sum(1 for t in closed if t["reason"] == k)) for k in ("target", "stop", "time")})


def _htf(symbol, tf, spec, n):
    if not any(c["type"] == "htf_trend" for c in spec["conditions"]):
        return None, None
    htf = gm.LADDER[tf][0] if gm.LADDER.get(tf) else None
    if not htf:
        return None, None
    need = int(n * md.TF_MIN[tf] / md.TF_MIN[htf]) + 120
    try:
        return md.get_candles(symbol, htf, bars=min(5000, need), min_bars=40)["df"], htf
    except md.DataError:
        return None, htf


def _intraday_only(spec, tf, notes=None):
    if md.TF_MIN[tf] >= 1440 and any(c["type"] == "session" for c in spec["conditions"]):
        if notes is not None:
            notes.append("Session filters only work on intraday charts, so it was ignored on this timeframe.")
        return dict(spec, conditions=[c for c in spec["conditions"] if c["type"] != "session"] or
                    [dict(type="structure_trend")])
    return spec


def live_check(symbol, tf, spec, bars=600):
    """Does the strategy fire on the last CLOSED candle? (strategy alerts). Returns dict(time, signal, entry...)."""
    spec = _intraday_only(sanitize(spec), md.norm_tf(tf))
    tf = md.norm_tf(tf)
    try:
        C = md.get_candles(symbol, tf, bars=bars, min_bars=150)
    except md.DataError as e:
        raise StrategyError(f"Couldn't load {symbol} {tf}: {str(e)[:120]}")
    df = C["df"]
    if len(df) < 220:
        raise StrategyError(f"Only {len(df)} candles for {C['symbol']} on {tf}.")
    htf_df, htf = _htf(symbol, tf, spec, len(df))
    ctx = Context(df, tf, htf_df, htf)
    lng, sht, _ = signals(ctx, spec)
    i = ctx.n - 1
    side = "long" if lng[i] else "short" if sht[i] else None
    out = dict(symbol=C["symbol"], tf=tf, time=int(md.epoch_s(df.index[-1:])[0]), signal=side, price=float(C["price"]),
               decimals=C["decimals"])
    if side:
        stp = stop_target(ctx, spec, i, 1 if side == "long" else -1, float(C["price"]))
        if stp:
            out.update(entry=float(C["price"]), stop=float(stp[0]), target=float(stp[1]))
    return out


def run(symbol, tf, spec, bars=3000):
    """Backtest on recent history + check the current candle. Returns everything the strategy page shows."""
    spec = sanitize(spec)
    tf = md.norm_tf(tf)
    notes = []
    spec = _intraday_only(spec, tf, notes)
    try:
        C = md.get_candles(symbol, tf, bars=bars, min_bars=150)
    except md.DataError as e:
        raise StrategyError(f"Couldn't load {symbol} {tf}: {str(e)[:120]}")
    df = C["df"]
    if len(df) < 250:
        raise StrategyError(f"Only {len(df)} candles for {C['symbol']} on {tf}; pick a lower timeframe for a backtest.")
    htf_df, htf = _htf(symbol, tf, spec, len(df))
    ctx = Context(df, tf, htf_df, htf)
    cost, slip = gm.cost_of(C["sub"])
    trades, (lng, sht, per) = backtest(ctx, spec, cost, slip)
    st = stats(trades)
    times = md.epoch_s(df.index)
    closed = [t for t in trades if not t["open"]]
    equity = []
    cum = 0.0
    for t in closed:
        cum += t["r"]
        equity.append([t["exit_t"], round(cum, 3)])
    i = ctx.n - 1
    checks = []
    for c, a, b in per:
        checks.append(dict(type=c["type"], label=CONDITIONS[c["type"]]["label"], long=bool(a[i]), short=bool(b[i])))
    live_side = "long" if lng[i] else "short" if sht[i] else None
    live = dict(time=int(times[i]), price=float(C["price"]), signal=live_side, checks=checks,
                long_ready=sum(ch["long"] for ch in checks), short_ready=sum(ch["short"] for ch in checks),
                total=len(checks))
    if live_side:
        d = 1 if live_side == "long" else -1
        stp = stop_target(ctx, spec, i, d, float(C["price"]))
        if stp:
            live.update(entry=float(C["price"]), stop=float(stp[0]), target=float(stp[1]))
    open_trade = next((t for t in trades if t["open"]), None)
    markers = []
    for t in closed[-80:]:
        d = 1 if t["side"] == "long" else -1
        win = t["r"] > 0
        markers.append(dict(kind="marker", layer="strategy", order=1, prio=1, t1=t["entry_t"], p1=t["entry"],
                            symbol="triangle-up" if d == 1 else "triangle-down", color="#2fd3a6" if d == 1 else "#ff5d7a"))
        markers.append(dict(kind="line", layer="strategy", order=2, prio=1, t1=t["entry_t"], t2=t["exit_t"], p1=t["entry"],
                            p2=t["exit"], color="rgba(47,211,166,0.75)" if win else "rgba(255,93,122,0.75)", width=1.2,
                            dash="dot"))
        markers.append(dict(kind="marker", layer="strategy", order=3, prio=1, t1=t["exit_t"], p1=t["exit"],
                            symbol="circle" if t["reason"] == "target" else "x",
                            color="#2fd3a6" if win else "#ff5d7a"))
    return dict(symbol=C["symbol"], tf=tf, source=C["source"], decimals=C["decimals"], spec=spec, summary=describe(spec),
                period=dict(start=int(times[0]), end=int(times[-1]), candles=int(ctx.n)), stats=st,
                trades=[t for t in closed[-40:]][::-1], open_trade=open_trade, equity=equity, live=live,
                markers=markers, costs=dict(round_trip_pct=cost * 100, stop_slip_pct=slip * 100), notes=notes,
                generated=pd.Timestamp.now(tz=timezone.utc).isoformat())

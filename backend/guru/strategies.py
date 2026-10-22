"""strategies.py: the trading strategies a person can ask the analyst to use.

A person picks one strategy or several (a scalper, a fixed-time trader and a swing trader want different things), and
the analyst reads the chart with those strategies only. Every strategy here is a set of rules that can be checked on
a closed candle, so the same code serves three jobs:

  * the live analysis: does the strategy fire on the newest closed candle, and where would its stop and target go
  * the record: a backtest on the candles already loaded, after costs, so the analyst knows how the strategy has been
    doing on this market and timeframe (the "fit"), and weighs strategies that disagree by their record
  * the overlay: the strategy's past trades marked on the chart, like a strategy report

Rules use only what was known at the close of the signal candle. Trades enter at the next candle's open. If a candle
touches both the stop and the target, the stop is assumed to come first. Fixed-time strategies are judged at expiry:
the close N candles later is above (UP) or below (DOWN) the entry close.

The liquidity guard (guard_stop) moves a stop past the swing lows/highs and equal lows/highs that sit just beyond it, by
the typical depth of a stop hunt on this chart (sweep_depth). A stop placed a few ticks under an obvious low is where
stop hunts reach, which is how many plans get stopped out just before price goes their way.

Research tool, not financial advice."""
import math

import numpy as np
import pandas as pd

import structure_engine as se

FT_PAYOUT = 0.85            # a typical fixed-time payout: a win pays 85% of the stake, a loss loses the stake

GROUPS = [
    ("smc", "Smart money & liquidity", "ICT and SMC concepts: liquidity sweeps, structure shifts, order blocks, FVGs."),
    ("price_action", "Price action", "Support and resistance, breakouts and candle patterns, without indicators."),
    ("trend", "Trend following", "Indicator strategies that buy strength and sell weakness."),
    ("reversion", "Mean reversion", "Indicator strategies that fade stretched moves back to the average."),
    ("breakout", "Breakout & volatility", "Range and volatility breakouts."),
    ("scalp", "Scalping", "Fast entries on 1–15 minute charts with tight stops and quick targets."),
    ("fixed_time", "Fixed time", "Up/down calls with an expiry, for fixed-time (binary-style) platforms."),
]

# drawing layers of the analysis that matter to each kind of strategy (the chart shows only these for the chosen ones)
L_SMC = ["structure", "liquidity", "orderblocks", "fvg", "fib", "range", "session", "period"]
L_PA = ["structure", "zones", "trendlines", "patterns", "candles", "period", "round"]
L_IND = ["structure", "zones"]


def _s(id, name, group, how, wait, best, tfs, markets, layers, rr=2.0, hold=48, stop="swing", ft=False, expiry=3,
       indicators=(), min_bars=120, intraday=False):
    return dict(id=id, name=name, group=group, how=how, wait_for=wait, best_for=best, timeframes=list(tfs),
                markets=list(markets), layers=list(layers), rr=rr, hold=hold, stop=stop, fixed_time=ft,
                expiry=expiry, indicators=list(indicators), min_bars=min_bars, intraday=intraday)


ALL_MKT = ("fx", "crypto", "gold", "index", "stock")
CATALOG = [
    # ── smart money & liquidity
    _s("ict_sweep_mss", "Liquidity sweep + structure shift", "smc",
       "Price takes the stops above a high (or below a low), closes back, then breaks structure the other way. Enter on "
       "the shift, stop beyond the sweep's wick, target the liquidity on the other side.",
       "a sweep of a swing high or low followed by a break of structure the other way",
       "Tends to work best on liquid markets in the London and New York killzones: EURUSD, GBPUSD, XAUUSD, NAS100, "
       "US30, BTC and ETH. Noisy on thin altcoins.", ("5m", "15m", "1h", "4h"), ALL_MKT, L_SMC, rr=2.5),
    _s("ote_pullback", "OTE pullback (61.8–78.6%)", "smc",
       "After a break of structure, wait for price to retrace into the 61.8–78.6% zone of the leg (ICT's optimal trade "
       "entry) and turn back with the trend. Stop beyond the leg's origin.",
       "a pullback into the 61.8–78.6% zone of the last impulse, with a candle turning back with the trend",
       "Trending markets: gold, indices, major FX pairs and BTC on 15m–4h.", ("15m", "1h", "4h", "1D"), ALL_MKT,
       L_SMC, rr=2.5),
    _s("ob_retest", "Order block retest", "smc",
       "The last opposite candle before a move that broke structure is an order block. Buy (sell) the first return to "
       "it when price rejects from it. Stop beyond the block.",
       "price returning to the order block left by the last break of structure",
       "FX majors, gold and indices on 15m–4h; crypto majors on 1h–4h.", ("15m", "1h", "4h"), ALL_MKT, L_SMC, rr=2.5),
    _s("fvg_fill", "Fair value gap continuation", "smc",
       "In a trend, price often comes back to fill part of an imbalance (FVG) before continuing. Buy (sell) the "
       "rejection from an open FVG in the trend's direction.",
       "a pullback into an open FVG in the trend's direction",
       "Fast-moving markets: NAS100, gold, BTC/ETH, GBP pairs.", ("5m", "15m", "1h", "4h"), ALL_MKT, L_SMC, rr=2.0),
    _s("turtle_soup", "Turtle soup (false breakout)", "smc",
       "Price breaks the last 20 candles' high (low), fails to hold it and closes back inside: the breakout traders' "
       "stops become fuel the other way. Stop beyond the wick.",
       "a wick beyond the 20-candle high or low that closes back inside",
       "Ranging FX pairs (EURUSD, AUDUSD, EURGBP) and gold; weaker in strong crypto trends.",
       ("5m", "15m", "1h", "4h"), ALL_MKT, ["liquidity", "structure", "period", "session"], rr=2.0),
    _s("silver_bullet", "ICT silver bullet", "smc",
       "Inside the silver-bullet hours (03–04, 10–11 and 14–15 New York time), after a sweep, the first fair value gap "
       "in the new direction is the entry. Stop beyond the gap's first candle.",
       "a fair value gap forming inside a silver-bullet hour after a liquidity sweep",
       "Index futures and CFDs (NAS100, US30, SPX), gold, EURUSD/GBPUSD on 1m–15m.", ("1m", "5m", "15m"),
       ("fx", "gold", "index", "crypto"), L_SMC, rr=2.0, hold=24, intraday=True),
    _s("power_of_3", "Power of 3 (Asia sweep)", "smc",
       "Accumulation in the Asian session, manipulation in London (a sweep of the Asian high or low) and distribution "
       "the other way. Buy a London/NY sweep of the Asian low that closes back inside (sell the high).",
       "a London or New York sweep of the Asian range that closes back inside it",
       "FX majors (EURUSD, GBPUSD), gold and indices on 5m–1h. Less useful on 24/7 crypto.", ("5m", "15m", "30m", "1h"),
       ("fx", "gold", "index"), L_SMC, rr=2.5, hold=36, intraday=True),
    _s("premium_discount", "Premium / discount", "smc",
       "Buy only in the discount half of the range in an uptrend (sell only in the premium half in a downtrend), when a "
       "candle closes back above the previous candle's high (below its low).",
       "price in the discount half of the range with a candle turning up (premium half and turning down for sells)",
       "Any liquid market on 15m–1D.", ("15m", "1h", "4h", "1D"), ALL_MKT, L_SMC, rr=2.5),
    _s("liquidity_draw", "Draw on liquidity", "smc",
       "Trade toward the nearest pool of untaken stops (equal highs or lows) after structure breaks toward it. The "
       "target is the pool.",
       "a break of structure toward an untaken pool of equal highs or lows at least 1.5R away",
       "Markets with clean swings: EURUSD, GBPUSD, XAUUSD, NAS100, BTC.", ("15m", "1h", "4h"), ALL_MKT, L_SMC, rr=2.0),
    _s("breaker_block", "Breaker block", "smc",
       "An order block that fails (price closes through it) often flips to the other side. Buy the retest of a broken "
       "bearish block from above (sell the retest of a broken bullish block from below).",
       "price retesting an order block it has just broken through",
       "Gold, indices and FX majors on 15m–4h.", ("15m", "1h", "4h"), ALL_MKT, L_SMC, rr=2.0),
    # ── price action
    _s("sr_bounce", "Support / resistance bounce", "price_action",
       "Buy a rejection from a support level that held before (sell from resistance): a long lower wick or a bullish "
       "engulfing candle at the level.",
       "a rejection candle at a level that held before",
       "Ranging markets and the higher timeframes of any market.", ("15m", "1h", "4h", "1D"), ALL_MKT, L_PA, rr=2.0),
    _s("breakout_retest", "Breakout and retest", "price_action",
       "A close beyond the 20-candle high (low), then the first retest of the broken level from the other side.",
       "a retest of a level price has just closed beyond",
       "Trending markets: indices, gold, BTC/ETH, GBPJPY.", ("15m", "1h", "4h", "1D"), ALL_MKT, L_PA, rr=2.0),
    _s("chart_patterns", "Double top / bottom", "price_action",
       "Two lows (highs) at the same price, then a close beyond the neckline between them. Target the measured move.",
       "a close beyond the neckline of a double bottom or top",
       "Any market on 1h–1D; reversal patterns work best after an extended move.", ("1h", "4h", "1D"), ALL_MKT, L_PA,
       rr=2.0, hold=60),
    _s("engulfing_trend", "Engulfing in the trend", "price_action",
       "In an uptrend (EMA 50 above EMA 200), buy a bullish engulfing candle near the EMA 20/50 pullback (sells "
       "mirrored).",
       "a pullback to the EMA 20/50 that ends with an engulfing candle",
       "Trending FX pairs, gold, indices and crypto majors on 1h–1D.", ("1h", "4h", "1D"), ALL_MKT,
       L_PA, rr=2.0, indicators=("ema20", "ema50", "ema200")),
    _s("inside_bar", "Inside bar breakout", "price_action",
       "A candle inside the previous one is a pause. Buy a close above the mother candle's high in an uptrend (sell "
       "below its low in a downtrend).",
       "an inside bar followed by a close beyond the mother candle",
       "Daily and 4h charts of FX majors, gold and indices.", ("1h", "4h", "1D"), ALL_MKT, L_PA, rr=2.0),
    _s("outside_bar", "Outside bar", "price_action",
       "A candle that engulfs the previous one's whole range and closes strong shows a shift of control. Trade in the "
       "direction it closes.",
       "a candle that takes out both the previous high and low and closes strong",
       "Volatile markets on 1h–1D.", ("1h", "4h", "1D"), ALL_MKT, L_PA, rr=1.5),
    _s("pin_bar", "Pin bar rejection", "price_action",
       "A long wick (at least twice the body) poking below the recent low (above the recent high) shows rejection.",
       "a pin bar at the edge of the recent range",
       "Gold, FX majors and indices on 1h–1D.", ("1h", "4h", "1D"), ALL_MKT, L_PA, rr=2.0),
    # ── trend following (classic indicator strategies)
    _s("supertrend", "Supertrend", "trend",
       "Supertrend (10, 3) flips: buy when price closes above the line, sell when it closes below.",
       "the Supertrend line flipping", "Trending markets: crypto, indices and gold on 1h–1D.",
       ("15m", "1h", "4h", "1D"), ALL_MKT, L_IND, rr=2.0, stop="indicator", indicators=("supertrend",)),
    _s("psar", "Parabolic SAR", "trend",
       "Parabolic SAR dots flip from above price to below it (buy) or from below to above (sell).",
       "the Parabolic SAR flipping sides", "Smooth trends: indices, gold, JPY pairs on 1h–1D.",
       ("15m", "1h", "4h", "1D"), ALL_MKT, L_IND, rr=2.0, stop="indicator", indicators=("psar",)),
    _s("two_ma_cross", "Two moving averages crossover", "trend",
       "EMA 9 crosses above EMA 21 (buy) or below it (sell).", "EMA 9 crossing EMA 21",
       "Trending markets on 15m–4h.", ("5m", "15m", "1h", "4h"), ALL_MKT, L_IND, rr=2.0, indicators=("ema9", "ema21")),
    _s("ma_cross", "Moving average crossover", "trend",
       "Price closes above the 20 SMA (buy) or below it (sell).", "a close across the 20 SMA",
       "Strong trends on 1h–1D; whipsaws in ranges.", ("1h", "4h", "1D"), ALL_MKT, L_IND, rr=2.0,
       indicators=("sma20",)),
    _s("macd_cross", "MACD", "trend",
       "The MACD histogram crosses above zero (buy) or below zero (sell).", "the MACD histogram crossing zero",
       "Trending FX and crypto on 1h–1D.", ("15m", "1h", "4h", "1D"), ALL_MKT, L_IND, rr=2.0, indicators=("macd",)),
    _s("momentum", "Momentum", "trend",
       "12-candle momentum crosses above zero and keeps rising (buy); below zero and falling (sell).",
       "momentum crossing zero", "Indices and crypto on 1h–1D.", ("1h", "4h", "1D"), ALL_MKT, L_IND, rr=2.0),
    _s("tech_ratings", "Technical ratings", "trend",
       "Moving averages and oscillators vote buy, sell or neutral. Buy when the rating turns to buy, sell when it turns "
       "to sell.", "the overall technical rating turning", "Any market on 1h–1D.", ("1h", "4h", "1D"), ALL_MKT, L_IND,
       rr=2.0),
    _s("bar_updn", "Bar up / down", "trend",
       "A candle that opens above the last close and closes up (buy), or opens below and closes down (sell).",
       "a gap-and-go candle", "Stocks and indices with session gaps; noisy elsewhere.", ("15m", "1h", "4h", "1D"),
       ALL_MKT, L_IND, rr=1.5, stop="atr"),
    _s("consecutive", "Consecutive up / down", "trend",
       "Three closes in a row higher (buy) or lower (sell).", "three closes in a row the same way",
       "Momentum markets; filter by the higher timeframe.", ("15m", "1h", "4h", "1D"), ALL_MKT, L_IND, rr=1.5,
       stop="atr"),
    _s("greedy", "Gap continuation", "trend",
       "A candle that opens beyond the previous candle's high (low) and closes in the same direction.",
       "an opening gap that holds", "Stocks and indices; rare in 24/7 markets.", ("1h", "4h", "1D"),
       ("stock", "index"), L_IND, rr=1.5, stop="atr"),
    # ── mean reversion
    _s("rsi_strategy", "RSI", "reversion",
       "RSI (14) crosses back above 30 (buy) or back below 70 (sell).", "RSI leaving oversold or overbought",
       "Ranging FX crosses (EURGBP, AUDNZD, EURCHF) and range-bound crypto on 15m–4h.", ("15m", "1h", "4h"), ALL_MKT,
       ["zones", "structure"], rr=1.5, indicators=("rsi",)),
    _s("bb_strategy", "Bollinger Bands", "reversion",
       "A close back inside the lower band after closing below it (buy), or back inside the upper band (sell). Target "
       "the middle band.", "a close back inside a Bollinger band",
       "Ranging markets: EURUSD in Asia, EURGBP, AUDNZD, range-bound crypto.", ("5m", "15m", "1h", "4h"), ALL_MKT,
       ["zones"], rr=1.5, stop="atr", indicators=("bb",)),
    _s("stoch_slow", "Stochastic slow", "reversion",
       "%K crosses above %D below 20 (buy) or below %D above 80 (sell).", "a Stochastic cross in an extreme",
       "Ranges and pullbacks in a trend on 15m–4h.", ("15m", "1h", "4h"), ALL_MKT, ["zones"], rr=1.5,
       indicators=("stoch",)),
    _s("pivot_ext", "Pivot reversal (extension)", "reversion",
       "A confirmed swing low (4 candles each side) is bought, a confirmed swing high sold.",
       "a new swing low or high being confirmed", "Range-bound markets on 1h–1D.", ("1h", "4h", "1D"), ALL_MKT,
       ["structure", "zones"], rr=1.5),
    # ── breakout & volatility
    _s("channel_breakout", "Channel breakout", "breakout",
       "A close above the highest high of the last 20 candles (buy) or below the lowest low (sell).",
       "a close beyond the 20-candle channel", "Trending markets: gold, indices, crypto, JPY pairs.",
       ("15m", "1h", "4h", "1D"), ALL_MKT, ["zones", "structure"], rr=2.0),
    _s("price_channel", "Price channel (55)", "breakout",
       "A close beyond the 55-candle high or low: the slower, trend-following breakout (the turtles' system 2).",
       "a close beyond the 55-candle channel", "Long trends: commodities, gold, indices, crypto on 4h–1D.",
       ("1h", "4h", "1D"), ALL_MKT, ["zones", "structure"], rr=2.5, hold=80),
    _s("pivot_reversal", "Pivot breakout", "breakout",
       "A close above the last confirmed swing high (buy) or below the last swing low (sell). Stop at the opposite "
       "swing.", "a close beyond the last swing high or low", "Trending markets on 15m–4h.", ("15m", "1h", "4h"),
       ALL_MKT, ["structure", "liquidity"], rr=2.0),
    _s("keltner", "Keltner channels", "breakout",
       "A close above the upper Keltner channel (EMA 20 + 2 ATR) buys; below the lower one sells.",
       "a close beyond a Keltner channel", "Volatile trending markets on 15m–4h.", ("15m", "1h", "4h"), ALL_MKT,
       ["zones"], rr=2.0, indicators=("keltner",)),
    _s("adx_breakout", "ADX breakout", "breakout",
       "After a quiet stretch (ADX below 20), a close beyond the 20-candle box starts a trend.",
       "a quiet market (ADX < 20) breaking its box", "FX majors and indices on 15m–4h.", ("15m", "1h", "4h"),
       ALL_MKT, ["zones", "structure"], rr=2.0),
    _s("vol_expansion", "Volatility expansion close", "breakout",
       "A close more than 0.75 ATR beyond the previous close starts a move; trade with it.",
       "a large expansion candle", "News-driven markets: gold, indices, GBP pairs, crypto.", ("5m", "15m", "1h", "4h"),
       ALL_MKT, ["zones"], rr=1.5, stop="atr"),
    # ── scalping
    _s("scalp_ema_vwap", "EMA + VWAP scalp", "scalp",
       "EMA 9 above EMA 21 and price above VWAP: buy the first touch of the EMA 9 that closes back up (sells "
       "mirrored). Tight stop below the last few candles, quick 1.5R target.",
       "a touch of EMA 9 in the direction of EMA 21 and VWAP",
       "EURUSD, GBPUSD, XAUUSD, NAS100 and BTC/ETH on 1m–15m, in the London and New York sessions.",
       ("1m", "5m", "15m"), ALL_MKT, ["liquidity", "session"], rr=1.5, hold=20, indicators=("ema9", "ema21", "vwap"),
       intraday=True),
    _s("scalp_london", "S.C.A.L.P. London sweep", "scalp",
       "In the London killzone (02:00–05:00 New York): a liquidity sweep, a structure break the other way, entry only "
       "from the discount half (longs) or premium half (shorts).",
       "a London-killzone sweep followed by a structure break",
       "GBPUSD, EURUSD, GBPJPY and gold on 1m–15m.", ("1m", "5m", "15m"), ("fx", "gold", "index"), L_SMC, rr=3.0,
       hold=24, stop="atr", intraday=True),
    _s("scalp_range", "Range fade scalp", "scalp",
       "When the market is quiet (ADX below 20), fade closes back inside the Bollinger Bands toward the middle band.",
       "a quiet market closing back inside a band",
       "EURUSD and GBPUSD in the Asian session, EURGBP, and sideways crypto on 1m–5m.", ("1m", "5m", "15m"),
       ALL_MKT, ["zones", "session"], rr=1.2, hold=15, stop="atr", indicators=("bb",), intraday=True),
    _s("scalp_burst", "Momentum burst scalp", "scalp",
       "Inside a killzone, a candle larger than 1.8 ATR closing near its extreme on high volume: ride the continuation "
       "with a stop at the candle's middle.",
       "a large, high-volume candle in a killzone",
       "Gold, NAS100, US30, GBPUSD and BTC on 1m–5m at the session opens.", ("1m", "5m", "15m"), ALL_MKT,
       ["session", "liquidity"], rr=1.5, hold=12, intraday=True),
    # ── fixed time (expiry trades)
    _s("ft_trend", "Fixed time · trend pullback", "fixed_time",
       "EMA 8 above EMA 21 above EMA 50: after a red candle, a green candle closing above the previous high calls UP "
       "for the next 3 candles (DOWN mirrored).",
       "a pullback candle followed by a strong candle with the trend",
       "Trending EURUSD, GBPUSD, AUDUSD and BTC on 1m–5m.", ("1m", "5m", "15m"), ALL_MKT, ["structure", "session"],
       ft=True, expiry=3, indicators=("ema8", "ema21", "ema50"), intraday=True),
    _s("ft_reversal", "Fixed time · exhaustion reversal", "fixed_time",
       "RSI (7) below 20 and a candle rejecting the 20-candle low with a long lower wick calls UP for 3 candles "
       "(DOWN mirrored at the high).",
       "an RSI extreme with a rejection wick at the edge of the range",
       "Ranging EURUSD, GBPUSD and EURGBP on 1m–5m, outside news.", ("1m", "5m", "15m"), ALL_MKT, ["zones", "session"],
       ft=True, expiry=3, indicators=("rsi7",), intraday=True),
    _s("ft_level", "Fixed time · level touch", "fixed_time",
       "Price touches the last swing low (high) and closes back away from it: UP (DOWN) for 2 candles.",
       "a touch of the last swing level that closes away from it",
       "EURUSD, GBPUSD and USDJPY on 1m–5m.", ("1m", "5m", "15m"), ALL_MKT, ["structure", "zones"], ft=True, expiry=2,
       intraday=True),
    _s("ft_momentum", "Fixed time · momentum", "fixed_time",
       "Three candles the same colour with growing bodies, closing beyond the Bollinger middle: same direction for 2 "
       "candles.", "three growing candles in a row",
       "News-free sessions of EURUSD, GBPUSD and crypto majors on 1m–5m.", ("1m", "5m"), ALL_MKT, ["session"], ft=True,
       expiry=2, intraday=True),
]
BY_ID = {s["id"]: s for s in CATALOG}
DEFAULT_SET = ["ict_sweep_mss", "ote_pullback", "ob_retest", "sr_bounce", "breakout_retest"]
# the analyst's own setups (guru_analyst._candidate_plans) and the strategy each belongs to
GURU_SETUP = {"pullback": "ote_pullback", "sweep": "ict_sweep_mss", "breakout": "breakout_retest",
              "pattern": "chart_patterns"}


def clean_ids(ids):
    """The known strategy ids in `ids`, in catalog order, without repeats."""
    want = {str(i) for i in (ids or [])}
    return [s["id"] for s in CATALOG if s["id"] in want]


def public_catalog():
    keys = ("id", "name", "group", "how", "wait_for", "best_for", "timeframes", "markets", "fixed_time", "expiry", "rr",
            "intraday")
    return dict(groups=[dict(id=g, name=n, about=a) for g, n, a in GROUPS],
                strategies=[{k: s[k] for k in keys} for s in CATALOG], default=DEFAULT_SET)


def layers_for(ids):
    out = {"plan", "price", "user", "strategy", "mtf"}
    for i in clean_ids(ids):
        out.update(BY_ID[i]["layers"])
    return sorted(out)


# ───────────────────────────── indicator helpers (numpy, known at each close) ─────────────────────────────
def _sma(x, n):
    return pd.Series(x).rolling(n, min_periods=n).mean().to_numpy()


def _ema(x, n):
    return pd.Series(x).ewm(span=n, adjust=False, min_periods=n).mean().to_numpy()


def _rma(x, n):
    return pd.Series(x).ewm(alpha=1 / n, adjust=False, min_periods=n).mean().to_numpy()


def _std(x, n):
    return pd.Series(x).rolling(n, min_periods=n).std(ddof=0).to_numpy()


def _rsi(c, n):
    d = np.diff(c, prepend=c[0])
    up = _rma(np.clip(d, 0, None), n)
    dn = _rma(np.clip(-d, 0, None), n)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = up / dn
        out = 100 - 100 / (1 + rs)
    out = np.where(dn == 0, 100.0, out)
    return np.where(np.isnan(up), 50.0, out)


def _prev(a, k=1, fill=np.nan):
    a = np.asarray(a, dtype=float)
    if k <= 0:
        return a
    return np.r_[np.full(k, fill), a[:-k]]


def _cross_up(a, b):
    pa, pb = _prev(a), _prev(b)
    return np.nan_to_num((a > b) & (pa <= pb), nan=0).astype(bool)


def _cross_dn(a, b):
    pa, pb = _prev(a), _prev(b)
    return np.nan_to_num((a < b) & (pa >= pb), nan=0).astype(bool)


def _recent(mask, k):
    if k <= 1:
        return np.asarray(mask, bool)
    return pd.Series(np.asarray(mask, float)).rolling(k, min_periods=1).max().to_numpy() > 0


def _hh(h, n):
    """Highest high of the n candles before this one (this one excluded)."""
    return pd.Series(h).rolling(n, min_periods=n).max().shift(1).to_numpy()


def _ll(l_, n):
    return pd.Series(l_).rolling(n, min_periods=n).min().shift(1).to_numpy()


def _true(x):
    return np.nan_to_num(np.asarray(x, dtype=float), nan=0.0) > 0


class Ctx:
    """Everything the strategies read from one candle frame, computed once and cached."""

    def __init__(self, df, tf, A=None, asset_class=None):
        if "atr" not in df.columns:
            df = se.add_atr(df[["open", "high", "low", "close", "volume"]].astype(float).copy())
        self.df, self.tf, self.asset_class = df, tf, asset_class
        self.o, self.h, self.l, self.c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
        self.v = df["volume"].to_numpy(dtype=float)
        self.atr = df["atr"].bfill().to_numpy(dtype=float)
        self.n = len(df)
        if A is None:
            piv = se.find_pivots(df, 3, 3)
            events, sweeps, trend = se.detect_structure_breaks(df, piv)
            A = dict(pivots=piv, events=events, sweeps=sweeps, trend=trend, fvgs=se.find_fvgs(df))
        self.A = A
        self.trend = np.asarray(A["trend"], dtype=int)
        try:
            ny = df.index.tz_convert("America/New_York")
            self.ny_hour = np.asarray(ny.hour + ny.minute / 60.0, dtype=float)
            self.ny_day = np.asarray(ny.normalize().asi8)
        except (TypeError, AttributeError):
            self.ny_hour = np.full(self.n, 12.0)
            self.ny_day = np.zeros(self.n, dtype=np.int64)
        self._c = {}

    def get(self, key, fn):
        if key not in self._c:
            self._c[key] = fn()
        return self._c[key]

    def ema(self, n):
        return self.get(("ema", n), lambda: _ema(self.c, n))

    def sma(self, n):
        return self.get(("sma", n), lambda: _sma(self.c, n))

    def rsi(self, n=14):
        return self.get(("rsi", n), lambda: _rsi(self.c, n))

    def atr_n(self, n):
        def f():
            pc = _prev(self.c)
            tr = np.nanmax(np.vstack([self.h - self.l, np.abs(self.h - pc), np.abs(self.l - pc)]), axis=0)
            return _rma(tr, n)
        return self.get(("atr", n), f)

    def bb(self, n=20, k=2.0):
        def f():
            m, s = _sma(self.c, n), _std(self.c, n)
            return m - k * s, m, m + k * s
        return self.get(("bb", n, k), f)

    def adx(self, n=14):
        def f():
            up, dn = np.diff(self.h, prepend=self.h[0]), -np.diff(self.l, prepend=self.l[0])
            plus = np.where((up > dn) & (up > 0), up, 0.0)
            minus = np.where((dn > up) & (dn > 0), dn, 0.0)
            atr = self.atr_n(n)
            with np.errstate(divide="ignore", invalid="ignore"):
                pdi = 100 * _rma(plus, n) / atr
                mdi = 100 * _rma(minus, n) / atr
                dx = 100 * np.abs(pdi - mdi) / (pdi + mdi)
            return np.nan_to_num(_rma(np.nan_to_num(dx), n)), np.nan_to_num(pdi), np.nan_to_num(mdi)
        return self.get(("adx", n), f)

    def macd(self, f=12, s=26, sig=9):
        def g():
            m = _ema(self.c, f) - _ema(self.c, s)
            sg = _ema(np.nan_to_num(m), sig)
            sg = np.where(np.isnan(m), np.nan, sg)
            return m, sg, m - sg
        return self.get(("macd", f, s, sig), g)

    def stoch(self, k=14, d=3, smooth=3):
        def f():
            hh = pd.Series(self.h).rolling(k, min_periods=k).max().to_numpy()
            ll = pd.Series(self.l).rolling(k, min_periods=k).min().to_numpy()
            with np.errstate(divide="ignore", invalid="ignore"):
                raw = np.where(hh > ll, (self.c - ll) / (hh - ll) * 100, 50.0)
            kk = _sma(raw, smooth)
            return kk, _sma(kk, d)
        return self.get(("stoch", k, d, smooth), f)

    def supertrend(self, n=10, mult=3.0):
        def f():
            atr = self.atr_n(n)
            hl2 = (self.h + self.l) / 2
            up_b, dn_b = hl2 - mult * atr, hl2 + mult * atr
            line = np.full(self.n, np.nan)
            dirn = np.zeros(self.n, dtype=int)
            fu, fd, d = np.nan, np.nan, 1
            for i in range(self.n):
                if np.isnan(atr[i]):
                    continue
                pc = self.c[i - 1] if i else self.c[i]
                fu = up_b[i] if np.isnan(fu) or pc < fu else max(up_b[i], fu)
                fd = dn_b[i] if np.isnan(fd) or pc > fd else min(dn_b[i], fd)
                if d == 1 and self.c[i] < fu:
                    d = -1
                elif d == -1 and self.c[i] > fd:
                    d = 1
                dirn[i] = d
                line[i] = fu if d == 1 else fd
            return line, dirn
        return self.get(("st", n, mult), f)

    def psar(self, step=0.02, mx=0.2):
        def f():
            n = self.n
            sar = np.full(n, np.nan)
            dirn = np.zeros(n, dtype=int)
            if n < 3:
                return sar, dirn
            d = 1 if self.c[1] >= self.c[0] else -1
            ep = self.h[0] if d == 1 else self.l[0]
            s = self.l[0] if d == 1 else self.h[0]
            af = step
            for i in range(1, n):
                s = s + af * (ep - s)
                if d == 1:
                    s = min(s, self.l[i - 1], self.l[i - 2] if i >= 2 else self.l[i - 1])
                    if self.l[i] < s:
                        d, s, ep, af = -1, ep, self.l[i], step
                    elif self.h[i] > ep:
                        ep, af = self.h[i], min(mx, af + step)
                else:
                    s = max(s, self.h[i - 1], self.h[i - 2] if i >= 2 else self.h[i - 1])
                    if self.h[i] > s:
                        d, s, ep, af = 1, ep, self.h[i], step
                    elif self.l[i] < ep:
                        ep, af = self.l[i], min(mx, af + step)
                sar[i], dirn[i] = s, d
            return sar, dirn
        return self.get(("psar", step, mx), f)

    def vwap(self):
        def f():
            tp = (self.h + self.l + self.c) / 3
            v = np.where(self.v > 0, self.v, 1.0)
            day = pd.Series(self.df.index.floor("1D").asi8)
            num = pd.Series(tp * v).groupby(day.values).cumsum().to_numpy()
            den = pd.Series(v).groupby(day.values).cumsum().to_numpy()
            return num / den
        return self.get("vwap", f)

    def pivots(self, left=3, right=3):
        return self.get(("piv", left, right), lambda: se.find_pivots(self.df, left, right))

    def last_pivot(self, kind, left=3, right=3):
        """(price, idx) of the latest pivot of `kind` (high/low) confirmed by each candle's close."""
        def f():
            pr = np.full(self.n, np.nan)
            ix = np.full(self.n, -1, dtype=int)
            for p in self.pivots(left, right):
                if p["type"] == kind and p["confirmed_idx"] < self.n:
                    pr[p["confirmed_idx"]] = p["price"]
                    ix[p["confirmed_idx"]] = p["idx"]
            s_pr = pd.Series(pr).ffill().to_numpy()
            s_ix = pd.Series(np.where(ix >= 0, ix, np.nan)).ffill().fillna(-1).to_numpy().astype(int)
            return s_pr, s_ix
        return self.get(("lastpiv", kind, left, right), f)

    def asia(self):
        """The Asian range (20:00–24:00 New York, the evening before) high and low, known from midnight on."""
        def f():
            hi = np.full(self.n, np.nan)
            lo = np.full(self.n, np.nan)
            day, hr = self.ny_day, self.ny_hour
            cur_hi = cur_lo = np.nan
            build_hi = build_lo = np.nan
            for i in range(self.n):
                if i and day[i] != day[i - 1]:            # a new New York day: last evening's range is the Asian range
                    cur_hi, cur_lo = build_hi, build_lo
                    build_hi = build_lo = np.nan
                if hr[i] >= 20:
                    build_hi = self.h[i] if np.isnan(build_hi) else max(build_hi, self.h[i])
                    build_lo = self.l[i] if np.isnan(build_lo) else min(build_lo, self.l[i])
                hi[i], lo[i] = cur_hi, cur_lo
            return hi, lo
        return self.get("asia", f)

    def sweep_depth(self):
        """How far past a swing high or low stop hunts usually reach on this chart, in ATR: the 80th percentile of the
        wicks beyond swept swings (0.35 ATR when there are too few sweeps to tell)."""
        def f():
            d = [abs(s["wick"] - s["level"]) / max(self.atr[s["idx"]], 1e-12) for s in self.A.get("sweeps", [])
                 if 0 <= s["idx"] < self.n]
            if len(d) < 8:
                return 0.35
            return float(np.clip(np.percentile(d, 80), 0.12, 1.5))
        return self.get("sweep_depth", f)

    def pools(self, i, side, look=150):
        """Untaken liquidity at candle i: confirmed swing lows (side=-1) or highs (side=1) no candle has traded through
        since, within the last `look` candles. Equal lows/highs are among them (two swings at one price)."""
        out = []
        lo_i = max(0, i - look)
        for p in self.pivots():
            if p["confirmed_idx"] > i or p["idx"] < lo_i:
                continue
            if side == -1 and p["type"] == "low":
                seg = self.l[p["idx"] + 1:i + 1]
                if not len(seg) or seg.min() >= p["price"]:
                    out.append(p["price"])
            elif side == 1 and p["type"] == "high":
                seg = self.h[p["idx"] + 1:i + 1]
                if not len(seg) or seg.max() <= p["price"]:
                    out.append(p["price"])
        return out


# ───────────────────────────── signals ─────────────────────────────
def _zero(n):
    return np.zeros(n, dtype=bool)


def _sig(ctx, long, short, sl_l=None, sl_s=None, tp_l=None, tp_s=None):
    return dict(long=np.asarray(long, bool), short=np.asarray(short, bool), sl_long=sl_l, sl_short=sl_s,
                tp_long=tp_l, tp_short=tp_s)


def _events_arrays(ctx):
    def f():
        bull = np.zeros(ctx.n, bool)
        bear = np.zeros(ctx.n, bool)
        for e in ctx.A["events"]:
            if 0 <= e["idx"] < ctx.n:
                (bull if e["direction"] == "bullish" else bear)[e["idx"]] = True
        return bull, bear
    return ctx.get("events_arr", f)


def sig_ict_sweep_mss(ctx):
    n, L, H, atr = ctx.n, ctx.l, ctx.h, ctx.atr
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    sweeps = sorted(ctx.A["sweeps"], key=lambda s: s["idx"])
    for e in ctx.A["events"]:
        i = e["idx"]
        if i >= n:
            continue
        want = "sell-side" if e["direction"] == "bullish" else "buy-side"
        prior = [s for s in sweeps if s["side"] == want and 0 <= i - s["idx"] <= 8]
        if not prior:
            continue
        s = prior[-1]
        if e["direction"] == "bullish":
            lng[i] = True
            sl_l[i] = float(L[s["idx"]:i + 1].min()) - 0.1 * atr[i]
        else:
            sht[i] = True
            sl_s[i] = float(H[s["idx"]:i + 1].max()) + 0.1 * atr[i]
    return _sig(ctx, lng, sht, sl_l, sl_s)


def sig_ote_pullback(ctx):
    n, L, H, C, O, atr = ctx.n, ctx.l, ctx.h, ctx.c, ctx.o, ctx.atr
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    tp_l, tp_s = np.full(n, np.nan), np.full(n, np.nan)
    evs = sorted(ctx.A["events"], key=lambda e: e["idx"])
    for k, e in enumerate(evs):
        i0 = e["idx"]
        end = min(n, evs[k + 1]["idx"] if k + 1 < len(evs) else n, i0 + 60)
        if e["direction"] == "bullish":
            origin = float(L[max(0, e["from_idx"]):i0 + 1].min())
            ext = H[i0]
            for i in range(i0 + 1, end):
                ext = max(ext, H[i - 1])
                leg = ext - origin
                if leg < 1.5 * atr[i] or C[i] < origin:
                    if C[i] < origin:
                        break
                    continue
                top, bot = ext - 0.618 * leg, ext - 0.786 * leg
                if L[i] <= top and C[i] > bot and C[i] > O[i] and C[i] < ext:
                    lng[i], sl_l[i], tp_l[i] = True, origin - 0.1 * atr[i], ext + 0.272 * leg
                    break
        else:
            origin = float(H[max(0, e["from_idx"]):i0 + 1].max())
            ext = L[i0]
            for i in range(i0 + 1, end):
                ext = min(ext, L[i - 1])
                leg = origin - ext
                if leg < 1.5 * atr[i] or C[i] > origin:
                    if C[i] > origin:
                        break
                    continue
                top, bot = ext + 0.786 * leg, ext + 0.618 * leg
                if H[i] >= bot and C[i] < top and C[i] < O[i] and C[i] > ext:
                    sht[i], sl_s[i], tp_s[i] = True, origin + 0.1 * atr[i], ext - 0.272 * leg
                    break
    return _sig(ctx, lng, sht, sl_l, sl_s, tp_l, tp_s)


def _order_blocks(ctx):
    """(direction, idx, bottom, top, event_idx) for the order block behind every break of structure."""
    def f():
        out = []
        O, C, L, H = ctx.o, ctx.c, ctx.l, ctx.h
        for e in ctx.A["events"]:
            i0 = e["idx"]
            bull = e["direction"] == "bullish"
            for j in range(i0 - 1, max(-1, i0 - 12), -1):
                if (bull and C[j] < O[j]) or (not bull and C[j] > O[j]):
                    out.append((1 if bull else -1, j, float(L[j]), float(H[j]), i0))
                    break
        return out
    return ctx.get("obs", f)


def sig_ob_retest(ctx):
    n, L, H, C, O, atr = ctx.n, ctx.l, ctx.h, ctx.c, ctx.o, ctx.atr
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    for d, j, bot, top, i0 in _order_blocks(ctx):
        for i in range(i0 + 1, min(n, i0 + 60)):
            if d == 1:
                if C[i] < bot:
                    break
                if L[i] <= top and C[i] > O[i] and C[i] >= bot:
                    lng[i], sl_l[i] = True, bot - 0.1 * atr[i]
                    break
            else:
                if C[i] > top:
                    break
                if H[i] >= bot and C[i] < O[i] and C[i] <= top:
                    sht[i], sl_s[i] = True, top + 0.1 * atr[i]
                    break
    return _sig(ctx, lng, sht, sl_l, sl_s)


def sig_breaker_block(ctx):
    n, L, H, C, atr = ctx.n, ctx.l, ctx.h, ctx.c, ctx.atr
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    for d, j, bot, top, i0 in _order_blocks(ctx):
        broke = None
        for i in range(i0 + 1, min(n, i0 + 80)):
            if broke is None:
                if d == -1 and C[i] > top:            # a bearish block closed through upward → bullish breaker
                    broke = i
                elif d == 1 and C[i] < bot:
                    broke = i
                continue
            if i - broke > 30:
                break
            if d == -1:
                if C[i] < bot:
                    break
                if L[i] <= top and C[i] > top:
                    lng[i], sl_l[i] = True, bot - 0.1 * atr[i]
                    break
            else:
                if C[i] > top:
                    break
                if H[i] >= bot and C[i] < bot:
                    sht[i], sl_s[i] = True, top + 0.1 * atr[i]
                    break
    return _sig(ctx, lng, sht, sl_l, sl_s)


def sig_fvg_fill(ctx):
    n, L, H, C, O = ctx.n, ctx.l, ctx.h, ctx.c, ctx.o
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    tr = ctx.trend
    for g in ctx.A.get("fvgs", []):
        i0 = g["idx"] + 2
        mid = (g["top"] + g["bottom"]) / 2
        for i in range(i0, min(n, i0 + 40)):
            if g["direction"] == "bullish":
                if C[i] < g["bottom"]:
                    break
                if tr[i] == 1 and L[i] <= g["top"] and C[i] > mid and C[i] > O[i]:
                    lng[i] = True
                    sl_l[i] = min(g["bottom"], float(L[max(0, i - 5):i + 1].min())) - 0.15 * ctx.atr[i]
                    break
            else:
                if C[i] > g["top"]:
                    break
                if tr[i] == -1 and H[i] >= g["bottom"] and C[i] < mid and C[i] < O[i]:
                    sht[i] = True
                    sl_s[i] = max(g["top"], float(H[max(0, i - 5):i + 1].max())) + 0.15 * ctx.atr[i]
                    break
    return _sig(ctx, lng, sht, sl_l, sl_s)


def sig_turtle_soup(ctx):
    L, H, C, atr = ctx.l, ctx.h, ctx.c, ctx.atr
    ll, hh = _ll(L, 20), _hh(H, 20)
    rng = np.maximum(H - L, 1e-12)
    lng = _true((L < ll) & (C > ll) & ((C - L) / rng >= 0.5))
    sht = _true((H > hh) & (C < hh) & ((H - C) / rng >= 0.5))
    return _sig(ctx, lng, sht, L - 0.1 * atr, H + 0.1 * atr)


def sig_silver_bullet(ctx):
    n, L, H, atr, hr = ctx.n, ctx.l, ctx.h, ctx.atr, ctx.ny_hour
    win = ((hr >= 3) & (hr < 4)) | ((hr >= 10) & (hr < 11)) | ((hr >= 14) & (hr < 15))
    ssl, bsl = _zero(n), _zero(n)
    for s in ctx.A["sweeps"]:
        if 0 <= s["idx"] < n:
            (ssl if s["side"] == "sell-side" else bsl)[s["idx"]] = True
    ssl, bsl = _recent(ssl, 20), _recent(bsl, 20)
    bull_fvg = (L > _prev(H, 2)) & ((L - _prev(H, 2)) >= 0.2 * atr)
    bear_fvg = (H < _prev(L, 2)) & ((_prev(L, 2) - H) >= 0.2 * atr)
    lng = _true(win & ssl & bull_fvg)
    sht = _true(win & bsl & bear_fvg)
    return _sig(ctx, lng, sht, _prev(L, 2) - 0.1 * atr, _prev(H, 2) + 0.1 * atr)


def sig_power_of_3(ctx):
    L, H, C, atr, hr = ctx.l, ctx.h, ctx.c, ctx.atr, ctx.ny_hour
    ahi, alo = ctx.asia()
    win = ((hr >= 2) & (hr < 5)) | ((hr >= 7) & (hr < 10))
    lng = _true(win & (L < alo) & (C > alo))
    sht = _true(win & (H > ahi) & (C < ahi))
    return _sig(ctx, lng, sht, L - 0.15 * atr, H + 0.15 * atr, ahi, alo)


def sig_premium_discount(ctx):
    L, H, C, atr = ctx.l, ctx.h, ctx.c, ctx.atr
    hh = pd.Series(H).rolling(50, min_periods=50).max().to_numpy()
    ll = pd.Series(L).rolling(50, min_periods=50).min().to_numpy()
    eq = (hh + ll) / 2
    tr = ctx.trend
    lng = _true((tr == 1) & (C < eq) & (C > _prev(H)))
    sht = _true((tr == -1) & (C > eq) & (C < _prev(L)))
    return _sig(ctx, lng, sht, ll - 0.1 * atr, hh + 0.1 * atr, hh, ll)


def sig_liquidity_draw(ctx):
    n, C = ctx.n, ctx.c
    bull, bear = _events_arrays(ctx)
    lng, sht = _zero(n), _zero(n)
    tp_l, tp_s = np.full(n, np.nan), np.full(n, np.nan)
    piv = [p for p in ctx.pivots()]
    highs = [p for p in piv if p["type"] == "high"]
    lows = [p for p in piv if p["type"] == "low"]
    for i in np.flatnonzero(bull | bear):
        a = ctx.atr[i]
        if bull[i]:
            pairs = [(x, y) for x, y in zip(highs, highs[1:]) if y["confirmed_idx"] <= i and abs(x["price"] - y["price"])
                     <= 0.15 * a and max(x["price"], y["price"]) > C[i] + a]
            pools = [max(x["price"], y["price"]) for x, y in pairs if ctx.h[y["idx"] + 1:i + 1].max(initial=-np.inf)
                     <= max(x["price"], y["price"])]
            if pools:
                lng[i], tp_l[i] = True, min(pools)
        if bear[i]:
            pairs = [(x, y) for x, y in zip(lows, lows[1:]) if y["confirmed_idx"] <= i and abs(x["price"] - y["price"])
                     <= 0.15 * a and min(x["price"], y["price"]) < C[i] - a]
            pools = [min(x["price"], y["price"]) for x, y in pairs if ctx.l[y["idx"] + 1:i + 1].min(initial=np.inf)
                     >= min(x["price"], y["price"])]
            if pools:
                sht[i], tp_s[i] = True, max(pools)
    return _sig(ctx, lng, sht, tp_l=tp_l, tp_s=tp_s)


def sig_sr_bounce(ctx):
    L, H, C, O, atr = ctx.l, ctx.h, ctx.c, ctx.o, ctx.atr
    pl, pli = ctx.last_pivot("low")
    ph, phi = ctx.last_pivot("high")
    idx = np.arange(ctx.n)
    rng = np.maximum(H - L, 1e-12)
    body_lo, body_hi = np.minimum(O, C), np.maximum(O, C)
    pin_up = (body_lo - L) / rng >= 0.5
    pin_dn = (H - body_hi) / rng >= 0.5
    eng_up = (C > O) & (_prev(C) < _prev(O)) & (C >= _prev(O))
    eng_dn = (C < O) & (_prev(C) > _prev(O)) & (C <= _prev(O))
    lng = _true((idx - pli >= 5) & (L <= pl + 0.15 * atr) & (L >= pl - 0.6 * atr) & (C > pl) & (pin_up | eng_up))
    sht = _true((idx - phi >= 5) & (H >= ph - 0.15 * atr) & (H <= ph + 0.6 * atr) & (C < ph) & (pin_dn | eng_dn))
    return _sig(ctx, lng, sht, np.minimum(L, pl) - 0.25 * atr, np.maximum(H, ph) + 0.25 * atr)


def sig_breakout_retest(ctx):
    n, L, H, C, atr = ctx.n, ctx.l, ctx.h, ctx.c, ctx.atr
    hh, ll = _hh(H, 20), _ll(L, 20)
    up = _true(C > hh)
    dn = _true(C < ll)
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    for b in np.flatnonzero(up):
        lvl = hh[b]
        for i in range(b + 1, min(n, b + 11)):
            if C[i] < lvl - 0.5 * atr[i]:
                break
            if L[i] <= lvl + 0.2 * atr[i] and C[i] > lvl:
                lng[i], sl_l[i] = True, lvl - 1.0 * atr[i]
                break
    for b in np.flatnonzero(dn):
        lvl = ll[b]
        for i in range(b + 1, min(n, b + 11)):
            if C[i] > lvl + 0.5 * atr[i]:
                break
            if H[i] >= lvl - 0.2 * atr[i] and C[i] < lvl:
                sht[i], sl_s[i] = True, lvl + 1.0 * atr[i]
                break
    return _sig(ctx, lng, sht, sl_l, sl_s)


def sig_chart_patterns(ctx):
    n, L, H, C, atr = ctx.n, ctx.l, ctx.h, ctx.c, ctx.atr
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    tp_l, tp_s = np.full(n, np.nan), np.full(n, np.nan)
    piv = ctx.pivots(4, 4)
    lows = [p for p in piv if p["type"] == "low"]
    highs = [p for p in piv if p["type"] == "high"]
    for a, b in zip(lows, lows[1:]):
        if b["idx"] - a["idx"] < 5 or abs(a["price"] - b["price"]) > 0.3 * atr[b["idx"]]:
            continue
        neck = float(H[a["idx"]:b["idx"] + 1].max())
        bottom = min(a["price"], b["price"])
        for i in range(b["confirmed_idx"], min(n, b["confirmed_idx"] + 40)):
            if L[i] < bottom - 0.3 * atr[i]:
                break
            if C[i] > neck:
                lng[i], sl_l[i], tp_l[i] = True, bottom - 0.15 * atr[i], neck + (neck - bottom)
                break
    for a, b in zip(highs, highs[1:]):
        if b["idx"] - a["idx"] < 5 or abs(a["price"] - b["price"]) > 0.3 * atr[b["idx"]]:
            continue
        neck = float(L[a["idx"]:b["idx"] + 1].min())
        top = max(a["price"], b["price"])
        for i in range(b["confirmed_idx"], min(n, b["confirmed_idx"] + 40)):
            if H[i] > top + 0.3 * atr[i]:
                break
            if C[i] < neck:
                sht[i], sl_s[i], tp_s[i] = True, top + 0.15 * atr[i], neck - (top - neck)
                break
    return _sig(ctx, lng, sht, sl_l, sl_s, tp_l, tp_s)


def sig_engulfing_trend(ctx):
    L, H, C, O, atr = ctx.l, ctx.h, ctx.c, ctx.o, ctx.atr
    e20, e50, e200 = ctx.ema(20), ctx.ema(50), ctx.ema(200)
    eng_up = (C > O) & (_prev(C) < _prev(O)) & (C >= _prev(O)) & (O <= _prev(C))
    eng_dn = (C < O) & (_prev(C) > _prev(O)) & (C <= _prev(O)) & (O >= _prev(C))
    near_up = np.minimum(np.abs(L - e20), np.abs(L - e50)) <= 0.8 * atr
    near_dn = np.minimum(np.abs(H - e20), np.abs(H - e50)) <= 0.8 * atr
    lng = _true(eng_up & (e50 > e200) & near_up)
    sht = _true(eng_dn & (e50 < e200) & near_dn)
    return _sig(ctx, lng, sht, np.minimum(L, _prev(L)) - 0.15 * atr, np.maximum(H, _prev(H)) + 0.15 * atr)


def sig_inside_bar(ctx):
    L, H, C, atr = ctx.l, ctx.h, ctx.c, ctx.atr
    inside = (_prev(H) < _prev(H, 2)) & (_prev(L) > _prev(L, 2))
    e50 = ctx.ema(50)
    lng = _true(inside & (C > _prev(H, 2)) & (C > e50))
    sht = _true(inside & (C < _prev(L, 2)) & (C < e50))
    return _sig(ctx, lng, sht, _prev(L, 2) - 0.1 * atr, _prev(H, 2) + 0.1 * atr)


def sig_outside_bar(ctx):
    L, H, C, O, atr = ctx.l, ctx.h, ctx.c, ctx.o, ctx.atr
    outside = (H > _prev(H)) & (L < _prev(L))
    rng = np.maximum(H - L, 1e-12)
    lng = _true(outside & (C > O) & ((C - L) / rng >= 0.7))
    sht = _true(outside & (C < O) & ((H - C) / rng >= 0.7))
    return _sig(ctx, lng, sht, L - 0.1 * atr, H + 0.1 * atr)


def sig_pin_bar(ctx):
    L, H, C, O, atr = ctx.l, ctx.h, ctx.c, ctx.o, ctx.atr
    rng = np.maximum(H - L, 1e-12)
    body = np.maximum(np.abs(C - O), 1e-12)
    lo_w = np.minimum(O, C) - L
    up_w = H - np.maximum(O, C)
    ll, hh = _ll(L, 20), _hh(H, 20)
    lng = _true((lo_w >= 2 * body) & (lo_w / rng >= 0.6) & (L <= ll + 0.3 * atr))
    sht = _true((up_w >= 2 * body) & (up_w / rng >= 0.6) & (H >= hh - 0.3 * atr))
    return _sig(ctx, lng, sht, L - 0.15 * atr, H + 0.15 * atr)


def sig_supertrend(ctx):
    line, d = ctx.supertrend()
    pd_ = _prev(d.astype(float))
    lng = _true((d == 1) & (pd_ == -1))
    sht = _true((d == -1) & (pd_ == 1))
    return _sig(ctx, lng, sht, line - 0.1 * ctx.atr, line + 0.1 * ctx.atr)


def sig_psar(ctx):
    sar, d = ctx.psar()
    pd_ = _prev(d.astype(float))
    lng = _true((d == 1) & (pd_ == -1))
    sht = _true((d == -1) & (pd_ == 1))
    return _sig(ctx, lng, sht, sar - 0.1 * ctx.atr, sar + 0.1 * ctx.atr)


def sig_two_ma_cross(ctx):
    f, s = ctx.ema(9), ctx.ema(21)
    return _sig(ctx, _cross_up(f, s), _cross_dn(f, s))


def sig_ma_cross(ctx):
    m = ctx.sma(20)
    return _sig(ctx, _cross_up(ctx.c, m), _cross_dn(ctx.c, m))


def sig_macd_cross(ctx):
    _, _, hist = ctx.macd()
    z = np.zeros(ctx.n)
    return _sig(ctx, _cross_up(hist, z), _cross_dn(hist, z))


def sig_momentum(ctx):
    mom = ctx.c - _prev(ctx.c, 12)
    z = np.zeros(ctx.n)
    rising = mom > _prev(mom)
    return _sig(ctx, _cross_up(mom, z) & _true(rising), _cross_dn(mom, z) & _true(~rising & ~np.isnan(mom)))


def _rating(ctx):
    def f():
        c = ctx.c
        votes = []
        for nn in (10, 20, 30, 50, 100, 200):
            for m in (ctx.sma(nn), ctx.ema(nn)):
                votes.append(np.where(np.isnan(m), 0, np.sign(c - m)))
        r = ctx.rsi(14)
        votes.append(np.where(r < 30, 1, np.where(r > 70, -1, 0)))
        k, d = ctx.stoch()
        votes.append(np.where((k < 20) & (k > d), 1, np.where((k > 80) & (k < d), -1, 0)))
        m, s, _ = ctx.macd()
        votes.append(np.nan_to_num(np.sign(m - s)))
        mom = c - _prev(c, 10)
        votes.append(np.nan_to_num(np.sign(mom - _prev(mom))))
        return np.mean(np.vstack(votes), axis=0)
    return ctx.get("rating", f)


def sig_tech_ratings(ctx):
    r = _rating(ctx)
    pr = _prev(r)
    return _sig(ctx, _true((r > 0.1) & (pr <= 0.1)), _true((r < -0.1) & (pr >= -0.1)))


def sig_bar_updn(ctx):
    C, O = ctx.c, ctx.o
    return _sig(ctx, _true((C > O) & (O > _prev(C))), _true((C < O) & (O < _prev(C))))


def sig_consecutive(ctx):
    C = ctx.c
    up = (C > _prev(C)) & (_prev(C) > _prev(C, 2)) & (_prev(C, 2) > _prev(C, 3))
    dn = (C < _prev(C)) & (_prev(C) < _prev(C, 2)) & (_prev(C, 2) < _prev(C, 3))
    up4 = up & ~((_prev(C) > _prev(C, 2)) & (_prev(C, 2) > _prev(C, 3)) & (_prev(C, 3) > _prev(C, 4)))
    dn4 = dn & ~((_prev(C) < _prev(C, 2)) & (_prev(C, 2) < _prev(C, 3)) & (_prev(C, 3) < _prev(C, 4)))
    return _sig(ctx, _true(up4), _true(dn4))


def sig_greedy(ctx):
    C, O, H, L = ctx.c, ctx.o, ctx.h, ctx.l
    return _sig(ctx, _true((O > _prev(H)) & (C > O)), _true((O < _prev(L)) & (C < O)))


def sig_rsi_strategy(ctx):
    r = ctx.rsi(14)
    return _sig(ctx, _cross_up(r, np.full(ctx.n, 30.0)), _cross_dn(r, np.full(ctx.n, 70.0)))


def sig_bb_strategy(ctx):
    lo, mid, up = ctx.bb()
    C = ctx.c
    lng = _true((_prev(C) < _prev(lo)) & (C > lo))
    sht = _true((_prev(C) > _prev(up)) & (C < up))
    return _sig(ctx, lng, sht, tp_l=mid, tp_s=mid)


def sig_stoch_slow(ctx):
    k, d = ctx.stoch()
    lng = _cross_up(k, d) & _true(k < 25)
    sht = _cross_dn(k, d) & _true(k > 75)
    return _sig(ctx, lng, sht)


def sig_pivot_ext(ctx):
    n = ctx.n
    lng, sht = _zero(n), _zero(n)
    sl_l, sl_s = np.full(n, np.nan), np.full(n, np.nan)
    for p in ctx.pivots(4, 2):
        i = p["confirmed_idx"]
        if i >= n:
            continue
        if p["type"] == "low":
            lng[i], sl_l[i] = True, p["price"] - 0.15 * ctx.atr[i]
        else:
            sht[i], sl_s[i] = True, p["price"] + 0.15 * ctx.atr[i]
    return _sig(ctx, lng, sht, sl_l, sl_s)


def sig_channel_breakout(ctx):
    hh, ll = _hh(ctx.h, 20), _ll(ctx.l, 20)
    return _sig(ctx, _cross_up(ctx.c, hh), _cross_dn(ctx.c, ll), _ll(ctx.l, 10), _hh(ctx.h, 10))


def sig_price_channel(ctx):
    hh, ll = _hh(ctx.h, 55), _ll(ctx.l, 55)
    return _sig(ctx, _cross_up(ctx.c, hh), _cross_dn(ctx.c, ll), _ll(ctx.l, 20), _hh(ctx.h, 20))


def sig_pivot_reversal(ctx):
    ph, _ = ctx.last_pivot("high", 4, 2)
    pl, _ = ctx.last_pivot("low", 4, 2)
    return _sig(ctx, _cross_up(ctx.c, ph), _cross_dn(ctx.c, pl), pl - 0.1 * ctx.atr, ph + 0.1 * ctx.atr)


def sig_keltner(ctx):
    m = ctx.ema(20)
    a = ctx.atr_n(10)
    up, lo = m + 2 * a, m - 2 * a
    return _sig(ctx, _cross_up(ctx.c, up), _cross_dn(ctx.c, lo), m - 0.5 * a, m + 0.5 * a)


def sig_adx_breakout(ctx):
    adx, _, _ = ctx.adx()
    quiet = pd.Series(adx < 20).rolling(5, min_periods=5).min().to_numpy() > 0
    quiet = _prev(quiet.astype(float)) > 0
    hh, ll = _hh(ctx.h, 20), _ll(ctx.l, 20)
    return _sig(ctx, _true(quiet & (ctx.c > hh)), _true(quiet & (ctx.c < ll)), ll, hh)


def sig_vol_expansion(ctx):
    C, atr = ctx.c, ctx.atr
    return _sig(ctx, _true(C > _prev(C) + 0.75 * _prev(atr)), _true(C < _prev(C) - 0.75 * _prev(atr)))


def sig_scalp_ema_vwap(ctx):
    L, H, C, O, atr = ctx.l, ctx.h, ctx.c, ctx.o, ctx.atr
    e9, e21, vw = ctx.ema(9), ctx.ema(21), ctx.vwap()
    lng = _true((e9 > e21) & (C > vw) & (L <= e9 + 0.1 * atr) & (C > e9) & (C > O))
    sht = _true((e9 < e21) & (C < vw) & (H >= e9 - 0.1 * atr) & (C < e9) & (C < O))
    lo4 = pd.Series(L).rolling(4, min_periods=1).min().to_numpy()
    hi4 = pd.Series(H).rolling(4, min_periods=1).max().to_numpy()
    return _sig(ctx, lng, sht, np.minimum(lo4, C - 0.8 * atr) - 0.1 * atr, np.maximum(hi4, C + 0.8 * atr) + 0.1 * atr)


def sig_scalp_london(ctx):
    n, hr = ctx.n, ctx.ny_hour
    london = (hr >= 2) & (hr < 5)
    ssl, bsl = _zero(n), _zero(n)
    for s in ctx.A["sweeps"]:
        if 0 <= s["idx"] < n:
            (ssl if s["side"] == "sell-side" else bsl)[s["idx"]] = True
    bull, bear = _events_arrays(ctx)
    hh = pd.Series(ctx.h).rolling(50, min_periods=50).max().to_numpy()
    ll = pd.Series(ctx.l).rolling(50, min_periods=50).min().to_numpy()
    mid = (hh + ll) / 2
    lng = _true(london & _recent(ssl, 6) & _recent(bull, 3) & (ctx.c < mid))
    sht = _true(london & _recent(bsl, 6) & _recent(bear, 3) & (ctx.c > mid))
    return _sig(ctx, lng, sht)


def sig_scalp_range(ctx):
    adx, _, _ = ctx.adx()
    lo, mid, up = ctx.bb()
    C = ctx.c
    quiet = adx < 20
    lng = _true(quiet & (_prev(C) < _prev(lo)) & (C > lo))
    sht = _true(quiet & (_prev(C) > _prev(up)) & (C < up))
    return _sig(ctx, lng, sht, tp_l=mid, tp_s=mid)


def sig_scalp_burst(ctx):
    L, H, C, O, V, atr, hr = ctx.l, ctx.h, ctx.c, ctx.o, ctx.v, ctx.atr, ctx.ny_hour
    kz = ((hr >= 2) & (hr < 5)) | ((hr >= 7) & (hr < 10))
    rng = np.maximum(H - L, 1e-12)
    vavg = _prev(pd.Series(V).rolling(20, min_periods=20).mean().to_numpy())
    big = (rng > 1.8 * _prev(atr)) & ((V > 1.5 * vavg) | (np.nan_to_num(vavg) == 0))
    lng = _true(kz & big & (C > O) & ((C - L) / rng >= 0.8))
    sht = _true(kz & big & (C < O) & ((H - C) / rng >= 0.8))
    midc = (H + L) / 2
    return _sig(ctx, lng, sht, midc, midc)


def sig_ft_trend(ctx):
    C, O, H, L = ctx.c, ctx.o, ctx.h, ctx.l
    e8, e21, e50 = ctx.ema(8), ctx.ema(21), ctx.ema(50)
    up_stack = (e8 > e21) & (e21 > e50)
    dn_stack = (e8 < e21) & (e21 < e50)
    lng = _true(up_stack & (_prev(C) < _prev(O)) & (C > O) & (C > _prev(H)))
    sht = _true(dn_stack & (_prev(C) > _prev(O)) & (C < O) & (C < _prev(L)))
    return _sig(ctx, lng, sht)


def sig_ft_reversal(ctx):
    C, O, H, L = ctx.c, ctx.o, ctx.h, ctx.l
    r = ctx.rsi(7)
    rng = np.maximum(H - L, 1e-12)
    ll, hh = _ll(L, 20), _hh(H, 20)
    lng = _true((r < 20) & (L <= ll) & ((np.minimum(O, C) - L) / rng >= 0.5))
    sht = _true((r > 80) & (H >= hh) & ((H - np.maximum(O, C)) / rng >= 0.5))
    return _sig(ctx, lng, sht)


def sig_ft_level(ctx):
    C, H, L, atr = ctx.c, ctx.h, ctx.l, ctx.atr
    pl, pli = ctx.last_pivot("low")
    ph, phi = ctx.last_pivot("high")
    idx = np.arange(ctx.n)
    lng = _true((idx - pli >= 5) & (np.abs(L - pl) <= 0.2 * atr) & (C > pl + 0.3 * atr))
    sht = _true((idx - phi >= 5) & (np.abs(H - ph) <= 0.2 * atr) & (C < ph - 0.3 * atr))
    return _sig(ctx, lng, sht)


def sig_ft_momentum(ctx):
    C, O = ctx.c, ctx.o
    b = C - O
    _, mid, _ = ctx.bb()
    up = (b > 0) & (_prev(b) > 0) & (_prev(b, 2) > 0) & (b > _prev(b)) & (_prev(b) > _prev(b, 2)) & (C > mid)
    dn = (b < 0) & (_prev(b) < 0) & (_prev(b, 2) < 0) & (b < _prev(b)) & (_prev(b) < _prev(b, 2)) & (C < mid)
    return _sig(ctx, _true(up), _true(dn))


SIGNALS = {k[4:]: v for k, v in globals().items() if k.startswith("sig_") and callable(v)}
assert set(SIGNALS) == set(BY_ID), sorted(set(BY_ID) ^ set(SIGNALS))


def signals(ctx, sid):
    """The strategy's signals on every candle (cached on the context)."""
    def f():
        s = BY_ID[sid]
        out = SIGNALS[sid](ctx)
        warm = max(s["min_bars"], 60)
        out["long"][:warm] = False
        out["short"][:warm] = False
        if s["intraday"] and ctx.tf in ("1D", "3D", "1W", "1M"):
            out["long"][:] = False
            out["short"][:] = False
        return out
    return ctx.get(("sig", sid), f)


# ───────────────────────────── stops, the liquidity guard, targets ─────────────────────────────
def default_stop(ctx, sid, i, d, entry):
    """The strategy's own stop for a trade signalled on candle i."""
    s = BY_ID[sid]
    sg = signals(ctx, sid)
    arr = sg["sl_long"] if d == 1 else sg["sl_short"]
    a = ctx.atr[i]
    stop = None
    if arr is not None and i < len(arr) and np.isfinite(arr[i]):
        stop = float(arr[i])
    elif s["stop"] == "atr":
        stop = entry - d * 1.5 * a
    else:                                               # the last swing beyond entry (structure stop)
        lb = 10
        if d == 1:
            stop = float(ctx.l[max(0, i - lb + 1):i + 1].min()) - 0.2 * a
        else:
            stop = float(ctx.h[max(0, i - lb + 1):i + 1].max()) + 0.2 * a
    if d * (entry - stop) < 0.5 * a:                    # never tighter than half an ATR (noise)
        stop = entry - d * 0.5 * a
    cap = 1.6 if s["group"] == "scalp" else 4.0         # a scalp is a tight-stop trade; nothing gets a huge stop
    if d * (entry - stop) > cap * a:
        stop = entry - d * cap * a
    return stop


def guard_stop(ctx, i, d, entry, stop, depth=None):
    """Move a stop past the untaken swing lows/highs (and equal lows/highs) that sit just beyond it or between it and
    the entry, by the typical depth of a stop hunt on this chart. Never moves a stop closer.
    Returns (stop, pool) where pool is the liquidity level the stop was moved past (None if it was fine)."""
    a = ctx.atr[i]
    depth = ctx.sweep_depth() if depth is None else depth
    buf = (depth + 0.05) * a
    pools = ctx.pools(i, -d)
    if d == 1:
        cand = [p for p in pools if stop - buf - 0.5 * a <= p < entry - 0.15 * a]
        if not cand:
            return stop, None
        p = min(cand)
        new = p - buf
        return (min(stop, new), p) if new < stop else (stop, None)
    cand = [p for p in pools if entry + 0.15 * a < p <= stop + buf + 0.5 * a]
    if not cand:
        return stop, None
    p = max(cand)
    new = p + buf
    return (max(stop, new), p) if new > stop else (stop, None)


def default_target(ctx, sid, i, d, entry, stop):
    s = BY_ID[sid]
    sg = signals(ctx, sid)
    arr = sg["tp_long"] if d == 1 else sg["tp_short"]
    risk = abs(entry - stop)
    if arr is not None and i < len(arr) and np.isfinite(arr[i]) and d * (arr[i] - entry) >= 0.8 * risk:
        return float(arr[i])
    return entry + d * s["rr"] * risk


# ───────────────────────────── the record (backtest) ─────────────────────────────
def backtest(ctx, sid, cost_frac=0.0, slip_frac=0.0, guard=True, start=0):
    """Trades the strategy would have taken on this frame. Price strategies return R multiples after costs;
    fixed-time strategies return wins and losses at expiry."""
    s = BY_ID[sid]
    sg = signals(ctx, sid)
    lng, sht = sg["long"], sg["short"]
    O, H, L, C = ctx.o, ctx.h, ctx.l, ctx.c
    n = ctx.n
    times = ctx.df.index
    trades = []
    i = max(start, 0)
    depth = ctx.sweep_depth()
    if s["fixed_time"]:
        N = s["expiry"]
        while i < n - 1:
            d = 1 if lng[i] else -1 if sht[i] else 0
            if d == 0:
                i += 1
                continue
            if i + N >= n:
                trades.append(dict(open=True, side="up" if d == 1 else "down", i=int(i), t=str(times[i]),
                                   entry=float(C[i]), expiry=N))
                break
            win = d * (C[i + N] - C[i]) > 0
            trades.append(dict(open=False, side="up" if d == 1 else "down", i=int(i), t=str(times[i]),
                               entry=float(C[i]), exit=float(C[i + N]), expiry=N, win=bool(win),
                               r=float(FT_PAYOUT if win else -1.0)))
            i += N
        return trades
    while i < n - 1:
        d = 1 if lng[i] else -1 if sht[i] else 0
        if d == 0:
            i += 1
            continue
        e = i + 1
        entry = float(O[e])
        stop = default_stop(ctx, sid, i, d, float(C[i]))
        if d * (entry - stop) <= 0:
            i += 1
            continue
        pool = None
        if guard:
            stop, pool = guard_stop(ctx, i, d, entry, stop, depth)
        risk = d * (entry - stop)
        if risk < 0.25 * ctx.atr[i] or cost_frac * entry > 0.5 * risk:
            i += 1
            continue
        target = default_target(ctx, sid, i, d, entry, stop)
        if d * (target - entry) <= 0:
            i += 1
            continue
        exit_px = reason = None
        last = min(n - 1, e + s["hold"] - 1)
        j = e
        for j in range(e, last + 1):
            hit_stop = L[j] <= stop if d == 1 else H[j] >= stop
            hit_tp = H[j] >= target if d == 1 else L[j] <= target
            if hit_stop:
                gap = (O[j] < stop) if d == 1 else (O[j] > stop)
                exit_px, reason = (O[j] if gap else stop) - d * slip_frac * entry, "stop"
                break
            if hit_tp:
                exit_px, reason = target, "target"
                break
        if exit_px is None:
            if j >= n - 1 and n - 1 - e < s["hold"] - 1:
                trades.append(dict(open=True, side="long" if d == 1 else "short", i=int(i), entry_i=int(e),
                                   t=str(times[e]), entry=entry, stop=float(stop), target=float(target),
                                   guarded=pool is not None))
                break
            exit_px, reason, j = float(C[last]), "time", last
        r = d * (exit_px - entry) / risk - cost_frac * entry / risk
        trades.append(dict(open=False, side="long" if d == 1 else "short", i=int(i), entry_i=int(e), exit_i=int(j),
                           t=str(times[e]), entry=entry, stop=float(stop), target=float(target), exit=float(exit_px),
                           reason=reason, r=float(r), bars=int(j - e + 1), guarded=pool is not None))
        i = j + 1
    return trades


def record(trades, fixed_time=False):
    """Win rate, average R, profit factor ... of a list of closed trades, and a plain verdict."""
    closed = [t for t in trades if not t.get("open")]
    n = len(closed)
    if n == 0:
        return dict(trades=0, verdict="no trades on the loaded candles")
    rs = np.array([t["r"] for t in closed], dtype=float)
    wins = rs[rs > 0]
    losses = rs[rs <= 0]
    win_rate = float((rs > 0).mean())
    out = dict(trades=n, win_rate=win_rate, avg_r=float(rs.mean()), total_r=float(rs.sum()),
               profit_factor=float(wins.sum() / -losses.sum()) if losses.sum() < 0 else None)
    eq = np.cumsum(rs)
    out["max_drawdown_r"] = float((eq - np.maximum.accumulate(np.r_[0.0, eq])[1:]).min())
    sd = float(rs.std(ddof=1)) if n > 1 else 0.0
    out["t_stat"] = float(rs.mean() / sd * math.sqrt(n)) if sd > 0 else None
    last = rs[-20:]
    out["recent_win_rate"] = float((last > 0).mean())
    out["recent_avg_r"] = float(last.mean())
    if fixed_time:
        be = 1 / (1 + FT_PAYOUT)
        out.update(breakeven=be, payout=FT_PAYOUT, edge=win_rate - be)
        out["verdict"] = ("too few calls to judge (need 30+)" if n < 30 else
                          f"wins {win_rate * 100:.0f}% vs {be * 100:.0f}% needed at an {FT_PAYOUT * 100:.0f}% payout: "
                          + ("an edge so far" if win_rate > be + 0.02 else "no edge after the payout"))
    else:
        out["stops"] = int(sum(1 for t in closed if t["reason"] == "stop"))
        out["targets"] = int(sum(1 for t in closed if t["reason"] == "target"))
        out["verdict"] = ("too few trades to judge (need 30+)" if n < 30 else
                          "positive and steady" if (out["t_stat"] or 0) >= 2 and out["avg_r"] > 0 else
                          "positive, but it could be luck" if out["avg_r"] > 0 else "loses after costs here")
    return out


def score_of(rec):
    """One number for how much to trust a strategy on this chart, from its record: around 0 = no edge,
    positive = an edge, shrunk toward 0 when there are few trades."""
    if not rec or not rec.get("trades"):
        return 0.0
    n = rec["trades"]
    shrink = n / (n + 30.0)
    if "edge" in rec:
        return float(np.clip(rec["edge"] * 4, -1, 1) * shrink)
    return float(np.clip(rec["avg_r"], -1, 1) * shrink)


# ───────────────────────────── live: the newest closed candle ─────────────────────────────
def live(ctx, sid, price=None, cost_frac=0.0, max_age=3):
    """What the strategy says now: a signal on one of the last `max_age` closed candles that is still valid (stop not
    hit, price not already more than 0.6R past the entry), with its entry, stop and target; else what to wait for."""
    s = BY_ID[sid]
    sg = signals(ctx, sid)
    n = ctx.n
    price = float(ctx.c[-1] if price is None else price)
    out = dict(id=sid, name=s["name"], group=s["group"], fixed_time=s["fixed_time"], signal=None,
               wait_for=s["wait_for"])
    for i in range(n - 1, max(-1, n - 1 - max_age), -1):
        d = 1 if sg["long"][i] else -1 if sg["short"][i] else 0
        if d == 0:
            continue
        age = n - 1 - i
        if s["fixed_time"]:
            if age > 0:
                continue                               # a fixed-time call is only good on the candle that made it
            out.update(signal="up" if d == 1 else "down", dir=d, idx=int(i), age=0, entry=float(ctx.c[i]),
                       expiry=s["expiry"])
            return out
        ref = float(ctx.c[i])
        stop = default_stop(ctx, sid, i, d, ref)
        stop, pool = guard_stop(ctx, i, d, ref, stop)
        risk = d * (ref - stop)
        if risk <= 0:
            continue
        seg_l = ctx.l[i + 1:] if i + 1 < n else np.array([])
        seg_h = ctx.h[i + 1:] if i + 1 < n else np.array([])
        if len(seg_l) and ((d == 1 and seg_l.min() <= stop) or (d == -1 and seg_h.max() >= stop)):
            continue                                    # stopped out already
        if d * (price - ref) > 0.6 * risk:
            out.update(missed=dict(dir=d, age=age, entry=ref))
            continue                                    # it ran without us: don't chase
        target = default_target(ctx, sid, i, d, ref, stop)
        out.update(signal="long" if d == 1 else "short", dir=d, idx=int(i), age=age, entry=ref, sl=float(stop),
                   tp=float(target), guarded_past=None if pool is None else float(pool),
                   chase=bool(d * (price - ref) > 0.15 * risk))
        return out
    # no live signal: the last one, for context
    for i in range(n - 1, max(-1, n - 200), -1):
        d = 1 if sg["long"][i] else -1 if sg["short"][i] else 0
        if d:
            out["last"] = dict(dir=d, age=int(n - 1 - i), price=float(ctx.c[i]))
            break
    return out


def fit(ctx, ids=None, cost_frac=0.0, slip_frac=0.0, guard=True):
    """Each strategy's record on this frame, best first."""
    rows = []
    for sid in clean_ids(ids) if ids else [s["id"] for s in CATALOG]:
        s = BY_ID[sid]
        if s["intraday"] and ctx.tf in ("1D", "3D", "1W", "1M"):
            continue
        try:
            tr = backtest(ctx, sid, cost_frac, slip_frac, guard=guard)
        except Exception as e:                          # one broken strategy must not break the rest
            rows.append(dict(id=sid, name=s["name"], group=s["group"], error=f"{type(e).__name__}: {e}"[:160]))
            continue
        rec = record(tr, s["fixed_time"])
        rows.append(dict(id=sid, name=s["name"], group=s["group"], fixed_time=s["fixed_time"], score=score_of(rec),
                         **rec))
    rows.sort(key=lambda r: -(r.get("score") or -9))
    return rows


def markers(ctx, sid, trades, show_from=0):
    """The strategy's trades as chart drawings (layer 'strategy'), like a strategy report on the chart."""
    s = BY_ID[sid]
    out = []
    ts = ctx.df.index
    up, dn = "#26a69a", "#ef5350"
    for t in trades:
        if t.get("open"):
            continue
        i = t.get("entry_i", t.get("i"))
        if i is None or i < show_from:
            continue
        d = 1 if t["side"] in ("long", "up") else -1
        win = t["r"] > 0
        out.append(dict(kind="marker", i=int(i), t=str(ts[i]), price=t["entry"], symbol="triangle-up" if d == 1 else "triangle-down",
                        color=up if d == 1 else dn, text=f"{s['name']} {'buy' if d == 1 else 'sell'}",
                        why=f"{s['name']}: {s['how']}"))
        j = t.get("exit_i", (t.get("i") or 0) + t.get("expiry", 0))
        if j is not None and j < ctx.n:
            out.append(dict(kind="line", i1=int(i), i2=int(j), t1=str(ts[i]), t2=str(ts[j]), p1=t["entry"], p2=t["exit"],
                            color="rgba(38,166,154,0.8)" if win else "rgba(239,83,80,0.8)", dash="dot",
                            text=(f"{t['r']:+.1f}R" if not s["fixed_time"] else ("win" if win else "loss")),
                            why=(f"Exit: {t.get('reason', 'expiry')} after {t.get('bars', t.get('expiry'))} candles, "
                                 f"{t['r']:+.2f}R after costs." if not s["fixed_time"] else
                                 f"Expiry after {t['expiry']} candles: {'won' if win else 'lost'}.")))
    return out


def indicator_lines(ctx, ids, start):
    """The indicator lines the chosen strategies use, from candle `start` on: {name: (label, color, values)}."""
    out = {}
    want = set()
    for sid in clean_ids(ids):
        want.update(BY_ID[sid]["indicators"])
    sl = slice(start, None)
    col = {"ema8": "#80deea", "ema9": "#4fc3f7", "ema20": "#ffffff", "ema21": "#ffb74d", "ema50": "#ffd54f",
           "ema200": "#9575cd", "sma20": "#90caf9", "vwap": "#ff9800"}
    for k in ("ema8", "ema9", "ema20", "ema21", "ema50", "ema200"):
        if k in want:
            out[k] = (k.upper().replace("EMA", "EMA "), col[k], ctx.ema(int(k[3:]))[sl])
    if "sma20" in want:
        out["sma20"] = ("SMA 20", col["sma20"], ctx.sma(20)[sl])
    if "vwap" in want:
        out["vwap"] = ("VWAP", col["vwap"], ctx.vwap()[sl])
    if "bb" in want:
        lo, mid, up = ctx.bb()
        out["bb_up"] = ("BB upper", "rgba(144,202,249,0.8)", up[sl])
        out["bb_mid"] = ("BB basis", "rgba(255,183,77,0.8)", mid[sl])
        out["bb_lo"] = ("BB lower", "rgba(144,202,249,0.8)", lo[sl])
    if "keltner" in want:
        m, a = ctx.ema(20), ctx.atr_n(10)
        out["kc_up"] = ("Keltner upper", "rgba(77,208,225,0.8)", (m + 2 * a)[sl])
        out["kc_lo"] = ("Keltner lower", "rgba(77,208,225,0.8)", (m - 2 * a)[sl])
    if "supertrend" in want:
        line, d = ctx.supertrend()
        out["st_up"] = ("Supertrend", "#26a69a", np.where(d == 1, line, np.nan)[sl])
        out["st_dn"] = ("Supertrend", "#ef5350", np.where(d == -1, line, np.nan)[sl])
    if "psar" in want:
        sar, _ = ctx.psar()
        out["psar"] = ("Parabolic SAR", "#ffb74d", sar[sl])
    return out

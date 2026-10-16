"""market_data.py: candles for any symbol on any timeframe (1m to 1M), cached and topped up to now.

Sources are tried in order. The first one that works wins and is remembered for that symbol.
  * Forex, metals, indices, energies, soft commodities, US stocks (and some crypto CFDs): Dukascopy
  * Crypto pairs (BTCUSDT, SOL/USDT, BINANCE:PEPEUSDT ...): Binance, Binance.US, KuCoin, Coinbase, Yahoo, Dukascopy
  * Anything else: Yahoo Finance
A prefix forces a source: DUKASCOPY:BTCUSD, BINANCE:SOLUSDT, BINANCEUS:, KUCOIN:, COINBASE:, YAHOO:AAPL.
TradingView-style prefixes (OANDA:EURUSD, BYBIT:BTCUSDT, NASDAQ:AAPL) are understood too.

Timeframes: 1m 5m 15m 30m 1h 4h 1D 3D 1W 1M  ("1m" = one minute, "1M" = one month).
Every function returns candles with a UTC index and float columns open, high, low, close, volume.
The candle that is still forming is returned separately: analysis runs on closed candles only.
"""
import json
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

try:
    import requests
except ImportError:          # pragma: no cover - requests ships with Colab
    requests = None

TFS = ("1m", "5m", "15m", "30m", "1h", "4h", "1D", "3D", "1W", "1M")
INTRADAY = ("1m", "5m", "15m", "30m", "1h", "4h")
TF_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1D": 1440, "3D": 4320, "1W": 10080,
          "1M": 43830}
TF_LABEL = {"1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes", "1h": "1 hour",
            "4h": "4 hours", "1D": "1 day", "3D": "3 days", "1W": "1 week", "1M": "1 month"}
_TF_ALIASES = {"1min": "1m", "m1": "1m", "1": "1m", "5min": "5m", "m5": "5m", "5": "5m", "15min": "15m",
               "m15": "15m", "15": "15m", "30min": "30m", "m30": "30m", "30": "30m", "60m": "1h", "60": "1h",
               "60min": "1h", "1hr": "1h", "1hour": "1h", "h1": "1h", "1h": "1h", "240": "4h", "4hr": "4h",
               "4hour": "4h", "h4": "4h", "4h": "4h", "1d": "1D", "d1": "1D", "d": "1D", "1day": "1D",
               "day": "1D", "daily": "1D", "3d": "3D", "3day": "3D", "1w": "1W", "w1": "1W", "w": "1W",
               "1wk": "1W", "week": "1W", "weekly": "1W", "1mo": "1M", "1mon": "1M", "1month": "1M", "mn": "1M",
               "mn1": "1M", "month": "1M", "monthly": "1M"}


class DataError(Exception):
    pass


class SourceBlocked(DataError):
    """The source refuses this server (e.g. Binance answers 451 to US data centres) or can't be reached."""


class SymbolNotFound(DataError):
    pass


# ───────────────────────────── timeframes ─────────────────────────────
def norm_tf(tf):
    """'1m' = minute, '1M' = month. Also accepts 15min, H1, 4H, D, 1d, W, 1wk, MN, monthly ..."""
    t = str(tf).strip()
    if t in TFS:
        return t
    low = t.lower().replace(" ", "")
    if low in _TF_ALIASES:
        return _TF_ALIASES[low]
    raise ValueError(f"Unknown timeframe {tf!r}. Use one of {', '.join(TFS)} ('1m' = minute, '1M' = month).")


def tf_delta(tf):
    """Fixed length of a candle (None for months, which vary)."""
    return None if tf == "1M" else pd.Timedelta(minutes=TF_MIN[tf])


def close_times(index, tf):
    """Time each candle closes (= when its values became known)."""
    if tf == "1M":
        return pd.DatetimeIndex(index) + pd.offsets.MonthBegin(1)
    return pd.DatetimeIndex(index) + tf_delta(tf)


def utcnow():
    return pd.Timestamp.now(tz="UTC")


def epoch_s(index):
    """Epoch seconds as int64, whatever pandas' internal time resolution is."""
    idx = pd.DatetimeIndex(index)
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    return np.asarray((idx - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1), dtype=np.int64)


def to_utc_index(index):
    idx = pd.DatetimeIndex(index)
    idx = idx.tz_convert("UTC") if idx.tz is not None else idx.tz_localize("UTC")
    idx.name = "time"
    return idx


# ───────────────────────────── symbols ─────────────────────────────
FIAT = {"USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "HUF", "CZK", "TRY",
        "ZAR", "MXN", "SGD", "HKD", "CNH", "RUB", "ILS", "BRL", "RON", "THB"}
G10 = {"USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"}
FX_MAJORS = {"EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD"}
STABLE = ("USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI", "USD")
CRYPTO_QUOTES = ("FDUSD", "USDT", "USDC", "BUSD", "TUSD", "DAI", "USD", "BTC", "ETH", "BNB", "EUR", "TRY")
KNOWN_CRYPTO = set("""BTC ETH SOL BNB XRP ADA DOGE AVAX DOT LINK LTC BCH TRX MATIC POL TON SHIB NEAR UNI ATOM ETC XLM FIL
APT ARB OP SUI PEPE INJ AAVE XMR EOS DASH COMP YFI MKR BAT ENJ ICP HBAR VET ALGO SAND MANA AXS FTM SEI TIA WIF
BONK FLOKI JUP RNDR RENDER FET GRT IMX STX RUNE KAS TAO ENA ONDO WLD TRUMP HYPE PENGU CRV LDO CAKE GALA CHZ THETA
EGLD XTZ ZEC NEO KAVA 1INCH SNX ZIL QNT FLOW MINA CFX ORDI BLUR JTO PYTH DYDX GMX ZRO NOT BOME MEME PEOPLE
LUNA LUNC USTC BTT HOT IOTA ONE ROSE CELO ANKR AR APE GMT MASK LRC ENS SUSHI BAL OCEAN XEC XDC KSM VIRTUAL
POPCAT BRETT MOG SPX NEIRO GOAT MOODENG ACT PNUT FARTCOIN AI16Z AIXBT S BERA IP KAITO PI XAUT PAXG""".split())
DUKA_CRYPTO = {"BTC": "BTC", "ETH": "ETH", "LTC": "LTC", "BCH": "BCH", "XRP": "XRP", "ADA": "ADA", "XLM": "XLM",
               "LINK": "LNK", "MATIC": "MAT", "POL": "MAT", "UNI": "UNI", "TRX": "TRX", "AAVE": "AVE", "EOS": "EOS",
               "XMR": "XMR", "DASH": "DSH", "COMP": "CMP", "YFI": "YFI", "BAT": "BAT", "ENJ": "ENJ", "MKR": "MKR"}
CRYPTO_MAJORS = {"BTC", "ETH"}

# canonical name: (Dukascopy attribute without "INSTRUMENT_", display, asset class, sub-class, Yahoo ticker)
_DUKA = {
    "XAUUSD": ("FX_METALS_XAU_USD", "XAU/USD", "metal", "gold", "GC=F"),
    "XAGUSD": ("FX_METALS_XAG_USD", "XAG/USD", "metal", "silver", "SI=F"),
    "XPTUSD": ("CMD_METALS_XPT_CMD_USD", "XPT/USD", "metal", "metal", "PL=F"),
    "XPDUSD": ("CMD_METALS_XPD_CMD_USD", "XPD/USD", "metal", "metal", "PA=F"),
    "COPPER": ("CMD_METALS_COPPER_CMD_USD", "COPPER", "metal", "metal", "HG=F"),
    "US30": ("IDX_AMERICA_E_D_J_IND", "US30", "index", "index", "^DJI"),
    "NAS100": ("IDX_AMERICA_E_NQ_100", "NAS100", "index", "index", "^NDX"),
    "US500": ("IDX_AMERICA_E_SANDP_500", "US500", "index", "index", "^GSPC"),
    "US2000": ("IDX_AMERICA_USSC2000_IDX_USD", "US2000", "index", "index", "^RUT"),
    "DXY": ("IDX_AMERICA_DOLLAR_IDX_USD", "DXY", "index", "index", "DX-Y.NYB"),
    "VIX": ("IDX_AMERICA_VOL_IDX_USD", "VIX", "index", "index", "^VIX"),
    "GER40": ("IDX_EUROPE_E_DAAX", "GER40", "index", "index", "^GDAXI"),
    "UK100": ("IDX_EUROPE_E_FUTSEE_100", "UK100", "index", "index", "^FTSE"),
    "FRA40": ("IDX_EUROPE_E_CAAC_40", "FRA40", "index", "index", "^FCHI"),
    "EU50": ("IDX_EUROPE_E_DJE50XX", "EU50", "index", "index", "^STOXX50E"),
    "ESP35": ("IDX_EUROPE_E_IBC_MAC", "ESP35", "index", "index", "^IBEX"),
    "SWI20": ("IDX_EUROPE_E_SWMI", "SWI20", "index", "index", "^SSMI"),
    "JP225": ("IDX_ASIA_E_N225JAP", "JP225", "index", "index", "^N225"),
    "HK50": ("IDX_ASIA_E_H_KONG", "HK50", "index", "index", "^HSI"),
    "AUS200": ("IDX_ASIA_E_XJO_ASX", "AUS200", "index", "index", "^AXJO"),
    "CHINA50": ("IDX_ASIA_CHI_IDX_USD", "CHINA50", "index", "index", None),
    "USOIL": ("CMD_ENERGY_E_LIGHT", "USOIL", "energy", "energy", "CL=F"),
    "UKOIL": ("CMD_ENERGY_E_BRENT", "UKOIL", "energy", "energy", "BZ=F"),
    "NATGAS": ("CMD_ENERGY_GAS_CMD_USD", "NATGAS", "energy", "energy", "NG=F"),
    "COCOA": ("CMD_AGRICULTURAL_COCOA_CMD_USD", "COCOA", "commodity", "commodity", "CC=F"),
    "COFFEE": ("CMD_AGRICULTURAL_COFFEE_CMD_USX", "COFFEE", "commodity", "commodity", "KC=F"),
    "COTTON": ("CMD_AGRICULTURAL_COTTON_CMD_USX", "COTTON", "commodity", "commodity", "CT=F"),
    "SOYBEAN": ("CMD_AGRICULTURAL_SOYBEAN_CMD_USX", "SOYBEAN", "commodity", "commodity", "ZS=F"),
    "SUGAR": ("CMD_AGRICULTURAL_SUGAR_CMD_USD", "SUGAR", "commodity", "commodity", None),
}
_QUOTE = {'GER40': 'EUR', 'UK100': 'GBP', 'FRA40': 'EUR', 'EU50': 'EUR', 'ESP35': 'EUR', 'SWI20': 'CHF', 'JP225': 'JPY', 'HK50': 'HKD', 'AUS200': 'AUD', 'COFFEE': 'USX', 'COTTON': 'USX', 'SOYBEAN': 'USX'}       # price currency where it isn't USD (USX = US cents)
_ALIASES = {"GOLD": "XAUUSD", "SILVER": "XAGUSD", "PLATINUM": "XPTUSD", "PALLADIUM": "XPDUSD", "XCUUSD": "COPPER",
            "HG": "COPPER", "DJ30": "US30", "DJI": "US30", "DOW": "US30", "WS30": "US30", "US30CASH": "US30",
            "DJIA": "US30", "YM": "US30", "US100": "NAS100", "USTEC": "NAS100", "NDX": "NAS100", "NASDAQ": "NAS100",
            "NAS": "NAS100", "NQ": "NAS100", "NASDAQ100": "NAS100", "USTECH": "NAS100", "US100CASH": "NAS100",
            "SPX500": "US500", "SPX": "US500", "SP500": "US500", "S&P500": "US500", "ES": "US500", "US500CASH": "US500",
            "RUSSELL2000": "US2000", "RUT": "US2000", "RTY": "US2000", "US2K": "US2000", "USDX": "DXY",
            "USDINDEX": "DXY", "DOLLARINDEX": "DXY", "DE40": "GER40", "DAX": "GER40", "GER30": "GER40", "DE30": "GER40",
            "DAX40": "GER40", "FTSE": "UK100", "FTSE100": "UK100", "CAC40": "FRA40", "CAC": "FRA40", "F40": "FRA40",
            "STOXX50": "EU50", "EUSTX50": "EU50", "SX5E": "EU50", "ESTX50": "EU50", "SPA35": "ESP35", "IBEX": "ESP35",
            "IBEX35": "ESP35", "SMI": "SWI20", "CH20": "SWI20", "JPN225": "JP225", "NIKKEI": "JP225", "N225": "JP225",
            "NIKKEI225": "JP225", "HSI": "HK50", "HANGSENG": "HK50", "HK33": "HK50", "ASX200": "AUS200",
            "AU200": "AUS200", "CN50": "CHINA50", "CHI50": "CHINA50", "WTI": "USOIL", "XTIUSD": "USOIL", "CL": "USOIL",
            "OIL": "USOIL", "CRUDE": "USOIL", "WTIUSD": "USOIL", "USOUSD": "USOIL", "BRENT": "UKOIL",
            "XBRUSD": "UKOIL", "BRN": "UKOIL", "UKOUSD": "UKOIL", "XNGUSD": "NATGAS", "NGAS": "NATGAS", "NG": "NATGAS",
            "GAS": "NATGAS"}
_SOURCES = ("dukascopy", "binance", "binanceus", "kucoin", "coinbase", "yahoo")
_PREFIX_SOURCE = {"DUKASCOPY": "dukascopy", "DUKA": "dukascopy", "BINANCE": "binance", "BINANCEUS": "binanceus",
                  "KUCOIN": "kucoin", "COINBASE": "coinbase", "YAHOO": "yahoo", "YF": "yahoo"}
_PREFIX_CRYPTO = {"BYBIT", "OKX", "BITGET", "MEXC", "GATEIO", "BINGX", "KRAKEN", "BITSTAMP", "HTX", "CRYPTO", "CRYPTOCAP"}
_PREFIX_STOCK = {"NASDAQ", "NYSE", "AMEX", "BATS", "ARCA"}


def parse_symbol(symbol):
    """Work out what a symbol is and where its candles can come from.
    Returns dict(display, key, asset_class, sub, base, quote, candidates=[(source, native), ...], forced)."""
    raw = str(symbol).strip()
    if not raw:
        raise ValueError("Empty symbol")
    prefix = None
    if ":" in raw:
        prefix, raw = raw.split(":", 1)
        prefix = prefix.strip().upper()
    forced = _PREFIX_SOURCE.get(prefix)
    up = raw.strip().upper().replace(" ", "")
    if "=" in up or up.startswith("^"):                       # a Yahoo ticker like EURUSD=X, GC=F, ^GSPC
        return dict(display=up, key=up, asset_class="other", sub="other", base=up, quote="USD",
                    candidates=[("yahoo", up)], forced="yahoo")
    up = re.sub(r"([._\-]?PERP|\.P)$", "", up)                 # BYBIT:BTCUSDT.P / BTC-PERP style perpetual names
    clean = re.sub(r"[/\-_.]", "", up)
    clean = _ALIASES.get(clean, clean)

    def out(display, cls, sub, base, quote, cands):
        if forced:
            cands = [c for c in cands if c[0] == forced] or [(forced, cands[0][1] if cands else clean)]
        return dict(display=display, key=f"{display}", asset_class=cls, sub=sub, base=base, quote=quote,
                    candidates=cands, forced=forced)

    if clean in _DUKA and prefix not in _PREFIX_CRYPTO:
        attr, disp, cls, sub, yh = _DUKA[clean]
        cands = td_candidates(clean, cls, clean, "USD") + [("dukascopy", attr)] + ([("yahoo", yh)] if yh else [])
        return out(disp, cls, sub, clean, _QUOTE.get(clean, "USD"), cands)
    if len(clean) == 6 and clean[:3] in FIAT and clean[3:] in FIAT and prefix not in _PREFIX_CRYPTO:
        a, b = clean[:3], clean[3:]
        sub = "fx_major" if clean in FX_MAJORS else ("fx_cross" if a in G10 and b in G10 else "fx_exotic")
        cands = td_candidates(clean, "fx", a, b) + [("dukascopy", f"FX_MAJORS_{a}_{b}|FX_CROSSES_{a}_{b}"),
                                                    ("yahoo", f"{clean}=X")]
        return out(f"{a}/{b}", "fx", sub, a, b, cands)
    base = quote = None
    for q in CRYPTO_QUOTES:
        if clean.endswith(q) and len(clean) > len(q):
            b = clean[: -len(q)]
            if b in KNOWN_CRYPTO or (q in STABLE and b not in FIAT and len(b) >= 2 and prefix not in _PREFIX_STOCK
                                     and (prefix in _PREFIX_CRYPTO or forced in ("binance", "binanceus", "kucoin",
                                                                                 "coinbase") or q != "USD")):
                base, quote = b, q
                break
    if base is None and clean in KNOWN_CRYPTO:
        base, quote = clean, "USDT"
    if base is not None:
        bq = "USDT" if quote == "USD" else quote
        cb_q = "USD" if quote in ("USDT", "USD", "USDC", "FDUSD", "BUSD", "TUSD", "DAI") else quote
        cands = [("binance", f"{base}{bq}"), ("binanceus", f"{base}{bq}"), ("kucoin", f"{base}-{bq}"),
                 ("coinbase", f"{base}-{cb_q}"), ("yahoo", f"{base}-{'USD' if cb_q == 'USD' else cb_q}")]
        if base in DUKA_CRYPTO and quote in STABLE:
            cands.append(("dukascopy", f"VCCY_{DUKA_CRYPTO[base]}_USD"))
            if forced == "dukascopy":
                cands = [("dukascopy", f"VCCY_{DUKA_CRYPTO[base]}_USD")]
        sub = "crypto_major" if base in CRYPTO_MAJORS else "crypto_alt"
        return out(f"{base}/{quote}", "crypto", sub, base, quote, cands)
    if re.fullmatch(r"[A-Z]{1,5}", clean):                     # looks like a US stock ticker
        return out(clean, "stock", "stock", clean, "USD",
                   td_candidates(clean, "stock", clean, "USD") + [("dukascopy", f"US_{clean}_US_USD"), ("yahoo", clean)])
    return out(raw.upper(), "other", "other", clean, "USD", [("yahoo", raw.strip())])


# ───────────────────────────── cleaning / resampling ─────────────────────────────
def clean(df):
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"], dtype=float,
                            index=pd.DatetimeIndex([], tz="UTC", name="time"))
    df = df.copy()
    df.columns = [str(c).lower() for c in df.columns]
    if "volume" not in df.columns:
        df["volume"] = 0.0
    df = df[["open", "high", "low", "close", "volume"]].apply(pd.to_numeric, errors="coerce").astype(float)
    df.index = to_utc_index(df.index)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=["open", "high", "low", "close"])
    df = df[(df[["open", "high", "low", "close"]] > 0).all(axis=1)]
    px = df[["open", "high", "low", "close"]]
    df["high"] = px.max(axis=1)
    df["low"] = px.min(axis=1)
    df["volume"] = df["volume"].fillna(0.0).clip(lower=0.0)
    flat = (df["high"] <= df["low"]) & (df["volume"] <= 0)        # holiday filler candles
    return df[~flat]


def _agg(df, key):
    g = df.groupby(key)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum(), "_n": g["close"].count()})
    out.index = to_utc_index(out.index)
    return out


def trading_days(df):
    """Daily candles for markets that close at weekends: a Saturday/Sunday stub is merged into Monday,
    as a broker's daily chart does."""
    if len(df) == 0:
        return df
    d = df.index.floor("1D")
    shift = np.where(d.dayofweek == 5, 2, np.where(d.dayofweek == 6, 1, 0))
    key = d + pd.to_timedelta(shift, unit="D")
    return _agg(df, key).drop(columns="_n")


def resample(df, tf, base_tf=None):
    """Candles of `tf` from smaller candles. Bins are UTC-aligned: 4h at 00/04/08..., days at 00:00,
    3D aligned to the epoch (like exchanges), weeks start Monday, months on the 1st."""
    if len(df) == 0:
        return df
    idx = df.index
    if tf in INTRADAY:
        key = idx.floor(f"{TF_MIN[tf]}min")
    elif tf == "1D":
        key = idx.floor("1D")
    elif tf == "3D":
        key = idx.floor("3D")
    elif tf == "1W":
        d = idx.floor("1D")
        key = d - pd.to_timedelta(d.dayofweek, unit="D")
    elif tf == "1M":
        d = idx.floor("1D")
        key = d - pd.to_timedelta(d.day - 1, unit="D")
    else:
        raise ValueError(tf)
    out = _agg(df, key)
    if base_tf in INTRADAY and tf in INTRADAY:                      # drop stub bins (e.g. FX Sunday open)
        expected = TF_MIN[tf] / TF_MIN[base_tf]
        out = out[out["_n"] >= max(1.0, 0.25 * expected)]
    return out.drop(columns="_n")


def split_forming(df, tf, now=None):
    """(closed candles, forming candle or None)."""
    if len(df) == 0:
        return df, None
    now = now or utcnow()
    end = close_times(df.index[-1:], tf)[0]
    if end > now:
        return df.iloc[:-1], df.iloc[-1]
    return df, None


def heuristic_decimals(price):
    """About six significant digits, at least two decimals (EURUSD 5, USDJPY 3, BTC 2, PEPE 10)."""
    p = abs(float(price))
    return int(min(10, max(2, 5 - math.floor(math.log10(p))))) if p > 0 else 2


def infer_decimals(prices):
    """Decimals the feed actually quotes (EURUSD 1.08432 → 5), capped near the heuristic for noisy floats."""
    x = np.asarray(prices, dtype=float)[-300:]
    x = x[np.isfinite(x) & (x > 0)]
    if len(x) == 0:
        return None
    heur = heuristic_decimals(np.median(x))
    for d in range(0, 11):
        s = x * 10.0 ** d
        if np.all(np.abs(s - np.round(s)) < 1e-6):
            return int(max(min(d, heur + 2), 2))
    return None                                                      # feed has float noise: caller decides


def price_decimals(prices, asset_class=None, quote=None):
    d = infer_decimals(prices)
    if d is not None:
        return d
    if asset_class == "fx":
        return 3 if quote in ("JPY", "HUF", "THB", "RUB", "CZK") else 5
    x = np.asarray(prices, dtype=float)
    x = x[np.isfinite(x) & (x > 0)]
    return heuristic_decimals(np.median(x)) if len(x) else 2


# ───────────────────────────── HTTP ─────────────────────────────
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
_HTTP = {"session": None}


def set_http(session):
    """Swap the HTTP client (used by tests)."""
    _HTTP["session"] = session


def _session():
    if _HTTP["session"] is None:
        if requests is None:
            raise DataError("The 'requests' package is not installed")
        _HTTP["session"] = requests.Session()
    return _HTTP["session"]


def _get_json(url, params=None, timeout=20, tries=3):
    last = None
    for k in range(tries):
        try:
            r = _session().get(url, params=params, headers={"User-Agent": UA, "Accept": "application/json"},
                               timeout=timeout)
        except Exception as e:                                       # DNS / firewall / timeout
            last = e
            time.sleep(0.5 * (k + 1))
            continue
        code = int(getattr(r, "status_code", 200))
        if code in (451, 403):
            raise SourceBlocked(f"HTTP {code}: refused from this server's location")
        if code in (429, 418):
            last = DataError(f"HTTP {code}: rate limited")
            time.sleep(2.0 * (k + 1))
            continue
        if code >= 500:
            last = DataError(f"HTTP {code}")
            time.sleep(1.0)
            continue
        if code in (400, 404):
            raise SymbolNotFound(f"HTTP {code}: {str(getattr(r, 'text', ''))[:160]}")
        try:
            return r.json()
        except Exception as e:
            last = DataError(f"bad JSON: {e}")
            continue
    if isinstance(last, DataError):
        raise last
    raise SourceBlocked(f"unreachable: {last}")


def _ms(ts):
    return int(pd.Timestamp(ts).timestamp() * 1000)


# ───────────────────────────── sources ─────────────────────────────
BINANCE_IV = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1d", "3D": "3d",
              "1W": "1w", "1M": "1M"}
KUCOIN_IV = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "4h": "4hour",
             "1D": "1day", "1W": "1week"}
COINBASE_GRAN = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1D": 86400}
YAHOO_IV = {"1m": ("1m", "7d"), "5m": ("5m", "60d"), "15m": ("15m", "60d"), "30m": ("30m", "60d"),
            "1h": ("1h", "730d"), "1D": ("1d", None), "1W": ("1wk", None), "1M": ("1mo", None)}
DUKA_IV = {"1m": "INTERVAL_MIN_1", "5m": "INTERVAL_MIN_5", "15m": "INTERVAL_MIN_15", "30m": "INTERVAL_MIN_30",
           "1h": "INTERVAL_HOUR_1", "4h": "INTERVAL_HOUR_4", "1D": "INTERVAL_DAY_1"}
BINANCE_URL = {"binance": "https://api.binance.com", "binanceus": "https://api.binance.us"}

# which candle size each source downloads to build a timeframe it doesn't offer itself
NATIVE = {
    "dukascopy": {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1D",
                  "3D": "1D", "1W": "1D", "1M": "1D"},
    "binance": {t: t for t in TFS},
    "binanceus": {t: t for t in TFS},
    "kucoin": {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1D",
               "3D": "1D", "1W": "1W", "1M": "1D"},
    "coinbase": {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "15m", "1h": "1h", "4h": "1h", "1D": "1D",
                 "3D": "1D", "1W": "1D", "1M": "1D"},
    "yahoo": {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "1h", "1D": "1D",
              "3D": "1D", "1W": "1W", "1M": "1M"},
}


def _empty():
    return clean(None)


# ───────────────────────── Twelve Data (paid plan for most metals and indices) ─────────────────────────
# Off unless TWELVEDATA_ENABLED=1 and TWELVEDATA_API_KEY is set. While it is off, nothing changes: the free sources answer.
TD_IV = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1D": "1day",
         "1W": "1week", "1M": "1month"}
# Twelve Data names for metals and indices. Check each one with a test call. A name Twelve Data rejects falls back to
# the free sources, so the chart keeps working.
TD_SYMBOL = {"XAUUSD": "XAU/USD", "XAGUSD": "XAG/USD", "XPTUSD": "XPT/USD", "XPDUSD": "XPD/USD",
             "US30": "DJI", "NAS100": "NDX", "US500": "SPX", "US2000": "RUT", "VIX": "VIX",
             "UK100": "FTSE", "JP225": "N225", "HK50": "HSI"}
NATIVE["twelvedata"] = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1D",
                        "3D": "1D", "1W": "1W", "1M": "1M"}


def twelvedata_on():
    return os.environ.get("TWELVEDATA_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")


def td_candidates(clean_name, asset_class, base, quote):
    """Twelve Data goes first for forex, metals, indices and stocks, and only when it is switched on."""
    if not twelvedata_on():
        return []
    if asset_class == "fx":
        return [("twelvedata", f"{base}/{quote}")]
    if asset_class == "stock":
        return [("twelvedata", clean_name)]
    if asset_class in ("metal", "index") and clean_name in TD_SYMBOL:
        return [("twelvedata", TD_SYMBOL[clean_name])]
    return []


def fetch_twelvedata(native, tf, start, end):
    """Twelve Data time series. Needs TWELVEDATA_API_KEY. Any error falls through to the next source."""
    key = os.environ.get("TWELVEDATA_API_KEY", "").strip()
    if not key:
        raise DataError("Twelve Data is on but TWELVEDATA_API_KEY is empty")
    s = pd.Timestamp(start).tz_convert("UTC").strftime("%Y-%m-%d %H:%M:%S")
    e = pd.Timestamp(end).tz_convert("UTC").strftime("%Y-%m-%d %H:%M:%S")
    js = _get_json("https://api.twelvedata.com/time_series",
                   dict(symbol=native, interval=TD_IV[tf], start_date=s, end_date=e, outputsize=5000,
                        timezone="UTC", order="ASC", format="JSON", apikey=key))
    if not isinstance(js, dict) or js.get("status") == "error" or "values" not in js:
        msg = js.get("message") if isinstance(js, dict) else js
        raise SymbolNotFound(f"Twelve Data: {str(msg)[:160]}")
    values = js.get("values") or []
    if not values:
        return _empty()
    df = pd.DataFrame(values)
    df.index = pd.to_datetime(df.pop("datetime"), utc=True)
    df = df.rename(columns=str.lower)
    for col in ("open", "high", "low", "close", "volume"):
        if col not in df.columns:
            df[col] = 0.0
    return clean(df[["open", "high", "low", "close", "volume"]].astype(float))


def fetch_dukascopy(native, tf, start, end):
    import dukascopy_python as dk
    from dukascopy_python import instruments as ins
    attr = None
    for name in native.split("|"):
        if hasattr(ins, "INSTRUMENT_" + name):
            attr = "INSTRUMENT_" + name
            break
    if attr is None:
        raise SymbolNotFound(f"Dukascopy has no instrument {native.split('|')[0]}")
    interval = getattr(dk, DUKA_IV[tf])
    s = pd.Timestamp(start).tz_convert("UTC").to_pydatetime()
    e = pd.Timestamp(end).tz_convert("UTC").to_pydatetime()
    df = dk.fetch(getattr(ins, attr), interval, dk.OFFER_SIDE_BID, s, e, max_retries=3)
    if df is None or len(df) == 0:
        return _empty()
    df.columns = [str(c).lower() for c in df.columns]
    return clean(df)


def fetch_binance(native, tf, start, end, source="binance"):
    base, rows = BINANCE_URL[source], []
    cur, end_ms = _ms(start), _ms(end)
    while cur <= end_ms:
        data = _get_json(f"{base}/api/v3/klines", dict(symbol=native, interval=BINANCE_IV[tf], startTime=cur,
                                                        endTime=end_ms, limit=1000))
        if isinstance(data, dict):
            raise SymbolNotFound(str(data)[:160])
        if not data:
            break
        rows.extend(data)
        nxt = int(data[-1][0]) + 1
        if len(data) < 1000 or nxt <= cur:
            break
        cur = nxt
    if not rows:
        return _empty()
    df = pd.DataFrame([r[:6] for r in rows], columns=["t", "open", "high", "low", "close", "volume"])
    df.index = pd.to_datetime(df.pop("t").astype("int64"), unit="ms", utc=True)
    return clean(df)


def fetch_kucoin(native, tf, start, end):
    rows, start_s, end_s = [], int(_ms(start) // 1000), int(_ms(end) // 1000)
    while end_s > start_s:
        js = _get_json("https://api.kucoin.com/api/v1/market/candles",
                       dict(type=KUCOIN_IV[tf], symbol=native, startAt=start_s, endAt=end_s))
        if str(js.get("code")) != "200000":
            raise SymbolNotFound(f"KuCoin: {js.get('msg', js.get('code'))}")
        data = js.get("data") or []
        if not data:
            break
        rows.extend(data)
        oldest = min(int(r[0]) for r in data)
        if oldest <= start_s or oldest - 1 >= end_s:
            break
        end_s = oldest - 1
    if not rows:
        return _empty()
    df = pd.DataFrame([[int(r[0]), r[1], r[3], r[4], r[2], r[5]] for r in rows],      # t, open, high, low, close, vol
                      columns=["t", "open", "high", "low", "close", "volume"])
    df.index = pd.to_datetime(df.pop("t"), unit="s", utc=True)
    return clean(df)


def fetch_coinbase(native, tf, start, end):
    gran = COINBASE_GRAN[tf]
    rows, cur, end_ts = [], pd.Timestamp(start), pd.Timestamp(end)
    step = pd.Timedelta(seconds=gran * 300)
    while cur < end_ts:
        nxt = min(cur + step, end_ts)
        data = _get_json(f"https://api.exchange.coinbase.com/products/{native}/candles",
                         dict(granularity=gran, start=cur.strftime("%Y-%m-%dT%H:%M:%SZ"),
                              end=nxt.strftime("%Y-%m-%dT%H:%M:%SZ")))
        if isinstance(data, dict):
            raise SymbolNotFound(f"Coinbase: {data.get('message', data)}")
        rows.extend(data or [])
        cur = nxt
        time.sleep(0.12)                                             # public limit: ~10 requests/second
    if not rows:
        return _empty()
    df = pd.DataFrame([[int(r[0]), r[3], r[2], r[1], r[4], r[5]] for r in rows],      # t, open, high, low, close, vol
                      columns=["t", "open", "high", "low", "close", "volume"])
    df.index = pd.to_datetime(df.pop("t"), unit="s", utc=True)
    return clean(df)


def fetch_yahoo(native, tf, start, end):
    import yfinance as yf
    iv, period = YAHOO_IV[tf]
    t = yf.Ticker(native)
    if period is None:
        h = t.history(start=pd.Timestamp(start).strftime("%Y-%m-%d"),
                      end=(pd.Timestamp(end) + pd.Timedelta(days=2)).strftime("%Y-%m-%d"), interval=iv,
                      auto_adjust=False)
    else:
        h = t.history(period=period, interval=iv, auto_adjust=False, prepost=False)
    if h is None or len(h) == 0:
        raise SymbolNotFound(f"Yahoo has no data for {native}")
    if isinstance(h.columns, pd.MultiIndex):
        h.columns = h.columns.get_level_values(0)
    h = h.rename(columns=str.lower)
    idx = pd.DatetimeIndex(h.index)
    if tf in ("1D", "1W", "1M"):                                     # daily+ bars: keep the calendar date
        idx = (idx.tz_localize(None) if idx.tz is not None else idx).normalize()
    h.index = to_utc_index(idx)
    return clean(h)


FETCH = {"dukascopy": fetch_dukascopy, "binance": lambda n, t, s, e: fetch_binance(n, t, s, e, "binance"),
         "binanceus": lambda n, t, s, e: fetch_binance(n, t, s, e, "binanceus"), "kucoin": fetch_kucoin,
         "coinbase": fetch_coinbase, "yahoo": fetch_yahoo, "twelvedata": fetch_twelvedata}


# ───────────────────────────── cache ─────────────────────────────
_STATE = {"dir": None}
_MEM, _CHECKED, _WORKING, _BLOCKED = {}, {}, {}, {}


def set_cache_dir(path):
    """Where candles are cached (e.g. a folder on Google Drive). None = memory only."""
    _STATE["dir"] = path
    if path:
        os.makedirs(path, exist_ok=True)


def reset_sources():
    """Forget which sources were blocked or chosen (e.g. after moving the notebook to another runtime)."""
    _BLOCKED.clear()
    _WORKING.clear()


def _cache_path(source, native, tf):
    if not _STATE["dir"]:
        return None
    safe = re.sub(r"[^A-Za-z0-9]+", "_", native).strip("_")
    return os.path.join(_STATE["dir"], source, f"{safe}__{tf}.csv.gz")


def _read_cache(path):
    if not path or not os.path.exists(path):
        return None
    try:
        df = pd.read_csv(path, index_col=0)
        df.index = to_utc_index(pd.to_datetime(df.index, utc=True))
        return clean(df)
    except Exception:
        return None


def _write_cache(path, df):
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp.csv.gz"
    df.to_csv(tmp)
    os.replace(tmp, path)


def _meta_path(path):
    return path.replace(".csv.gz", ".meta.json") if path else None


def _series(source, native, tf, start, end, refresh_s):
    """Candles of `tf` (a timeframe this source offers) covering start..end, from memory/disk cache + top-up."""
    key = (source, native, tf)
    now = utcnow()
    path = _cache_path(source, native, tf)
    df, fetched_at = None, None
    if key in _MEM:
        df, fetched_at = _MEM[key]
    elif path:
        df = _read_cache(path)
        mp = _meta_path(path)
        if df is not None and mp and os.path.exists(mp):
            try:
                _CHECKED[key] = pd.Timestamp(json.load(open(mp))["checked_from"])
            except Exception:
                pass
    step = tf_delta(tf) or pd.Timedelta(days=31)
    checked = _CHECKED.get(key)
    have_start = df is not None and len(df) > 0 and (df.index[0] <= start + 3 * step or
                                                       (checked is not None and checked <= start + 3 * step))
    if have_start:
        if fetched_at is not None and (now - fetched_at).total_seconds() < refresh_s:
            return df
        new = FETCH[source](native, tf, df.index[-1] - 3 * step, end)
        df = clean(pd.concat([df, new]))
    else:
        if df is not None and len(df):                                 # extend backwards, then top up
            older = FETCH[source](native, tf, start, df.index[0] + step)
            newer = FETCH[source](native, tf, df.index[-1] - 3 * step, end)
            df = clean(pd.concat([older, df, newer]))
        else:
            df = clean(FETCH[source](native, tf, start, end))
        _CHECKED[key] = min(start, _CHECKED.get(key, start))
        if path:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            json.dump({"checked_from": str(_CHECKED[key])}, open(_meta_path(path), "w"))
    _MEM[key] = (df, now)
    if path and len(df):
        _write_cache(path, df)
    return df


def start_for(tf, bars, asset_class, end=None):
    """How far back to ask for `bars` candles, allowing for weekends/holidays (or exchange hours for stocks)."""
    end = end or utcnow()
    m = TF_MIN[tf]
    if asset_class == "crypto" or tf in ("1W", "1M"):
        minutes = bars * m * 1.03 + 3 * m
    elif asset_class == "stock" and tf in INTRADAY:
        minutes = bars * m * 5.5 + 4 * 1440
    elif tf in INTRADAY:
        minutes = bars * m * 1.45 + 4 * 1440                       # + a weekend and a holiday
    else:
        minutes = bars * m * 1.48 + 10 * 1440
    return end - pd.Timedelta(minutes=minutes)


def daily_align(df):
    """Label each daily candle with its trading date, whichever convention the feed uses: a day that opens at
    00:00 UTC keeps its date, a forex day that opens at 22:00 UTC (New York close) belongs to the next date."""
    if len(df) == 0:
        return df
    return _agg(df, (df.index + pd.Timedelta(hours=12)).floor("1D")).drop(columns="_n")


def _transform(df, tf, base_tf, asset_class):
    if base_tf == "1D":
        df = daily_align(df)
    if asset_class != "crypto" and base_tf == "1D":
        df = trading_days(df)
    if tf != base_tf:
        df = resample(df, tf, base_tf)
    return df


def get_candles(symbol, tf="1h", bars=1000, start=None, end=None, refresh_s=None, min_bars=30, verbose=False):
    """Closed candles + the forming candle for any symbol/timeframe.
    Returns dict(symbol, tf, source, native, asset_class, sub, base, quote, df, forming, price, decimals,
    last_close_time, age_minutes)."""
    tf = norm_tf(tf)
    spec = parse_symbol(symbol)
    now = utcnow()
    end = pd.Timestamp(end).tz_convert("UTC") if end is not None else now
    start = pd.Timestamp(start).tz_convert("UTC") if start is not None else start_for(tf, bars, spec["asset_class"], end)
    refresh_s = refresh_s if refresh_s is not None else max(15, min(300, TF_MIN[tf] * 6))
    cands = list(spec["candidates"])
    if spec["key"] in _WORKING and _WORKING[spec["key"]] in cands:
        cands.remove(_WORKING[spec["key"]])
        cands.insert(0, _WORKING[spec["key"]])
    errors, df, used = [], None, None
    for source, native in cands:
        blocked = _BLOCKED.get(source)
        if blocked and not spec["forced"]:
            msg, until = blocked
            if until is None or now < until:
                errors.append(f"{source}: skipped ({msg})")
                continue
            _BLOCKED.pop(source, None)
        try:
            base_tf = NATIVE[source][tf]
            bstart = start
            if base_tf == "1D" and tf in ("3D", "1W", "1M"):
                bstart = start - pd.Timedelta(days=40)
            raw = _series(source, native, base_tf, bstart, end, refresh_s)
            d = _transform(raw, tf, base_tf, spec["asset_class"])
            d = d[d.index >= start - (tf_delta(tf) or pd.Timedelta(days=31))]
            if len(d) < min_bars:
                raise SymbolNotFound(f"only {len(d)} candles")
            df, used = d, (source, native)
            break
        except SourceBlocked as e:
            # a refusal (451/403) lasts the session; a network failure is retried after 10 minutes
            _BLOCKED[source] = (str(e)[:80], None if str(e).startswith("HTTP") else now + pd.Timedelta(minutes=10))
            errors.append(f"{source}: {e}")
        except Exception as e:
            errors.append(f"{source}: {type(e).__name__}: {str(e)[:160]}")
        if verbose:
            print("  ", errors[-1])
    if df is None:
        raise DataError(f"No data for {symbol} {tf}. Tried → " + " | ".join(errors))
    _WORKING[spec["key"]] = used
    closed, forming = split_forming(df, tf, now)
    if bars and len(closed) > bars:
        closed = closed.iloc[-bars:]
    last_close = close_times(closed.index[-1:], tf)[0] if len(closed) else None
    price = float(forming["close"]) if forming is not None else float(closed["close"].iloc[-1])
    return dict(symbol=spec["display"], query=str(symbol), tf=tf, source=used[0], native=used[1],
                asset_class=spec["asset_class"], sub=spec["sub"], base=spec["base"], quote=spec["quote"],
                df=closed, forming=forming, price=price,
                decimals=price_decimals(np.r_[closed["close"].to_numpy()[-300:], price], spec["asset_class"],
                                        spec["quote"]),
                last_close_time=last_close,
                age_minutes=None if last_close is None else round((now - last_close).total_seconds() / 60, 1))


def history(symbol, tf, years=None, start=None, verbose=True):
    """Long history for training (closed candles only)."""
    tf = norm_tf(tf)
    end = utcnow()
    start = pd.Timestamp(start, tz="UTC") if start is not None else end - pd.Timedelta(days=int(365.25 * years))
    c = get_candles(symbol, tf, bars=None, start=start, end=end, refresh_s=3600, min_bars=200)
    if verbose:
        d = c["df"]
        print(f"  {c['symbol']:10s} {tf:>3s}: {len(d):>8,} candles {d.index[0]:%Y-%m-%d} → {d.index[-1]:%Y-%m-%d} "
              f"({c['source']})")
    return c


def seed_cache_from_csv(path, source, native, tf):
    """Import an earlier notebook's cached CSV (time index + OHLCV) into this cache, if not already there."""
    dest = _cache_path(source, native, tf)
    if not dest or os.path.exists(dest) or not os.path.exists(path):
        return False
    df = _read_cache(path)
    if df is None or len(df) < 1000:
        return False
    _write_cache(dest, df)
    json.dump({"checked_from": str(df.index[0])}, open(_meta_path(dest), "w"))
    return True

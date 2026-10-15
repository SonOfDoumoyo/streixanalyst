"""Extends the notebook's market_data module for the web app (the notebook files stay untouched):

  * more crypto exchanges so almost any listed coin works: Bybit (spot + USDT perps), OKX (spot + swaps),
    MEXC, Gate, Binance USDⓈ-M futures
  * prefixes that force one exchange: BYBIT:, OKX:, MEXC:, GATE:, BINANCEF:
  * per-series locks so many users asking for the same chart at once trigger one download
  * a thread-safe context store for guru_analyst (many analyses run in parallel)
"""
import re
import threading

import pandas as pd

import market_data as md

PERP_RE = re.compile(r"([._\-]?PERP|\.P)$")
NEW_PREFIX = {"BYBIT": "bybit", "OKX": "okx", "OKEX": "okx", "MEXC": "mexc", "GATE": "gate", "GATEIO": "gate",
              "BINANCEF": "binancef", "BINANCEFUTURES": "binancef", "BINANCE_FUTURES": "binancef"}
CRYPTO_SOURCES = ("binance", "bybit", "okx", "kucoin", "mexc", "gate", "binancef", "coinbase", "binanceus")

BYBIT_IV = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1D": "D"}
OKX_IV = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1D": "1Dutc"}
MEXC_IV = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "4h": "4h", "1D": "1d"}
GATE_IV = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1d"}
STEP_S = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400}
_INTRA_D = {t: t for t in ("1m", "5m", "15m", "30m", "1h", "4h", "1D")}
for _src in ("bybit", "okx", "mexc", "gate"):
    md.NATIVE[_src] = dict(_INTRA_D, **{"3D": "1D", "1W": "1D", "1M": "1D"})
md.NATIVE["binancef"] = {t: t for t in md.TFS}


def _frame(rows, cols_idx, unit="ms"):
    """rows → OHLCV frame. cols_idx = (t, open, high, low, close, volume) positions."""
    if not rows:
        return md.clean(None)
    t, o, h, l, c, v = cols_idx
    df = pd.DataFrame([[int(float(r[t])), r[o], r[h], r[l], r[c], r[v]] for r in rows],
                      columns=["t", "open", "high", "low", "close", "volume"])
    df.index = pd.to_datetime(df.pop("t"), unit=unit, utc=True)
    return md.clean(df)


def fetch_bybit(native, tf, start, end):
    category, sym = native.split(":", 1) if ":" in native else ("spot", native)
    rows, start_ms, cur_end = [], md._ms(start), md._ms(end)
    while cur_end > start_ms:
        js = md._get_json("https://api.bybit.com/v5/market/kline",
                          dict(category=category, symbol=sym, interval=BYBIT_IV[tf], start=start_ms, end=cur_end,
                               limit=1000))
        if not isinstance(js, dict) or js.get("retCode") != 0:
            raise md.SymbolNotFound(f"Bybit: {js.get('retMsg') if isinstance(js, dict) else js}")
        data = (js.get("result") or {}).get("list") or []          # newest first
        if not data:
            break
        rows.extend(data)
        oldest = int(data[-1][0])
        if len(data) < 1000 or oldest <= start_ms:
            break
        cur_end = oldest - 1
    return _frame(rows, (0, 1, 2, 3, 4, 5))


def fetch_okx(native, tf, start, end):
    rows, start_ms, after = [], md._ms(start), md._ms(end) + 1
    for _ in range(400):
        js = md._get_json("https://www.okx.com/api/v5/market/history-candles",
                          dict(instId=native, bar=OKX_IV[tf], after=after, limit=100))
        if not isinstance(js, dict) or str(js.get("code")) != "0":
            raise md.SymbolNotFound(f"OKX: {js.get('msg') if isinstance(js, dict) else js}")
        data = js.get("data") or []                                  # newest first
        if not data:
            break
        rows.extend(data)
        oldest = int(data[-1][0])
        if oldest <= start_ms or len(data) < 100:
            break
        after = oldest
    return _frame(rows, (0, 1, 2, 3, 4, 5))


def fetch_mexc(native, tf, start, end):
    rows, cur, end_ms = [], md._ms(start), md._ms(end)
    while cur <= end_ms:
        data = md._get_json("https://api.mexc.com/api/v3/klines",
                            dict(symbol=native, interval=MEXC_IV[tf], startTime=cur, endTime=end_ms, limit=1000))
        if isinstance(data, dict):
            raise md.SymbolNotFound(f"MEXC: {data.get('msg', data)}")
        if not data:
            break
        rows.extend(data)
        nxt = int(data[-1][0]) + 1
        if len(data) < 1000 or nxt <= cur:
            break
        cur = nxt
    return _frame(rows, (0, 1, 2, 3, 4, 5))


def fetch_gate(native, tf, start, end):
    step = STEP_S[tf]
    rows, cur, end_s = [], int(md._ms(start) // 1000), int(md._ms(end) // 1000)
    while cur <= end_s:
        to = min(end_s, cur + 999 * step)
        data = md._get_json("https://api.gateio.ws/api/v4/spot/candlesticks",
                            {"currency_pair": native, "interval": GATE_IV[tf], "from": cur, "to": to})
        if isinstance(data, dict):
            raise md.SymbolNotFound(f"Gate: {data.get('message', data)}")
        rows.extend(data or [])
        cur = to + 1
    # [t, quote_volume, close, high, low, open, base_volume, closed]
    return _frame(rows, (0, 5, 3, 4, 2, 6), unit="s")


def fetch_binancef(native, tf, start, end):
    rows, cur, end_ms = [], md._ms(start), md._ms(end)
    while cur <= end_ms:
        data = md._get_json("https://fapi.binance.com/fapi/v1/klines",
                            dict(symbol=native, interval=md.BINANCE_IV[tf], startTime=cur, endTime=end_ms, limit=1500))
        if isinstance(data, dict):
            raise md.SymbolNotFound(str(data)[:160])
        if not data:
            break
        rows.extend(data)
        nxt = int(data[-1][0]) + 1
        if len(data) < 1500 or nxt <= cur:
            break
        cur = nxt
    return _frame(rows, (0, 1, 2, 3, 4, 5))


md.FETCH.update(bybit=fetch_bybit, okx=fetch_okx, mexc=fetch_mexc, gate=fetch_gate, binancef=fetch_binancef)

_orig_parse = md.parse_symbol


def crypto_candidates(base, quote, perp=False):
    q = "USDT" if quote == "USD" else quote
    spot = [("binance", f"{base}{q}"), ("bybit", f"spot:{base}{q}"), ("okx", f"{base}-{q}"),
            ("kucoin", f"{base}-{q}"), ("mexc", f"{base}{q}"), ("gate", f"{base}_{q}")]
    futs = []
    if q in ("USDT", "USDC"):
        futs = [("binancef", f"{base}{q}"), ("bybit", f"linear:{base}{q}" if q == "USDT" else f"linear:{base}PERP"),
                ("okx", f"{base}-{q}-SWAP")]
    cb_q = "USD" if quote in md.STABLE else quote
    tail = [("coinbase", f"{base}-{cb_q}"), ("binanceus", f"{base}{q}"), ("yahoo", f"{base}-{'USD' if cb_q == 'USD' else cb_q}")]
    if base in md.DUKA_CRYPTO and quote in md.STABLE:
        tail.append(("dukascopy", f"VCCY_{md.DUKA_CRYPTO[base]}_USD"))
    return (futs + spot + tail) if perp else (spot + futs + tail)


def parse_symbol(symbol):
    raw = str(symbol).strip()
    forced = None
    rest = raw
    if ":" in raw:
        pre, rest = raw.split(":", 1)
        if pre.strip().upper() in NEW_PREFIX:
            forced = NEW_PREFIX[pre.strip().upper()]
            raw = "CRYPTO:" + rest                      # tells the original parser "this is crypto"
    perp = bool(PERP_RE.search(rest.strip().upper()))
    spec = _orig_parse(raw)
    if spec["asset_class"] != "crypto":
        return spec
    if spec.get("forced") in ("dukascopy", "yahoo"):
        return spec
    keep_forced = spec.get("forced") or forced
    cands = crypto_candidates(spec["base"], spec["quote"], perp)
    if keep_forced:
        only = [c for c in cands if c[0] == keep_forced]
        if keep_forced == "bybit" and perp:
            only = [c for c in only if c[1].startswith("linear:")] + [c for c in only if c[1].startswith("spot:")]
        cands = only or cands
    spec = dict(spec, candidates=cands, forced=keep_forced, perp=perp)
    if perp:
        spec["display"] = spec["display"] + " PERP"
        spec["key"] = spec["display"]
    return spec


md.parse_symbol = parse_symbol

# ── one download per series at a time
_locks, _locks_guard = {}, threading.Lock()
_orig_series = md._series


def _locked_series(source, native, tf, start, end, refresh_s):
    key = (source, native, tf)
    with _locks_guard:
        lk = _locks.setdefault(key, threading.Lock())
    with lk:
        return _orig_series(source, native, tf, start, end, refresh_s)


md._series = _locked_series


class SafeContexts(dict):
    """guru_analyst keeps the last 20 analysis contexts for trade reviews; make that safe across threads."""
    _lock = threading.RLock()

    def __setitem__(self, k, v):
        with self._lock:
            super().__setitem__(k, v)

    def pop(self, k, *default):
        with self._lock:
            return super().pop(k, None)

    def __iter__(self):
        with self._lock:
            return iter(list(super().keys()))


def install_safe_contexts(ga):
    ga._STATE["ctx"] = SafeContexts()


def blocked_sources():
    now = md.utcnow()
    return {s: m for s, (m, until) in md._BLOCKED.items() if until is None or now < until}

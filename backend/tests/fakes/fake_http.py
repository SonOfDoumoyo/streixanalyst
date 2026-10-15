"""Fake HTTP session answering like Binance / Binance.US / KuCoin / Coinbase (documented formats), from synth data.
BLOCK = set of hosts that answer 451 (Binance does that to US data centres)."""
import json
import pandas as pd
import synth

BLOCK = {"api.binance.com"}
LOG = []
_BIN_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440}
_KU_MIN = {"1min": 1, "5min": 5, "15min": 15, "30min": 30, "1hour": 60, "4hour": 240, "1day": 1440}
KNOWN = {"BTC", "ETH", "SOL", "PEPE", "DOGE", "AVAX", "XRP", "BNB", "LINK", "ADA"}


class Resp:
    def __init__(self, code, payload):
        self.status_code = code
        self._p = payload
        self.text = json.dumps(payload)[:300]

    def json(self):
        return self._p


def _frame(sym, minutes=None, rule=None, start=None, end=None):
    name = sym
    if rule:
        return synth.calendar(name, start, end, rule)
    return synth.window(name, start, end, minutes)


class Session:
    def get(self, url, params=None, headers=None, timeout=None):
        params = params or {}
        LOG.append((url, dict(params)))
        host = url.split("/")[2]
        if host in BLOCK:
            return Resp(451, {"code": 0, "msg": "Service unavailable from a restricted location"})
        if "/api/v3/klines" in url:
            sym = params["symbol"]
            base = next((k for k in KNOWN if sym.startswith(k)), None)
            if base is None:
                return Resp(400, {"code": -1121, "msg": "Invalid symbol."})
            iv = params["interval"]
            s = pd.to_datetime(int(params["startTime"]), unit="ms", utc=True)
            e = pd.to_datetime(int(params["endTime"]), unit="ms", utc=True)
            if iv in _BIN_MIN:
                df = _frame(base, minutes=_BIN_MIN[iv], start=s, end=e)
            else:
                df = _frame(base, rule={"3d": "3D", "1w": "1W", "1M": "1M"}[iv], start=s, end=e)
            df = df[(df.index >= s) & (df.index <= e)].iloc[: int(params.get("limit", 500))]
            ms = (df.index - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(milliseconds=1)
            rows = [[int(t), f"{o:.8f}", f"{h:.8f}", f"{l:.8f}", f"{c:.8f}", f"{v:.4f}", int(t) + 1, "0", 1, "0", "0",
                     "0"] for t, o, h, l, c, v in zip(ms, df["open"], df["high"], df["low"], df["close"], df["volume"])]
            return Resp(200, rows)
        if "api.kucoin.com" in host:
            sym = params["symbol"]
            base = sym.split("-")[0]
            if base not in KNOWN:
                return Resp(200, {"code": "400100", "msg": "This pair is not provided at present"})
            s = pd.to_datetime(int(params["startAt"]), unit="s", utc=True)
            e = pd.to_datetime(int(params["endAt"]), unit="s", utc=True)
            iv = params["type"]
            df = _frame(base, minutes=_KU_MIN[iv], start=s, end=e) if iv in _KU_MIN else \
                _frame(base, rule="1W", start=s, end=e)
            df = df[(df.index >= s) & (df.index <= e)].iloc[-1500:].iloc[::-1]          # newest first
            secs = (df.index - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1)
            rows = [[str(int(t)), f"{o:.8f}", f"{c:.8f}", f"{h:.8f}", f"{l:.8f}", f"{v:.4f}", "0"]
                    for t, o, h, l, c, v in zip(secs, df["open"], df["high"], df["low"], df["close"], df["volume"])]
            return Resp(200, {"code": "200000", "data": rows})
        if "coinbase" in host:
            prod = url.split("/products/")[1].split("/")[0]
            base = prod.split("-")[0]
            if base not in KNOWN:
                return Resp(404, {"message": "NotFound"})
            g = int(params["granularity"])
            s = pd.Timestamp(params["start"]).tz_convert("UTC") if pd.Timestamp(params["start"]).tz else \
                pd.Timestamp(params["start"], tz="UTC")
            e = pd.Timestamp(params["end"]).tz_convert("UTC") if pd.Timestamp(params["end"]).tz else \
                pd.Timestamp(params["end"], tz="UTC")
            df = _frame(base, minutes=g // 60, start=s, end=e)
            df = df[(df.index >= s) & (df.index <= e)].iloc[:300].iloc[::-1]
            secs = (df.index - pd.Timestamp("1970-01-01", tz="UTC")) // pd.Timedelta(seconds=1)
            rows = [[int(t), l, h, o, c, v] for t, o, h, l, c, v in
                    zip(secs, df["open"], df["high"], df["low"], df["close"], df["volume"])]
            return Resp(200, rows)
        return Resp(404, {"msg": "unknown endpoint"})

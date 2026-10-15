"""Fake yfinance: Ticker(t).history(...) with Yahoo's column names and time zones, from synth data."""
import pandas as pd
import synth

_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "60m": 60, "1d": 1440}
_PERIOD = {"7d": 7, "60d": 60, "730d": 730}


class Ticker:
    def __init__(self, t):
        self.t = t

    def history(self, period=None, interval="1d", start=None, end=None, auto_adjust=True, prepost=False, **kw):
        if self.t.startswith("NOPE"):
            return pd.DataFrame()
        now = pd.Timestamp.now(tz="UTC")
        if period:
            s, e = now - pd.Timedelta(days=_PERIOD[period]), now
        else:
            s, e = pd.Timestamp(start, tz="UTC"), pd.Timestamp(end, tz="UTC")
        name = self.t.replace("-USD", "")
        if interval in _MIN:
            df = synth.window(name, s, e, _MIN[interval])
        else:
            df = synth.calendar(name, s, e, {"1wk": "1W", "1mo": "1M"}[interval])
        df = df.rename(columns=str.title)
        tz = "UTC" if "-USD" in self.t else "America/New_York"
        idx = df.index.tz_convert(tz)
        if interval in ("1d", "1wk", "1mo"):
            idx = idx.tz_localize(None).normalize().tz_localize(tz)
        df.index = idx
        df["Dividends"] = 0.0
        df["Stock Splits"] = 0.0
        return df

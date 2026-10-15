"""Fake dukascopy_python with the real API surface (fetch, INTERVAL_*, OFFER_SIDE_*), serving synthetic data."""
import pandas as pd
import synth
from . import instruments  # noqa: F401  (real instrument names)

INTERVAL_MONTH_1 = "1MONTH"
INTERVAL_WEEK_1 = "1WEEK"
INTERVAL_DAY_1 = "1DAY"
INTERVAL_HOUR_4 = "4HOUR"
INTERVAL_HOUR_1 = "1HOUR"
INTERVAL_MIN_30 = "30MIN"
INTERVAL_MIN_15 = "15MIN"
INTERVAL_MIN_10 = "10MIN"
INTERVAL_MIN_5 = "5MIN"
INTERVAL_MIN_1 = "1MIN"
OFFER_SIDE_BID = "B"
OFFER_SIDE_ASK = "A"
_MIN = {"1MIN": 1, "5MIN": 5, "10MIN": 10, "15MIN": 15, "30MIN": 30, "1HOUR": 60, "4HOUR": 240, "1DAY": 1440}
CALLS = []


def fetch(instrument, interval, offer_side, start, end, max_retries=7, limit=30_000, debug=False):
    CALLS.append((instrument, interval, start, end))
    if interval not in _MIN:
        raise NotImplementedError(interval)
    if "UST/USD" in instrument:                      # a dead market: no data
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"],
                            index=pd.DatetimeIndex([], tz="UTC", name="timestamp"))
    df = synth.window(instrument, start, end, _MIN[interval]).copy()
    df.index.name = "timestamp"
    return df

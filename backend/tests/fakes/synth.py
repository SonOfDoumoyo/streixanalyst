"""Deterministic synthetic markets for offline tests: one 15-minute path per instrument (2018 → now), with
volatility regimes, slowly wandering drift (trends), intraday seasonality and FX weekend closures.
5m / 1m candles are bridged inside the 15m candles; bigger candles are aggregated, so timeframes agree."""
import zlib
import numpy as np
import pandas as pd

START = pd.Timestamp("2018-01-01", tz="UTC")
CRYPTO = {"BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "LTC", "BCH", "XLM", "LNK", "LINK", "MAT", "UNI", "TRX",
          "AVE", "PEPE", "AVAX"}
TARGET = {"EUR/USD": 1.0843, "GBP/USD": 1.3232, "USD/JPY": 151.28, "XAU/USD": 4190.1, "BTC/USD": 98250.0,
          "ETH/USD": 3533.7, "E_NQ-100": 21884.0, "E_SANDP_500": 6212.0, "SOL": 187.3, "PEPE": 0.00001123}
_C = {}
NOISE_ONLY = {"on": False}       # True → pure random walk (no drift regimes): for null tests


def is_crypto(name):
    up = name.upper()
    return any(up.startswith(c + "/") or up.startswith(c + "-") or up.startswith(c + "USD") or up == c
               for c in CRYPTO)


def _profile(name):
    up = name.upper()
    if is_crypto(name):
        return 0.65, True
    if "XAU" in up or "XAG" in up:
        return 0.16, False
    if up.startswith("E_") or "IDX" in up:
        return 0.19, False
    if "LIGHT" in up or "BRENT" in up or "GAS" in up:
        return 0.35, False
    return 0.085, False


def base15(name):
    key = (name, NOISE_ONLY["on"])
    if key in _C:
        return _C[key]
    rng = np.random.default_rng(zlib.crc32(name.encode()) + (7 if NOISE_ONLY["on"] else 0))
    end = pd.Timestamp.now(tz="UTC").floor("15min")
    idx = pd.date_range(START, end, freq="15min")
    vol, crypto = _profile(name)
    if not crypto:
        dow, hr = idx.dayofweek, idx.hour
        weekend = ((dow == 4) & (hr >= 22)) | (dow == 5) | ((dow == 6) & (hr < 22))
        idx = idx[~weekend]
    n = len(idx)
    hr = idx.hour.to_numpy()
    season = np.where(hr < 7, 0.65, np.where(hr < 12, 1.15, np.where(hr < 17, 1.35, 0.85)))
    if crypto:
        season = 0.6 + 0.4 * season
    bars_year = 35040 if crypto else 25000
    sd = vol / np.sqrt(bars_year)
    lv = np.zeros(n)
    e = rng.normal(0, 0.03, n)
    for i in range(1, n):                       # slow volatility regimes
        lv[i] = 0.9985 * lv[i - 1] + e[i]
    v = np.exp(np.clip(lv, -1.2, 1.2))
    drift = np.zeros(n)
    if not NOISE_ONLY["on"]:
        d = rng.normal(0, sd * 0.004, n)
        for i in range(1, n):                   # slowly wandering drift = trends
            drift[i] = 0.9993 * drift[i - 1] + d[i]
    K = 16                                        # intrabar sub-steps: wicks are part of the real path
    sub = rng.standard_t(5, (n, K)) / np.sqrt(5 / 3) / np.sqrt(K)
    r_sub = drift[:, None] / K + (sd * season * v)[:, None] * sub
    lp = np.cumsum(r_sub.ravel()).reshape(n, K)
    tgt = next((p for k, p in TARGET.items() if k.upper() in name.upper()), None)
    if tgt is None:
        tgt = 50.0 + (zlib.crc32(name.encode()) % 1000)
    lp = lp - lp[-1, -1] + np.log(tgt)
    close = np.exp(lp[:, -1])
    open_ = np.r_[np.exp(lp[0, 0] - r_sub[0, 0]), close[:-1]]
    if not crypto:                               # small weekend gaps (the path continues from the gap)
        gapm = np.r_[False, np.diff(idx.asi8) > np.median(np.diff(idx.asi8)) * 4]
        jump = np.where(gapm, rng.normal(0, sd * 3, n), 0.0)
        cj = np.cumsum(jump)
        lp = lp + cj[:, None]
        close = np.exp(lp[:, -1])
        open_ = np.r_[np.exp(lp[0, 0] - r_sub[0, 0]), close[:-1]] * np.exp(jump)
    pth = np.exp(lp)
    high = np.maximum(np.maximum(open_, close), pth.max(1))
    low = np.minimum(np.minimum(open_, close), pth.min(1))
    volume = np.round(rng.gamma(2.0, 500.0, n) * season * v, 2)
    df = pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": volume}, index=idx)
    _C[key] = df
    return df


def window(name, start, end, minutes):
    """Candles of `minutes` (1, 5, 15, 30, 60, 240, 1440, ...) between start and end."""
    b = base15(name)
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    start = start.tz_convert("UTC") if start.tz is not None else start.tz_localize("UTC")
    end = end.tz_convert("UTC") if end.tz is not None else end.tz_localize("UTC")
    if minutes >= 15:
        sl = b[(b.index >= start.floor("1D") - pd.Timedelta(days=40)) & (b.index <= end)]
        if minutes == 15:
            out = sl
        else:
            key = sl.index.floor(f"{minutes}min")
            g = sl.groupby(key)
            out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                                "close": g["close"].last(), "volume": g["volume"].sum()})
        return out[(out.index >= start.floor(f"{min(minutes, 1440)}min")) & (out.index <= end)]
    sl = b[(b.index >= start.floor("15min")) & (b.index <= end)]
    k = 15 // minutes
    n = len(sl)
    if n == 0:
        return sl
    rng = np.random.default_rng(int(sl.index[0].timestamp()) % 2**31 + minutes)
    o, h, l, c = (sl[x].to_numpy() for x in ("open", "high", "low", "close"))
    steps = rng.normal(0, 1, (n, k))
    walk = np.cumsum(steps, axis=1)
    walk = walk - walk[:, -1:] * (np.arange(1, k + 1) / k)          # bridge: ends at 0
    span = (h - l)[:, None] * 0.25
    path = o[:, None] + (c - o)[:, None] * (np.arange(1, k + 1) / k) + walk / max(k ** 0.5, 1) * span
    path = np.clip(path, l[:, None], h[:, None])
    path[:, -1] = c
    so = np.c_[o, path[:, :-1]]
    sc = path
    sh = np.maximum(so, sc)
    slw = np.minimum(so, sc)
    hi_pos, lo_pos = rng.integers(0, k, n), rng.integers(0, k, n)
    sh[np.arange(n), hi_pos] = h
    slw[np.arange(n), lo_pos] = l
    sh = np.maximum(sh, np.maximum(so, sc))
    slw = np.minimum(slw, np.minimum(so, sc))
    t = (sl.index.tz_localize(None).to_numpy().astype("datetime64[ns]")[:, None] + (np.arange(k) * minutes * 60_000_000_000).astype("timedelta64[ns]")).ravel()
    out = pd.DataFrame({"open": so.ravel(), "high": sh.ravel(), "low": slw.ravel(), "close": sc.ravel(),
                        "volume": np.repeat(sl["volume"].to_numpy() / k, k)}, index=pd.DatetimeIndex(t, tz="UTC"))
    return out[(out.index >= start) & (out.index <= end)]


def calendar(name, start, end, rule):
    """3D / 1W / 1M candles (exchange style) from daily."""
    d = window(name, start - pd.Timedelta(days=40), end, 1440)
    idx = d.index
    if rule == "3D":
        key = idx.floor("3D")
    elif rule == "1W":
        key = idx - pd.to_timedelta(idx.dayofweek, unit="D")
    else:
        key = idx - pd.to_timedelta(idx.day - 1, unit="D")
    g = d.groupby(key)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    return out[(out.index >= start - pd.Timedelta(days=31)) & (out.index <= end)]

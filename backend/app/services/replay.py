"""Replays: how a call made at a past moment played out.

A call is judged by the same rules as the verified track record (services/tracker.py): fills, stops, targets, the time
limit and trading costs. Only candles that open after the moment are used, on a finer timeframe when the data allows
it, so the outcome is the market's real answer to the call, not a repaint."""
import pandas as pd

import guru_model as gm
import market_data as md

from . import tracker

FINAL = ("tp", "sl", "time", "missed", "expired", "void")   # settled: nothing about these can change any more


def score(symbol, tf, at, side, entry, sl, tp, kind="limit", now=None):
    """Play out one call made at `at`. Returns None when there is no call. Otherwise a dict with the levels judged,
    status (tp, sl, time, missed, expired, void, open, pending or unknown), `final`, r (multiples of the planned risk,
    after costs) and the fill and exit times (pandas Timestamps, or None)."""
    if side not in ("long", "short"):
        return None
    now = now or md.utcnow()
    tf = md.norm_tf(tf)
    lv = dict(side=side, entry=float(entry), sl=float(sl), tp=float(tp), kind=kind)
    end = min(at + pd.Timedelta(minutes=(tracker.EXPIRY + tracker.MAX_HOLD) * md.TF_MIN[tf]), now)
    try:
        C = md.get_candles(symbol, tracker.fine_tf(tf), bars=None, start=at, end=end, min_bars=1, refresh_s=3600)
    except md.DataError as e:
        return dict(lv, status="unknown", final=False, r=None, reason=str(e)[:160], filled_at=None, exited_at=None)
    cost, slip = gm.cost_of(C["sub"])
    t0 = int(at.timestamp())
    arr = tracker._arrays(dict(df=C["df"], forming=None), t0)
    res = tracker.resolve(*arr, t0=t0, tf_sec=tracker.tf_seconds(tf), side=side, kind=kind, entry=float(entry),
                          sl=float(sl), tp=float(tp), cost_frac=cost, slip_frac=slip, now_ts=int(now.timestamp()))
    st = res["status"]
    return dict(lv, status=st, final=st in FINAL,
                r=None if res.get("r") is None else round(float(res["r"]), 3),
                fill=res.get("fill"), exit=res.get("exit"),
                filled_at=None if res.get("fill_t") is None else pd.Timestamp(res["fill_t"], unit="s", tz="UTC"),
                exited_at=None if res.get("exit_t") is None else pd.Timestamp(res["exit_t"], unit="s", tz="UTC"))

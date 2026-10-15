"""Verified track record: every trade plan the analyst gives is checked against the market afterwards.

How a call is judged (the same rules the model was trained with, so the record and the probabilities agree):
- Only candles that OPEN AFTER the moment of the call are used, on a finer timeframe when the data allows it
  (a 1h call is followed on 5m candles), so nothing that happened before the call can count.
- Market orders fill at the call. Limit and stop orders stay valid for EXPIRY candles of the call's timeframe; a
  limit order is cancelled ("missed") if the target trades before it fills. A stop order that gaps past its trigger
  fills at the worse open price.
- After the fill the stop wins whenever stop and target share a candle, only the stop can trigger on the fill
  candle, a gap through the stop fills at the open, and the trade is closed at market after MAX_HOLD candles.
- Trading costs and stop slippage for the asset class are taken off every result (R = multiples of planned risk).
- Results are written once and never edited. Identical calls (same market, timeframe and side, entry within a
  quarter of the risk, inside the order's lifetime) count once: later copies point at the first one (dup_of)."""
import logging
import math
from collections import defaultdict
from datetime import timedelta

import numpy as np
import pandas as pd
from sqlalchemy import select

import guru_model as gm
import market_data as md

from ..db import SessionLocal
from ..models import AnalysisLog, jload, utcnow

log = logging.getLogger("streix.tracker")
EXPIRY = gm.EXPIRY
MAX_HOLD = gm.H_RACE
FINE = ["1m", "5m", "15m", "1h", "4h", "1D"]
MAX_FINE_BARS = 4000
OPEN_STATES = ("pending", "open")
FINAL_WIN, FINAL_LOSS = "tp", "sl"
RESOLVED = ("tp", "sl", "time")
METHOD = __doc__.split("\n\n", 1)[1]


def fine_tf(tf):
    """The finest timeframe that follows a call's whole life in at most MAX_FINE_BARS candles."""
    life = (EXPIRY + MAX_HOLD) * md.TF_MIN[tf]
    for f in FINE:
        if md.TF_MIN[f] <= md.TF_MIN[tf] and life / md.TF_MIN[f] <= MAX_FINE_BARS:
            return f
    return tf


def tf_seconds(tf):
    return int(md.TF_MIN[tf] * 60)


def resolve(t, o, h, l, c, t0, tf_sec, side, kind, entry, sl, tp, cost_frac, slip_frac, now_ts,
            expiry=EXPIRY, max_hold=MAX_HOLD):
    """Judge one plan on candles (open times `t`, epoch s, all opening at/after the call time t0).
    Returns dict(status=pending|open|tp|sl|time|expired|missed|void, fill_t, fill, exit_t, exit, r)."""
    d = 1 if side == "long" else -1
    risk = abs(entry - sl)
    if not (risk > 0 and d * (entry - sl) > 0 and d * (tp - entry) > 0):
        return dict(status="void", reason="inconsistent levels")
    n = len(t)
    exp_end = t0 + expiry * tf_sec
    if kind == "market":
        fi, fill_t, fill = -1, t0, float(entry)
    else:
        fi = None
        for j in range(n):
            if t[j] >= exp_end:
                return dict(status="expired")
            if kind == "stop":
                hit = (h[j] >= entry) if d == 1 else (l[j] <= entry)
                gapped = (o[j] > entry) if d == 1 else (o[j] < entry)
                px = o[j] if gapped else entry
            else:
                hit = (l[j] <= entry) if d == 1 else (h[j] >= entry)
                px = entry
            if hit:
                fi, fill_t, fill = j, int(t[j]), float(px)
                break
            if kind == "limit" and ((h[j] >= tp) if d == 1 else (l[j] <= tp)):
                return dict(status="missed", exit_t=int(t[j]))
        if fi is None:
            return dict(status="expired" if now_ts >= exp_end else "pending")
    cost = cost_frac * fill
    hold_end = fill_t + max_hold * tf_sec
    for k in range(max(fi, 0), n):
        if t[k] >= hold_end:
            px = float(o[k])
            return dict(status="time", fill_t=fill_t, fill=fill, exit_t=int(t[k]), exit=px,
                        r=float(d * (px - fill) / risk - cost / risk))
        if (l[k] <= sl) if d == 1 else (h[k] >= sl):
            gap = k > fi and ((o[k] < sl) if d == 1 else (o[k] > sl))
            px = float(o[k]) if gap else float(sl)
            return dict(status="sl", fill_t=fill_t, fill=fill, exit_t=int(t[k]), exit=px,
                        r=float(d * (px - fill) / risk - (cost + slip_frac * fill) / risk))
        if k > fi and ((h[k] >= tp) if d == 1 else (l[k] <= tp)):
            return dict(status="tp", fill_t=fill_t, fill=fill, exit_t=int(t[k]), exit=float(tp),
                        r=float(d * (tp - fill) / risk - cost / risk))
    if now_ts >= hold_end and n and t[-1] < hold_end:
        # data ended before the holding time did (closed market, delisted): close at the last known price
        px = float(c[-1])
        return dict(status="time", fill_t=fill_t, fill=fill, exit_t=int(t[-1]), exit=px,
                    r=float(d * (px - fill) / risk - cost / risk))
    return dict(status="open", fill_t=fill_t, fill=fill)


def _ts(dt):
    return int(pd.Timestamp(dt, tz="UTC").timestamp())


def _arrays(C, t0):
    df = C["df"]
    if C.get("forming") is not None:
        f = C["forming"]
        df = pd.concat([df, f.to_frame().T.astype(float)])
    times = md.epoch_s(df.index)
    keep = times >= t0
    return (times[keep], *(df[k].to_numpy(dtype=float)[keep] for k in ("open", "high", "low", "close")))


def _plan_meta(row):
    s = jload(row.summary, {}) or {}
    pl = s.get("plan") or {}
    v = s.get("verdict") or {}
    return dict(kind=pl.get("type") or "limit", called=bool(v.get("trade")), display=s.get("symbol") or row.symbol)


def _dedupe(db, row, meta):
    """Mark `row` as a copy of an earlier identical call (returns the original's id) or None."""
    if row.tf not in md.TF_MIN:
        return None
    window = timedelta(seconds=EXPIRY * tf_seconds(row.tf))
    risk = abs(row.entry - row.sl)
    cands = db.execute(select(AnalysisLog).where(
        AnalysisLog.kind == "analysis", AnalysisLog.id < row.id, AnalysisLog.tf == row.tf, AnalysisLog.side == row.side,
        AnalysisLog.created_at >= row.created_at - window, AnalysisLog.dup_of.is_(None),
        AnalysisLog.entry.is_not(None)).order_by(AnalysisLog.id.desc()).limit(50)).scalars().all()
    for o in cands:
        if o.outcome in ("void", "dup") or o.called != meta["called"]:
            continue
        if _plan_meta(o)["display"] != meta["display"]:
            continue
        if abs(o.entry - row.entry) <= 0.25 * risk:
            return o.id
    return None


def _apply(row, res, now):
    st = res["status"]
    row.checked_at = now
    if res.get("fill_t") is not None and row.filled_at is None:
        row.filled_at = pd.Timestamp(res["fill_t"], unit="s").to_pydatetime()
    if st in ("pending", "open"):
        row.outcome = st
        return False
    row.outcome = st
    row.outcome_at = pd.Timestamp(res["exit_t"], unit="s").to_pydatetime() if res.get("exit_t") else now
    row.exit_price = res.get("exit")
    row.outcome_r = None if res.get("r") is None else round(float(res["r"]), 4)
    return True


def run_once(limit=400, fetch=None):
    """Advance every open call. Returns counts. `fetch(symbol, tf, start)` is injectable for tests."""
    fetch = fetch or (lambda sym, tf, start: md.get_candles(sym, tf, bars=None, start=start, min_bars=1))
    db = SessionLocal()
    counts = defaultdict(int)
    try:
        now = utcnow()
        now_ts = _ts(now)
        rows = db.execute(select(AnalysisLog).where(
            AnalysisLog.kind == "analysis", AnalysisLog.side.is_not(None), AnalysisLog.entry.is_not(None),
            AnalysisLog.sl.is_not(None), AnalysisLog.tp.is_not(None),
            (AnalysisLog.outcome.is_(None)) | (AnalysisLog.outcome.in_(OPEN_STATES)),
            AnalysisLog.created_at >= now - timedelta(days=400)).order_by(AnalysisLog.id).limit(limit)).scalars().all()
        groups = defaultdict(list)
        for row in rows:
            if row.tf not in md.TF_MIN:
                row.outcome, row.checked_at = "void", now
                counts["void"] += 1
                continue
            meta = _plan_meta(row)
            if row.outcome is None:
                row.plan_type, row.called = meta["kind"], meta["called"]
                orig = _dedupe(db, row, meta)
                if orig:
                    row.dup_of, row.outcome, row.checked_at = orig, "dup", now
                    counts["dup"] += 1
                    db.flush()
                    continue
                db.flush()
            ftf = fine_tf(row.tf)
            every = min(1800, max(60, tf_seconds(ftf)))
            if row.checked_at and (now - row.checked_at).total_seconds() < every and row.outcome is not None:
                continue
            groups[(row.symbol, ftf)].append(row)
        for (sym, ftf), rs in groups.items():
            t_first = min(_ts(r.created_at) for r in rs)
            start = max(t_first - tf_seconds(ftf), now_ts - (MAX_FINE_BARS + 200) * tf_seconds(ftf))
            try:
                C = fetch(sym, ftf, pd.Timestamp(start, unit="s", tz="UTC"))
            except Exception as e:
                log.info("tracker: no data for %s %s: %s", sym, ftf, str(e)[:120])
                for r in rs:
                    life = (EXPIRY + MAX_HOLD) * tf_seconds(r.tf)
                    if now_ts - _ts(r.created_at) > life + 7 * 86400:
                        r.outcome, r.checked_at = "void", now
                        counts["void"] += 1
                continue
            cost_frac, slip_frac = gm.cost_of(C.get("sub"))
            for r in rs:
                t0 = _ts(r.created_at)
                arr = _arrays(C, t0)
                if arr[0].size and arr[0][0] - t0 > (EXPIRY + MAX_HOLD) * tf_seconds(r.tf):
                    r.outcome, r.checked_at = "void", now          # the data doesn't reach back to the call
                    counts["void"] += 1
                    continue
                res = resolve(*arr, t0=t0, tf_sec=tf_seconds(r.tf), side=r.side, kind=r.plan_type or "limit",
                              entry=float(r.entry), sl=float(r.sl), tp=float(r.tp), cost_frac=cost_frac,
                              slip_frac=slip_frac, now_ts=now_ts)
                if _apply(r, res, now):
                    counts["resolved"] += 1
                counts[res["status"]] += 1
        db.commit()
    except Exception:
        db.rollback()
        log.exception("tracker run failed")
    finally:
        db.close()
    return dict(counts)


# ───────────────────────────── statistics ─────────────────────────────
def _agg(rows):
    rs = np.array([r.outcome_r for r in rows if r.outcome in RESOLVED and r.outcome_r is not None], dtype=float)
    n = len(rs)
    out = dict(resolved=n, wins=int((rs > 0).sum()) if n else 0)
    if not n:
        return dict(out, win_rate=None, avg_r=None, total_r=0.0, t_stat=None)
    sd = float(rs.std(ddof=1)) if n > 1 else 0.0
    return dict(out, win_rate=float((rs > 0).mean()), avg_r=float(rs.mean()), total_r=float(rs.sum()),
                t_stat=float(rs.mean() / sd * math.sqrt(n)) if sd > 0 else None)


def verdict_of(a):
    n = a["resolved"]
    if n < 30:
        return "not enough resolved calls to judge yet (need 30+)"
    if a["t_stat"] and a["t_stat"] >= 2 and a["avg_r"] > 0:
        return "positive and statistically meaningful"
    if a["avg_r"] > 0:
        return "positive, but it could still be luck"
    return "negative after costs"


def summarize(rows):
    """Stats for a list of AnalysisLog rows (duplicates already excluded by the caller)."""
    allr = _agg(rows)
    status = defaultdict(int)
    for r in rows:
        status[r.outcome or "new"] += 1
    orders = [r for r in rows if r.plan_type in ("limit", "stop") and r.outcome not in (None, "pending", "void")]
    filled = [r for r in orders if r.outcome in ("open",) + RESOLVED]
    by_grade = []
    for g in ("A+", "A", "B", "C", "D"):
        sub = [r for r in rows if r.grade == g]
        if sub:
            by_grade.append(dict(grade=g, calls=len(sub), **_agg(sub)))
    by_tf = []
    for tf in md.TFS:
        sub = [r for r in rows if r.tf == tf]
        if sub:
            by_tf.append(dict(tf=tf, calls=len(sub), **_agg(sub)))
    by_side = {s: dict(calls=len(sub), **_agg(sub)) for s in ("long", "short") for sub in [[r for r in rows if r.side == s]] if sub}
    closed = sorted([r for r in rows if r.outcome in RESOLVED and r.outcome_r is not None], key=lambda r: r.outcome_at or r.created_at)
    eq, cum = [], 0.0
    for r in closed:
        cum += r.outcome_r
        eq.append([_ts(r.outcome_at or r.created_at), round(cum, 3)])
    return dict(summary=dict(calls=len(rows), **allr, verdict=verdict_of(allr), status=dict(status),
                             fill_rate=(len(filled) / len(orders)) if orders else None,
                             exits={k: status.get(k, 0) for k in RESOLVED}),
                by_grade=by_grade, by_tf=by_tf, by_side=by_side, equity=eq[-2000:])

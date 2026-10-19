"""How a call travelled, beyond its result: the worst and best it went while open, and what price did after a stop.

The stop-sweep question is the one traders ask about the big players: price runs the stops sitting just past a level,
then turns and goes the way the trade said. A stopped call is watched for the rest of its holding time. If price then
reaches the target, the stop was swept. How far price went past the stop before turning (sweep_depth_r) says how much
room a stop would have needed to survive it.

Plain numpy on candle arrays (open times in epoch seconds), so it is tested without a database. All distances are in
multiples of the planned risk (|entry - stop|)."""
import numpy as np


def excursions(t, h, l, side, fill_t, fill, exit_t, risk):
    """(mae_r, mfe_r) from the fill candle to the exit candle, both included. mae_r is how far price went against the
    position (positive number), mfe_r how far for it. None when there is no fill or no risk."""
    if fill_t is None or not risk or risk <= 0 or len(t) == 0:
        return None, None
    t = np.asarray(t)
    end = exit_t if exit_t is not None else t[-1]
    m = (t >= _start(t, fill_t)) & (t <= end)
    if not m.any():
        return None, None
    hi = float(np.max(np.asarray(h)[m]))
    lo = float(np.min(np.asarray(l)[m]))
    if side == "long":
        return round(max(0.0, fill - lo) / risk, 3), round(max(0.0, hi - fill) / risk, 3)
    return round(max(0.0, hi - fill) / risk, 3), round(max(0.0, fill - lo) / risk, 3)


def _start(t, fill_t):
    """The open time of the candle that holds the fill."""
    before = t[t <= fill_t]
    return before[-1] if len(before) else t[0]


def after_stop(t, h, l, side, sl, tp, stop_t, hold_end, risk, now_ts):
    """What price did after the stop was hit, until the call's holding time ran out.

    Returns dict(swept, depth_r, final): swept is True when price reached the target after the stop candle (False when
    the holding time ended without it, None while still being watched); depth_r is how far price went past the stop,
    counting the stop candle itself, before reaching the target (or in the whole window when it never did)."""
    if not risk or risk <= 0:
        return dict(swept=None, depth_r=None, final=True)
    t = np.asarray(t)
    h = np.asarray(h, dtype=float)
    l = np.asarray(l, dtype=float)

    def past(k):                      # how far candle k went beyond the stop
        return (sl - l[k]) if side == "long" else (h[k] - sl)

    worst = 0.0
    for k in np.nonzero(t == stop_t)[0]:
        worst = max(worst, past(k))
    for k in np.nonzero((t > stop_t) & (t < hold_end))[0]:
        worst = max(worst, past(k))
        if (h[k] >= tp) if side == "long" else (l[k] <= tp):
            return dict(swept=True, depth_r=round(float(max(0.0, worst)) / risk, 3), final=True)
    final = bool(now_ts >= hold_end)
    return dict(swept=False if final else None, depth_r=round(float(max(0.0, worst)) / risk, 3), final=final)

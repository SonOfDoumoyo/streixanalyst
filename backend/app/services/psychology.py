"""How a person's own calls go, read from their replays: the feeling they named when they made a call, chasing the
entry, and calling again straight after a losing one.

Used for three things: the coach that follows a replay's reveal, the "Your tendencies" notes on the analysis, and the
decisions export that feeds the model. Every feature only looks at decisions made before it, so nothing here (or in the
export) can see the future.
"""
from datetime import datetime

from sqlalchemy import select

from ..models import AnalysisLog, jload

EMOTIONS = {"calm": "Calm", "confident": "Confident", "fomo": "FOMO", "fear": "Fear", "revenge": "Revenge",
            "bored": "Bored", "unsure": "Unsure"}
CHASE_R = 0.25        # the fill was this many R worse than the analyst's entry: chasing
QUICK_MIN = 30        # a new call this many minutes after a losing one is a quick re-entry
MIN_TIPS = 5          # settled calls needed before the notes about tendencies say anything
MIN_GROUP = 3         # calls needed in one group (one feeling, or quick re-entries) before comparing it
SETTLED = ("tp", "sl", "time")


def replays_of(db, user_id, limit=None):
    """A person's replay rows in the order they were made (the newest `limit` when a limit is given)."""
    q = select(AnalysisLog).where(AnalysisLog.user_id == user_id, AnalysisLog.kind == "replay")
    if limit:
        rows = db.execute(q.order_by(AnalysisLog.id.desc()).limit(limit)).scalars().all()
        return list(reversed(rows))
    return db.execute(q.order_by(AnalysisLog.id)).scalars().all()


def _minutes(a, b):
    if not a or not b:
        return None
    try:
        da = datetime.fromisoformat(a.replace("Z", "+00:00"))
        db = datetime.fromisoformat(b.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (db - da).total_seconds() / 60


def slip_r(side, entry, analyst_entry, analyst_sl):
    """How much worse the person's fill is than the analyst's entry, in units of the analyst's risk. Positive is worse."""
    if not (side and entry and analyst_entry and analyst_sl):
        return None
    risk = abs(analyst_entry - analyst_sl)
    if risk <= 0:
        return None
    worse = (entry - analyst_entry) if side == "long" else (analyst_entry - entry)
    return round(worse / risk, 3)


def decision_rows(rows):
    """The decisions in one person's replays, in the order they were made. `rows` are replay AnalysisLog rows."""
    out = []
    for r in rows:
        s = jload(r.summary, {}) or {}
        d = s.get("decision")
        if not d:
            continue
        res = s.get("result") or {}
        u = res.get("user") or {}
        final = bool(res.get("final"))
        status = u.get("status") if final else None
        rr = u.get("r") if final else None
        settled = status in SETTLED and isinstance(rr, (int, float))
        out.append(dict(
            id=r.id, moment=r.created_at.replace(microsecond=0).isoformat() + "Z" if r.created_at else None,
            symbol=r.symbol, tf=r.tf, decided_at=d.get("decided_at"), emotion=d.get("emotion"), note=d.get("note"),
            side=d.get("side"), entry=d.get("entry"), sl=d.get("sl"), tp=d.get("tp"),
            analyst_side=r.side, analyst_entry=r.entry, analyst_sl=r.sl, analyst_tp=r.tp, grade=r.grade,
            analyst_outcome=r.outcome, analyst_r=r.outcome_r,
            status=status, r=rr if settled else None, settled=settled,
        ))
    out.sort(key=lambda x: x["decided_at"] or "")
    return out


def features(decisions):
    """Adds what was true before each call was made: how far the fill was chased, the losing streak going in, and
    whether the call came straight after a loss. The call's own outcome only counts for the calls after it."""
    streak = 0
    prev = None
    for d in decisions:
        d["slip_r"] = slip_r(d["side"], d["entry"], d["analyst_entry"], d["analyst_sl"])
        d["chased"] = None if d["slip_r"] is None else d["slip_r"] >= CHASE_R
        d["streak_before"] = streak
        prev_loss = bool(prev and prev["settled"] and prev["r"] < 0)
        mins = _minutes(prev["decided_at"], d["decided_at"]) if prev else None
        d["quick_after_loss"] = bool(prev_loss and mins is not None and mins <= QUICK_MIN)
        if d["settled"]:
            streak = streak + 1 if d["r"] < 0 else 0
        prev = d
    return decisions


def _rate(items):
    if not items:
        return None
    return sum(1 for x in items if x["r"] > 0) / len(items)


def tips(decisions):
    """Plain-language notes from a person's history. Empty until there are enough settled calls to say something."""
    settled = [d for d in decisions if d["settled"]]
    if len(settled) < MIN_TIPS:
        return []
    out = []
    entries = [d for d in decisions if d["chased"] is not None]
    chased = sum(1 for d in entries if d["chased"])
    if len(entries) >= MIN_TIPS and chased / len(entries) >= 0.4:
        out.append(f"You chased the entry in {chased} of {len(entries)} calls, filling {CHASE_R}R or more past the "
                   "analyst's entry. A limit order at the level, or an alert there, is the cleaner call.")
    quick = [d for d in settled if d["quick_after_loss"]]
    rest = [d for d in settled if not d["quick_after_loss"]]
    if len(quick) >= MIN_GROUP and rest:
        qw, rw = _rate(quick), _rate(rest)
        if qw + 0.15 <= rw:
            out.append(f"Calls made straight after a loss won {round(qw * 100)}% of the time ({len(quick)} calls), "
                       f"against {round(rw * 100)}% otherwise. After a stop-out, wait for the next setup.")
    groups = {}
    for d in settled:
        if d["emotion"] in EMOTIONS:
            groups.setdefault(d["emotion"], []).append(d)
    ranked = sorted(((_rate(v), k, len(v)) for k, v in groups.items() if len(v) >= MIN_GROUP))
    if len(ranked) >= 2 and ranked[-1][0] - ranked[0][0] >= 0.2:
        (lo, worst, nlo), (hi, best, nhi) = ranked[0], ranked[-1]
        out.append(f"Your {EMOTIONS[worst]} calls won {round(lo * 100)}% of {nlo}; your {EMOTIONS[best]} calls won "
                   f"{round(hi * 100)}% of {nhi}. When you notice {EMOTIONS[worst].lower()}, slow down before you enter.")
    return out[:3]


def coach(current, prior):
    """What to say about the call just made, from its own features and the calls before it."""
    if current is None:
        return []
    out = []
    if current["chased"]:
        out.append(f"Your fill is {current['slip_r']}R past the analyst's entry. Chasing usually costs the edge: a limit "
                   "order at the analyst's level is the cleaner version of this call.")
    if current["quick_after_loss"]:
        out.append("You are calling again straight after a loss. Check whether this is a fresh setup or a reaction to "
                   "the last one.")
    emo = current.get("emotion")
    if emo in EMOTIONS:
        same = [d for d in prior if d["settled"] and d["emotion"] == emo]
        if len(same) >= MIN_GROUP:
            out.append(f"Your {EMOTIONS[emo]} calls have won {round(_rate(same) * 100)}% of {len(same)} so far.")
    out.extend(tips(prior)[:2])
    return out[:4]

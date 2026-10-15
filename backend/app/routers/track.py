"""The analyst's verified track record (public) and each user's own calls."""
from datetime import timedelta
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import optional_user
from ..models import AnalysisLog, iso, utcnow
from ..services import tracker

router = APIRouter(prefix="/track-record", tags=["track record"])
FIELDS = ("id", "user_id", "symbol", "tf", "side", "grade", "entry", "sl", "tp", "plan_type", "called", "outcome",
          "outcome_r", "outcome_at", "filled_at", "exit_price", "created_at", "dup_of", "checked_at")


def _row(r, override=None):
    d = {k: getattr(r, k) for k in FIELDS}
    if override is not None:
        for k in ("outcome", "outcome_r", "outcome_at", "filled_at", "exit_price"):
            d[k] = getattr(override, k)
    return SimpleNamespace(**d)


def _out(r):
    return dict(id=r.id, symbol=r.symbol, tf=r.tf, side=r.side, grade=r.grade, type=r.plan_type, called=r.called,
                entry=r.entry, sl=r.sl, tp=r.tp, outcome=r.outcome, r=r.outcome_r, created_at=iso(r.created_at),
                filled_at=iso(r.filled_at), outcome_at=iso(r.outcome_at), exit=r.exit_price, dup_of=r.dup_of)


@router.get("")
def track_record(scope: str = Query("all", pattern="^(all|mine)$"), tf: str | None = Query(None, max_length=4),
                 days: int = Query(90, ge=1, le=400), calls: str = Query("called", pattern="^(called|rejected|all)$"),
                 user=Depends(optional_user), db: Session = Depends(get_db)):
    if scope == "mine" and not user:
        raise HTTPException(401, "Sign in to see your own calls.")
    since = utcnow() - timedelta(days=days)
    q = select(AnalysisLog).where(AnalysisLog.kind == "analysis", AnalysisLog.side.is_not(None),
                                  AnalysisLog.entry.is_not(None), AnalysisLog.outcome.is_not(None),
                                  AnalysisLog.outcome != "void", AnalysisLog.created_at >= since)
    if tf:
        q = q.where(AnalysisLog.tf == tf)
    if scope == "mine":
        q = q.where(AnalysisLog.user_id == user.id)
    else:
        q = q.where(AnalysisLog.dup_of.is_(None))
    raw = db.execute(q.order_by(AnalysisLog.id.desc()).limit(20000)).scalars().all()
    origs = {}
    dup_ids = {r.dup_of for r in raw if r.dup_of}
    if dup_ids:
        origs = {o.id: o for o in db.execute(select(AnalysisLog).where(AnalysisLog.id.in_(dup_ids))).scalars()}
    rows = [_row(r, origs.get(r.dup_of)) for r in raw]
    if scope == "mine":
        # your copies of a call share its result; for your stats count each call once
        seen, uniq = set(), []
        for r in rows:
            key = r.dup_of or r.id
            if key not in seen:
                seen.add(key)
                uniq.append(r)
        rows = uniq
    pick = {"called": lambda r: r.called, "rejected": lambda r: r.called is False, "all": lambda r: True}[calls]
    chosen = [r for r in rows if pick(r)]
    stats = tracker.summarize(chosen)
    compare = dict(called=tracker._agg([r for r in rows if r.called]),
                   rejected=tracker._agg([r for r in rows if r.called is False]))
    last_check = db.execute(select(func.max(AnalysisLog.checked_at))).scalar()
    return dict(scope=scope, tf=tf, days=days, calls=calls, **stats, compare=compare,
                recent=[_out(r) for r in sorted(chosen, key=lambda r: r.created_at, reverse=True)[:60]], method=tracker.METHOD, updated_at=iso(last_check),
                rules=dict(expiry=tracker.EXPIRY, max_hold=tracker.MAX_HOLD))

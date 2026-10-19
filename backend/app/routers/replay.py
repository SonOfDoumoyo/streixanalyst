"""Replays: go back to a past moment, analyse it as it was then, make your own call, then see what happened next."""
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import AnalysisLog, User, iso, jdump, jload, utcnow
from ..plans import consume, features_of, refund, require_feature, tier_of
from ..services import engine, psychology
from ..services import replay as rp
from .analysis import _mode

router = APIRouter(prefix="/replay", tags=["replay"])


class AnalyzeIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = Field("1h", max_length=4)
    at: str = Field(min_length=10, max_length=40)            # ISO time; a time with no zone is UTC
    mode: str | None = Field(None, max_length=12)


class RevealIn(BaseModel):
    replay_id: int
    side: str | None = Field(None, pattern="^(long|short)$")
    entry: float | None = Field(None, gt=0)
    sl: float | None = Field(None, gt=0)
    tp: float | None = Field(None, gt=0)
    emotion: str | None = Field(None, max_length=12)      # how the person felt making the call (psychology.EMOTIONS)
    note: str | None = Field(None, max_length=280)


def _naive(ts):
    return None if ts is None else ts.tz_convert(None).to_pydatetime()


def _json(d):
    if d is None:
        return None
    return {k: (v.isoformat() if isinstance(v, pd.Timestamp) else v) for k, v in d.items()}


@router.post("/analyze")
def analyze(body: AnalyzeIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "analysis")
    consume(db, user, "analysis")
    mode = _mode(user, body.mode)
    try:
        res = engine.analyze(body.symbol.strip(), body.tf, mode=mode, at=body.at)
    except engine.EngineError as e:
        refund(db, user, "analysis")
        raise HTTPException(422, str(e))
    except Exception as e:
        refund(db, user, "analysis")
        raise HTTPException(500, f"The replay failed unexpectedly ({type(e).__name__}). Please try again.")
    if "pro_report" not in features_of(tier_of(user)):          # free plan: the report in the user's own mode only
        res["report_pro" if mode == "beginner" else "report_beginner"] = None
    pl, vd = res.get("plan") or {}, res.get("verdict") or {}
    j = min(1, len(pl.get("tps") or [0]) - 1)
    at = engine.parse_moment(body.at)
    # Stored as a call dated to the replay moment, so the verified-learning export can split it by time.
    row = AnalysisLog(kind="replay", user_id=user.id, symbol=body.symbol.strip().upper(), tf=res["tf"],
                      price=float(res.get("price") or 0), action=vd.get("action"), grade=vd.get("grade"),
                      called=bool(vd.get("trade")), plan_type=(pl.get("type") or "limit") if pl else None,
                      side=pl.get("side") if pl else None, entry=pl.get("entry") if pl else None,
                      sl=pl.get("sl") if pl else None,
                      tp=(pl.get("tps") or [None])[j] if pl else None,
                      p_tp=(pl.get("p_tp") or [None])[j] if pl else None,
                      summary=jdump(dict(engine.summarize(res), replay=True, at=res["replay_at"])),
                      created_at=_naive(at))
    db.add(row)
    db.commit()
    res["replay_id"] = row.id
    res["at"] = res["replay_at"]
    res["mode"] = mode
    return res


def _coach(db, user, row, decision):
    """The notes about this call, from its own features and the person's earlier calls (never this call's outcome)."""
    if not decision:
        return []
    hist = psychology.features(psychology.decision_rows(psychology.replays_of(db, user.id)))
    cur = next((d for d in hist if d["id"] == row.id), None)
    prior = [d for d in hist if d["id"] != row.id and d["decided_at"] and d["decided_at"] < decision["decided_at"]]
    return psychology.coach(cur, prior)


@router.post("/reveal")
def reveal(body: RevealIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    row = db.get(AnalysisLog, body.replay_id)
    if not row or row.user_id != user.id or row.kind != "replay":
        raise HTTPException(404, "Replay not found.")
    s = jload(row.summary, {}) or {}
    if body.emotion is not None and body.emotion not in psychology.EMOTIONS:
        raise HTTPException(422, "Pick one of the feelings listed, or leave it empty.")
    if body.side is not None and not (body.entry and body.sl and body.tp):
        raise HTTPException(422, "Fill in entry, stop and target, or leave the call empty.")
    # The call is written down the moment it is made, so it survives closing the panel, and it cannot change
    # afterwards: a call made after seeing the outcome would not be a call.
    decision = s.get("decision")
    if body.side is not None:
        made = dict(side=body.side, entry=body.entry, sl=body.sl, tp=body.tp)
        if decision is None:
            decision = dict(made, emotion=body.emotion, note=(body.note or "").strip() or None, decided_at=iso(utcnow()))
            s["decision"] = decision
            row.summary = jdump(s)
            db.commit()
        elif any(decision.get(k) != v for k, v in made.items()):
            raise HTTPException(409, "Your call for this moment is already recorded and can't be changed.")
    if (s.get("result") or {}).get("final"):
        return dict(s["result"], coach=_coach(db, user, row, decision))     # settled: written once, never changed
    at = pd.Timestamp(row.created_at, tz="UTC")
    analyst = None
    if row.side and row.entry and row.sl and row.tp:
        analyst = rp.score(row.symbol, row.tf, at, row.side, row.entry, row.sl, row.tp, row.plan_type or "limit")
    mine = None
    if decision:
        mine = rp.score(row.symbol, row.tf, at, decision["side"], decision["entry"], decision["sl"], decision["tp"], "limit")
    final = all(x is None or x["final"] for x in (analyst, mine))
    result = dict(replay_id=row.id, at=iso(row.created_at), final=final, analyst=_json(analyst), user=_json(mine),
                  decision=dict(side=decision["side"], entry=decision["entry"], sl=decision["sl"], tp=decision["tp"],
                                emotion=decision.get("emotion"), note=decision.get("note")) if decision else None)
    if final:
        if analyst and row.outcome is None:                      # the analyst's call is what gets verified
            row.outcome, row.outcome_r = analyst["status"], analyst["r"]
            row.exit_price, row.filled_at = analyst["exit"], _naive(analyst["filled_at"])
            ex = analyst["exited_at"]
            row.outcome_at = _naive(ex) if ex is not None else utcnow()
            row.checked_at = utcnow()
        s["result"] = result
        row.summary = jdump(s)
        db.commit()
    return dict(result, coach=_coach(db, user, row, decision))

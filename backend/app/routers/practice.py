"""Draw & score practice, the daily challenge and its leaderboard."""
import hashlib

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..models import AnalysisLog, PracticeAttempt, User, iso, jdump, jload, utcnow
from ..plans import consume, refund, require_feature
from ..services import engine, practice
from .analysis import _clean_drawings

router = APIRouter(prefix="/practice", tags=["practice"])
DAILY_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XAUUSD", "EURUSD", "GBPUSD", "NAS100", "US30", "XRPUSDT", "GBPJPY",
                 "USDJPY", "BNBUSDT"]
DAILY_TFS = ["15m", "1h", "1h", "4h"]


class TradeIn(BaseModel):
    side: str
    entry: float = Field(gt=0)
    sl: float = Field(gt=0)
    tp: float = Field(gt=0)


class ScoreIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = "1h"
    bias: str | None = None
    drawings: list = Field(default_factory=list, max_length=60)
    trade: TradeIn | None = None
    challenge: str | None = Field(None, max_length=20)


def daily():
    day = utcnow().strftime("%Y-%m-%d")
    h = int(hashlib.sha256(day.encode()).hexdigest(), 16)
    return dict(id=f"daily-{day}", symbol=DAILY_SYMBOLS[h % len(DAILY_SYMBOLS)], tf=DAILY_TFS[(h >> 8) % len(DAILY_TFS)],
                date=day)


@router.get("/challenge")
def challenge(user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = daily()
    best = db.execute(select(func.max(PracticeAttempt.score)).where(PracticeAttempt.user_id == user.id,
                                                                    PracticeAttempt.challenge == c["id"])).scalar()
    players = db.execute(select(func.count(func.distinct(PracticeAttempt.user_id)))
                         .where(PracticeAttempt.challenge == c["id"])).scalar()
    return dict(c, your_best=best, players=players)


@router.post("/score")
def score(body: ScoreIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    require_feature(user, "practice")
    drawings = _clean_drawings(body.drawings)
    if not drawings and not body.trade and not body.bias:
        raise HTTPException(422, "Draw at least one level, pick a bias, or place a trade first.")
    consume(db, user, "practice")
    trade = body.trade.model_dump() if body.trade else None
    try:
        out = practice.score_attempt(body.symbol.strip(), body.tf, drawings, body.bias, trade)
    except engine.EngineError as e:
        refund(db, user, "practice")
        raise HTTPException(422, str(e))
    except Exception as e:
        refund(db, user, "practice")
        raise HTTPException(500, f"Scoring failed unexpectedly ({type(e).__name__}). Please try again.")
    ch = body.challenge if body.challenge and body.challenge == daily()["id"] else None
    row = PracticeAttempt(user_id=user.id, symbol=body.symbol.strip().upper(), tf=out["analysis"]["tf"],
                          price=float(out["analysis"]["price"]), bias=body.bias, score=out["score"], grade=out["grade"],
                          breakdown=jdump(out["breakdown"]), drawings=jdump(drawings), trade=jdump(trade) if trade else None,
                          challenge=ch)
    db.add(row)
    a = out["analysis"]
    summ = engine.summarize(a)
    summ["practice"] = dict(score=out["score"], grade=out["grade"], good=out["good"], improve=out["improve"],
                            bias=out["breakdown"]["bias"], levels={k: out["breakdown"]["levels"][k] for k in
                                                                   ("score", "recall", "precision", "missed")},
                            trade=out["breakdown"]["trade"], your_levels=out["your_levels"], your_trade=trade)
    log = AnalysisLog(user_id=user.id, kind="practice", symbol=body.symbol.strip().upper(), tf=a["tf"],
                      price=float(a["price"]), action=(a.get("verdict") or {}).get("action"),
                      grade=(a.get("verdict") or {}).get("grade"), summary=jdump(summ))
    db.add(log)
    db.commit()
    out["analysis_id"] = log.id
    best = db.execute(select(func.max(PracticeAttempt.score)).where(PracticeAttempt.user_id == user.id)).scalar()
    out.update(attempt_id=row.id, personal_best=best, new_best=out["score"] >= (best or 0), challenge=ch)
    return out


@router.get("/history")
def history(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(PracticeAttempt).where(PracticeAttempt.user_id == user.id)
                      .order_by(PracticeAttempt.id.desc()).limit(50)).scalars().all()
    scores = [r.score for r in rows]
    return dict(items=[dict(id=r.id, symbol=r.symbol, tf=r.tf, score=r.score, grade=r.grade, bias=r.bias,
                            challenge=r.challenge, created_at=iso(r.created_at),
                            breakdown={k: (v or {}).get("score") for k, v in (jload(r.breakdown, {}) or {}).items()})
                       for r in rows],
                stats=dict(attempts=len(scores), best=max(scores) if scores else None,
                           average=round(sum(scores) / len(scores), 1) if scores else None,
                           last5=round(sum(scores[:5]) / min(5, len(scores)), 1) if scores else None))


@router.get("/leaderboard")
def leaderboard(challenge: str | None = None, user: User = Depends(current_user), db: Session = Depends(get_db)):
    cid = challenge or daily()["id"]
    q = (select(PracticeAttempt.user_id, func.max(PracticeAttempt.score).label("best"))
         .where(PracticeAttempt.challenge == cid).group_by(PracticeAttempt.user_id)
         .order_by(func.max(PracticeAttempt.score).desc()).limit(20))
    rows = db.execute(q).all()
    out = []
    for rank, (uid, best) in enumerate(rows, 1):
        u = db.get(User, uid)
        name = (u.first_name or "Trader") + (f" {u.last_name[:1]}." if u and u.last_name else "")
        out.append(dict(rank=rank, name=name, score=best, you=uid == user.id, experience=u.experience if u else None))
    return dict(challenge=cid, entries=out)

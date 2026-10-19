"""The Analyse button, trade reviews and analysis history."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import AnalysisLog, User, iso, jdump, jload
from ..plans import consume, features_of, refund, require_feature, tier_of
from ..services import engine, psychology

router = APIRouter(prefix="/analysis", tags=["analysis"])


class AnalyzeIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = "1h"
    account: float = Field(1000.0, gt=0, le=1e10)
    risk_pct: float = Field(1.0, gt=0, le=10)
    leverage: float | None = Field(None, gt=0, le=200)
    mode: str | None = None
    drawings: list = Field(default_factory=list, max_length=60)


class ReviewIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = "1h"
    side: str
    entry: float = Field(gt=0)
    sl: float = Field(gt=0)
    tp: float = Field(gt=0)
    tp2: float | None = Field(None, gt=0)
    account: float = Field(1000.0, gt=0, le=1e10)
    risk_pct: float = Field(1.0, gt=0, le=10)
    leverage: float | None = Field(None, gt=0, le=200)


def _mode(user, mode):
    if mode in ("beginner", "pro"):
        return mode
    return "beginner" if (user.experience or "beginner") == "beginner" else "pro"


def _clean_drawings(items):
    out = []
    for it in items[:60]:
        if not isinstance(it, dict):
            continue
        t = it.get("type")
        keep = {k: it[k] for k in ("type", "price", "bottom", "top", "t1", "t2", "p1", "p2", "t", "text", "label", "id")
                if k in it}
        if t in ("hline", "level", "zone", "trendline", "note"):
            out.append(keep)
    return out


@router.post("/run")
def run(body: AnalyzeIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "analysis")
    consume(db, user, "analysis")
    mode = _mode(user, body.mode)
    try:
        res = engine.analyze(body.symbol.strip(), body.tf, account=body.account, risk_pct=body.risk_pct, mode=mode,
                             user_drawings=_clean_drawings(body.drawings), leverage=body.leverage)
    except engine.EngineError as e:
        refund(db, user, "analysis")
        raise HTTPException(422, str(e))
    except Exception as e:
        refund(db, user, "analysis")
        raise HTTPException(500, f"The analysis failed unexpectedly ({type(e).__name__}). Please try again.")
    if "pro_report" not in features_of(tier_of(user)):          # free plan: the report in the user's own mode only
        res["report_pro" if mode == "beginner" else "report_beginner"] = None
    pl = res.get("plan") or {}
    vd = res.get("verdict") or {}
    j = min(1, len(pl.get("tps") or [0]) - 1)
    log_row = AnalysisLog(user_id=user.id, kind="analysis", symbol=body.symbol.strip().upper(), tf=res["tf"],
                          price=float(res.get("price") or 0), action=vd.get("action"), grade=vd.get("grade"),
                          side=pl.get("side"), entry=pl.get("entry"), sl=pl.get("sl"),
                          tp=(pl.get("tps") or [None])[j] if pl else None,
                          p_tp=(pl.get("p_tp") or [None])[j] if pl else None,
                          summary=jdump(engine.summarize(res)))
    db.add(log_row)
    db.commit()
    res["analysis_id"] = log_row.id
    res["mode"] = mode
    # the person's own tendencies from their replays (chasing, re-entering after a loss, feelings): empty until enough
    res["tendencies"] = psychology.tips(psychology.features(psychology.decision_rows(psychology.replays_of(db, user.id, 300))))
    return res


@router.post("/review")
def review(body: ReviewIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "review")
    consume(db, user, "review")
    try:
        out = engine.review(body.symbol.strip(), body.tf, body.side, body.entry, body.sl, body.tp, body.tp2,
                            account=body.account, risk_pct=body.risk_pct, leverage=body.leverage,
                            mode=_mode(user, None))
    except engine.EngineError as e:
        refund(db, user, "review")
        raise HTTPException(422, str(e))
    except Exception as e:
        refund(db, user, "review")
        raise HTTPException(500, f"The review failed unexpectedly ({type(e).__name__}). Please try again.")
    if out.get("ok"):
        pl = out.get("plan") or {}
        db.add(AnalysisLog(user_id=user.id, kind="review", symbol=body.symbol.strip().upper(), tf=body.tf,
                           price=body.entry, action=out.get("verdict"), grade=pl.get("grade"),
                           side="long" if body.side.lower() in ("long", "buy") else "short", entry=body.entry,
                           sl=body.sl, tp=body.tp, p_tp=(pl.get("p_tp") or [None])[0],
                           summary=jdump(dict(verdict=out.get("verdict"), issues=out.get("issues"),
                                              fixes=out.get("fixes")))))
        db.commit()
    return out


@router.get("/history")
def history(limit: int = 30, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(AnalysisLog).where(AnalysisLog.user_id == user.id).order_by(AnalysisLog.id.desc())
                      .limit(min(limit, 100))).scalars()
    return dict(items=[dict(id=r.id, kind=r.kind, symbol=r.symbol, tf=r.tf, price=r.price, action=r.action,
                            grade=r.grade, side=r.side, entry=r.entry, sl=r.sl, tp=r.tp, p_tp=r.p_tp,
                            outcome=r.outcome, created_at=iso(r.created_at)) for r in rows])


@router.get("/{analysis_id}/summary")
def summary(analysis_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = db.get(AnalysisLog, analysis_id)
    if not r or r.user_id != user.id:
        raise HTTPException(404, "Not found.")
    return dict(id=r.id, summary=jload(r.summary, {}), created_at=iso(r.created_at))

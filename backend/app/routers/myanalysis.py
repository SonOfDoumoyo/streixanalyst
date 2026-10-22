"""My analysis: analyses the person made their own. An AI analysis they edit moves here with all its drawings, and the
AI can grade their version: the trade plan's odds and geometry, where the stop sits against liquidity, and how their
levels relate to the market's."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import User, UserAnalysis, iso, jdump, jload, utcnow
from ..plans import consume, refund, require_feature
from ..services import engine
from .analysis import _clean_drawings, strategies_for

router = APIRouter(prefix="/my-analyses", tags=["my-analyses"])
MAX_PER_USER = 300


class PlanIn(BaseModel):
    side: str = Field(pattern="^(long|short)$")
    entry: float = Field(gt=0)
    sl: float = Field(gt=0)
    tps: list[float] = Field(default_factory=list, max_length=3)


class AnalysisIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = Field("1h", max_length=8)
    title: str = Field("", max_length=120)
    source: str = Field("ai", pattern="^(ai|own|replay)$")
    source_analysis_id: int | None = None
    replay_at: str | None = Field(None, max_length=40)
    drawings: list = Field(default_factory=list, max_length=500)
    plan: PlanIn | None = None
    notes: str = Field("", max_length=4000)
    ai: dict | None = None                          # the AI's original call (verdict, plan, strategies) for comparison


class AnalysisPatch(BaseModel):
    title: str | None = Field(None, max_length=120)
    drawings: list | None = Field(None, max_length=500)
    plan: PlanIn | None = None
    clear_plan: bool = False
    notes: str | None = Field(None, max_length=4000)


def _out(r, full=False):
    d = jload(r.data, {}) or {}
    out = dict(id=r.id, symbol=r.symbol, tf=r.tf, title=r.title or f"{r.symbol} · {r.tf}", source=r.source,
               source_analysis_id=r.source_analysis_id, replay_at=r.replay_at, plan=d.get("plan"),
               grade=jload(r.grade, None), graded_at=iso(r.graded_at), created_at=iso(r.created_at),
               updated_at=iso(r.updated_at), drawings_count=len(d.get("drawings") or []))
    if full:
        out.update(drawings=d.get("drawings") or [], notes=d.get("notes") or "", ai=d.get("ai"))
    return out


def _own(db, user, aid):
    r = db.get(UserAnalysis, aid)
    if not r or r.user_id != user.id:
        raise HTTPException(404, "Analysis not found.")
    return r


def _check_plan(p):
    if p is None:
        return None
    d = 1 if p.side == "long" else -1
    if not d * (p.entry - p.sl) > 0:
        raise HTTPException(422, f"For a {'buy' if d == 1 else 'sell'} the stop must be {'below' if d == 1 else 'above'} "
                                 "the entry.")
    tps = [t for t in p.tps if t and t > 0]
    if any(d * (t - p.entry) <= 0 for t in tps):
        raise HTTPException(422, f"Targets must be {'above' if d == 1 else 'below'} the entry.")
    return dict(side=p.side, entry=p.entry, sl=p.sl, tps=tps)


def _blob(data):
    b = jdump(data)
    if len(b) > 600_000:
        raise HTTPException(413, "That analysis is too large.")
    return b


@router.get("")
def list_mine(limit: int = 60, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(UserAnalysis).where(UserAnalysis.user_id == user.id)
                      .order_by(UserAnalysis.updated_at.desc()).limit(min(max(limit, 1), 200))).scalars()
    return dict(items=[_out(r) for r in rows])


@router.post("", status_code=201)
def create(body: AnalysisIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    n = db.scalar(select(func.count()).select_from(UserAnalysis).where(UserAnalysis.user_id == user.id)) or 0
    if n >= MAX_PER_USER:
        raise HTTPException(429, f"You have {MAX_PER_USER} saved analyses. Delete some to save new ones.")
    data = dict(drawings=body.drawings, plan=_check_plan(body.plan), notes=body.notes, ai=body.ai)
    r = UserAnalysis(user_id=user.id, symbol=body.symbol.strip().upper(), tf=body.tf, title=body.title.strip(),
                     source=body.source, source_analysis_id=body.source_analysis_id, replay_at=body.replay_at,
                     data=_blob(data))
    db.add(r)
    db.commit()
    return _out(r, full=True)


@router.get("/{aid}")
def get_one(aid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _out(_own(db, user, aid), full=True)


@router.patch("/{aid}")
def update(aid: int, body: AnalysisPatch, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    r = _own(db, user, aid)
    d = jload(r.data, {}) or {}
    if body.title is not None:
        r.title = body.title.strip()
    if body.drawings is not None:
        d["drawings"] = body.drawings
    if body.clear_plan:
        d["plan"] = None
    elif body.plan is not None:
        d["plan"] = _check_plan(body.plan)
    if body.notes is not None:
        d["notes"] = body.notes
    r.data = _blob(d)
    r.updated_at = utcnow()
    db.commit()
    return _out(r, full=True)


@router.delete("/{aid}")
def delete(aid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    r = _own(db, user, aid)
    db.delete(r)
    db.commit()
    return dict(ok=True)


def _liquidity_notes(res, plan):
    """Where the person's stop sits against the liquidity the analyst sees."""
    liq = res.get("liquidity") or {}
    depth = liq.get("depth_atr") or 0.35
    atr = res.get("atr") or 0
    d = 1 if plan["side"] == "long" else -1
    notes = []
    pools = liq.get("below" if d == 1 else "above") or []
    for q in pools:
        gap = d * (q - plan["sl"])                  # > 0: the pool is between the stop and the entry side
        if atr and -depth * atr <= gap <= 0.6 * atr and d * (plan["entry"] - q) > 0:
            notes.append(dict(ok=False, text=f"Your stop is within reach of a stop hunt at the liquidity {q:g}: on this "
                                             f"chart hunts usually reach {depth:.2f} ATR past a swing. Put it beyond "
                                             f"{q - d * (depth + 0.05) * atr:g} or size down."))
            break
    if not notes:
        notes.append(dict(ok=True, text="Your stop isn't sitting just past an obvious pool of liquidity."))
    return notes


@router.post("/{aid}/grade")
def grade(aid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """The AI grades this analysis: a fresh read of the chart, the person's plan reviewed against it, their levels
    checked against the market's, and their stop checked against nearby liquidity."""
    require_feature(user, "review")
    r = _own(db, user, aid)
    d = jload(r.data, {}) or {}
    plan = d.get("plan")
    consume(db, user, "review")
    user_drawings = _clean_drawings(_to_analyst_drawings(d.get("drawings") or []))
    try:
        res = engine.analyze(r.symbol, r.tf, mode="pro", user_drawings=user_drawings,
                             strategies=strategies_for(user), at=r.replay_at)
        rev = None
        if plan:
            tps = plan.get("tps") or []
            tp = tps[0] if tps else None
            if tp is None:
                raise HTTPException(422, "Add at least one target to the plan before grading it.")
            if r.replay_at:
                rev = None                          # a past moment: the plan's odds are judged by the replay itself
            else:
                rev = engine.review(r.symbol, r.tf, plan["side"], plan["entry"], plan["sl"], tp,
                                    tps[1] if len(tps) > 1 else None, analysis=res)
    except engine.EngineError as e:
        refund(db, user, "review")
        raise HTTPException(422, str(e))
    except HTTPException:
        refund(db, user, "review")
        raise
    except Exception as e:
        refund(db, user, "review")
        raise HTTPException(500, f"Grading failed unexpectedly ({type(e).__name__}). Please try again.")
    ai_v = (res.get("verdict") or {})
    ai_p = res.get("plan") or {}
    agree = None
    if plan and ai_p.get("side"):
        agree = plan["side"] == ai_p["side"]
    levels = res.get("user_drawings") or []
    score = None
    if rev and rev.get("ok"):
        score = {"A+": 95, "A": 85, "B": 70, "C": 50, "D": 30}.get((rev.get("plan") or {}).get("grade"), 50)
        if agree is False:
            score -= 10
    out = dict(
        at=iso(utcnow()), score=score, verdict=(rev or {}).get("verdict"), review=rev,
        agrees_with_ai=agree, ai=dict(action=ai_v.get("action"), headline=ai_v.get("headline"),
                                      confidence=(ai_v.get("confidence") or {}).get("level"),
                                      plan=dict(side=ai_p.get("side"), entry=ai_p.get("entry"), sl=ai_p.get("sl"),
                                                tps=ai_p.get("tps")) if ai_p else None),
        levels=levels[:20], liquidity=_liquidity_notes(res, plan) if plan else [],
        mtf=(res.get("mtf") or {}).get("text"),
        summary=_summary(rev, agree, levels, plan))
    r.grade = jdump(out)
    r.graded_at = utcnow()
    db.commit()
    return dict(_out(r, full=True), grade=out)


def _to_analyst_drawings(items):
    """The chart's drawings (engine format: type + points) as the analyst's input (levels, zones, trendlines)."""
    out = []
    for d in items:
        if not isinstance(d, dict) or d.get("hidden") or (d.get("style") or {}).get("fromAi"):
            continue                                # the analyst's own drawings aren't graded as the person's levels
        P = d.get("points") or []
        label = ((d.get("style") or {}).get("text") or "")[:60] or None
        t = d.get("type")
        try:
            if t in ("hline", "hray") and P:
                out.append(dict(type="hline", price=float(P[0]["p"]), label=label))
            elif t == "rect" and len(P) >= 2:
                out.append(dict(type="zone", top=max(P[0]["p"], P[1]["p"]), bottom=min(P[0]["p"], P[1]["p"]), label=label))
            elif t in ("trendline", "ray", "extline") and len(P) >= 2 and P[0]["t"] != P[1]["t"]:
                out.append(dict(type="trendline", t1=P[0]["t"], p1=P[0]["p"], t2=P[1]["t"], p2=P[1]["p"], label=label))
        except (KeyError, TypeError, ValueError):
            continue
        if len(out) >= 40:
            break
    return out


def _summary(rev, agree, levels, plan):
    parts = []
    if not plan:
        parts.append("No trade plan yet: add an entry, stop and target to have it graded.")
    elif rev and rev.get("ok"):
        parts.append(f"Your plan: {rev.get('verdict', '').lower()}.")
        if rev.get("issues"):
            parts.append("Main issue: " + rev["issues"][0])
    if agree is True:
        parts.append("The analyst leans the same way.")
    elif agree is False:
        parts.append("The analyst leans the other way right now: check the timeframe table.")
    good = [lv for lv in levels if lv.get("confluence") or (lv.get("past_turns") or 0) >= 2]
    if levels:
        parts.append(f"{len(good)} of your {len(levels)} levels line up with levels the market has respected.")
    return " ".join(parts)

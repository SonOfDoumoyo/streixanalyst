"""Classroom live: a teacher exposes their chart (live or a replay, with their drawings and the analysis) to the
students of their organization, and students watch it. TV mode is on for the shared view: only the chart, the
drawings and the plan travel; the teacher's account size, risk settings, email and private notes never leave."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import ClassLive, User, iso, jdump, jload, utcnow
from ..plans import require_feature

router = APIRouter(prefix="/class", tags=["classroom"])
FRESH = timedelta(seconds=90)                   # a session not updated for this long is shown as offline
PRIVATE_KEYS = {"account", "risk_pct", "leverage", "sizing", "email", "notes_private", "balance", "pnl", "phone"}


class LiveIn(BaseModel):
    title: str = Field("", max_length=120)
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = Field("1h", max_length=8)
    replay: dict | None = None                  # {at, ahead} during a replay
    drawings: list = Field(default_factory=list, max_length=500)
    analysis: dict | None = None                # the overlay items and verdict the teacher is showing
    view: dict | None = None                    # {from, to}: the time span on the teacher's screen
    note: str = Field("", max_length=500)


def _is_teacher(user):
    return user.role == "admin" or (user.org_id and user.org_role in ("owner", "teacher"))


def _scrub(v):
    """Drop anything private from what is shared (TV mode)."""
    if isinstance(v, dict):
        return {k: _scrub(x) for k, x in v.items() if k not in PRIVATE_KEYS}
    if isinstance(v, list):
        return [_scrub(x) for x in v]
    return v


def _out(row, teacher, full=False):
    live = row.active and utcnow() - row.updated_at <= FRESH
    out = dict(teacher_id=row.teacher_id, teacher=teacher.name if teacher else "Teacher", title=row.title, live=live,
               started_at=iso(row.started_at), updated_at=iso(row.updated_at))
    st = jload(row.state, {}) or {}
    out.update(symbol=st.get("symbol"), tf=st.get("tf"), replay=st.get("replay"))
    if full:
        out["state"] = st
    return out


@router.put("/live")
def go_live(body: LiveIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """Start or update the teacher's exposed chart (the teacher's page calls this every few seconds while live)."""
    if not _is_teacher(user):
        raise HTTPException(403, "Only teachers and organization owners can expose their chart to students.")
    require_feature(user, "class_live")
    state = _scrub(dict(symbol=body.symbol.strip().upper(), tf=body.tf, replay=body.replay, drawings=body.drawings,
                        analysis=body.analysis, view=body.view, note=body.note.strip()))
    blob = jdump(state)
    if len(blob) > 900_000:
        raise HTTPException(413, "Too much on the chart to share. Clean up some drawings and try again.")
    row = db.get(ClassLive, user.id)
    now = utcnow()
    if row is None:
        row = ClassLive(teacher_id=user.id, org_id=user.org_id or 0, title=body.title.strip(), state=blob, active=True,
                        started_at=now, updated_at=now)
        db.add(row)
    else:
        if not row.active:
            row.started_at = now
        row.active, row.state, row.updated_at = True, blob, now
        row.org_id = user.org_id or 0
        if body.title.strip():
            row.title = body.title.strip()
    db.commit()
    return _out(row, user)


@router.delete("/live")
def stop_live(user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.get(ClassLive, user.id)
    if row:
        row.active = False
        db.commit()
    return dict(ok=True)


@router.get("/live")
def sessions(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The live sessions a student can watch: their organization's teachers who are exposing their chart."""
    if not user.org_id and user.role != "admin":
        return dict(items=[], note="Join your school's organization (with its invite code) to watch your teacher.")
    q = select(ClassLive).where(ClassLive.active.is_(True), ClassLive.updated_at >= utcnow() - FRESH)
    if user.role != "admin":
        q = q.where(ClassLive.org_id == user.org_id)
    rows = db.execute(q.order_by(ClassLive.updated_at.desc())).scalars().all()
    return dict(items=[_out(r, db.get(User, r.teacher_id)) for r in rows if r.teacher_id != user.id])


@router.get("/live/{teacher_id}")
def watch(teacher_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.get(ClassLive, teacher_id)
    teacher = db.get(User, teacher_id)
    if not row or not teacher:
        raise HTTPException(404, "That teacher isn't sharing their chart.")
    if user.role != "admin" and user.id != teacher_id and (not user.org_id or user.org_id != row.org_id):
        raise HTTPException(403, "You can only watch teachers from your own organization.")
    out = _out(row, teacher, full=True)
    if not out["live"]:
        out["state"] = None
    return out

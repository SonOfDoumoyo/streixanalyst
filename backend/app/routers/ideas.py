"""Ideas: people publish a chart idea (market, direction, reasoning, the drawings) for everyone to read and like."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import Idea, IdeaLike, User, iso, jdump, jload, utcnow

router = APIRouter(prefix="/ideas", tags=["ideas"])
DAILY_MAX = 20


class IdeaIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = Field("1h", max_length=8)
    side: str | None = Field(None, pattern="^(long|short)$")
    title: str = Field(min_length=3, max_length=140)
    body: str = Field("", max_length=6000)
    drawings: list = Field(default_factory=list, max_length=300)
    plan: dict | None = None
    price: float | None = None


def _out(r, author, liked=False, full=False):
    d = jload(r.data, {}) or {}
    out = dict(id=r.id, symbol=r.symbol, tf=r.tf, side=r.side, title=r.title, excerpt=(r.body or "")[:240],
               author=dict(id=author.id, name=author.name) if author else None, likes=r.likes, liked=liked,
               created_at=iso(r.created_at), plan=d.get("plan"), price=d.get("price"))
    if full:
        out.update(body=r.body, drawings=d.get("drawings") or [])
    return out


@router.get("")
def feed(scope: str = "latest", symbol: str | None = None, limit: int = 30, before: int | None = None,
         user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(Idea).where(Idea.hidden.is_(False))
    if scope == "mine":
        q = q.where(Idea.user_id == user.id)
    if symbol:
        q = q.where(Idea.symbol == symbol.strip().upper())
    if before:
        q = q.where(Idea.id < before)
    q = q.order_by(Idea.likes.desc(), Idea.id.desc()) if scope == "top" else q.order_by(Idea.id.desc())
    rows = db.execute(q.limit(min(max(limit, 1), 60))).scalars().all()
    liked = set(db.execute(select(IdeaLike.idea_id).where(IdeaLike.user_id == user.id,
                                                          IdeaLike.idea_id.in_([r.id for r in rows]))).scalars()) \
        if rows else set()
    authors = {u.id: u for u in db.execute(select(User).where(User.id.in_({r.user_id for r in rows}))).scalars()} \
        if rows else {}
    return dict(items=[_out(r, authors.get(r.user_id), r.id in liked) for r in rows])


@router.post("", status_code=201)
def publish(body: IdeaIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    day = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    n = db.scalar(select(func.count()).select_from(Idea).where(Idea.user_id == user.id, Idea.created_at >= day)) or 0
    if n >= DAILY_MAX:
        raise HTTPException(429, f"You can publish up to {DAILY_MAX} ideas a day.")
    data = jdump(dict(drawings=body.drawings, plan=body.plan, price=body.price))
    if len(data) > 400_000:
        raise HTTPException(413, "That idea has too many drawings to publish.")
    r = Idea(user_id=user.id, symbol=body.symbol.strip().upper(), tf=body.tf, side=body.side, title=body.title.strip(),
             body=body.body.strip(), data=data)
    db.add(r)
    db.commit()
    return _out(r, user, full=True)


@router.get("/{iid}")
def one(iid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = db.get(Idea, iid)
    if not r or (r.hidden and r.user_id != user.id and user.role != "admin"):
        raise HTTPException(404, "Idea not found.")
    liked = db.execute(select(IdeaLike).where(IdeaLike.idea_id == iid, IdeaLike.user_id == user.id)).first() is not None
    return _out(r, db.get(User, r.user_id), liked, full=True)


@router.post("/{iid}/like")
def like(iid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    r = db.get(Idea, iid)
    if not r or r.hidden:
        raise HTTPException(404, "Idea not found.")
    row = db.execute(select(IdeaLike).where(IdeaLike.idea_id == iid, IdeaLike.user_id == user.id)).scalar_one_or_none()
    if row:
        db.delete(row)
        r.likes = max(0, (r.likes or 0) - 1)
        liked = False
    else:
        db.add(IdeaLike(idea_id=iid, user_id=user.id))
        r.likes = (r.likes or 0) + 1
        liked = True
    db.commit()
    return dict(id=iid, likes=r.likes, liked=liked)


@router.delete("/{iid}")
def remove(iid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = db.get(Idea, iid)
    if not r:
        raise HTTPException(404, "Idea not found.")
    if r.user_id != user.id and user.role != "admin":
        raise HTTPException(403, "You can only delete your own ideas.")
    db.delete(r)
    db.commit()
    return dict(ok=True)

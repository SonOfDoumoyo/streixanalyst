"""The user's own data: drawings per symbol, watchlist, organization membership."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..models import Organization, SavedDrawing, User, WatchItem, iso, jdump, jload
from ..plans import limits_of, tier_of
from ..security import random_code
from .auth import join_org

router = APIRouter(prefix="/user", tags=["user"])


def _sym(s):
    s = (s or "").strip()
    if not s or len(s) > 64:
        raise HTTPException(422, "Invalid symbol.")
    return s.upper()


class DrawingsIn(BaseModel):
    symbol: str
    items: list = Field(default_factory=list)


@router.get("/drawings")
def get_drawings(symbol: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.execute(select(SavedDrawing).where(SavedDrawing.user_id == user.id,
                                                SavedDrawing.symbol == _sym(symbol))).scalar_one_or_none()
    return dict(symbol=_sym(symbol), items=jload(row.data, []) if row else [], updated_at=iso(row.updated_at) if row else None)


@router.put("/drawings")
def put_drawings(body: DrawingsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    sym = _sym(body.symbol)
    if len(body.items) > 500:
        raise HTTPException(413, "Too many drawings on one chart (max 500).")
    blob = jdump(body.items)
    if len(blob) > 400_000:
        raise HTTPException(413, "Drawings are too large.")
    row = db.execute(select(SavedDrawing).where(SavedDrawing.user_id == user.id,
                                                SavedDrawing.symbol == sym)).scalar_one_or_none()
    if row is None:
        row = SavedDrawing(user_id=user.id, symbol=sym, data=blob)
        db.add(row)
    else:
        row.data = blob
    db.commit()
    return dict(ok=True, count=len(body.items))


@router.get("/watchlist")
def watchlist(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(WatchItem).where(WatchItem.user_id == user.id).order_by(WatchItem.position,
                                                                                     WatchItem.id)).scalars().all()
    return dict(symbols=[r.symbol for r in rows])


class WatchIn(BaseModel):
    symbol: str


@router.post("/watchlist")
def add_watch(body: WatchIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    sym = _sym(body.symbol)
    rows = db.execute(select(WatchItem).where(WatchItem.user_id == user.id)).scalars().all()
    if any(r.symbol == sym for r in rows):
        return dict(symbols=[r.symbol for r in sorted(rows, key=lambda r: (r.position, r.id))])
    lim = limits_of(db, tier_of(user)).get("watchlist")
    if lim is not None and len(rows) >= lim:
        raise HTTPException(429, detail=dict(code="limit", kind="watchlist", limit=lim,
                                             message=f"Your plan holds {lim} watchlist symbols. Remove one or upgrade."))
    db.add(WatchItem(user_id=user.id, symbol=sym, position=max([r.position for r in rows], default=-1) + 1))
    db.commit()
    return watchlist(user, db)


@router.delete("/watchlist/{symbol:path}")
def remove_watch(symbol: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.execute(select(WatchItem).where(WatchItem.user_id == user.id,
                                             WatchItem.symbol == _sym(symbol))).scalar_one_or_none()
    if row:
        db.delete(row)
        db.commit()
    return watchlist(user, db)


class OrderIn(BaseModel):
    symbols: list[str]


@router.put("/watchlist")
def reorder_watch(body: OrderIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = {r.symbol: r for r in db.execute(select(WatchItem).where(WatchItem.user_id == user.id)).scalars()}
    for i, s in enumerate(body.symbols):
        if s.upper() in rows:
            rows[s.upper()].position = i
    db.commit()
    return watchlist(user, db)


# ── organizations (seats bought through billing; classroom tools arrive in a later phase)
class JoinIn(BaseModel):
    code: str = Field(max_length=24)


class OrgIn(BaseModel):
    name: str | None = Field(None, max_length=120)
    brand_color: str | None = Field(None, max_length=16)


@router.get("/org")
def my_org(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not user.org_id:
        return dict(org=None)
    org = db.get(Organization, user.org_id)
    members = []
    if user.org_role in ("owner", "teacher"):
        members = [dict(id=m.id, name=m.name, email=m.email, role=m.org_role, experience=m.experience,
                        last_seen_at=iso(m.last_seen_at))
                   for m in db.execute(select(User).where(User.org_id == org.id)).scalars()]
    return dict(org=dict(id=org.id, name=org.name, seats=org.seats, used=db.query(User).filter(User.org_id == org.id).count(),
                         expires_at=iso(org.plan_expires_at), brand_color=org.brand_color,
                         invite_code=org.invite_code if user.org_role in ("owner", "teacher") else None,
                         role=user.org_role), members=members)


@router.post("/org/join")
def org_join(body: JoinIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.org_id and user.org_role == "owner":
        raise HTTPException(409, "You own an organization. Transfer it before joining another.")
    join_org(db, user, body.code)
    db.commit()
    return my_org(user, db)


@router.post("/org/leave")
def org_leave(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.org_role == "owner":
        raise HTTPException(409, "Owners can't leave their own organization.")
    user.org_id, user.org_role = None, None
    db.commit()
    return dict(org=None)


@router.patch("/org")
def org_update(body: OrgIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.org_role != "owner":
        raise HTTPException(403, "Only the owner can change the organization.")
    org = db.get(Organization, user.org_id)
    if body.name:
        org.name = body.name.strip()
    if body.brand_color is not None:
        org.brand_color = body.brand_color.strip() or None
    db.commit()
    return my_org(user, db)


@router.post("/org/invite-code")
def org_new_code(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.org_role != "owner":
        raise HTTPException(403, "Only the owner can do that.")
    org = db.get(Organization, user.org_id)
    org.invite_code = random_code(10)
    db.commit()
    return my_org(user, db)


class MemberIn(BaseModel):
    role: str | None = None


@router.patch("/org/members/{member_id}")
def org_member(member_id: int, body: MemberIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.org_role != "owner":
        raise HTTPException(403, "Only the owner can do that.")
    m = db.get(User, member_id)
    if not m or m.org_id != user.org_id or m.id == user.id:
        raise HTTPException(404, "Member not found.")
    if body.role not in ("teacher", "member"):
        raise HTTPException(422, "Role must be teacher or member.")
    m.org_role = body.role
    db.commit()
    return my_org(user, db)


@router.delete("/org/members/{member_id}")
def org_remove(member_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.org_role != "owner":
        raise HTTPException(403, "Only the owner can do that.")
    m = db.get(User, member_id)
    if not m or m.org_id != user.org_id or m.id == user.id:
        raise HTTPException(404, "Member not found.")
    m.org_id, m.org_role = None, None
    db.commit()
    return my_org(user, db)

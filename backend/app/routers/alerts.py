"""Price and strategy alerts, and the in-app notifications they create."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import Alert, Notification, SavedStrategy, User, iso, utcnow
from ..plans import limits_of, require_feature, tier_of
from ..services import engine

router = APIRouter(prefix="/alerts", tags=["alerts"])
TFS = ("1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W")


class AlertIn(BaseModel):
    kind: str = Field("price", pattern="^(price|strategy)$")
    symbol: str = Field(min_length=1, max_length=64)
    tf: str | None = Field(None, max_length=4)
    op: str | None = Field(None, pattern="^(above|below|cross)$")
    price: float | None = Field(None, gt=0)
    strategy_id: int | None = None
    note: str | None = Field(None, max_length=120)
    repeat: bool = False
    email: bool = False


class AlertPatch(BaseModel):
    status: str | None = Field(None, pattern="^(active|paused)$")
    price: float | None = Field(None, gt=0)
    op: str | None = Field(None, pattern="^(above|below|cross)$")
    note: str | None = Field(None, max_length=120)
    repeat: bool | None = None
    email: bool | None = None


class ReadIn(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=200)
    all: bool = False


def _out(a, names=None):
    return dict(id=a.id, kind=a.kind, symbol=a.symbol, tf=a.tf, op=a.op, price=a.price, strategy_id=a.strategy_id,
                strategy=(names or {}).get(a.strategy_id), note=a.note, status=a.status, repeat=a.repeat,
                email=a.email, fired=a.fired, last_price=a.last_price, triggered_at=iso(a.triggered_at),
                checked_at=iso(a.checked_at), error=a.error, created_at=iso(a.created_at))


def _active(db, user):
    return db.execute(select(func.count(Alert.id)).where(Alert.user_id == user.id, Alert.status == "active")).scalar()


def _check_room(db, user):
    lim = limits_of(db, tier_of(user)).get("alerts")
    if lim is not None and _active(db, user) >= lim:
        msg = f"You have {lim} active alert{'s' if lim != 1 else ''}, the most your plan allows."
        msg += " Pause or delete one, or upgrade to Pro for more." if tier_of(user) == "free" else " Pause or delete one first."
        raise HTTPException(429, detail=dict(code="limit", kind="alerts", limit=lim, used=_active(db, user), message=msg))


@router.get("")
def list_alerts(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Alert).where(Alert.user_id == user.id).order_by(Alert.id.desc()).limit(300)).scalars().all()
    names = {s.id: s.name for s in db.execute(select(SavedStrategy).where(SavedStrategy.user_id == user.id)).scalars()}
    lim = limits_of(db, tier_of(user)).get("alerts")
    return dict(items=[_out(a, names) for a in rows], active=sum(a.status == "active" for a in rows), limit=lim)


@router.post("")
def create_alert(body: AlertIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "alerts")
    _check_room(db, user)
    sym = body.symbol.strip().upper()
    tf = body.tf if body.tf in TFS else None
    a = Alert(user_id=user.id, kind=body.kind, symbol=sym, tf=tf, note=(body.note or "").strip() or None,
              repeat=body.repeat, email=body.email)
    if body.kind == "price":
        if not body.price or not body.op:
            raise HTTPException(422, "A price alert needs a price and a condition (above, below or cross).")
        try:
            q = engine.latest(sym, "1m")
        except engine.EngineError as e:
            raise HTTPException(422, str(e))
        a.op, a.price, a.last_price = body.op, float(body.price), float(q["price"])
    else:
        require_feature(user, "strategy")
        s = db.get(SavedStrategy, body.strategy_id) if body.strategy_id else None
        if not s or s.user_id != user.id:
            raise HTTPException(404, "Save the strategy first, then set an alert on it.")
        if not tf:
            raise HTTPException(422, "Pick the timeframe the strategy should watch.")
        a.strategy_id = s.id
        a.repeat = True              # a strategy alert reports every new signal until you pause it
    db.add(a)
    db.commit()
    return _out(a)


@router.patch("/{aid}")
def patch_alert(aid: int, body: AlertPatch, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    a = db.get(Alert, aid)
    if not a or a.user_id != user.id:
        raise HTTPException(404, "Alert not found.")
    if body.status == "active" and a.status != "active":
        _check_room(db, user)
        a.triggered_at = None
        a.last_bar = None
    for k in ("status", "price", "op", "repeat", "email"):
        v = getattr(body, k)
        if v is not None:
            setattr(a, k, v)
    if body.note is not None:
        a.note = body.note.strip() or None
    db.commit()
    return _out(a)


@router.delete("/{aid}")
def delete_alert(aid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    a = db.get(Alert, aid)
    if not a or a.user_id != user.id:
        raise HTTPException(404, "Alert not found.")
    db.delete(a)
    db.commit()
    return dict(ok=True)


@router.get("/notifications")
def notifications(after: int = 0, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(Notification).where(Notification.user_id == user.id)
    if after:
        q = q.where(Notification.id > after)
    rows = db.execute(q.order_by(Notification.id.desc()).limit(50)).scalars().all()
    unread = db.execute(select(func.count(Notification.id)).where(Notification.user_id == user.id,
                                                                  Notification.read_at.is_(None))).scalar()
    return dict(items=[dict(id=n.id, kind=n.kind, title=n.title, body=n.body, link=n.link, read=n.read_at is not None,
                            created_at=iso(n.created_at)) for n in rows], unread=unread)


@router.post("/notifications/read")
def mark_read(body: ReadIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    q = update(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
    if not body.all:
        if not body.ids:
            return dict(ok=True)
        q = q.where(Notification.id.in_(body.ids))
    db.execute(q.values(read_at=utcnow()))
    db.commit()
    return dict(ok=True)

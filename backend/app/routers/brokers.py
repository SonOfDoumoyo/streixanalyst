"""Connect a broker, and send a trade plan to it. The keys are stored encrypted and never returned."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import BrokerAccount, BrokerOrder, StrategyWatch, User, iso, jdump, jload
from ..plans import require_feature
from ..services import brokers as bk

router = APIRouter(prefix="/brokers", tags=["brokers"])
MAX_ACCOUNTS = 6


class ConnectIn(BaseModel):
    kind: str = Field(pattern="^(mt|binance|bybit|oanda)$")
    label: str | None = Field(None, max_length=60)
    live: bool = False
    credentials: dict = Field(default_factory=dict)
    settings: dict = Field(default_factory=dict)


class PatchIn(BaseModel):
    label: str | None = Field(None, max_length=60)
    settings: dict | None = None


class SendIn(BaseModel):
    broker_id: int
    symbol: str = Field(min_length=1, max_length=64)
    side: str = Field(pattern="^(long|short)$")
    kind: str = Field("market", pattern="^(market|limit)$")
    entry: float = Field(gt=0)
    sl: float = Field(gt=0)
    tps: list[float] = Field(min_length=1, max_length=3)
    size: float = Field(gt=0)
    tp_mode: str = Field("first", pattern="^(first|split)$")
    confirm: bool = False
    ref: str | None = Field(None, max_length=100)


def _mine(db, user, bid):
    a = db.get(BrokerAccount, bid)
    if not a or a.user_id != user.id:
        raise HTTPException(404, "Broker account not found.")
    return a


@router.get("")
def overview(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(BrokerAccount).where(BrokerAccount.user_id == user.id)
                      .order_by(BrokerAccount.id)).scalars().all()
    return dict(available=bk.available(), accounts=[bk.public(a) for a in rows], names=bk.NAMES, units=bk.SIZE_UNIT)


@router.post("")
def connect(body: ConnectIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "broker")
    n = db.execute(select(BrokerAccount).where(BrokerAccount.user_id == user.id)).scalars().all()
    if len(n) >= MAX_ACCOUNTS:
        raise HTTPException(429, detail=dict(code="limit", kind="brokers", limit=MAX_ACCOUNTS,
                                             message=f"You can connect up to {MAX_ACCOUNTS} broker accounts."))
    try:
        acct = bk.connect(db, user, body.kind, body.label, body.live, body.credentials, body.settings)
    except bk.BrokerError as e:
        raise HTTPException(422, str(e))
    db.commit()
    return bk.public(acct)


@router.patch("/{bid}")
def update(bid: int, body: PatchIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    a = _mine(db, user, bid)
    if body.label is not None:
        a.label = body.label.strip()[:60]
    if body.settings is not None:
        merged = dict(jload(a.settings, {}) or {})
        merged.update(body.settings)
        try:
            a.settings = jdump(bk.clean_settings(merged))
        except bk.BrokerError as e:
            raise HTTPException(422, str(e))
        if not bk.cfg(a).get("auto_size"):                 # no auto size: no watch may send by itself on this account
            for w in db.execute(select(StrategyWatch).where(StrategyWatch.broker_id == a.id)).scalars():
                w.auto_send = False
    db.commit()
    return bk.public(a)


@router.post("/{bid}/check")
def check(bid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    a = _mine(db, user, bid)
    try:
        bk.refresh(a)
    except bk.BrokerError as e:
        a.status, a.error = "error", str(e)[:300]
        db.commit()
        raise HTTPException(422, str(e))
    db.commit()
    return bk.public(a)


@router.delete("/{bid}")
def remove(bid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    a = _mine(db, user, bid)
    for w in db.execute(select(StrategyWatch).where(StrategyWatch.broker_id == a.id)).scalars():
        w.broker_id, w.auto_send = None, False
    db.delete(a)
    db.commit()
    return dict(ok=True)


@router.post("/send")
def send(body: SendIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "broker")
    if not body.confirm:
        raise HTTPException(422, "Confirm the order before it is sent.")
    a = _mine(db, user, body.broker_id)
    o = dict(symbol=body.symbol, side=body.side, kind=body.kind, entry=body.entry, sl=body.sl, tps=body.tps,
             size=body.size, tp_mode=body.tp_mode)
    try:
        res = bk.send(db, user, a, o, source="manual", ref=(f"u{user.id}:{body.ref}" if body.ref else None))
    except bk.BrokerError as e:
        raise HTTPException(422, str(e))
    db.commit()
    if not res["ok"]:
        raise HTTPException(422, res["error"])
    return dict(ok=True, note=res["note"], ids=res["ids"], live=a.live, broker=a.label or bk.NAMES[a.kind],
                duplicate=bool(res.get("duplicate")))


@router.get("/orders")
def orders(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(BrokerOrder).where(BrokerOrder.user_id == user.id)
                      .order_by(BrokerOrder.id.desc()).limit(40)).scalars().all()
    return dict(items=[dict(id=o.id, account_id=o.account_id, symbol=o.symbol, side=o.side, kind=o.kind, entry=o.entry,
                            sl=o.sl, tps=jload(o.tps, []), size=o.size, status=o.status, error=o.error, source=o.source,
                            created_at=iso(o.created_at)) for o in rows])

"""Phone alerts: which devices receive the alerts (Web push). The alerts are the same ones the bell shows."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import current_user
from ..models import PushSubscription, User
from ..plans import require_feature
from ..services import push

router = APIRouter(prefix="/push", tags=["push"])
MAX_DEVICES = 10                                 # the newest ten devices keep receiving alerts


class Keys(BaseModel):
    p256dh: str = Field(min_length=10, max_length=200)
    auth: str = Field(min_length=4, max_length=100)


class SubIn(BaseModel):
    endpoint: str = Field(min_length=20, max_length=600)
    keys: Keys


class EndpointIn(BaseModel):
    endpoint: str = Field(min_length=20, max_length=600)


def _need_keys():
    if not settings.push_enabled:
        raise HTTPException(503, "Phone alerts aren't switched on for this server yet.")


@router.get("")
def status(user: User = Depends(current_user), db: Session = Depends(get_db)):
    devices = db.execute(select(PushSubscription).where(PushSubscription.user_id == user.id)).scalars().all()
    on = settings.push_enabled
    return dict(available=on, public_key=settings.vapid_public_key if on else None, devices=len(devices))


@router.post("/subscribe")
def subscribe(body: SubIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _need_keys()
    require_feature(user, "alerts")
    if not body.endpoint.startswith("https://"):
        raise HTTPException(422, "That device's push address isn't valid.")
    row = db.execute(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint)).scalar_one_or_none()
    if row is None:
        row = PushSubscription(endpoint=body.endpoint)
        db.add(row)
    row.user_id, row.p256dh, row.auth = user.id, body.keys.p256dh, body.keys.auth
    db.flush()
    mine = db.execute(select(PushSubscription).where(PushSubscription.user_id == user.id)
                      .order_by(PushSubscription.id)).scalars().all()
    for old in mine[:-MAX_DEVICES]:
        db.delete(old)
    db.commit()
    return dict(ok=True, devices=min(len(mine), MAX_DEVICES))


@router.post("/unsubscribe")
def unsubscribe(body: EndpointIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.execute(delete(PushSubscription).where(PushSubscription.user_id == user.id,
                                              PushSubscription.endpoint == body.endpoint))
    db.commit()
    return dict(ok=True)


@router.post("/test")
def send_test(user: User = Depends(current_user), db: Session = Depends(get_db)):
    _need_keys()
    require_feature(user, "alerts")
    counts = push.send_to_user(db, user.id, "Phone alerts are on", "This is a test from StreixAnalyst.", "/terminal")
    db.commit()
    return counts

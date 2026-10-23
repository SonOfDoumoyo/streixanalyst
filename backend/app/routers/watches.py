"""Strategy watches: pick a pair, pick strategies, press Watch. The scanner reports each new setup by site
notification, email and phone/browser push. Also the ping URL that keeps the scanner running on hosts that sleep."""
import hmac

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import current_user, verified_user
from ..models import StrategyWatch, User, iso, jdump, jload
from ..plans import limits_of, require_feature, tier_of
from ..services import engine, mailer, watcher

import strategies as st

router = APIRouter(prefix="/watches", tags=["watches"])
TFS = ("1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W")
MAX_IDS = 12


class WatchIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = Field("15m", max_length=4)
    strategies: list[str] = Field(min_length=1, max_length=60)
    email: bool = True
    push: bool = True


class WatchPatch(BaseModel):
    status: str | None = Field(None, pattern="^(active|paused)$")
    strategies: list[str] | None = Field(None, max_length=60)
    tf: str | None = Field(None, max_length=4)
    email: bool | None = None
    push: bool | None = None


def _out(w):
    ids = jload(w.strategies, []) or []
    return dict(id=w.id, symbol=w.symbol, tf=w.tf, strategies=ids,
                names=[st.BY_ID[i]["name"] for i in ids if i in st.BY_ID], status=w.status, email=w.email, push=w.push,
                fired=w.fired, last_fired_at=iso(w.last_fired_at), last_text=w.last_text, checked_at=iso(w.checked_at),
                error=w.error, created_at=iso(w.created_at))


def _active(db, user):
    return db.execute(select(func.count(StrategyWatch.id)).where(StrategyWatch.user_id == user.id,
                                                                  StrategyWatch.status == "active")).scalar()


def _check_room(db, user):
    lim = limits_of(db, tier_of(user)).get("watches")
    if lim is not None and _active(db, user) >= lim:
        msg = f"You are watching {lim} pair{'s' if lim != 1 else ''}, the most your plan allows."
        msg += " Pause or delete one, or upgrade to Pro for more." if tier_of(user) == "free" else " Pause or delete one first."
        raise HTTPException(429, detail=dict(code="limit", kind="watches", limit=lim, used=_active(db, user), message=msg))


def _ids(raw):
    ids = st.clean_ids(raw)
    if not ids:
        raise HTTPException(422, "Pick at least one strategy to watch for.")
    if len(ids) > MAX_IDS:
        raise HTTPException(422, f"Watch up to {MAX_IDS} strategies on one pair.")
    return ids


def _tf(tf):
    if tf not in TFS:
        raise HTTPException(422, "Pick a timeframe from 1m to 1W.")
    return tf


def _live(res):
    return [dict(id=s["id"], name=s["name"], side=s["side"], kind=s["kind"], age=s["age"], entry=s.get("entry"),
                 sl=s.get("sl"), tp=s.get("tp"), rr=s.get("rr")) for s in res["signals"]]


@router.get("")
def list_watches(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(StrategyWatch).where(StrategyWatch.user_id == user.id)
                      .order_by(StrategyWatch.id.desc()).limit(200)).scalars().all()
    lim = limits_of(db, tier_of(user)).get("watches")
    return dict(items=[_out(w) for w in rows], active=sum(w.status == "active" for w in rows), limit=lim,
                email=bool(user.email and mailer.configured()), user_email=user.email)


@router.post("")
def create_watch(body: WatchIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "alerts")
    _check_room(db, user)
    sym = body.symbol.strip().upper()
    w = StrategyWatch(user_id=user.id, symbol=sym, tf=_tf(body.tf), strategies=jdump(_ids(body.strategies)),
                      email=body.email, push=body.push)
    try:
        res = watcher.first_look(db, w, user)                     # checks the pair loads, and arms the watch
    except engine.EngineError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(422, f"Couldn't read {sym} {body.tf}: {str(e)[:120]}")
    w.symbol = res["symbol"]
    db.add(w)
    db.commit()
    return dict(watch=_out(w), live=_live(res))


@router.patch("/{wid}")
def patch_watch(wid: int, body: WatchPatch, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    w = db.get(StrategyWatch, wid)
    if not w or w.user_id != user.id:
        raise HTTPException(404, "Watch not found.")
    if body.status == "active" and w.status != "active":
        _check_room(db, user)
        w.last_bar = None                      # look again at once
    if body.status:
        w.status = body.status
    if body.strategies is not None:
        w.strategies = jdump(_ids(body.strategies))
    if body.tf is not None:
        w.tf, w.last_bar, w.seen = _tf(body.tf), None, "{}"
    if body.email is not None:
        w.email = body.email
    if body.push is not None:
        w.push = body.push
    db.commit()
    return _out(w)


@router.delete("/{wid}")
def delete_watch(wid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    w = db.get(StrategyWatch, wid)
    if not w or w.user_id != user.id:
        raise HTTPException(404, "Watch not found.")
    db.delete(w)
    db.commit()
    return dict(ok=True)


@router.post("/test-email")
def test_email(user: User = Depends(verified_user)):
    """Sends the person a sample alert email so they can see it arrives (and not in spam)."""
    if not mailer.configured():
        raise HTTPException(503, "Email isn't set up on this server yet.")
    title, body = watcher.message(dict(name="Liquidity sweep + structure shift", fixed_time=False, dir=1, kind="market",
                                       age=0, entry=1.0842, sl=1.0821, tp=1.0894, rr=2.5, chase=False),
                                  "EURUSD", "15m", 4)
    url = settings.frontend_url + "/terminal?s=EURUSD&tf=15m"
    mailer.send(user.email, "StreixAnalyst · Test alert", f"This is a test alert.\n\n{title}\n{body}\n\nOpen: {url}",
                html=watcher._email_html("Test alert: " + title, body, url))
    return dict(ok=True, to=user.email)


@router.post("/cron")
def cron(x_cron_secret: str | None = Header(None)):
    """Runs one scan. Point a free scheduler at it every 5 minutes (header X-Cron-Secret: <CRON_SECRET>). It also wakes a
    server that sleeps when idle, which is what keeps the watches working on a free host."""
    secret = settings.cron_secret
    if not secret or not x_cron_secret or not hmac.compare_digest(x_cron_secret, secret):
        raise HTTPException(403, "Wrong or missing cron secret.")
    return watcher.run_once()

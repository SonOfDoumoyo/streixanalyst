"""Strategy mode: describe your rules → live check + backtest. Saved strategies."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import SavedStrategy, User, iso, jdump, jload
from ..plans import consume, refund, require_feature
from ..services import strategy as stg

router = APIRouter(prefix="/strategy", tags=["strategy"])


class ParseIn(BaseModel):
    text: str = Field(min_length=3, max_length=2000)


class RunIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    tf: str = "1h"
    spec: dict
    bars: int = Field(3000, ge=300, le=5000)
    save_id: int | None = None


class SaveIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    spec: dict


@router.get("/library")
def library(user: User = Depends(current_user)):
    return dict(templates=stg.TEMPLATES, conditions={k: dict(label=v["label"], params=v["params"], desc=v["desc"])
                                                     for k, v in stg.CONDITIONS.items()},
                stops=stg.STOPS, targets=stg.TARGETS, sessions=list(stg.SESSIONS))


@router.post("/parse")
def parse(body: ParseIn, user: User = Depends(verified_user)):
    require_feature(user, "strategy")
    try:
        spec, notes, used_ai = stg.parse_text(body.text)
    except stg.StrategyError as e:
        raise HTTPException(422, str(e))
    return dict(spec=spec, summary=stg.describe(spec), notes=notes, used_ai=used_ai)


@router.post("/run")
def run(body: RunIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "strategy")
    consume(db, user, "strategy")
    try:
        out = stg.run(body.symbol.strip(), body.tf, body.spec, body.bars)
    except stg.StrategyError as e:
        refund(db, user, "strategy")
        raise HTTPException(422, str(e))
    except ValueError as e:
        refund(db, user, "strategy")
        raise HTTPException(422, str(e))
    if body.save_id:
        row = db.get(SavedStrategy, body.save_id)
        if row and row.user_id == user.id:
            row.last_symbol, row.last_tf, row.last_stats = body.symbol.strip().upper(), out["tf"], jdump(out["stats"])
            db.commit()
    return out


def _out(r):
    return dict(id=r.id, name=r.name, spec=jload(r.spec, {}), last_symbol=r.last_symbol, last_tf=r.last_tf,
                last_stats=jload(r.last_stats, None), updated_at=iso(r.updated_at))


@router.get("/saved")
def saved(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(SavedStrategy).where(SavedStrategy.user_id == user.id).order_by(SavedStrategy.updated_at.desc())).scalars()
    return dict(items=[_out(r) for r in rows])


@router.post("/saved")
def save(body: SaveIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    require_feature(user, "strategy")
    try:
        spec = stg.sanitize(dict(body.spec, name=body.name))
    except stg.StrategyError as e:
        raise HTTPException(422, str(e))
    n = db.execute(select(SavedStrategy).where(SavedStrategy.user_id == user.id)).scalars().all()
    if len(n) >= 50:
        raise HTTPException(409, "You can keep up to 50 strategies. Delete one first.")
    row = SavedStrategy(user_id=user.id, name=body.name.strip(), spec=jdump(spec))
    db.add(row)
    db.commit()
    return _out(row)


@router.put("/saved/{sid}")
def update(sid: int, body: SaveIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    row = db.get(SavedStrategy, sid)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "Strategy not found.")
    try:
        row.spec = jdump(stg.sanitize(dict(body.spec, name=body.name)))
    except stg.StrategyError as e:
        raise HTTPException(422, str(e))
    row.name = body.name.strip()
    db.commit()
    return _out(row)


@router.delete("/saved/{sid}")
def delete(sid: int, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    row = db.get(SavedStrategy, sid)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "Strategy not found.")
    db.delete(row)
    db.commit()
    return dict(ok=True)

"""The strategies the analyst can use: the catalog, the person's own choice, and how each strategy has been doing on a
market (its "fit")."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user, verified_user
from ..models import User, jdump, jload, utcnow
from ..plans import consume, refund
from ..services import engine, findings

import strategies as st

router = APIRouter(prefix="/strategies", tags=["strategies"])


class ChoiceIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=60)


@router.get("")
def catalog():
    """Every strategy, grouped, with what it waits for and which markets it tends to suit."""
    out = st.public_catalog()
    out["findings"] = findings.summary()
    return out


def user_strategies(user):
    """The person's chosen strategies (ids), or None if they haven't picked yet."""
    ids = st.clean_ids(jload(user.strategies, []) or [])
    return ids or None


@router.get("/mine")
def mine(user: User = Depends(current_user)):
    ids = user_strategies(user) or []
    return dict(ids=ids, set_at=user.strategies_set_at.isoformat() + "Z" if user.strategies_set_at else None,
                needs_choice=user.strategies_set_at is None)


@router.put("/mine")
def choose(body: ChoiceIn, user: User = Depends(verified_user), db: Session = Depends(get_db)):
    ids = st.clean_ids(body.ids)
    if not ids:
        raise HTTPException(422, "Pick at least one strategy for the analyst to use.")
    user.strategies = jdump(ids)
    user.strategies_set_at = utcnow()
    db.commit()
    return dict(ids=ids, set_at=user.strategies_set_at.isoformat() + "Z", needs_choice=False)


@router.get("/fit")
def fit(symbol: str, tf: str = "1h", user: User = Depends(verified_user), db: Session = Depends(get_db)):
    """How each strategy has done on this market and timeframe: a backtest on the loaded candles, after costs."""
    sym = (symbol or "").strip()
    if not sym or len(sym) > 64:
        raise HTTPException(422, "Invalid symbol.")
    consume(db, user, "strategy")
    try:
        return engine.fit(sym, tf)
    except engine.EngineError as e:
        refund(db, user, "strategy")
        raise HTTPException(422, str(e))
    except Exception as e:
        refund(db, user, "strategy")
        raise HTTPException(500, f"The strategy test failed unexpectedly ({type(e).__name__}). Please try again.")


@router.get("/findings")
def get_findings():
    """The latest research run: which strategies did best on the main markets and timeframes."""
    return findings.load() or dict(runs=[], note="No research run yet. It runs on the server every 12 hours.")

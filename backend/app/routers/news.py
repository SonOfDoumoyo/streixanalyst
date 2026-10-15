"""Economic calendar and headlines."""
from fastapi import APIRouter, Depends, HTTPException

from ..deps import current_user
from ..models import User
from ..services import engine, news

router = APIRouter(prefix="/news", tags=["news"])


@router.get("/calendar")
def calendar(currencies: str | None = None, days: int = 7, impact: str = "High,Medium",
             user: User = Depends(current_user)):
    ccys = [c.strip().upper() for c in currencies.split(",")] if currencies else None
    imp = tuple(i.strip().capitalize() for i in impact.split(",") if i.strip())
    return dict(events=news.upcoming(ccys, max(1, min(days, 14)), imp), ok=bool(news.calendar()))


@router.get("/for")
def for_symbol(symbol: str, tf: str = "1h", user: User = Depends(current_user)):
    try:
        spec = engine.spec_of(symbol)
    except engine.EngineError as e:
        raise HTTPException(422, str(e))
    return news.for_symbol(spec, tf)

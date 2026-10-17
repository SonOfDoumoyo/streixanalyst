"""Charts: symbol search, candles, live updates, watchlist quotes."""
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..deps import client_ip, current_user
from ..models import User
from ..security import market_limiter
from ..services import catalog, engine

router = APIRouter(prefix="/market", tags=["market"])
_pool = ThreadPoolExecutor(max_workers=8)


def _limit(key):
    if not market_limiter.hit(key):
        raise HTTPException(429, "Slow down a little — too many chart requests.")


def _run(fn, *a):
    try:
        return fn(*a)
    except engine.EngineError as e:
        raise HTTPException(404, str(e))


@router.get("/search")
def search(q: str = "", kind: str | None = None, limit: int = Query(40, le=100), user: User = Depends(current_user)):
    return dict(results=catalog.search(q, limit, kind))


@router.get("/candles")
def candles(symbol: str, tf: str = "1h", bars: int = Query(600, ge=50, le=5000),
            at: str | None = None, ahead: int = Query(0, ge=0, le=500),
            user: User = Depends(current_user)):
    """Live candles. With `at` (a replay): the candles up to that moment, and `ahead` more once revealed."""
    _limit(f"u{user.id}")
    return _run(engine.candles, symbol, tf, bars, at, ahead)


@router.get("/latest")
def latest(symbol: str, tf: str = "1h", user: User = Depends(current_user)):
    _limit(f"u{user.id}")
    return _run(engine.latest, symbol, tf)


@router.get("/divergence")
def divergence(symbol: str, tf: str = "1h", bars: int = Query(1500, ge=200, le=5000),
               user: User = Depends(current_user)):
    _limit(f"u{user.id}")
    return _run(engine.divergence, symbol, tf, bars)


@router.get("/quotes")
def quotes(symbols: str, user: User = Depends(current_user)):
    _limit(f"u{user.id}")
    syms = [s.strip() for s in symbols.split(",") if s.strip()][:40]

    def one(s):
        try:
            return engine.quote(s)
        except Exception as e:
            return dict(symbol=s, error=str(e)[:120])
    return dict(quotes=list(_pool.map(one, syms)))


@router.get("/demo")
def demo(request: Request):
    """Public candles for the landing page (one fixed market)."""
    _limit("ip" + client_ip(request))
    try:
        return engine.candles("BTCUSDT", "1h", 160)
    except engine.EngineError as e:
        raise HTTPException(503, str(e))

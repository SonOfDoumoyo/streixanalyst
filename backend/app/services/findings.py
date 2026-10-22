"""Strategy research: every strategy backtested on the main markets and timeframes, every 12 hours, on the server.

The result answers "which strategies have been working where?" with numbers rather than opinions: each strategy's
trades, win rate and average R after costs on each market and timeframe, with stops past nearby liquidity. The strategy
picker shows the best ones for the market a person trades, and the analyst weighs a strategy by its record when the
chosen strategies disagree. Past results don't promise future ones."""
import json
import logging
import threading
import time

from ..config import settings

log = logging.getLogger("streix.findings")
BASKET = [("EURUSD", "5m"), ("EURUSD", "15m"), ("EURUSD", "1h"), ("GBPUSD", "5m"), ("GBPUSD", "15m"), ("GBPUSD", "1h"),
          ("USDJPY", "15m"), ("USDJPY", "1h"), ("XAUUSD", "15m"), ("XAUUSD", "1h"), ("XAUUSD", "4h"),
          ("BTCUSDT", "15m"), ("BTCUSDT", "1h"), ("BTCUSDT", "4h"), ("ETHUSDT", "1h"), ("SOLUSDT", "1h"),
          ("NAS100", "15m"), ("NAS100", "1h"), ("US30", "1h"), ("GBPJPY", "1h"), ("AUDUSD", "1h"), ("EURGBP", "1h")]
_lock = threading.Lock()
_mem = {"data": None}


def path():
    p = settings.data_dir / "learning" / "strategy_findings.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def load():
    if _mem["data"] is not None:
        return _mem["data"]
    p = path()
    if p.exists():
        try:
            _mem["data"] = json.loads(p.read_text())
        except (OSError, ValueError):
            _mem["data"] = None
    return _mem["data"]


def run(basket=None, pause=1.0):
    """Backtest every strategy on every market/timeframe of the basket and save the table."""
    from . import engine
    runs = []
    started = time.time()
    for sym, tf in basket or BASKET:
        try:
            f = engine.fit(sym, tf, ttl=0)
        except Exception as e:                       # one market failing must not stop the rest
            runs.append(dict(symbol=sym, tf=tf, error=f"{type(e).__name__}: {str(e)[:120]}"))
            continue
        rows = [dict(id=r["id"], name=r["name"], group=r["group"], trades=r.get("trades", 0),
                     win_rate=r.get("win_rate"), avg_r=r.get("avg_r"), score=r.get("score"),
                     breakeven=r.get("breakeven"), verdict=r.get("verdict")) for r in f["rows"] if "error" not in r]
        runs.append(dict(symbol=f["symbol"], query=sym, tf=tf, candles=f["candles"], end=f["end"], rows=rows))
        time.sleep(pause)
    out = dict(generated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), seconds=round(time.time() - started, 1),
               runs=runs, note="Backtests after costs, stops past nearby liquidity. Past results don't promise future ones.")
    with _lock:
        path().write_text(json.dumps(out))
        _mem["data"] = out
    log.info("strategy findings: %d markets in %.0fs", len(runs), out["seconds"])
    return out


def summary(top=3, min_trades=20):
    """For each market: the strategies that did best (enough trades, positive after costs)."""
    data = load()
    if not data:
        return None
    best = {}
    for r in data.get("runs", []):
        if "rows" not in r:
            continue
        good = [x for x in r["rows"] if (x.get("trades") or 0) >= min_trades and (x.get("score") or 0) > 0]
        good.sort(key=lambda x: -(x.get("score") or 0))
        best[f"{r['query']}|{r['tf']}"] = [dict(id=x["id"], name=x["name"], trades=x["trades"],
                                                 win_rate=x["win_rate"], avg_r=x["avg_r"]) for x in good[:top]]
    return dict(generated=data.get("generated"), best=best)


def for_symbol(symbol, tf=None):
    """Ids of the strategies that did best on this market (any timeframe, or one), best first."""
    s = (summary(top=6) or {}).get("best") or {}
    sym = (symbol or "").upper().replace("/", "")
    out = []
    for k, rows in s.items():
        q, t = k.split("|")
        if q.upper() == sym and (tf is None or t == tf):
            for x in rows:
                if x["id"] not in out:
                    out.append(x["id"])
    return out

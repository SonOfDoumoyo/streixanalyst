"""The analysis engine: loads the guru modules and the trained brain, serves candles and analyses."""
import logging
import sys
import threading
import time
import warnings
from pathlib import Path

from ..config import BASE_DIR, settings

GURU_DIR = BASE_DIR / "guru"
if str(GURU_DIR) not in sys.path:
    sys.path.insert(0, str(GURU_DIR))

import market_data as md            # noqa: E402
import guru_model as gm             # noqa: E402
import guru_analyst as ga           # noqa: E402
import divergence as dvg            # noqa: E402

from . import exchanges, news      # noqa: E402  (exchanges patches market_data on import)

log = logging.getLogger("streix.engine")
md.set_cache_dir(str(settings.cache_dir / "candles"))
exchanges.install_safe_contexts(ga)

BRAIN = {"brain": None, "status": "loading", "detail": None, "loaded_at": None, "path": str(settings.brain_path)}
_sem = threading.BoundedSemaphore(max(1, settings.analysis_workers))
_latest_cache, _latest_lock = {}, threading.Lock()


class EngineError(Exception):
    """A user-facing problem (unknown symbol, not enough candles ...)."""


def check_build_version(brain):
    """A brain saved with one scikit-learn version can load wrongly, or not at all, on another. Refuse it clearly.

    Returns the version the brain was built with (None for older brains that don't record one)."""
    import sklearn
    built_with = (getattr(brain, "b", None) or {}).get("sklearn")
    if built_with and built_with != sklearn.__version__:
        raise RuntimeError(f"it was trained with scikit-learn {built_with}, but this server runs {sklearn.__version__}. "
                           "Pin scikit-learn to the notebook's version in requirements.txt, redeploy, then upload again.")
    return built_with


def load_brain(path=None):
    path = Path(path or settings.brain_path)
    if not path.exists():
        BRAIN.update(brain=gm.FallbackBrain(), status="untrained",
                     detail=f"No trained brain at {path}. Probabilities are random-walk approximations until you "
                            "upload guru_brain.joblib from the notebook.")
        ga.use_brain(BRAIN["brain"])
        return BRAIN
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            brain = ga.use_brain(str(path))
        built_with = check_build_version(brain)          # raises (and falls back) if the versions differ
        ver = [str(w.message)[:200] for w in caught if "version" in str(w.message).lower()]
        card = brain.b.get("card", {})
        BRAIN.update(brain=brain, status="trained", loaded_at=time.time(),
                     detail=dict(created=brain.b.get("created"), version=brain.b.get("version"),
                                 rows=card.get("rows"), sklearn=built_with, warnings=ver,
                                 skill=ga.model_skill(brain)))
    except Exception as e:
        log.exception("brain load failed")
        BRAIN.update(brain=gm.FallbackBrain(), status="error",
                     detail=f"Could not load {path.name}: {type(e).__name__}: {str(e)[:300]}. Check that the server's "
                            "scikit-learn version matches the notebook's.")
        ga.use_brain(BRAIN["brain"])
    return BRAIN


def brain():
    if BRAIN["brain"] is None:
        load_brain()
    return BRAIN["brain"]


def spec_of(symbol):
    try:
        return md.parse_symbol(symbol)
    except ValueError as e:
        raise EngineError(str(e))


def _norm_tf(tf):
    try:
        return md.norm_tf(tf)
    except ValueError as e:
        raise EngineError(str(e))


def _get(symbol, tf, bars, refresh_s, min_bars=30):
    try:
        return md.get_candles(symbol, tf, bars=bars, refresh_s=refresh_s, min_bars=min_bars)
    except md.DataError as e:
        msg = str(e)
        if "Tried" in msg:
            msg = (f"Couldn't load {symbol} on {tf}. Check the symbol (e.g. BTCUSDT, EURUSD, XAUUSD, NAS100, AAPL) "
                   "or try another timeframe.")
        raise EngineError(msg)


def candles_payload(C, include_forming=True):
    df = C["df"]
    ts = md.epoch_s(df.index)
    rows = [[int(t), float(o), float(h), float(l), float(c), float(v)]
            for t, o, h, l, c, v in zip(ts, df["open"], df["high"], df["low"], df["close"], df["volume"], strict=False)]
    forming = C.get("forming")
    if include_forming and forming is not None:
        import pandas as pd
        t = int(md.epoch_s(pd.DatetimeIndex([forming.name]))[0])
        rows.append([t, float(forming["open"]), float(forming["high"]), float(forming["low"]), float(forming["close"]),
                     float(forming["volume"])])
    return rows


def _meta(C):
    spec = spec_of(C["query"])
    return dict(symbol=C["query"], display=C["symbol"], tf=C["tf"], source=C["source"], asset_class=C["asset_class"],
                sub=C["sub"], base=C["base"], quote=C["quote"], decimals=C["decimals"], price=C["price"],
                forming=C["forming"] is not None, perp=bool(spec.get("perp")), tf_seconds=md.TF_MIN[C["tf"]] * 60,
                age_minutes=C["age_minutes"])


def candles(symbol, tf, bars=600):
    tf = _norm_tf(tf)
    bars = int(min(max(bars, 50), 5000))
    C = _get(symbol, tf, bars, refresh_s=5 if md.TF_MIN[tf] < 1440 else 30)
    return dict(_meta(C), candles=candles_payload(C))


def latest(symbol, tf):
    """The last few candles (incl. the forming one) for live updates. The chart asks every 5 seconds. Every viewer shares
    one upstream request per symbol every 5 seconds, which keeps paid data plans (Twelve Data) within their limits."""
    tf = _norm_tf(tf)
    key = (symbol.upper(), tf)
    now = time.time()
    with _latest_lock:
        hit = _latest_cache.get(key)
        if hit and now - hit[0] < 5.0:
            return hit[1]
    C = _get(symbol, tf, 5, refresh_s=5, min_bars=1)
    rows = candles_payload(C)[-3:]
    out = dict(symbol=symbol, tf=tf, price=C["price"], decimals=C["decimals"], candles=rows, source=C["source"])
    with _latest_lock:
        _latest_cache[key] = (now, out)
        if len(_latest_cache) > 5000:
            _latest_cache.clear()
    return out


def quote(symbol):
    """Last price and today's change (vs the daily open) for watchlists."""
    C = _get(symbol, "1D", 3, refresh_s=20, min_bars=1)
    df = C["df"]
    if C["forming"] is not None:
        op = float(C["forming"]["open"])
    elif len(df):
        op = float(df["open"].iloc[-1])
    else:
        op = None
    price = float(C["price"])
    return dict(symbol=symbol, display=C["symbol"], price=price, decimals=C["decimals"],
                change=None if not op else (price / op - 1) * 100, asset_class=C["asset_class"])


def divergence(symbol, tf, bars=1500):
    """Regular divergence on nine oscillators, and how each one's past signals played out (guru/divergence.py).
    Uses closed candles only, and the same cost model as the Strategy Lab."""
    tf = _norm_tf(tf)
    bars = int(min(max(bars, 200), 5000))
    C = _get(symbol, tf, bars, refresh_s=60 if md.TF_MIN[tf] < 1440 else 300, min_bars=60)
    cost, slip = gm.cost_of(C["sub"])
    res = dvg.scan(C["df"], cost_frac=cost, slip_frac=slip)
    return dict(symbol=C["symbol"], tf=tf, source=C["source"], asset_class=C["asset_class"], bars=int(len(C["df"])),
                **res)


def _attach_news(res, spec, tf):
    try:
        nw = news.for_symbol(spec, tf)
    except Exception as e:
        nw = dict(risk="unknown", note=f"News unavailable ({str(e)[:60]}).", events=[], headlines=[])
    res["news"] = nw
    vd = res.get("verdict") or {}
    if nw.get("risk") == "high":
        vd["news_warning"] = nw["note"]
        if vd.get("trade"):
            vd["headline"] = vd["headline"] + " · ⚠ news risk"
    res["verdict"] = vd
    return res


def analyze(symbol, tf, account=1000.0, risk_pct=1.0, mode="pro", user_drawings=None, leverage=None):
    tf = _norm_tf(tf)
    spec = spec_of(symbol)
    if not _sem.acquire(timeout=60):
        raise EngineError("The analyst is busy right now. Try again in a few seconds.")
    try:
        C = _get(symbol, tf, ga.BARS[tf], refresh_s=8)
        try:
            res = ga.analyze(symbol, tf, account=float(account), risk_pct=float(risk_pct), mode=mode,
                             user_drawings=user_drawings or None, brain=brain(), leverage=leverage, data=C)
        except ValueError as e:
            raise EngineError(str(e))
        res = ga.jsonable(res)
    finally:
        _sem.release()
    res["meta"] = _meta(C)
    res["brain_status"] = BRAIN["status"]
    return _attach_news(res, spec, tf)


def review(symbol, tf, side, entry, sl, tp, tp2=None, account=1000.0, risk_pct=1.0, leverage=None, mode="pro",
           analysis=None):
    tf = _norm_tf(tf)
    if not _sem.acquire(timeout=60):
        raise EngineError("The analyst is busy right now. Try again in a few seconds.")
    try:
        _get(symbol, tf, ga.BARS[tf], refresh_s=8)          # fresh candles for the review's own analysis
        try:
            out = ga.review_trade(symbol, tf, side, float(entry), float(sl), float(tp),
                                  None if tp2 in (None, "") else float(tp2), account=float(account),
                                  risk_pct=float(risk_pct), leverage=leverage, brain=brain(), mode=mode,
                                  analysis=analysis)
        except (ValueError, md.DataError) as e:
            raise EngineError(str(e))
        return ga.jsonable(out)
    finally:
        _sem.release()


def grade_user_drawings(res, drawings):
    """The analyst's view of the user's own levels/zones/trendlines, against the analysis just run."""
    X = ga._STATE["ctx"].get((res["symbol"], res["tf"]))
    if X is None or not drawings:
        return []
    out, _ = ga.analyze_user_drawings(drawings, X, brain())
    return ga.jsonable(out)


def status():
    return dict(brain=dict(status=BRAIN["status"], detail=BRAIN["detail"], path=BRAIN["path"]),
                blocked_sources=exchanges.blocked_sources(), workers=settings.analysis_workers)


def summarize(res, report_chars=5000):
    """Compact version of an analysis: stored with the log and given to StreixAI as chart context."""
    def plan(p):
        if not p:
            return None
        return {k: p.get(k) for k in ("side", "type", "setup", "entry", "sl", "tps", "tp_labels", "rr", "p_fill", "p_tp",
                                      "breakeven", "ev", "grade", "score", "why", "invalidation", "sizing", "checklist",
                                      "risk_atr", "cost_r")}
    price = res.get("price") or 0
    lv = sorted(res.get("levels") or [], key=lambda c: abs(c.get("dist_atr", 99)))[:10]
    nw = res.get("news") or {}
    return dict(
        symbol=res.get("symbol"), tf=res.get("tf"), price=price, decimals=res.get("decimals"), atr=res.get("atr"),
        time=res.get("time"), verdict=res.get("verdict"), plan=plan(res.get("plan")),
        alternative=plan(res.get("alternative")), timeframes=res.get("timeframes"),
        structure={k: (res.get("structure") or {}).get(k) for k in ("trend", "phase", "last_event", "swings",
                                                                    "dealing_range")},
        levels=[dict(price=c.get("price"), labels=(c.get("labels") or [])[:4], dist_atr=c.get("dist_atr"),
                     p_touch=c.get("p_touch")) for c in lv],
        patterns=[p.get("name") for p in (res.get("patterns") or [])][:6],
        divergences=[d.get("name") for d in (res.get("divergences") or [])][:4], rsi=res.get("rsi"),
        probabilities=res.get("probabilities"), session=res.get("session"), model=res.get("model"),
        news=dict(risk=nw.get("risk"), note=nw.get("note"), events=(nw.get("events") or [])[:5],
                  headlines=[h.get("title") for h in (nw.get("headlines") or [])[:5]]),
        user_drawings=res.get("user_drawings"),
        report=(res.get("report") or "")[:report_chars])

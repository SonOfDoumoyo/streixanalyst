"""The analysis engine: loads the guru modules and the trained brain, serves candles and analyses."""
import logging
import sys
import threading
import os
import time
import warnings
from pathlib import Path

import pandas as pd

from ..config import BASE_DIR, settings

GURU_DIR = BASE_DIR / "guru"
if str(GURU_DIR) not in sys.path:
    sys.path.insert(0, str(GURU_DIR))

import market_data as md            # noqa: E402
import guru_model as gm             # noqa: E402
import guru_analyst as ga           # noqa: E402
import divergence as dvg            # noqa: E402
import playbook as pb               # noqa: E402
import strategies as st             # noqa: E402

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


BUNDLED_BRAIN = Path(__file__).resolve().parent.parent.parent / "models" / "guru_brain.joblib"


def load_brain(path=None):
    path = Path(path or settings.brain_path)
    if (not path.exists() and path != BUNDLED_BRAIN and BUNDLED_BRAIN.exists()
            and os.environ.get("GURU_BUNDLED_BRAIN", "1") != "0"):
        # no uploaded brain (Render's free plan has no disk, so uploads vanish when the service sleeps or redeploys):
        # use the one committed with the code in backend/models/
        path = BUNDLED_BRAIN
    BRAIN["path"] = str(path)
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
                                 skill=ga.model_skill(brain), heads=heads_info(brain)))
    except Exception as e:
        log.exception("brain load failed")
        BRAIN.update(brain=gm.FallbackBrain(), status="error",
                     detail=f"Could not load {path.name}: {type(e).__name__}: {str(e)[:300]}. Check that the server's "
                            "scikit-learn version matches the notebook's.")
        ga.use_brain(BRAIN["brain"])
    return BRAIN


def heads_info(brain):
    """What the Notebook 10 heads in this brain are used for (the notebook's tests decide each `use` flag)."""
    out = {}
    liq, strat = getattr(brain, "liq", None), getattr(brain, "strat", None)
    if liq:
        c = liq.get("card", {})
        out["liquidity"] = dict(use=liq.get("use"), rows=c.get("rows"),
                                sweep_auc=(c.get("sweep") or {}).get("auc_model"),
                                reverse_auc=(c.get("reverse") or {}).get("auc_model"),
                                depth_coverage=(c.get("depth") or {}).get("coverage_model"))
    if strat:
        c = strat.get("card", {})
        out["strategies"] = dict(use=strat.get("use"), rows=c.get("rows"), auc=(c.get("model") or {}).get("auc_model"))
    return out


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


def _get(symbol, tf, bars, refresh_s, min_bars=30, end=None):
    try:
        return md.get_candles(symbol, tf, bars=bars, refresh_s=refresh_s, min_bars=min_bars, end=end)
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


def parse_moment(value):
    """A replay moment as a UTC time (a time with no zone is taken as UTC). It has to be in the past."""
    try:
        t = pd.Timestamp(value)
    except (TypeError, ValueError):
        raise EngineError("That date and time isn't valid.")
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    if t >= md.utcnow():
        raise EngineError("Pick a moment in the past.")
    return t


def window_end(at, tf, ahead=0):
    """(cut-off, last moment the chart may show): the cut-off plus `ahead` candles, never later than now."""
    t = parse_moment(at)
    return t, min(t + pd.Timedelta(minutes=md.TF_MIN[_norm_tf(tf)] * int(ahead)), md.utcnow())


# chart-only timeframes, built from a standard one: (base timeframe, candles of the base per candle)
CUSTOM_TF = {"2m": ("1m", 2), "3m": ("1m", 3), "10m": ("5m", 2), "45m": ("15m", 3), "2h": ("1h", 2), "3h": ("1h", 3),
             "6h": ("1h", 6), "8h": ("4h", 2), "12h": ("4h", 3)}


def _custom(symbol, tf, bars, at=None, ahead=0, latest_only=False):
    """Candles of a chart-only timeframe (e.g. 3m, 2h), aggregated from its base timeframe in UTC-aligned bins."""
    base, k = CUSTOM_TF[tf]
    minutes = md.TF_MIN[base] * k
    if at is not None:
        t, end = window_end(at, base, ahead * k)
        C = _get(symbol, base, min(5000, bars * k + k), refresh_s=3600, end=end)
        df = C["df"]
    else:
        C = _get(symbol, base, min(5000, (5 if latest_only else bars) * k + k), refresh_s=5, min_bars=1)
        df = C["df"]
        if C["forming"] is not None:
            df = pd.concat([df, C["forming"].to_frame().T.astype(float)])
    key = df.index.floor(f"{minutes}min")
    g = df.groupby(key)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    ts = md.epoch_s(out.index)
    rows = [[int(t), float(o), float(h), float(l), float(c), float(v)]
            for t, o, h, l, c, v in zip(ts, out["open"], out["high"], out["low"], out["close"], out["volume"])]
    meta = dict(_meta(C), tf=tf, tf_seconds=minutes * 60, base_tf=base)
    return meta, rows[-bars:]


def candles(symbol, tf, bars=600, at=None, ahead=0):
    """Candles for the chart. With `at` it is a replay: the chart stops at that moment, and shows `ahead` more candles
    once the person has revealed what happened next."""
    if tf in CUSTOM_TF:
        bars = int(min(max(bars, 50), 2000))
        meta, rows = _custom(symbol, tf, bars, at, ahead)
        out = dict(meta, candles=rows)
        if at is not None:
            out["replay_at"] = parse_moment(at).isoformat()
        return out
    tf = _norm_tf(tf)
    bars = int(min(max(bars, 50), 5000))
    if at is None:
        C = _get(symbol, tf, bars, refresh_s=5 if md.TF_MIN[tf] < 1440 else 30)
        return dict(_meta(C), candles=candles_payload(C))
    t, end = window_end(at, tf, ahead)
    C = _get(symbol, tf, bars, refresh_s=3600, end=end)
    return dict(_meta(C), replay_at=t.isoformat(), candles=candles_payload(C, include_forming=False))


def _pin_age(C, asof):
    """How old the newest candle is at the replay moment (the live clock is not the replay's clock)."""
    if C.get("last_close_time") is not None:
        C["age_minutes"] = round((asof - C["last_close_time"]).total_seconds() / 60, 1)


def latest(symbol, tf):
    """The last few candles (incl. the forming one) for live updates. The chart asks every 5 seconds. Every viewer shares
    one upstream request per symbol every 5 seconds, which keeps paid data plans (Twelve Data) within their limits."""
    custom = tf in CUSTOM_TF
    tf = tf if custom else _norm_tf(tf)
    key = (symbol.upper(), tf)
    now = time.time()
    with _latest_lock:
        hit = _latest_cache.get(key)
        if hit and now - hit[0] < 5.0:
            return hit[1]
    if custom:
        meta, rows = _custom(symbol, tf, 3, latest_only=True)
        out = dict(symbol=symbol, tf=tf, price=meta["price"], decimals=meta["decimals"], candles=rows[-3:],
                   source=meta["source"])
        with _latest_lock:
            _latest_cache[key] = (now, out)
        return out
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


def analyze(symbol, tf, account=1000.0, risk_pct=1.0, mode="pro", user_drawings=None, leverage=None, at=None,
            strategies=None):
    """The analysis. With `at` it is a replay: run as it would have been at that moment, from candles that had closed
    by then. Today's headlines are left out, because they did not exist then."""
    tf = _norm_tf(tf)
    spec = spec_of(symbol)
    asof = parse_moment(at) if at is not None else None
    if not _sem.acquire(timeout=60):
        raise EngineError("The analyst is busy right now. Try again in a few seconds.")
    try:
        C = _get(symbol, tf, ga.BARS[tf], refresh_s=8 if asof is None else 3600, end=asof)
        if asof is not None:
            _pin_age(C, asof)
        try:
            res = ga.analyze(symbol, tf, account=float(account), risk_pct=float(risk_pct), mode=mode,
                             user_drawings=user_drawings or None, brain=brain(), leverage=leverage, data=C, asof=asof,
                             strategies=strategies)
        except ValueError as e:
            raise EngineError(str(e))
        res = ga.jsonable(res)
    finally:
        _sem.release()
    res["meta"] = _meta(C)
    res["brain_status"] = BRAIN["status"]
    if asof is not None:
        res["replay_at"] = asof.isoformat()
        res["news"] = dict(risk="unknown", note="Headlines are live, so none are shown for a past moment.",
                           events=[], headlines=[])
        return res
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
        user_drawings=res.get("user_drawings"), learning=res.get("learning"),
        asset_class=(res.get("meta") or {}).get("asset_class"),
        report=(res.get("report") or "")[:report_chars])


def whatif(symbol, tf, price, strategies=None):
    """'If I enter here, now': buy and sell scenarios from a price on the latest candle (playbook.whatif)."""
    tf = _norm_tf(tf)
    if not _sem.acquire(timeout=60):
        raise EngineError("The analyst is busy right now. Try again in a few seconds.")
    try:
        C = _get(symbol, tf, ga.BARS[tf], refresh_s=8)
        last = C["forming"] if C["forming"] is not None else C["df"].iloc[-1]
        lo, hi = float(last["low"]), float(last["high"])
        atr_now = float(C["df"]["high"].sub(C["df"]["low"]).tail(14).mean())
        if not (lo - 3 * atr_now <= float(price) <= hi + 3 * atr_now):
            raise EngineError("Pick a price near the latest candle: 'analyse from here' is for entering now.")
        try:
            ga.analyze(symbol, tf, brain=brain(), data=C, strategies=strategies)
        except ValueError as e:
            raise EngineError(str(e))
        X = ga._STATE["ctx"].get((C["symbol"], tf))
        if X is None:
            raise EngineError("The analysis context is not available. Try again.")
        out = pb.whatif(X, float(price), brain())
        out.update(symbol=C["symbol"], tf=tf, decimals=C["decimals"])
        return ga.jsonable(out)
    finally:
        _sem.release()


_fit_cache, _fit_lock = {}, threading.Lock()


def fit(symbol, tf, ids=None, bars=3000, ttl=1800):
    """Every strategy's record on this market and timeframe (after its costs), best first. Cached for 30 minutes."""
    tf = _norm_tf(tf)
    key = (symbol.upper(), tf, tuple(sorted(ids)) if ids else None)
    now = time.time()
    with _fit_lock:
        hit = _fit_cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    C = _get(symbol, tf, bars, refresh_s=600, min_bars=300)
    dfe, A = ga.se.analyze(C["df"])
    ctx = st.Ctx(dfe, tf, A, C["asset_class"])
    cost, slip = gm.cost_of(C["sub"])
    rows = st.fit(ctx, ids, cost, slip)
    out = dict(symbol=C["symbol"], tf=tf, candles=int(len(dfe)), source=C["source"], asset_class=C["asset_class"],
               start=str(dfe.index[0]), end=str(dfe.index[-1]), sweep_depth=ctx.sweep_depth(),
               costs=dict(round_trip_pct=cost * 100, stop_slip_pct=slip * 100), rows=ga.jsonable(rows),
               note="Backtests on the candles loaded for this market, after spread, fees and slippage, with stops placed "
                    "past nearby liquidity. Past results don't promise future ones: use them to compare strategies, "
                    "not as a forecast.")
    with _fit_lock:
        _fit_cache[key] = (now, out)
        if len(_fit_cache) > 500:
            _fit_cache.clear()
    return out


def strategy_overlay(symbol, tf, sid, bars=1500):
    """One strategy's trades on this chart (entries, exits, result) and the indicator lines it uses, with epoch times,
    so the chart can draw them like a strategy report."""
    tf = _norm_tf(tf)
    if sid not in st.BY_ID:
        raise EngineError("Unknown strategy.")
    C = _get(symbol, tf, bars, refresh_s=60, min_bars=150)
    dfe, A = ga.se.analyze(C["df"])
    ctx = st.Ctx(dfe, tf, A, C["asset_class"])
    cost, slip = gm.cost_of(C["sub"])
    s = st.BY_ID[sid]
    trades = st.backtest(ctx, sid, cost, slip)
    ts = md.epoch_s(dfe.index)
    items = []
    for m in st.markers(ctx, sid, trades[-150:]):
        if m["kind"] == "marker":
            items.append(dict(kind="marker", layer="strategy", t1=int(ts[m["i"]]), p1=m["price"], symbol=m["symbol"],
                              color=m["color"], text=m["text"], why=m["why"], title=m["text"]))
        else:
            items.append(dict(kind="line", layer="strategy", t1=int(ts[m["i1"]]), t2=int(ts[m["i2"]]), p1=m["p1"],
                              p2=m["p2"], color=m["color"], dash="dot", width=1.1, text=m["text"], labelAt="end",
                              why=m["why"], title=m["text"]))
    for key, (label, color, vals) in st.indicator_lines(ctx, [sid], 0).items():
        pts, run = [], []
        for t, v in zip(ts, vals):
            if v is None or not (v == v):
                if len(run) > 1:
                    pts.append(run)
                run = []
            else:
                run.append(dict(t=int(t), p=float(v)))
        if len(run) > 1:
            pts.append(run)
        for seg in pts:
            items.append(dict(kind="path", layer="strategy", points=seg, color=color, width=1.2, title=label,
                              why=f"{label}: part of {s['name']}."))
    rec = st.record(trades, s["fixed_time"])
    live = st.live(ctx, sid, price=float(C["price"]))
    return ga.jsonable(dict(id=sid, name=s["name"], symbol=C["symbol"], tf=tf, record=rec, items=items, live=live,
                            how=s["how"]))

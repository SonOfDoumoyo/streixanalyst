"""The analyst learning from its own calls: which of its calls actually won, and how often its stops were swept.

Two things are learned from the settled calls in the journal (live and replay, duplicates left out, only accounts
that agreed to "learn from my charts"):

1. A check on its own probabilities. A logistic regression, written in numpy like services/behaviour.py, predicts
   whether a call wins from what was known when it was made: the grade, the side, the order type, the planned
   reward:risk, the timeframe, the model's own target probability, whether the verdict said trade, and whether it was a
   replay. It is only used when it beats the plain win rate on the most recent 30% of calls, which it has not seen.
2. Stop sweeps: of the calls that hit their stop, how many then reached the target before their time was up (the stop
   was run, then the move happened), and how far past the stop price went first. From those depths comes the room a
   stop would have needed to outlast most sweeps.

Nothing here changes a plan by itself. An analysis gets a `learning` note beside it, which the panel and StreixAI show,
so the person sees what the record says about calls like this one.

Retrained in the background every few hours (main.py), or from the admin console. Saved as JSON (no code is loaded)."""
import json
import logging
import math
import threading
import time
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import select

from ..config import settings
from ..models import AnalysisLog, User, jload
from .behaviour import _fit, _ll, _sig

log = logging.getLogger("streix.selflearn")
VERSION = 1
MIN_CALLS = 150          # settled calls before the probability check is fitted
MIN_TEST = 50
TEST_SHARE = 0.3
BEAT = 0.99              # must beat the baseline's log loss by at least 1% on the held-back calls
MIN_SWEEP_GROUP = 20     # stopped calls in a group before its sweep numbers are used
GRADES = ("A+", "A", "B", "C")
FEATURES = (["intercept"] + [f"grade_{g}" for g in GRADES] +
            ["long", "market", "stop_order", "log_rr", "tf", "p_logit", "called", "replay"])
TF_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1D": 1440, "3D": 4320, "1W": 10080, "1M": 43200}
_cache = {"model": None, "loaded": 0.0}
_lock = threading.Lock()


def path():
    return settings.data_dir / "models" / "selflearn.json"


def _rr(entry, sl, tp):
    try:
        risk = abs(float(entry) - float(sl))
        return abs(float(tp) - float(entry)) / risk if risk > 0 else None
    except (TypeError, ValueError):
        return None


def _x(c):
    """One call as numbers. c: dict with grade, side, type, entry, sl, tp, tf, p_tp, called, kind."""
    rr = _rr(c.get("entry"), c.get("sl"), c.get("tp")) or 1.0
    p = c.get("p_tp")
    p = min(0.98, max(0.02, float(p))) if isinstance(p, (int, float)) else 0.5
    tfm = TF_MIN.get(c.get("tf"), 60)
    return ([1.0] + [1.0 if c.get("grade") == g else 0.0 for g in GRADES] +
            [1.0 if c.get("side") == "long" else 0.0, 1.0 if c.get("type") == "market" else 0.0,
             1.0 if c.get("type") == "stop" else 0.0, math.log(max(0.05, rr)), math.log(tfm) / math.log(1440),
             math.log(p / (1 - p)), 1.0 if c.get("called") else 0.0, 1.0 if c.get("kind") == "replay" else 0.0])


def asset_class(symbol):
    try:
        import market_data as md
        return md.parse_symbol(symbol)["asset_class"]
    except Exception:
        return "other"


def rows_from_db(db):
    consenting = select(User.id).where(User.learn_consent.is_(True))
    rows = db.execute(select(AnalysisLog).where(
        AnalysisLog.kind.in_(("analysis", "replay")), AnalysisLog.dup_of.is_(None),
        AnalysisLog.outcome.in_(("tp", "sl", "time")), AnalysisLog.outcome_r.is_not(None),
        AnalysisLog.user_id.in_(consenting)).order_by(AnalysisLog.created_at, AnalysisLog.id)).scalars().all()
    return [dict(id=r.id, kind=r.kind, symbol=r.symbol, tf=r.tf, grade=r.grade, side=r.side, type=r.plan_type,
                 entry=r.entry, sl=r.sl, tp=r.tp, p_tp=r.p_tp, called=r.called, outcome=r.outcome, r=r.outcome_r,
                 swept=r.swept, depth=r.sweep_depth_r, post_final=r.post_final, mae=r.mae_r,
                 cls=(jload(r.summary, {}) or {}).get("asset_class") or asset_class(r.symbol)) for r in rows]


def _sweep_stats(rows):
    stopped = [r for r in rows if r["outcome"] == "sl" and r.get("post_final") and r.get("swept") is not None]
    swept = [r for r in stopped if r["swept"]]
    depths = np.array([r["depth"] for r in swept if isinstance(r.get("depth"), (int, float))], dtype=float)
    out = dict(stopped=len(stopped), swept=len(swept), rate=(len(swept) / len(stopped)) if stopped else None)
    if len(depths):
        out.update(depth_p50=round(float(np.percentile(depths, 50)), 3), depth_p75=round(float(np.percentile(depths, 75)), 3),
                   depth_p90=round(float(np.percentile(depths, 90)), 3))
    return out


def train(rows):
    """Fit the probability check and the sweep statistics. Returns a JSON-safe dict."""
    n = len(rows)
    base = dict(version=VERSION, created=datetime.now(timezone.utc).isoformat(), features=FEATURES, settled=n)
    wins = [1.0 if (r["r"] or 0) > 0 else 0.0 for r in rows]
    by_grade = []
    for g in ("A+", "A", "B", "C", "D"):
        sub = [w for r, w in zip(rows, wins) if r.get("grade") == g]
        if sub:
            by_grade.append(dict(grade=g, calls=len(sub), win_rate=round(sum(sub) / len(sub), 3)))
    sweeps = dict(overall=_sweep_stats(rows), by_tf={}, by_class={})
    for tf in TF_MIN:
        st = _sweep_stats([r for r in rows if r["tf"] == tf])
        if st["stopped"] >= MIN_SWEEP_GROUP:
            sweeps["by_tf"][tf] = st
    for cls in sorted({r["cls"] for r in rows}):
        st = _sweep_stats([r for r in rows if r["cls"] == cls])
        if st["stopped"] >= MIN_SWEEP_GROUP:
            sweeps["by_class"][cls] = st
    out = dict(base, win_rate=round(sum(wins) / n, 3) if n else None, by_grade=by_grade, sweeps=sweeps)
    if n < MIN_CALLS:
        return dict(out, ship=False, weights=None,
                    reason=f"{n} settled calls so far; {MIN_CALLS} are needed before the probability check is fitted.")
    cut = n - max(MIN_TEST, round(n * TEST_SHARE))
    X = np.array([_x(r) for r in rows])
    y = np.array(wins)
    w = _fit(X[:cut], y[:cut])
    p_te = _sig(X[cut:] @ w)
    ll_m = _ll(p_te, y[cut:])
    ll_b = _ll(np.full(n - cut, y[:cut].mean()), y[cut:])
    # per-call gain over the plain win rate: the check ships only if it is better by 1% AND clearly more than chance
    # (two standard errors); on ~70 test calls a 1% gain alone is often luck
    yt = y[cut:]
    eps = 1e-9
    pb = np.clip(np.full(n - cut, y[:cut].mean()), eps, 1 - eps)
    pm = np.clip(p_te, eps, 1 - eps)
    gain = (-(yt * np.log(pb) + (1 - yt) * np.log(1 - pb))) - (-(yt * np.log(pm) + (1 - yt) * np.log(1 - pm)))
    se = float(gain.std(ddof=1) / np.sqrt(len(gain))) if len(gain) > 1 else float("inf")
    ship = bool(ll_m < BEAT * ll_b and gain.mean() > 2 * se)
    return dict(out, ship=ship, weights=[round(float(v), 6) for v in w],
                reason=("The check beat the plain win rate on the latest calls, so it is shown." if ship else
                        "The check did not beat the plain win rate on the latest calls, so it is not shown."),
                card=dict(train_calls=cut, test_calls=n - cut, log_loss=round(ll_m, 5), log_loss_baseline=round(ll_b, 5),
                          improvement=round(1 - ll_m / ll_b, 4) if ll_b else None))


def save(model):
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(model, indent=1), encoding="utf-8")
    tmp.replace(p)
    with _lock:
        _cache.update(model=model, loaded=time.time())


def load():
    with _lock:
        if _cache["model"] is not None and time.time() - _cache["loaded"] < 600:
            return _cache["model"]
    try:
        m = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        m = None
    with _lock:
        _cache.update(model=m, loaded=time.time())
    return m


def retrain(db):
    model = train(rows_from_db(db))
    save(model)
    log.info("self-learning: %s settled calls, ship=%s", model["settled"], model.get("ship"))
    return model


def _sweep_for(model, tf, cls):
    sw = (model or {}).get("sweeps") or {}
    for key, grp in ((tf, "by_tf"), (cls, "by_class")):
        st = (sw.get(grp) or {}).get(key)
        if st and st.get("stopped", 0) >= MIN_SWEEP_GROUP:
            return st, key
    st = sw.get("overall")
    if st and st.get("stopped", 0) >= MIN_SWEEP_GROUP:
        return st, "all markets"
    return None, None


def note_for(res, model=None):
    """What the record says about a call like this analysis's plan, or None when there is nothing to say yet."""
    model = model if model is not None else load()
    plan = (res or {}).get("plan") or {}
    if not model or not plan.get("entry") or not plan.get("sl"):
        return None
    tps = plan.get("tps") or []
    j = min(1, len(tps) - 1) if tps else 0
    c = dict(grade=(res.get("verdict") or {}).get("grade"), side=plan.get("side"), type=plan.get("type"),
             entry=plan.get("entry"), sl=plan.get("sl"), tp=tps[j] if tps else None, tf=res.get("tf"),
             p_tp=(plan.get("p_tp") or [None] * (j + 1))[j] if isinstance(plan.get("p_tp"), list) else plan.get("p_tp"),
             called=bool((res.get("verdict") or {}).get("trade")), kind="replay" if res.get("replay_at") else "analysis")
    out = dict(settled=model.get("settled", 0))
    if model.get("ship") and model.get("weights") and model.get("features") == FEATURES and c["tp"]:
        out["p_win"] = round(float(_sig(np.array(_x(c)) @ np.array(model["weights"]))), 3)
    cls = (res.get("meta") or {}).get("asset_class") or asset_class(res.get("symbol") or "")
    st, where = _sweep_for(model, res.get("tf"), cls)
    if st and st.get("rate") is not None:
        risk = abs(float(plan["entry"]) - float(plan["sl"]))
        d = 1 if plan.get("side") == "long" else -1
        sweep = dict(rate=round(st["rate"], 3), stopped=st["stopped"], where=where)
        if st.get("depth_p75") is not None and risk > 0:
            sweep["depth_r"] = st["depth_p75"]
            sweep["wider_sl"] = round(float(plan["sl"]) - d * st["depth_p75"] * risk, 10)
        out["sweep"] = sweep
    if len(out) == 1:
        return None
    parts = []
    if "p_win" in out:
        parts.append(f"Calls like this one won {round(out['p_win'] * 100)}% of the time in the analyst's own record.")
    if "sweep" in out:
        s = out["sweep"]
        parts.append(f"{round(s['rate'] * 100)}% of stopped calls ({s['where']}) were swept: price took the stop, then "
                     f"reached the target.")
        if s.get("wider_sl") is not None:
            parts.append(f"Three in four of those sweeps went no more than {s['depth_r']:.2f}R past the stop; for this plan that "
                         f"is a stop near {s['wider_sl']:.{int((res.get('decimals') or 2))}f}. A wider stop means a smaller "
                         "position for the same risk.")
    out["message"] = " ".join(parts)
    return out

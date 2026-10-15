"""Draw & score: grade the user's own analysis against the analyst's.

Score (0–100):
  levels 40  — did you mark the levels that matter (recall) and are the levels you marked real (precision)?
  bias   20  — does your directional call fit the structure on this and the higher timeframe?
  trade  40  — the analyst's review of your trade (entry, stop, target, odds); or, with no trade, whether sitting
               out matches the analyst's verdict.
Corrections come back as chart drawings: the levels you missed, and the ones with no evidence behind them."""
from . import engine

GRADE_WORDS = [(85, "Expert"), (70, "Strong"), (55, "Solid"), (40, "Developing"), (0, "Beginner")]
TRADE_POINTS = {"A+": 40, "A": 34, "B": 26, "C": 16, "D": 6}


def _grade(score):
    return next(w for t, w in GRADE_WORDS if score >= t)


def key_levels(res, max_dist=8.0, n=6):
    lv = [c for c in (res.get("levels") or []) if abs(c.get("dist_atr", 99)) <= max_dist and c.get("strength", 0) >= 2.0]
    lv.sort(key=lambda c: (-c["strength"], abs(c["dist_atr"])))
    out = []
    for c in lv:
        if all(abs(c["price"] - o["price"]) > 0.6 * res["atr"] for o in out):
            out.append(c)
        if len(out) >= n:
            break
    return out


def _covers(u, price, tol):
    if u.get("type") == "zone" and u.get("bottom") is not None:
        return float(u["bottom"]) - tol <= price <= float(u["top"]) + tol
    lv = u.get("level")
    return lv is not None and abs(float(lv) - price) <= tol


def score_levels(res, users):
    atr = float(res["atr"])
    tol = 0.35 * atr
    keys = key_levels(res)
    lv_users = [u for u in users if u.get("level") is not None and not u.get("error")]
    hit, missed = [], []
    for c in keys:
        (hit if any(_covers(u, c["price"], tol) for u in lv_users) else missed).append(c)
    good, weak = [], []
    for u in lv_users:
        if u.get("type") == "trendline":
            ok = (u.get("touches") or 0) >= 2
        else:
            ok = bool(u.get("confluence")) or (u.get("tests", 0) >= 2 and u.get("held", 0) >= 1) or \
                any(_covers(u, c["price"], tol) for c in keys)
        (good if ok else weak).append(u)
    recall = len(hit) / len(keys) if keys else (1.0 if lv_users else 0.0)
    precision = len(good) / len(lv_users) if lv_users else 0.0
    pts = 0 if not lv_users else round(40 * (0.6 * recall + 0.4 * precision))
    return dict(score=pts, recall=recall, precision=precision, key=keys, hit=hit, missed=missed, good=good, weak=weak,
                count=len(lv_users))


def expected_bias(res):
    st = res.get("structure") or {}
    trend = int(st.get("trend") or 0)
    tfs = res.get("timeframes") or []
    htf = int(tfs[0]["trend"]) if tfs else 0
    pr = res.get("probabilities") or {}
    if trend and trend == htf:
        return ("long" if trend > 0 else "short"), f"{res['tf']} and {tfs[0]['tf']} structure both point {'up' if trend > 0 else 'down'}"
    if trend and htf and trend != htf:
        return "neutral", f"{res['tf']} is {'bullish' if trend > 0 else 'bearish'} but {tfs[0]['tf']} is " \
                          f"{'bullish' if htf > 0 else 'bearish'} — conflicting, so patience is the safer call"
    if trend:
        return ("long" if trend > 0 else "short"), f"{res['tf']} structure is {'bullish' if trend > 0 else 'bearish'}"
    pu, pd = float(pr.get("p_up") or 0), float(pr.get("p_down") or 0)
    if abs(pu - pd) > 0.12:
        return ("long" if pu > pd else "short"), "no clear structure; the model leans this way"
    return "neutral", "no clear trend: a range — wait for a break"


BIAS_WORD = {"long": "bullish", "short": "bearish", "neutral": "no clear direction (no trade)"}


def score_bias(res, bias):
    exp, why = expected_bias(res)
    b = (bias or "").lower()
    if b in ("bull", "bullish", "buy"):
        b = "long"
    if b in ("bear", "bearish", "sell"):
        b = "short"
    if b not in ("long", "short", "neutral"):
        return dict(score=0, expected=exp, yours=None, why="You didn't pick a bias.")
    if b == exp:
        pts = 20
    elif exp == "neutral":
        pts = 10
    elif b == "neutral":
        pts = 10
    else:
        pts = 2
    return dict(score=pts, expected=exp, yours=b, why=why)


def score_trade(res, trade, review):
    v = res.get("verdict") or {}
    if not trade:
        if not v.get("trade"):
            return dict(score=30, verdict="No trade — same as the analyst",
                        notes=["The analyst also says wait. Not trading a weak chart is a skill."])
        pl = res.get("plan") or {}
        return dict(score=14, verdict="No trade — the analyst found one",
                    notes=[f"The analyst's plan: {pl.get('text', v.get('action'))}. Compare it with your levels."])
    if not review or not review.get("ok"):
        return dict(score=0, verdict="Invalid trade", notes=[(review or {}).get("text", "The trade couldn't be read.")])
    grade = (review.get("plan") or {}).get("grade", "D")
    pts = TRADE_POINTS.get(grade, 6)
    if review.get("verdict", "").startswith("WEAK"):
        pts = min(pts, 18)
    if review.get("verdict", "").startswith("POOR"):
        pts = min(pts, 8)
    return dict(score=pts, verdict=review.get("verdict"), grade=grade, notes=(review.get("issues") or [])[:4],
                fixes=(review.get("fixes") or [])[:4], plan=review.get("plan"))


def corrections(res, lv):
    """Chart drawings that show what the user missed and what was weak (engine overlay format, by time)."""
    out = []
    last_t = res["candles"][-1][0] if res.get("candles") else 0
    first_t = res["candles"][0][0] if res.get("candles") else 0
    step = (res.get("meta") or {}).get("tf_seconds", 3600)
    end = last_t + 30 * step
    k = 0
    for c in lv["missed"]:
        k += 1
        out.append(dict(id=f"miss{k}", layer="practice", kind="line", order=1, prio=1, t1=first_t, t2=end, p1=c["price"],
                        p2=c["price"], color="#f5b342", dash="dash", width=1.6, extend="right",
                        text=f"Missed: {' + '.join(c['labels'][:2])}"))
    for c in lv["hit"]:
        k += 1
        out.append(dict(id=f"hit{k}", layer="practice", kind="line", order=2, prio=1, t1=first_t, t2=end, p1=c["price"],
                        p2=c["price"], color="#2fd3a6", dash="dot", width=1.2, extend="right",
                        text=f"✓ {c['labels'][0]}"))
    for u in lv["weak"]:
        if u.get("level") is None:
            continue
        k += 1
        out.append(dict(id=f"weak{k}", layer="practice", kind="line", order=3, prio=1, t1=first_t, t2=end,
                        p1=float(u["level"]), p2=float(u["level"]), color="#ff6b6b", dash="dot", width=1.2, extend="right",
                        text="No evidence here"))
    return out


def feedback(total, lv, bias, tr):
    good, improve = [], []
    if lv["count"] == 0:
        improve.append("Mark the levels you see: horizontal lines or zones at swing highs/lows, support and resistance.")
    else:
        if lv["recall"] >= 0.67:
            good.append(f"You found {len(lv['hit'])} of the {len(lv['key'])} key levels.")
        elif lv["missed"]:
            m = lv["missed"][0]
            improve.append(f"You missed {len(lv['missed'])} key level(s), e.g. {m['labels'][0]} at {m['price']:.6g}. "
                           "Look for where price reacted several times, and old highs/lows where stops rest.")
        if lv["precision"] >= 0.75:
            good.append("Your levels are backed by real reactions.")
        elif lv["weak"]:
            improve.append(f"{len(lv['weak'])} of your levels have little evidence (few reactions, nothing lines up). "
                           "Fewer, stronger levels beat many lines.")
    if bias["score"] >= 20:
        good.append(f"Right bias: {bias['why']}.")
    elif bias.get("yours"):
        improve.append(f"Bias: you said {BIAS_WORD.get(bias['yours'], bias['yours'])}, but the chart reads "
                       f"{BIAS_WORD.get(bias['expected'], bias['expected'])} — {bias['why']}.")
    for n in tr.get("notes", [])[:2]:
        (good if tr["score"] >= 26 else improve).append(n)
    for f in tr.get("fixes", [])[:2]:
        improve.append(f)
    return good, improve


def score_attempt(symbol, tf, drawings, bias, trade, account=1000.0, risk_pct=1.0):
    res = engine.analyze(symbol, tf, account=account, risk_pct=risk_pct, mode="pro", user_drawings=None)
    users = engine.grade_user_drawings(res, drawings)
    lv = score_levels(res, users)
    bs = score_bias(res, bias)
    review = None
    if trade:
        try:
            review = engine.review(symbol, tf, trade["side"], float(trade["entry"]), float(trade["sl"]),
                                   float(trade["tp"]), account=account, risk_pct=risk_pct,
                                   analysis={"symbol": res["symbol"], "tf": res["tf"]})
        except engine.EngineError as e:
            review = dict(ok=False, text=str(e))
    tr = score_trade(res, trade, review)
    total = int(max(0, min(100, lv["score"] + bs["score"] + tr["score"])))
    good, improve = feedback(total, lv, bs, tr)
    strip = lambda cs: [dict(price=c["price"], labels=c["labels"][:3], strength=c["strength"]) for c in cs]
    return dict(
        score=total, grade=_grade(total),
        breakdown=dict(
            levels=dict(score=lv["score"], of=40, recall=lv["recall"], precision=lv["precision"], count=lv["count"],
                        key=strip(lv["key"]), hit=strip(lv["hit"]), missed=strip(lv["missed"]),
                        weak=[dict(level=u.get("level"), label=u.get("label")) for u in lv["weak"]]),
            bias=dict(bs, of=20), trade=dict({k: v for k, v in tr.items() if k != "plan"}, of=40)),
        good=good, improve=improve, your_levels=users, corrections=corrections(res, lv),
        review_plan=tr.get("plan"), analysis=res)

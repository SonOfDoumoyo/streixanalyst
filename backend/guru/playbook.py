"""playbook.py: how the analyst uses the strategies a person picked.

  * plans: the analyst's own setups (OTE pullback, sweep → shift, reactions at levels, breakouts, patterns) belong to
    strategies in strategies.py; rule-based strategies add plans of their own. Only the chosen strategies' plans count.
  * the liquidity guard: every stop goes past the liquidity sitting just beyond it, by the depth stop hunts usually
    reach on this chart, and an entry right above (below) an obvious pool is flagged: wait for the sweep first.
  * records: each chosen strategy's backtest on the loaded candles. Strategies that disagree are weighed by their
    record and by the higher timeframes; a close split is "no trade".
  * the timeframe matrix: trend, last break, location and the chosen strategies' signals on every timeframe.
  * confidence: plain, modest wording. A plan is a scenario with odds, never a certainty.
  * fixed time: an up/down call with an expiry for fixed-time traders, with its record against the payout's break-even.

Research tool, not financial advice."""
import numpy as np

import guru_model as gm
import liquidity_head as lh
import market_data as md
import strategies as st
import strategy_head as sh
import structure_engine as se

# lower timeframe used to fine-tune entries, and the matrix shown for each chart timeframe
LOWER = {"1m": None, "5m": "1m", "15m": "5m", "30m": "5m", "1h": "15m", "4h": "1h", "1D": "4h", "3D": "1D",
         "1W": "1D", "1M": "1W"}
TF_WEIGHT = {"1M": 3.0, "1W": 3.0, "3D": 2.5, "1D": 2.5, "4h": 2.0, "1h": 1.5, "30m": 1.2, "15m": 1.0, "5m": 0.8,
             "1m": 0.6}


def chosen(ids):
    """The strategies the person picked (catalog ids), or None for the analyst's own mix."""
    out = st.clean_ids(ids)
    return out or None


def strategy_of(p):
    """Which strategy one of the analyst's own plans belongs to."""
    if p.get("strategy"):
        return p["strategy"]
    fam = p.get("family")
    if fam in st.GURU_SETUP:
        return st.GURU_SETUP[fam]
    setup = (p.get("setup") or "").lower()
    if setup.startswith("breakout"):
        return "breakout_retest"
    if "reaction at" in setup:
        if "breaker" in setup:
            return "breaker_block"
        if " ob" in setup or "order block" in setup:
            return "ob_retest"
        if "fvg" in setup:
            return "fvg_fill"
        return "sr_bounce"
    if "breakout" in setup:
        return "chart_patterns"
    return None


def tag(plans):
    for p in plans:
        sid = strategy_of(p)
        p["strategy"] = sid
        p["strategy_name"] = st.BY_ID[sid]["name"] if sid in st.BY_ID else None
    return plans


def rule_plans(X, ids):
    """Plans from the chosen strategies' rules (signals on the last few closed candles that are still valid)."""
    import guru_analyst as ga
    if not ids:
        return []
    ctx, f, atr, price = X["sctx"], X["f"], X["atr"], X["price"]
    out = []
    for sid in ids:
        s = st.BY_ID[sid]
        if s["fixed_time"]:
            continue
        lv = st.live(ctx, sid, price=price)
        X.setdefault("live", {})[sid] = lv
        if not lv.get("signal"):
            continue
        d = lv["dir"]
        side = "long" if d == 1 else "short"
        entry = lv["entry"]
        near = abs(price - entry) <= 0.15 * abs(entry - lv["sl"])
        kind = "market" if near else "limit"
        if kind == "market":
            entry = price
        tps = ga._targets(X["clusters"], entry, lv["sl"], d, atr, extra=[(lv["tp"], f"{s['name']} target")])
        when = "on the last closed candle" if lv["age"] == 0 else f"{lv['age']} candle{'s' if lv['age'] > 1 else ''} ago"
        why = [f"{s['name']} signalled a {'buy' if d == 1 else 'sell'} {when}: {s['how']}"]
        if kind == "limit":
            why.append(f"price has moved since: the plan waits for a return to {f.p(entry)} instead of chasing")
        p = ga._plan(side, kind, f"{s['name']}: {'buy' if d == 1 else 'sell'} signal", entry, lv["sl"], tps, why,
                     f"a close {'below' if d == 1 else 'above'} {f.p(lv['sl'])}", min(gm.EXPIRY, s["hold"]),
                     family=None, extra=dict(strategy=sid, strategy_name=s["name"], signal_age=lv["age"]))
        if p:
            out.append(p)
    return out


def guard(p, X):
    """The liquidity guard for one plan: the stop moves past liquidity just beyond it (never closer), and an entry with
    an untaken pool right under (over) it gets a 'wait for the sweep' note. Returns the plan (rebuilt if moved)."""
    import guru_analyst as ga
    ctx, f, atr = X["sctx"], X["f"], X["atr"]
    i = ctx.n - 1
    d, entry, sl = p["dir"], p["entry"], p["sl"]
    depth, learned = stop_depth(X, d, sl)
    new_sl, pool = st.guard_stop(ctx, i, d, entry, sl, depth)
    # the analyst's key levels too (zones, equal highs/lows, previous day/week levels): a stop a few ticks past one of
    # them is the first thing a sweep takes, so it goes past the level by the same stop-hunt depth
    buf = (depth + 0.05) * atr
    lv = [c["price"] for c in X.get("clusters") or []
          if d * (entry - c["price"]) > 0.15 * atr and -0.5 * atr <= d * (c["price"] - new_sl) < buf]
    if lv:
        far = min(lv) if d == 1 else max(lv)
        cand = far - d * buf
        if d * (new_sl - cand) > 0 and abs(cand - entry) <= 2.5 * abs(sl - entry):
            new_sl, pool = cand, far
    keep = {k: p[k] for k in ("zone", "strategy", "strategy_name", "signal_age", "family") if k in p}
    if pool is not None and abs(new_sl - sl) > 1e-12:
        moved = abs(new_sl - entry) / max(abs(sl - entry), 1e-12)
        why = p["why"] + [f"stop moved past the {'sell' if d == 1 else 'buy'}-side liquidity at {f.p(pool)}: stop hunts "
                          + (f"at pools like this usually reach {depth:.2f} ATR past them (learned from years of "
                             f"markets)" if learned else f"on this chart usually reach {depth:.2f} ATR past a swing")
                          + ", so a stop just beyond that is where they finish"]
        q = ga._plan(p["side"], p["type"], p["setup"], entry, new_sl,
                     ga._targets(X["clusters"], entry, new_sl, d, atr, extra=list(zip(p["tps"], p["tp_labels"]))),
                     why, p["invalidation"], p["expiry"], keep.get("family"), keep)
        if q is not None:
            q["liquidity_guard"] = dict(pool=float(pool), moved_from=float(sl), depth_atr=float(depth),
                                        wider=float(moved), learned=bool(learned))
            p = q
    # an obvious pool just past the entry on the stop side: price often takes it before going our way
    pools = ctx.pools(i, -d)
    close = [q for q in pools if 0 < d * (entry - q) <= 0.6 * atr and d * (q - p["sl"]) > 0]
    if close:
        lvl = max(close) if d == 1 else min(close)
        odds = pool_odds(X, lvl, -d)
        ps = odds.get("p_sweep") if odds else None
        if ps is None or ps >= 0.35:                      # the liquidity head can rule out a pool unlikely to be hit
            extra = ""
            if ps is not None:
                extra = f" There's about a {round(ps * 100)}% chance it's taken within {LIQ_H} candles"
                pr = odds.get("p_reverse")
                extra += (f", and after sweeps of pools like it price reversed {round(pr * 100)}% of the time." if pr
                          is not None else ".")
            p["sweep_first"] = dict(level=float(lvl), entry_after=float(lvl - d * 0.5 * depth * atr), p_sweep=ps,
                                    p_reverse=(odds or {}).get("p_reverse"), note=(
                f"{'Sell' if d == 1 else 'Buy'}-side liquidity at {f.p(lvl)} sits just {'under' if d == 1 else 'over'} "
                f"the entry. Price often takes it first.{extra} Safer: wait for a sweep of {f.p(lvl)} and a close back "
                f"{'above' if d == 1 else 'below'} it, or enter nearer {f.p(lvl - d * 0.5 * depth * atr)}."))
    return p


LIQ_H = 24


def pool_odds(X, level, side):
    """The liquidity head's numbers for the pool at `level` (side +1 above, -1 below price), or None."""
    rows = X.get("liq") or []
    best = None
    for r in rows:
        if r["side"] == side and abs(r["price"] - level) <= 0.05 * X["atr"]:
            if best is None or abs(r["price"] - level) < abs(best["price"] - level):
                best = r
    return best


def stop_depth(X, d, sl):
    """How far past a pool to put a stop (ATR): the liquidity head's learned hunt depth for the pool nearest the
    stop, when the head is trained and passed its test; else this chart's own 80th percentile. (depth, learned?)"""
    rows = [r for r in (X.get("liq") or []) if r["side"] == -d and r.get("depth_atr") is not None]
    if rows:
        r = min(rows, key=lambda r: abs(r["price"] - sl))
        if abs(r["price"] - sl) <= 1.5 * X["atr"]:
            return float(np.clip(r["depth_atr"], 0.12, 1.5)), True
    return float(X["depth"]), False


def records(X, ids):
    """Each chosen strategy's record on the loaded candles (after this market's costs), with its trades."""
    out = {}
    if not ids:
        return out
    ctx = X["sctx"]
    for sid in ids:
        s = st.BY_ID[sid]
        if s["intraday"] and X["tf"] in ("1D", "3D", "1W", "1M"):
            out[sid] = dict(record=dict(trades=0, verdict="needs an intraday chart (1m–4h)"), trades=[], score=0.0)
            continue
        try:
            tr = st.backtest(ctx, sid, X["cost"], X["slip"], guard=True)
        except Exception as e:
            out[sid] = dict(record=dict(trades=0, verdict=f"could not test ({type(e).__name__})"), trades=[], score=0.0)
            continue
        rec = st.record(tr, s["fixed_time"])
        out[sid] = dict(record=rec, trades=tr, score=st.score_of(rec))
    return out


def rank_bonus(p, X):
    r = (X.get("records") or {}).get(p.get("strategy"))
    bonus = 2.0 * (r["score"] if r else 0.0)
    h = p.get("head")
    if h:                                                 # years of similar signals, not just this chart's candles
        bonus += 3.0 * float(np.clip(h["ev"], -0.5, 0.5))
    return bonus


def _htf_agree(X, d):
    vals = []
    for h in X["ladder"][:2]:
        hs = X["htf"].get(h)
        if hs:
            vals.append(1.0 if hs["trend"] == d else -1.0 if hs["trend"] == -d else 0.0)
    return float(np.mean(vals)) if vals else 0.0


def conflict(plans, X):
    """Do the chosen strategies point opposite ways right now? Each strategy with a live plan votes for its side,
    weighted by its record on this chart and by the higher timeframes."""
    if not X.get("chosen"):
        return None
    price, atr = X["price"], X["atr"]
    votes = {}
    for p in plans:
        sid = p.get("strategy")
        live_now = (p.get("signal_age") is not None and p["signal_age"] <= 3) or p["type"] == "market" or \
            abs(p["entry"] - price) <= 1.0 * atr
        if not sid or not live_now:
            continue
        rec = (X.get("records") or {}).get(sid) or {}
        h = p.get("head") or {}
        w = max(0.2, 1.0 + rec.get("score", 0.0) + 0.5 * _htf_agree(X, p["dir"])
                + float(np.clip(h.get("ev", 0.0), -0.5, 0.5)))
        votes.setdefault(sid, {})[p["dir"]] = max(votes.get(sid, {}).get(p["dir"], 0.0), w)
    long_w = sum(v.get(1, 0.0) for v in votes.values())
    short_w = sum(v.get(-1, 0.0) for v in votes.values())
    if not long_w or not short_w:
        return dict(split=False, long=long_w, short=short_w,
                    side=1 if long_w > short_w else -1 if short_w > long_w else 0)
    margin = abs(long_w - short_w) / (long_w + short_w)
    side = 1 if long_w > short_w else -1
    names = lambda d: [st.BY_ID[s]["name"] for s, v in votes.items() if v.get(d)]
    return dict(split=margin < 0.25, margin=float(margin), long=float(long_w), short=float(short_w), side=side,
                buyers=names(1), sellers=names(-1),
                note=(f"Your strategies disagree: {', '.join(names(1))} say buy, {', '.join(names(-1))} say sell. "
                      + ("The split is close, so this is a time to stand aside." if margin < 0.25 else
                         f"The {'buy' if side == 1 else 'sell'} side is stronger once each strategy's record on this "
                         f"chart and the higher timeframes are weighed, but treat it with extra care.")))


def confidence(p, X):
    """How much weight a plan deserves, in plain words. Never 'certain': the best is 'good'."""
    if p is None:
        return dict(level="none", score=0.0, text="No plan worth taking right now.", reasons=[])
    j = min(1, len(p["tps"]) - 1)
    pts, reasons = 0.0, []
    g = {"A+": 2.0, "A": 1.5, "B": 1.0, "C": 0.3, "D": 0.0}.get(p["grade"], 0.0)
    pts += g
    edge = p["p_tp"][j] - p["breakeven"][j]
    pts += float(np.clip(edge * 10, -1.5, 1.5))
    reasons.append(f"similar setups reached TP{j + 1} before the stop about {round(p['p_tp'][j] * 100)}% of the time "
                   f"(break-even needs {round(p['breakeven'][j] * 100)}%)")
    a = X.get("mtf_alignment")
    if a is not None:
        pts += float(np.clip(a * p["dir"], -1, 1))
        if a * p["dir"] > 0.3:
            reasons.append("the timeframes mostly agree")
        elif a * p["dir"] < -0.3:
            reasons.append("the bigger timeframes lean the other way")
    rec = (X.get("records") or {}).get(p.get("strategy"))
    if rec and rec["record"].get("trades", 0) >= 15:
        pts += float(np.clip(rec["score"] * 2, -1, 1))
        r = rec["record"]
        reasons.append(f"{p.get('strategy_name')} on this chart: {r['trades']} trades, {r['win_rate'] * 100:.0f}% won, "
                       f"{r['avg_r']:+.2f}R on average")
    h = p.get("head")
    if h:
        pts += float(np.clip((h["p_win"] - h["needed"]) * 6, -1.0, 1.0))
        reasons.append(f"across years of markets, {p.get('strategy_name') or 'this strategy'}'s signals like this one "
                       f"ended in profit (at its own target or time limit) about {round(h['p_win'] * 100)}% of the time "
                       f"(needs about {round(h['needed'] * 100)}%)")
    if p.get("sweep_first"):
        pts -= 0.5
        ps = p["sweep_first"].get("p_sweep")
        reasons.append("liquidity right under the entry may be taken first"
                       + (f" ({round(ps * 100)}% chance within {LIQ_H} candles)" if ps is not None else ""))
    if X.get("brain") is not None and getattr(X["brain"], "untrained", False):
        pts = min(pts, 2.0)
        reasons.append("the odds model isn't trained yet, so the odds are rough")
    level = "good" if pts >= 3.5 else "moderate" if pts >= 2.0 else "low"
    word = {"good": "Good", "moderate": "Moderate", "low": "Low"}[level]
    return dict(level=level, score=round(float(pts), 2), reasons=reasons,
                text=f"{word} confidence. This is a scenario, not a certainty: " + "; ".join(reasons[:3]) + ".")


def soften(verdict, p, X, conf, clash):
    """Modest wording on top of the analyst's verdict: a possible trade, its confidence, and what can change it."""
    v = dict(verdict)
    v["confidence"] = conf
    v["tf_note"] = (f"Analysis can change with every new {X['tf']} candle and differ on other timeframes. Recheck after "
                    f"the next candle closes, and check the timeframe table before entering.")
    ids = X.get("chosen")
    if p is None and ids:
        ft = X.get("fixed_time")
        price_ids = [i for i in ids if not st.BY_ID[i]["fixed_time"]]
        if ft and ft.get("direction") and (ft.get("edge") or 0) > 0.01:
            v.update(action=f"Fixed time: {ft['direction']} for {ft['expiry']} candles", trade=False, side=None,
                     headline=ft["text"], fixed_time_call=True)
        elif not price_ids:
            v.update(action="NO CALL (wait)", headline=(ft or {}).get("text") or "No fixed-time call right now.")
        else:
            waits = [st.BY_ID[i]["wait_for"] for i in price_ids][:3]
            v.update(action="NO TRADE (wait)", headline="None of your strategies has a setup on this chart right now. "
                     "Wait for " + "; or ".join(waits) + ".")
        return v
    if clash and clash.get("split"):
        v.update(action="NO TRADE (strategies disagree)", trade=False, side=None, conflict=clash,
                 headline=clash["note"])
        return v
    if clash and clash.get("sellers") and clash.get("buyers"):
        v["conflict"] = clash
    # the grade never says more than the confidence does: an "A" with low confidence reads as a promise
    cap = {"low": "C", "moderate": "B"}.get(conf.get("level"))
    order = ["A+", "A", "B", "C", "D"]
    if cap and p is not None:
        for obj in (v, p):
            g = obj.get("grade")
            if g in order and order.index(g) < order.index(cap):
                obj["grade"] = cap
    if v.get("trade") and p is not None:
        word = "BUY" if p["dir"] == 1 else "SELL"
        how = {"market": "now (market)", "limit": f"limit at {X['f'].p(p['entry'])}",
               "stop": f"stop order at {X['f'].p(p['entry'])}"}[p["type"]]
        v["action"] = f"Possible {word} · {how}"
        v["headline"] = (f"Possible {word.lower()} {how} · {conf['level']} confidence · {p['setup']}"
                         + (f" ({p['strategy_name']})" if p.get("strategy_name") else ""))
    return v


def how_to_enter(p, X):
    """Step-by-step: how to take this plan without getting caught by the usual traps."""
    if p is None:
        return []
    f = X["f"]
    d = p["dir"]
    w = "buy" if d == 1 else "sell"
    steps = []
    if p["type"] == "market":
        steps.append(f"Wait for the current {X['tf']} candle to close {'above' if d == 1 else 'below'} "
                     f"{f.p(p['entry'])} before you {w}; a signal on a candle that hasn't closed can disappear.")
    elif p["type"] == "limit":
        steps.append(f"Place a {w} limit at {f.p(p['entry'])}. If price never comes back there, there is no trade: "
                     f"don't chase it.")
    else:
        steps.append(f"Place a {w} stop order at {f.p(p['entry'])}: it only fills if price breaks through.")
    if p.get("sweep_first"):
        steps.append(p["sweep_first"]["note"])
    steps.append(f"Stop loss at {f.p(p['sl'])}, set at the same time as the entry. "
                 + ("It sits past the nearby liquidity so a stop hunt is less likely to take you out. "
                    if p.get("liquidity_guard") else "")
                 + "Size the position so this stop costs no more than your risk per trade (1% is common).")
    tps = p["tps"]
    steps.append(f"Take part profit at TP1 {f.p(tps[0])}"
                 + (f", move the stop to break-even, and let the rest run to TP2 {f.p(tps[1])}" if len(tps) > 1 else "")
                 + ".")
    steps.append(f"Cancel the idea if {p['invalidation']}, or if nothing has filled within {p['expiry']} candles.")
    if X["intraday"] and X.get("news_high"):
        steps.append("High-impact news is close: wait until it has passed.")
    return steps


def _frame_row(tf, df, A, ids, price=None, asset_class=None):
    """One row of the timeframe table: trend, last break, location and signals."""
    n = len(df)
    t = int(A["trend"][-1])
    ev = A["events"][-1] if A["events"] else None
    c = df["close"].to_numpy(dtype=float)
    e50 = st._ema(c, 50)
    e200 = st._ema(c, 200)
    rsi = float(st._rsi(c, 14)[-1])
    hi = float(df["high"].tail(100).max())
    lo = float(df["low"].tail(100).min())
    pos = (c[-1] - lo) / (hi - lo) if hi > lo else 0.5
    ema_bias = 0
    if np.isfinite(e50[-1]) and np.isfinite(e200[-1]):
        ema_bias = 1 if c[-1] > e50[-1] > e200[-1] else -1 if c[-1] < e50[-1] < e200[-1] else 0
    bias = float(np.clip(0.6 * t + 0.4 * ema_bias, -1, 1))
    sigs = []
    if ids:
        ctx = st.Ctx(df, tf, A, asset_class)
        for sid in ids:
            s = st.BY_ID[sid]
            if s["intraday"] and tf in ("1D", "3D", "1W", "1M"):
                continue
            lv = st.live(ctx, sid, max_age=2)
            if lv.get("signal"):
                sigs.append(dict(id=sid, name=s["name"], dir=lv["dir"], age=lv.get("age", 0)))
    return dict(tf=tf, trend=t, trend_word={1: "up", -1: "down", 0: "unclear"}[t], ema_bias=ema_bias,
                bias=round(bias, 2), rsi=round(rsi, 1), zone="premium" if pos > 0.55 else "discount" if pos < 0.45 else
                "middle", range_pos=round(float(pos), 2),
                last_event=None if ev is None else dict(kind=ev["kind"], direction=ev["direction"], level=float(ev["level"]),
                                                        bars_ago=int(n - 1 - ev["idx"])),
                signals=sigs)


def mtf(X, symbol, HT, asof=None, ids=None):
    """The timeframe table: every timeframe from the higher ones the analyst loaded to one lower timeframe."""
    rows = []
    tf = X["tf"]
    for h in X["ladder"][::-1]:
        v = HT.get(h)
        if v is None:
            continue
        try:
            rows.append(_frame_row(h, v["df"], v["A"], ids, asset_class=X["asset_class"]))
        except Exception:
            continue
    try:
        rows.append(dict(_frame_row(tf, X["df"], X["A"], ids, asset_class=X["asset_class"]), current=True))
    except Exception:
        pass
    low = LOWER.get(tf)
    if low:
        try:
            Cl = md.get_candles(symbol, low, bars=600, end=asof, min_bars=60)
            dl, Al = se.analyze(Cl["df"])
            rows.append(dict(_frame_row(low, dl, Al, ids, asset_class=X["asset_class"]), lower=True))
        except Exception:
            pass
    rows.sort(key=lambda r: -md.TF_MIN[r["tf"]])
    if not rows:
        return dict(rows=[], alignment=0.0, text="")
    w = np.array([TF_WEIGHT.get(r["tf"], 1.0) for r in rows])
    b = np.array([r["bias"] for r in rows])
    align = float((w * b).sum() / w.sum())
    word = ("aligned up" if align > 0.45 else "leaning up" if align > 0.15 else "aligned down" if align < -0.45 else
            "leaning down" if align < -0.15 else "mixed")
    ups = [r["tf"] for r in rows if r["bias"] > 0.2]
    dns = [r["tf"] for r in rows if r["bias"] < -0.2]
    text = (f"Timeframes {word}: up on {', '.join(ups) or 'none'}; down on {', '.join(dns) or 'none'}."
            + (" Trade with the higher timeframes, or stand aside when they fight." if word == "mixed" else ""))
    return dict(rows=rows, alignment=round(align, 2), word=word, text=text)


def fixed_time(X, ids):
    """An up/down call with an expiry for fixed-time traders, from the chosen fixed-time strategies."""
    ft = [s for s in (ids or []) if st.BY_ID[s]["fixed_time"]]
    if not ft:
        return None
    ctx = X["sctx"]
    mins = md.TF_MIN[X["tf"]]
    calls = []
    for sid in ft:
        s = st.BY_ID[sid]
        lv = st.live(ctx, sid)
        rec = (X.get("records") or {}).get(sid, {}).get("record") or {}
        n = rec.get("trades", 0)
        wr = rec.get("win_rate", 0.5)
        p = (wr * n + 0.5 * 30) / (n + 30)                       # shrunk toward a coin flip when there are few calls
        head = None
        if lv.get("signal"):
            head = sh.score(getattr(X.get("brain"), "strat", None), ctx, X["row"], sid, lv["dir"], lv["entry"],
                            lv["entry"], lv["entry"], X["cost"], X["slip"])
            if head:                                          # years of history weigh more than one chart's candles
                p = 0.7 * head["p_win"] + 0.3 * p
        calls.append(dict(id=sid, name=s["name"], signal=lv.get("signal"), dir=lv.get("dir"), expiry=s["expiry"],
                          expiry_minutes=s["expiry"] * mins, p_win=float(p), record=rec,
                          last=lv.get("last"), head=head))
    live_calls = [c for c in calls if c["signal"]]
    be = 1 / (1 + st.FT_PAYOUT)
    out = dict(breakeven=be, payout=st.FT_PAYOUT, calls=calls, tf=X["tf"])
    dirs = {c["dir"] for c in live_calls}
    skip = []
    if X["intraday"] and X.get("news_high"):
        skip.append("high-impact news is close")
    ph = X.get("phase") or {}
    if ph.get("adx", 0) > 45:
        skip.append("the move is very stretched (ADX above 45)")
    if not live_calls:
        out.update(direction=None, text="No fixed-time call on the last closed candle. Wait for one of your fixed-time "
                                        "setups: " + "; ".join(st.BY_ID[c['id']]['wait_for'] for c in calls) + ".")
    elif len(dirs) > 1:
        out.update(direction=None, text="Your fixed-time strategies disagree on this candle: skip it.")
    else:
        best = max(live_calls, key=lambda c: c["p_win"])
        d = best["dir"]
        edge = best["p_win"] - be
        out.update(direction="UP" if d == 1 else "DOWN", expiry=best["expiry"], expiry_minutes=best["expiry_minutes"],
                   p_win=best["p_win"], edge=edge, strategy=best["name"],
                   text=(f"{'UP' if d == 1 else 'DOWN'} for {best['expiry']} candles ({best['expiry_minutes']} min) from "
                         f"{best['name']}. "
                         f"{'Across years of markets and on this chart' if best.get('head') else 'On this chart'} "
                         f"such calls won about {round(best['p_win'] * 100)}% vs "
                         f"{round(be * 100)}% needed at an {round(st.FT_PAYOUT * 100)}% payout"
                         + (": skip it, there's no edge." if edge <= 0.01 else ".")))
        if edge <= 0.01:
            skip.append("its record here doesn't beat the payout's break-even")
    out["skip_if"] = skip
    return out


def liquidity_map(X):
    """The liquidity around price: the nearest untaken pools on each side, how deep stop hunts usually reach, and the
    side price is most likely drawn to next. With the liquidity head (Notebook 10) every pool also gets its odds of
    being swept within 24 candles and of reversing after the sweep, and the draw is the side most likely taken first."""
    ctx, f, price = X["sctx"], X["f"], X["price"]
    i = ctx.n - 1
    above = sorted(p for p in ctx.pools(i, 1) if p > price)[:4]
    below = sorted((p for p in ctx.pools(i, -1) if p < price), reverse=True)[:4]
    pools = [c for c in X["clusters"] if any(k in " ".join(c["labels"]).lower() for k in ("equal", "liquidity", "pdh",
                                                                                          "pdl", "asian"))]
    up = min((c for c in pools if c["side"] == "above"), key=lambda c: c["dist_atr"], default=None)
    dn = max((c for c in pools if c["side"] == "below"), key=lambda c: c["dist_atr"], default=None)
    lean = X.get("mtf_alignment", 0.0) or 0.0
    draw = None
    if up and dn:
        su = (up.get("strength", 1) + 2 * max(lean, 0)) / max(abs(up["dist_atr"]), 0.3)
        sd = (dn.get("strength", 1) + 2 * max(-lean, 0)) / max(abs(dn["dist_atr"]), 0.3)
        draw = "above" if su > sd else "below"
    elif up or dn:
        draw = "above" if up else "below"
    tgt = up if draw == "above" else dn if draw == "below" else None
    draw_level = None if tgt is None else float(tgt["price"])
    draw_labels = None if tgt is None else tgt["labels"][:3]
    learned = [r for r in (X.get("liq") or []) if r.get("p_sweep") is not None]
    rows, odds_text = [], ""
    if learned:
        rows = [dict(price=r["price"], side="above" if r["side"] == 1 else "below", kind=lh.type_word(r),
                     d_atr=round(r["d_atr"], 2), p_sweep=r["p_sweep"], p_reverse=r.get("p_reverse"),
                     depth_atr=r.get("depth_atr")) for r in learned]
        first = max(learned, key=lambda r: r["p_sweep"])
        if first["p_sweep"] >= 0.25:
            draw = "above" if first["side"] == 1 else "below"
            draw_level, draw_labels = float(first["price"]), [lh.type_word(first)]
            odds_text = (f"Most likely taken first: the {lh.type_word(first)} at {f.p(first['price'])} "
                         f"({round(first['p_sweep'] * 100)}% within {LIQ_H} candles"
                         + (f"; after sweeps there, price reversed {round(first['p_reverse'] * 100)}% of the time"
                            if first.get("p_reverse") is not None else "") + "). ")
        else:
            odds_text = (f"No pool near price is likely to be taken within {LIQ_H} candles (the best chance is "
                         f"{round(first['p_sweep'] * 100)}%). ")
    return dict(depth_atr=float(X["depth"]), above=[float(p) for p in above], below=[float(p) for p in below],
                draw=draw, draw_level=draw_level, draw_labels=draw_labels, pools=rows, learned=bool(learned),
                text=(f"Stop hunts on this chart usually reach {X['depth']:.2f} ATR past a swing. "
                      + (f"Nearest buy-side liquidity {f.p(above[0])}. " if above else "")
                      + (f"Nearest sell-side liquidity {f.p(below[0])}. " if below else "")
                      + (odds_text or (f"Price looks drawn to the liquidity {'above' if draw == 'above' else 'below'} at "
                                       f"{f.p(tgt['price'])} ({', '.join(tgt['labels'][:2])})." if tgt else ""))))


def whatif(X, price, brain=None):
    """'If I enter here, now': a buy and a sell from `price` on the latest candle, each with a stop past the nearest
    liquidity, targets at the next levels, the odds of reaching them first, and which side (if either) is better."""
    import guru_analyst as ga
    brain = brain or X["brain"]
    ctx, f, atr, now = X["sctx"], X["f"], X["atr"], X["price"]
    i = ctx.n - 1
    depth = X["depth"]
    sides = []
    for d in (1, -1):
        pools = [q for q in ctx.pools(i, -d) if d * (price - q) > 0.25 * atr]
        if pools:
            near = max(pools) if d == 1 else min(pools)
            sl = near - d * (depth + 0.05) * atr if d * (price - near) <= 3.5 * atr else price - d * 1.5 * atr
        else:
            sl = price - d * 1.5 * atr
        if d * (price - sl) < 0.5 * atr:
            sl = price - d * 0.5 * atr
        kind = "market" if abs(price - now) <= 0.05 * atr else ("limit" if d * (now - price) > 0 else "stop")
        tps = ga._targets(X["clusters"], price, sl, d, atr)
        p = ga._plan("long" if d == 1 else "short", kind, f"{'Buy' if d == 1 else 'Sell'} from {f.p(price)}", price, sl,
                     tps, [f"you picked {f.p(price)} on the latest candle"], f"price reaching {f.p(sl)}", gm.EXPIRY)
        if p is None:
            continue
        p = guard(p, X)
        p = ga.evaluate_plan(p, X, brain)
        j = min(1, len(p["tps"]) - 1)
        warn = []
        opp = [q for q in ctx.pools(i, d) if 0 < d * (q - price) <= 0.6 * atr]
        if opp:
            lvl = min(opp) if d == 1 else max(opp)
            warn.append(f"{'Buy' if d == 1 else 'Sell'}-side liquidity at {f.p(lvl)} is only "
                        f"{abs(lvl - price) / atr:.2f} ATR away: price often tags it and turns, so the room to move is "
                        f"small.")
        if p.get("sweep_first"):
            warn.append(p["sweep_first"]["note"])
        a = X.get("mtf_alignment", 0.0) or 0.0
        if a * d < -0.3:
            warn.append(f"The bigger timeframes lean {'down' if d == 1 else 'up'}: this is a counter-trend "
                        f"{'buy' if d == 1 else 'sell'}.")
        for c in p["checklist"]:
            if not c["ok"] and c["w"] < 0:
                warn.append(c["text"][0].upper() + c["text"][1:] + ".")
        sides.append(dict(side=p["side"], dir=d, type=kind, entry=float(price), sl=float(p["sl"]), tps=p["tps"],
                          tp_labels=p["tp_labels"], rr=p["rr"], p_tp=p["p_tp"], breakeven=p["breakeven"], ev=p["ev"],
                          p_fill=p["p_fill"], grade=p["grade"], score=p["score"], checklist=p["checklist"],
                          liquidity_guard=p.get("liquidity_guard"), sweep_first=p.get("sweep_first"), warnings=warn[:5],
                          ev_main=float(p["ev"][j]), confidence=confidence(dict(p, strategy=None), X)))
    best = None
    if sides:
        ranked = sorted(sides, key=lambda s: -(s["ev_main"] + 0.15 * s["score"]))
        top = ranked[0]
        if top["ev_main"] > 0.02 and top["grade"] in ("A+", "A", "B"):
            best = top["side"]
    if best:
        b = next(s for s in sides if s["side"] == best)
        text = (f"From {f.p(price)}, a {'buy' if best == 'long' else 'sell'} has the better odds: grade {b['grade']}, "
                f"{round(b['p_tp'][min(1, len(b['tps']) - 1)] * 100)}% to reach TP{min(2, len(b['tps']))} first. Still "
                f"a scenario, not a certainty.")
    else:
        text = (f"From {f.p(price)}, neither a buy nor a sell has an edge right now. Better to wait for one of your "
                f"strategies' setups.")
    return dict(price=float(price), now=float(now), sides=sides, better=best, text=text,
                p_up=X["prob"]["p_up"], p_down=X["prob"]["p_down"], horizon=X["prob"]["horizon"],
                tf_note=f"Only for the latest {X['tf']} candle. It changes as price moves.")

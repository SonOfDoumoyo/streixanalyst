"""The analyst's reasons on the chart (the glass HUD the web app draws after Analyse).

For the best plan it works out what stands in the way of taking it right now, and where each reason sits on the chart
(a price, and the candle it comes from when there is one): liquidity not swept yet, structure not shifted yet, a bigger
timeframe against it, an entry into an opposing level, news, the session clock. Each reason the chart can show becomes
a numbered flag; every check also goes in a list with a tick or a cross. It adds the scenario that would turn the idea
into a trade (a dotted path through the flags to the entry and the targets) and a short verdict: Wait, Don't trade, or
Possible buy / sell.

Times are epoch seconds of candle opens, the same clock as the chart's candles, so the web app can place every flag
with the chart's own coordinates however the person zooms or scrolls."""
import numpy as np
import pandas as pd

import market_data as md
import playbook as pb

MAX_FLAGS = 5            # numbered flags on the chart (the rest stay in the list)
MAX_GOOD = 2             # ticks drawn on the chart (things already in place)
LEG_BARS = (2, 14)       # candles per leg of the scenario path


def _t(X, idx):
    d_ = X["df"]
    i = int(min(max(int(idx), 0), len(d_) - 1))
    return int(md.epoch_s(d_.index[i:i + 1])[0])


def _last_t(X):
    forming = X["C"].get("forming")
    if forming is not None:
        return int(md.epoch_s(pd.DatetimeIndex([forming.name]))[0])
    return _t(X, len(X["df"]) - 1)


def _epoch(ts):
    try:
        ts = pd.Timestamp(ts)
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        return int(ts.timestamp())
    except Exception:
        return None


def _idx_near(X, level, tol_atr=0.05):
    """The candle of the swing (or equal highs / lows) nearest `level`, for anchoring a pool given only by price."""
    A, atr = X["A"], X["atr"]
    best, gap = None, tol_atr * atr
    for s in A["swings"]:
        g = abs(s["price"] - level)
        if g <= gap:
            best, gap = int(s["idx"]), g
    for pl in A["liquidity"]["pools"]:
        g = abs(pl["level"] - level)
        if g <= gap:
            best, gap = int(pl["idx_b"]), g
    return best


def _hunt_pool(X, d, max_atr=3.0):
    """The nearest untaken pool on the side where stops get hunted before a move toward d (below price for a buy,
    above for a sell), within max_atr ATR of price: (price, candle index, kind) or None."""
    A, price, atr = X["A"], X["price"], X["atr"]
    side = -d
    liq = A["liquidity"]
    cands = [(float(s["price"]), int(s["idx"]), "swing low" if side == -1 else "swing high")
             for s in (liq["sell_side"] if side == -1 else liq["buy_side"])]
    cands += [(float(pl["level"]), int(pl["idx_b"]), "equal lows" if side == -1 else "equal highs")
              for pl in liq["pools"] if not pl["taken"] and pl["kind"] == ("EQL" if side == -1 else "EQH")]
    cands = [c for c in cands if side * (c[0] - price) > 0 and abs(c[0] - price) <= max_atr * atr]
    if not cands:
        return None
    # equal highs / lows are the obvious pool: they win when about as near
    return min(cands, key=lambda c: abs(c[0] - price) * (0.8 if c[2].startswith("equal") else 1.0))


def _shift_level(X, d):
    """The swing a close has to break for structure to turn toward d: the latest swing high above price for a buy,
    the latest swing low below price for a sell. (price, candle index) or None."""
    typ, price = ("high" if d == 1 else "low"), X["price"]
    for s in reversed(X["A"]["swings"]):
        if s["type"] == typ and d * (s["price"] - price) > 0:
            return float(s["price"]), int(s["idx"])
    return None


def _trend_rows(X):
    rows = [r for r in (X.get("mtf") or {}).get("rows", []) if not r.get("lower")]
    return [dict(tf=r["tf"], dir=int(r.get("trend") or 0)) for r in rows][:4]


def _pools_word(kind):
    return {"equal highs": "Equal highs", "equal lows": "Equal lows", "swing high": "The swing high",
            "swing low": "The swing low"}.get(kind, "Liquidity")


def _flags_for_plan(X, p, now_s):
    """Flags (on the chart) and checks (the list) for one plan."""
    import guru_analyst as ga
    f, atr, price, tfw = X["f"], X["atr"], X["price"], X["tf"]
    d = p["dir"]
    word, Word = ("buy", "Buy") if d == 1 else ("sell", "Sell")
    by = {}
    for c in p.get("checklist") or []:
        by.setdefault(c.get("key"), c)
    flags, good = [], []

    # 1 · liquidity on the hunt side
    sf = p.get("sweep_first")
    sweep_ok = bool((by.get("sweep") or {}).get("ok"))
    hp, odds = None, None
    if sf:
        hp = (float(sf["level"]), _idx_near(X, sf["level"]), "liquidity")
        # its own row in the list: an older sweep can tick "swept recently" while this pool is still there
        odds = sf.get("p_sweep")
    elif not sweep_ok:
        hp = _hunt_pool(X, d)
        if hp:
            odds = (pb.pool_odds(X, hp[0], -d) or {}).get("p_sweep")
    if hp:
        lvl, idx, kind = hp
        depth = float(X.get("depth") or 0.3)
        stops = "sell" if d == 1 else "buy"
        if sf:
            text = (f"{stops.capitalize()}-side liquidity at {f.p(lvl)} sits just {'under' if d == 1 else 'over'} the "
                    f"entry. Price often takes it first.")
        else:
            verb = "hold" if kind.startswith("equal") else "holds"
            text = f"{_pools_word(kind)} at {f.p(lvl)} {verb} {stops} stops."
        if odds is not None:
            text += f" About {round(odds * 100)}% chance they're swept within {pb.LIQ_H} candles."
        text += f" {Word}ing before that means {word}ing into the hunt."
        flags.append(dict(
            key="pool" if sf else "sweep", tone="wait", kind="level", price=lvl, t=None if idx is None else _t(X, idx),
            zone=sorted([lvl, lvl - d * depth * atr]),
            title=f"Liquidity {'below' if d == 1 else 'above'} isn't taken yet",
            short=f"{f.p(lvl)} not swept" + (f" · {round(odds * 100)}%" if odds is not None else ""),
            text=text, need=f"a sweep of {f.p(lvl)}"))
    elif sweep_ok:
        side = "sell-side" if d == 1 else "buy-side"
        sw = [s for s in X["A"]["sweeps"] if s["side"] == side]
        if sw:
            s = sw[-1]
            good.append(dict(key="sweep", tone="good", kind="level", price=float(s["wick"]), t=_t(X, s["idx"]),
                             title=f"{side.capitalize()} liquidity swept", short="Swept",
                             text=f"Stops past {f.p(s['level'])} were taken and price closed back: the hunt is done."))

    # 2 · structure
    if X["trend"] != d:
        sl_ = _shift_level(X, d)
        now_word = "down" if X["trend"] == -1 else "up" if X["trend"] == 1 else "sideways"
        if sl_:
            lvl, idx = sl_
            # a condition only when breaking it still leaves room to the first target; else a warning
            on_way = d * (p["tps"][0] - lvl) > 0.25 * atr
            flags.append(dict(
                key="structure", tone="wait" if on_way else "bad", kind="level", price=lvl, t=_t(X, idx),
                title="No structure shift yet",
                short=f"Needs a close {'above' if d == 1 else 'below'} {f.p(lvl)}",
                text=(f"{tfw} structure still points {now_word}. A {word} needs a {tfw} close "
                      f"{'above' if d == 1 else 'below'} {f.p(lvl)}, the last swing {'high' if d == 1 else 'low'}"
                      + (", after the sweep." if hp and on_way else ".") if on_way else
                      f"{tfw} structure still points {now_word}: a {word} is against it until a {tfw} close "
                      f"{'above' if d == 1 else 'below'} {f.p(lvl)}."),
                need=f"a {tfw} close {'above' if d == 1 else 'below'} {f.p(lvl)}" if on_way else None))
        else:
            flags.append(dict(key="structure", tone="bad", kind="chip", price=None, t=None,
                              title="No structure shift yet", short=f"{tfw} structure is {now_word}",
                              text=f"{tfw} structure still points {now_word}: a {word} is against it."))
    else:
        ev = [e for e in X["A"]["events"] if (e["direction"] == "bullish") == (d == 1)]
        if ev and len(X["df"]) - 1 - ev[-1]["idx"] <= 80:
            e = ev[-1]
            good.append(dict(key="structure", tone="good", kind="level", price=float(e["level"]), t=_t(X, e["idx"]),
                             title=f"{e['kind']} {'up' if d == 1 else 'down'}", short="Structure agrees",
                             text=f"{tfw} structure broke {'up' if d == 1 else 'down'} at {f.p(e['level'])}."))

    # 3 · the bigger timeframes
    for h in X["ladder"][:2]:
        hs = X["htf"].get(h)
        if hs and hs["trend"] == -d:
            flags.append(dict(key="htf", tone="bad", kind="chip", price=None, t=None,
                              title=f"The {h} trend is {'up' if hs['trend'] == 1 else 'down'}",
                              short=f"{h} trend {'up' if hs['trend'] == 1 else 'down'}",
                              text=f"A {word} here is against the {h} trend: half size at most.", rows=_trend_rows(X)))
            break

    # 4 · the entry level
    lv = by.get("level")
    if lv and not lv["ok"] and "into" in lv["text"]:
        near = [c for c in X["clusters"] if c["lo"] - 0.3 * atr <= p["entry"] <= c["hi"] + 0.3 * atr
                and any(ga.polarity(lab) == -d for lab in c["labels"])]
        at = float(near[0]["price"]) if near else float(p["entry"])
        labs = list(dict.fromkeys(lab for c in near for lab in c["labels"] if ga.polarity(lab) == -d))[:2]
        flags.append(dict(key="level", tone="bad", kind="level", price=at, t=None,
                          title=f"Entry is into {'resistance' if d == 1 else 'support'}",
                          short=", ".join(labs) or "Opposing level",
                          text=f"{', '.join(labs).capitalize() or 'An opposing level'} at {f.p(at)} sits on the entry: "
                               f"{'sellers' if d == 1 else 'buyers'} defend it."))

    # 5 · the session clock (intraday, not crypto)
    ss = by.get("session")
    sess = X.get("session") or {}
    if ss and not ss["ok"] and sess.get("minutes_to_next") is not None and now_s is not None \
            and sess["minutes_to_next"] <= 12 * 60:
        m = int(sess["minutes_to_next"])
        flags.append(dict(key="session", tone="wait", kind="time", price=None, t=int(now_s + m * 60),
                          title=f"{sess.get('next_killzone') or 'Next killzone'} in {m} min",
                          short=f"Killzone in {m} min",
                          text="Outside the London and New York killzones moves are thinner and fakeouts more common.",
                          need=f"the {sess.get('next_killzone') or 'next killzone'}"))

    # 6 · the road to the target
    pa = by.get("path")
    if pa and not pa["ok"]:
        first = p["tps"][0]
        block = [c for c in X["clusters"] if c["strength"] >= 2.5 and d * (c["price"] - p["entry"]) > 0.1 * atr
                 and d * (first - c["price"]) > 0.6 * abs(first - p["entry"])]
        if block:
            flags.append(dict(key="path", tone="bad", kind="level", price=float(block[0]["price"]), t=None,
                              title="Strong level before TP1", short=f"Level at {f.p(block[0]['price'])}",
                              text=f"{', '.join(block[0]['labels'][:2]).capitalize()} at {f.p(block[0]['price'])} "
                                   f"stands between the entry and the first target."))

    # 7 · where the entry sits in the range
    rg = by.get("range")
    dr = X.get("dr")
    if rg and not rg["ok"] and dr:
        flags.append(dict(key="range", tone="bad", kind="level", price=float(dr["eq"]),
                          t=_t(X, min(dr["top_idx"], dr["bottom_idx"])),
                          title=f"{Word}ing in the {'premium' if d == 1 else 'discount'}",
                          short=f"{'Above' if d == 1 else 'Below'} the range middle",
                          text=f"The entry is {'above' if d == 1 else 'below'} the middle of the range "
                               f"({f.p(dr['eq'])}): {'buying high' if d == 1 else 'selling low'}."))

    # 8 · reward to risk
    rr = by.get("rr")
    if rr and not rr["ok"] and len(p["tps"]) > 1:
        r2 = p["rr"][1]
        flags.append(dict(key="rr", tone="wait", kind="level", price=float(p["tps"][1]), t=None,
                          title=f"Target pays only {r2:.1f}R", short=f"{r2:.1f}R to TP2",
                          text="The second target is less than 2.5 times the risk: the odds have to be better than "
                               "usual to make it worth it."))

    # 9 · momentum
    mo = by.get("momentum")
    if mo and not mo["ok"]:
        rsi = X["rsi"]
        flags.append(dict(key="momentum", tone="wait", kind="level", price=float(price), t=_last_t(X),
                          title=f"RSI {rsi:.0f} is stretched {'up' if d == 1 else 'down'}",
                          short=f"RSI {rsi:.0f}",
                          text=f"{Word}ing after a stretched move: wait for a pullback."))

    return flags, good


def _path(X, p, flags, state):
    """The scenario: from the last candle through the flags that have to happen first, to the entry and the targets.
    Points are (t, price, mark): mark is a flag number, 'entry', 'tp1' or 'tp2'."""
    atr, price = X["atr"], X["price"]
    d = p["dir"]
    step = int(md.TF_MIN[X["tf"]] * 60)
    lo, hi = LEG_BARS
    t = _last_t(X)
    pts = [dict(t=t, p=float(price), mark=None)]

    def go(to, mark):
        nonlocal t
        bars = int(np.clip(round(abs(to - pts[-1]["p"]) / max(atr, 1e-12) * 1.6), lo, hi))
        t += bars * step
        pts.append(dict(t=int(t), p=float(to), mark=mark))

    depth = float(X.get("depth") or 0.3)
    for fl in flags if state == "wait" else []:
        if fl["tone"] == "good" or fl.get("price") is None or not fl.get("need"):
            continue
        if fl["key"] in ("sweep", "pool"):
            go(fl["price"] - d * max(0.35, depth) * atr, fl["n"])
        elif fl["key"] == "structure" and fl["kind"] == "level":
            go(fl["price"] + d * 0.3 * atr, fl["n"])
    if p["type"] != "market" or len(pts) > 1:
        go(p["entry"], "entry")
    else:
        pts[-1]["mark"] = "entry"
    for k, tp in enumerate(p["tps"][:2]):
        go(tp, f"tp{k + 1}")
    return pts


def _number(flags, good):
    n = 0
    for fl in flags:
        n += 1
        fl["n"] = n
    for g in good:
        g["n"] = None
    return flags + good


def _steps(flags):
    return [dict(n=fl["n"], text=fl["need"]) for fl in flags if fl.get("need") and fl["tone"] != "good"]


COMMON = ("Liquidity", "No ", "Entry", "Strong", "Target", "Buying", "Selling", "The ", "Last", "Price")


def _lower(s):
    return s[:1].lower() + s[1:] if s and s.startswith(COMMON) else s


def compose(hud):
    """The one-paragraph summary under the verdict, from the HUD's own fields."""
    if hud.get("state") == "dont":
        return hud.get("headline") or "No setup worth taking here."
    flags = [x for x in hud.get("flags") or [] if x.get("n")]
    steps = hud.get("steps") or []
    against = [x for x in flags if x["tone"] == "bad" and not x.get("need")]
    how = hud.get("how") or ""
    out = []
    if hud.get("state") == "go":
        out.append(f"{how[:1].upper() + how[1:]}. {hud.get('levels_text') or ''}".strip())
        if any(x["tone"] in ("bad", "wait") for x in flags):
            out.append("Careful: " + "; ".join(f"({x['n']}) {_lower(x['title'])}"
                                                for x in flags if x["tone"] in ("bad", "wait")) + ".")
        return " ".join(out)
    if steps:
        out.append("Waiting for " + ", then ".join(f"({s['n']}) {s['text']}" for s in steps) + ".")
    if against:
        out.append("Against it: " + "; ".join(f"({x['n']}) {_lower(x['title'])}" for x in against) + ".")
    if not steps and not against:
        out.append(f"The best idea is only grade {hud.get('grade') or 'C'}: not strong enough yet.")
    out.append(f"Conditional plan: {how}." if not steps else f"Then {how}.")
    return " ".join(out)


def build(X, p, verdict, now=None):
    """The HUD for the analysis: verdict words, numbered flags, the check list, the scenario path and the entry."""
    try:
        return _build(X, p, verdict, now)
    except Exception as e:                                 # the chart still works without the HUD
        return dict(error=f"{type(e).__name__}: {str(e)[:120]}")


def _build(X, p, verdict, now):
    f = X["f"]
    v = verdict or {}
    now_s = _epoch(now) if now is not None else None
    split = isinstance(v.get("conflict"), dict) and v["conflict"].get("split")
    if p is None or split:
        state = "dont"
    elif v.get("trade"):
        state = "go"
    else:
        state = "wait"
    conf = (v.get("confidence") or {}).get("level")
    out = dict(state=state, confidence=conf, trend=_trend_rows(X), tf=X["tf"], atr=float(X["atr"]),
               last_t=_last_t(X), step=int(md.TF_MIN[X["tf"]] * 60))
    if p is None or split:
        flags = []
        lm = X.get("liq_map") or {}
        if lm.get("draw_level") is not None:
            lvl = float(lm["draw_level"])
            flags.append(dict(key="draw", tone="info", kind="level", price=lvl, t=None,
                              title=f"Price looks drawn {'up' if lm.get('draw') == 'above' else 'down'} to {f.p(lvl)}",
                              short=f"Drawn to {f.p(lvl)}",
                              text=f"{', '.join((lm.get('draw_labels') or [])[:2]).capitalize() or 'Liquidity'} at "
                                   f"{f.p(lvl)}. Context only: not a trade."))
        ev = X["A"]["events"]
        if ev:
            e = ev[-1]
            flags.append(dict(key="structure", tone="info", kind="level", price=float(e["level"]), t=_t(X, e["idx"]),
                              title=f"Last break: {e['kind']} {'up' if e['direction'] == 'bullish' else 'down'}",
                              short=f"{e['kind']} at {f.p(e['level'])}",
                              text="Wait for a clear break of structure before looking for an entry."))
        flags = _number(flags, [])
        out.update(title="Don't trade", sub="Your strategies disagree" if split else "No setup worth taking",
                   flags=flags, checks=[], steps=[], met=0, total=0, path=None, entry=None,
                   headline=v.get("headline"))
        out["summary"] = compose(out)
        return out
    d = p["dir"]
    word = "buy" if d == 1 else "sell"
    flags, good = _flags_for_plan(X, p, now_s)
    flags = flags[:MAX_FLAGS]
    allf = _number(flags, good[:MAX_GOOD])
    keys = {fl["key"] for fl in flags}
    checks = [dict(ok=bool(c["ok"]), text=c["text"], key=c.get("key")) for c in p.get("checklist") or []]
    # every flag has a failing row in the list, so its number has somewhere to go
    for fl in flags:
        if not any(c["key"] == fl["key"] and not c["ok"] for c in checks):
            checks.insert(0, dict(ok=False, text=fl["title"], key=fl["key"]))
    steps = _steps(flags)
    if state == "go":
        title, sub = f"Possible {word}", "Now, at market" if p["type"] == "market" else f"{p['type'].capitalize()} at {f.p(p['entry'])}"
    else:
        title, sub = "Wait", "No entry yet"
    zone = p.get("zone")
    if not (isinstance(zone, (list, tuple)) and len(zone) == 2):
        zone = [p["entry"] - 0.12 * X["atr"], p["entry"] + 0.12 * X["atr"]]
    out.update(
        title=title, sub=sub, flags=allf, checks=checks, steps=steps,
        met=sum(c["ok"] for c in checks), total=len(checks),
        path=_path(X, p, allf, state),
        entry=dict(side=p["side"], type=p["type"], entry=float(p["entry"]), sl=float(p["sl"]),
                   tps=[float(t) for t in p["tps"][:2]], zone=sorted(float(z) for z in zone), active=state == "go",
                   label=(f"{word.capitalize()} zone" if state != "go" else f"{word.capitalize()} {p['type']}")
                         + (" · only after " + " ".join(f"({s['n']})" for s in steps) if steps and state != "go" else "")),
        how=f"{word} " + ("at market" if p["type"] == "market" else f"{p['type']} at {f.p(p['entry'])}"),
        levels_text=f"Stop {f.p(p['sl'])}, first target {f.p(p['tps'][0])}.", grade=p.get("grade"),
        keys=sorted(keys))
    out["summary"] = compose(out)
    return out


def with_news(hud, news):
    """Add the next high-impact release (from the news service) as a flag on the time axis and a check in the list.
    Called after the analysis, because news is fetched separately."""
    if not isinstance(hud, dict) or hud.get("error") or "flags" not in hud:
        return hud
    news = news or {}
    ev = None
    for e in news.get("events") or []:
        m = e.get("minutes_until")
        if str(e.get("impact", "")).lower() == "high" and m is not None and -30 <= m <= 240:
            ev = e
            break
    checks = hud.get("checks") or []
    if ev is None:
        if hud.get("state") != "dont" and news.get("calendar_ok", True) and news.get("risk") != "unknown":
            checks.append(dict(ok=True, text="No high-impact news in the next 4 hours", key="news"))
        hud["checks"] = checks
        hud["met"] = sum(c["ok"] for c in checks)
        hud["total"] = len(checks)
        return hud
    m = int(ev["minutes_until"])
    name = f"{ev.get('country') or ''} {ev.get('title') or 'news'}".strip()
    when = f"in {m} min" if m > 0 else "now" if m == 0 else f"{-m} min ago"
    fl = dict(key="news", tone="bad", kind="time", price=None, t=_epoch(ev.get("time")),
              title=f"{name} {when}", short=f"{name} {when}",
              text="High-impact release. Spreads widen and stops slip around it: don't enter before it.",
              need=f"{name} to pass" if m >= 0 else None)
    flags = [x for x in hud["flags"] if x["key"] != "news"]
    bad = [x for x in flags if x["tone"] != "good"]
    good = [x for x in flags if x["tone"] == "good"]
    at = sum(1 for x in bad if x["key"] in ("sweep", "pool", "structure"))
    bad.insert(at, fl)
    bad = bad[:MAX_FLAGS]
    for k, x in enumerate(bad):
        x["n"] = k + 1
    hud["flags"] = bad + good
    checks.insert(0, dict(ok=False, text=f"High-impact news: {name} {when}", key="news"))
    hud["checks"] = checks
    hud["met"] = sum(c["ok"] for c in checks)
    hud["total"] = len(checks)
    hud["steps"] = _steps(bad)
    if hud.get("state") == "wait" and hud.get("entry") and hud["steps"]:
        base = hud["entry"]["label"].split(" · ")[0]
        hud["entry"]["label"] = base + " · only after " + " ".join(f"({s['n']})" for s in hud["steps"])
    hud["keys"] = sorted({x["key"] for x in bad})
    hud["summary"] = compose(hud)
    return hud

"""Strategy watches: "tell me when these strategies fire on this pair".

The scanner (run by the background loop, and by POST /api/watches/cron for hosts that sleep) looks at every active
watch. For each pair and timeframe it loads the closed candles once, runs the watch's strategies on them with the same
code the analyst uses (`strategies.live`), and reports every signal it has not reported before:

  * a Notification (the bell and the in-site toast) - always
  * an email, when the watch asks for it
  * a phone / browser push to the devices the person switched alerts on for, when the watch asks for it

A watch only looks again when a new candle has closed (or after a quiet spell), so many watches cost little. A signal
is reported once, whichever way it reaches the person (`seen` keeps the strategy, the candle and the direction).
Research tool, not financial advice: the message says to check the chart before trading."""
import calendar
import html as htmllib
import logging
import threading
import time
from collections import defaultdict
from datetime import timedelta

from sqlalchemy import select

from ..config import settings
from ..db import SessionLocal
from ..models import Notification, StrategyWatch, User, jdump, jload, utcnow
from . import engine, mailer, push

import market_data as md   # noqa: E402  (engine put guru/ on the path)
import strategies as st    # noqa: E402

log = logging.getLogger("streix.watch")
SEEN_KEEP = 120                    # signals remembered per watch
RECHECK_S = 20 * 60                # a watch whose candle hasn't moved is looked at again after this long
SCAN_BUDGET_S = 25                 # one scan stops starting new pairs after this long (the next round carries on)
BARS = 700
_lock = threading.Lock()           # one scan at a time inside this server
_ago = {"1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "30m": "30 minutes", "1h": "1 hour",
        "4h": "4 hours", "1D": "1 day", "1W": "1 week"}


def _epoch(dt):
    return calendar.timegm(dt.timetuple())


def fmt(x, dec):
    try:
        return f"{float(x):,.{max(0, min(10, int(dec)))}f}"
    except (TypeError, ValueError):
        return str(x)


def scan_pair(symbol, tf, ids):
    """Run the strategies on the newest closed candles of one pair. Returns dict(symbol, tf, bar, decimals, price,
    signals=[{id, name, side, dir, kind, bar, entry, sl, tp, rr, age, chase, fixed_time, expiry}])."""
    tf = md.norm_tf(tf)
    C = engine._get(symbol, tf, BARS, refresh_s=max(15, min(120, md.TF_MIN[tf] * 6)), min_bars=150)
    dfe, A = engine.ga.se.analyze(C["df"])
    ctx = st.Ctx(dfe, tf, A, C["asset_class"])
    price = float(C["price"])
    times = md.epoch_s(dfe.index)
    out = []
    max_age = 3 if md.TF_MIN[tf] <= 5 else 2
    for sid in ids:
        s = st.BY_ID.get(sid)
        if not s or (s["intraday"] and tf in ("1D", "1W")):
            continue
        try:
            lv = st.live(ctx, sid, price=price, max_age=max_age)
        except Exception:
            log.exception("strategy %s failed on %s %s", sid, symbol, tf)
            continue
        if not lv.get("signal"):
            continue
        d = lv["dir"]
        row = dict(id=sid, name=s["name"], dir=d, fixed_time=bool(s["fixed_time"]), age=int(lv["age"]),
                   bar=int(times[int(lv["idx"])]), entry=float(lv["entry"]))
        if s["fixed_time"]:
            row.update(side="up" if d == 1 else "down", expiry=int(lv.get("expiry") or 3), kind="fixed")
        else:
            risk = abs(lv["entry"] - lv["sl"])
            if risk <= 0:
                continue
            # price that pulled back gives a better fill now; price that ran with the signal means wait for a return
            market = d * (price - lv["entry"]) <= 0.15 * risk and d * (price - lv["sl"]) > 0.3 * risk
            entry = price if market else float(lv["entry"])
            row.update(side="long" if d == 1 else "short", kind="market" if market else "limit", entry=entry,
                       sl=float(lv["sl"]), tp=float(lv["tp"]), chase=bool(lv.get("chase")),
                       rr=round(abs(lv["tp"] - entry) / abs(entry - lv["sl"]), 2))
        out.append(row)
    return dict(symbol=C["symbol"], tf=tf, bar=int(times[-1]), decimals=C["decimals"], price=price, signals=out)


def message(sig, symbol, tf, dec):
    """(title, plain text body) of one alert."""
    if sig["fixed_time"]:
        word = "UP (buy)" if sig["dir"] == 1 else "DOWN (sell)"
        title = f"{sig['name']}: {word} call on {symbol} {tf}"
        body = (f"{sig['name']} gave a {word} call on {symbol} {tf}, price {fmt(sig['entry'], dec)}. "
                f"Expiry: {sig['expiry']} candles ({sig['expiry']} × {tf}).")
        return title, body
    side = "Buy" if sig["dir"] == 1 else "Sell"
    title = f"{sig['name']}: {side} setup on {symbol} {tf}"
    how = ("Enter now at about" if sig["kind"] == "market" else "Wait for price to come back to")
    late = ""
    if sig["age"] >= 1:
        late = f" The signal came {sig['age']} candle{'s' if sig['age'] != 1 else ''} ago."
    if sig.get("chase") and sig["kind"] == "limit":
        late += " Price has already moved: don't chase it."
    body = (f"{sig['name']} found a {side.lower()} setup on {symbol} {tf}.{late}\n"
            f"{how} {fmt(sig['entry'], dec)}. Stop loss {fmt(sig['sl'], dec)}. Take profit {fmt(sig['tp'], dec)} "
            f"(reward {sig['rr']}× the risk).\n"
            "Check the chart before you trade; no strategy wins every time.")
    return title, body


def _email_html(title, body, url):
    rows = "".join(f"<p style='margin:0 0 10px'>{htmllib.escape(line)}</p>" for line in body.split("\n"))
    return ("<div style='font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px'>"
            f"<h2 style='margin:0 0 12px;font-size:18px;color:#2962ff'>{htmllib.escape(title)}</h2>{rows}"
            f"<p style='margin:18px 0'><a href='{htmllib.escape(url)}' style='background:#2962ff;color:#fff;"
            "padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600'>Open the chart</a></p>"
            "<p style='color:#666;font-size:12px'>You get this because you are watching this pair on StreixAnalyst. "
            "Pause or delete the watch in the terminal (Watch) to stop these emails. Research tool, not financial advice."
            "</p></div>")


def deliver(db, user, w, title, body, link):
    """The in-site notification (always), and the email and phone push when the watch asks for them. Adds rows; the
    caller commits."""
    db.add(Notification(user_id=user.id, kind="watch", title=title[:160], body=body, link=link))
    if w.email and user.email:
        url = settings.frontend_url + link
        mailer.send(user.email, f"StreixAnalyst · {title}", f"{body}\n\nOpen the chart: {url}",
                    html=_email_html(title, body, url))
    if w.push and settings.push_enabled:
        try:
            push.send_to_user(db, user.id, title, body, link)
        except Exception:
            log.exception("phone alert could not be sent")


def _prune(seen):
    if len(seen) <= SEEN_KEEP:
        return seen
    keep = sorted(seen.items(), key=lambda kv: kv[1])[-SEEN_KEEP:]
    return dict(keep)


def _due(w, now):
    """Is it worth looking at this watch now? A new candle has closed since the last look, or it's been a while."""
    if w.last_bar is None or w.checked_at is None:
        return True
    sec = int(md.TF_MIN[md.norm_tf(w.tf)] * 60)
    if _epoch(now) >= w.last_bar + 2 * sec + 5:
        return True
    return (now - w.checked_at).total_seconds() >= max(RECHECK_S, sec)


def apply_scan(db, w, user, res, now, quiet=False):
    """Report the new signals of one pair to one watch. quiet=True only remembers them (a new watch doesn't announce
    what was already there when it was created). Returns how many alerts were sent."""
    seen = jload(w.seen, {}) or {}
    sent = 0
    fresh = []
    for sig in res["signals"]:
        key = f"{sig['id']}:{sig['bar']}:{sig['dir']}"
        if key in seen:
            continue
        seen[key] = sig["bar"]
        if not quiet:
            fresh.append(sig)
    for sig in fresh:
        title, body = message(sig, res["symbol"], res["tf"], res["decimals"])
        deliver(db, user, w, title, body, f"/terminal?s={res['symbol']}&tf={res['tf']}")
        w.fired = (w.fired or 0) + 1
        w.last_fired_at, w.last_text = now, title[:200]
        sent += 1
    w.seen = jdump(_prune(seen))
    w.last_bar, w.checked_at, w.error = res["bar"], now, None
    return sent


def run_once(now=None, scan=None, budget=SCAN_BUDGET_S):
    """One pass over every active watch. `scan` can be swapped in tests. Returns dict(alerts, pairs, watches)."""
    scan = scan or scan_pair
    now = now or utcnow()
    stats = dict(alerts=0, pairs=0, watches=0)
    if not _lock.acquire(blocking=False):
        return stats                                  # another scan is running: it will do the work
    db = SessionLocal()
    t0 = time.time()
    try:
        ws = db.execute(select(StrategyWatch).where(StrategyWatch.status == "active")
                        .order_by(StrategyWatch.checked_at.is_(None).desc(), StrategyWatch.checked_at)).scalars().all()
        groups = defaultdict(list)
        for w in ws:
            if _due(w, now):
                groups[(w.symbol, md.norm_tf(w.tf))].append(w)
        for (sym, tf), items in groups.items():
            if time.time() - t0 > budget:
                break
            ids = sorted({i for w in items for i in (jload(w.strategies, []) or [])})
            try:
                res = scan(sym, tf, ids)
            except Exception as e:
                for w in items:
                    w.error, w.checked_at = str(e)[:200], now
                db.commit()
                continue
            stats["pairs"] += 1
            for w in items:
                user = db.get(User, w.user_id)
                if not user or not user.is_active:
                    w.status = "paused"
                    continue
                mine = set(jload(w.strategies, []) or [])
                sub = dict(res, signals=[s for s in res["signals"] if s["id"] in mine])
                stats["alerts"] += apply_scan(db, w, user, sub, now)
                stats["watches"] += 1
            db.commit()                               # the seen-list and the notifications are saved together
        return stats
    except Exception:
        db.rollback()
        log.exception("watch scan failed")
        return stats
    finally:
        db.close()
        _lock.release()


def first_look(db, w, user, scan=None):
    """When a watch is created: scan once, remember what is already live (it isn't announced as new), and return the
    setups live right now so the person sees them at once."""
    scan = scan or scan_pair
    res = scan(w.symbol, w.tf, jload(w.strategies, []) or [])
    apply_scan(db, w, user, res, utcnow(), quiet=True)
    return res

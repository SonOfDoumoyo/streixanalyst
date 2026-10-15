"""Alert checking (run by the background loop).

Price alerts look at the 1-minute candles since the previous check, so a quick wick through the level between two
checks still counts. Strategy alerts are evaluated once per closed candle of their timeframe. Each firing writes an
in-app Notification and, when the user asked for it, an email."""
import calendar
import logging
from collections import defaultdict
from datetime import timedelta

from sqlalchemy import select

import market_data as md

from ..config import settings
from ..db import SessionLocal
from ..models import Alert, Notification, SavedStrategy, User, jload, utcnow
from . import engine, mailer
from . import strategy as stg

log = logging.getLogger("streix.alerts")
REPEAT_COOLDOWN = timedelta(minutes=10)
OP_WORD = {"above": "rose to", "below": "fell to", "cross": "crossed"}


def fmt(x, dec):
    try:
        return f"{float(x):,.{max(0, min(10, int(dec)))}f}"
    except (TypeError, ValueError):
        return str(x)


def _epoch(dt):
    return calendar.timegm(dt.timetuple())


def price_hit(op, level, lo, hi, last, now_price, rearm=False):
    """Did price satisfy the alert between the previous check and now? `rearm`: a repeating alert that already
    fired must see price come back from the other side first."""
    if op == "above":
        return hi >= level and (not rearm or (last is not None and last < level))
    if op == "below":
        return lo <= level and (not rearm or (last is not None and last > level))
    if last is None:
        return False
    return (lo <= level <= hi) or ((last - level) * (now_price - level) <= 0)


def notify(db, user, title, body, link, kind="alert", email=False):
    db.add(Notification(user_id=user.id, kind=kind, title=title[:160], body=body, link=link))
    if email and user.email:
        mailer.send(user.email, f"StreixAnalyst · {title}", f"{body}\n\nOpen: {settings.frontend_url}{link}")


def _fire(db, a, user, title, body, link, now):
    notify(db, user, title, body, link, email=a.email)
    a.fired = (a.fired or 0) + 1
    a.triggered_at = now
    if not a.repeat:
        a.status = "triggered"


def check_prices(db, now=None, latest=None):
    latest = latest or (lambda sym: engine.latest(sym, "1m"))
    now = now or utcnow()
    alerts = db.execute(select(Alert).where(Alert.kind == "price", Alert.status == "active")).scalars().all()
    by_sym = defaultdict(list)
    for a in alerts:
        by_sym[a.symbol].append(a)
    fired = 0
    for sym, items in by_sym.items():
        try:
            d = latest(sym)
        except Exception as e:
            for a in items:
                a.error, a.checked_at = str(e)[:200], now
            continue
        px = float(d["price"])
        dec = d.get("decimals", 2)
        for a in items:
            t_since = _epoch((a.checked_at or a.created_at) - timedelta(seconds=60))
            rows = [r for r in d.get("candles") or [] if r[0] + 60 > t_since] or (d.get("candles") or [])[-1:]
            hi = max([r[2] for r in rows] + [px])
            lo = min([r[3] for r in rows] + [px])
            cool = a.repeat and a.triggered_at and now - a.triggered_at < REPEAT_COOLDOWN
            if not cool and price_hit(a.op, a.price, lo, hi, a.last_price, px, rearm=bool(a.repeat and a.fired)):
                user = db.get(User, a.user_id)
                if user and user.is_active:
                    word = OP_WORD.get(a.op, "reached")
                    title = f"{sym} {word} {fmt(a.price, dec)}"
                    body = (f"{sym} {word} your level {fmt(a.price, dec)} (now {fmt(px, dec)})."
                            + (f" Note: {a.note}" if a.note else ""))
                    _fire(db, a, user, title, body, f"/terminal?s={sym}&tf={a.tf or '1h'}", now)
                    fired += 1
            a.last_price, a.checked_at, a.error = px, now, None
    db.commit()
    return fired


def check_strategies(db, now=None, live=None):
    live = live or stg.live_check
    now = now or utcnow()
    alerts = db.execute(select(Alert).where(Alert.kind == "strategy", Alert.status == "active")).scalars().all()
    fired = 0
    for a in alerts:
        tf = md.norm_tf(a.tf or "1h")
        sec = int(md.TF_MIN[tf] * 60)
        now_ts = _epoch(now)
        if a.last_bar and now_ts < a.last_bar + 2 * sec + 5:
            continue                     # the next candle hasn't closed yet
        s = db.get(SavedStrategy, a.strategy_id) if a.strategy_id else None
        if not s:
            a.status, a.error = "paused", "The strategy was deleted."
            continue
        try:
            out = live(a.symbol, tf, jload(s.spec, {}))
        except Exception as e:
            a.error, a.checked_at = str(e)[:200], now
            continue
        new_bar = out["time"] != a.last_bar
        first = a.last_bar is None
        a.last_bar, a.checked_at, a.error = out["time"], now, None
        if out["signal"] and new_bar and not first:
            user = db.get(User, a.user_id)
            if user and user.is_active:
                dec = out.get("decimals", 2)
                side = "Long" if out["signal"] == "long" else "Short"
                title = f"{s.name}: {side} signal on {out['symbol']} {tf}"
                lv = (f" Entry ≈ {fmt(out['entry'], dec)}, stop {fmt(out['stop'], dec)}, target {fmt(out['target'], dec)}."
                      if out.get("stop") is not None else "")
                body = f"Your strategy \"{s.name}\" fired on the candle that just closed.{lv} Check the chart before trading."
                _fire(db, a, user, title, body, f"/strategy?s={a.symbol}&tf={tf}", now)
                fired += 1
    db.commit()
    return fired


def run_once():
    db = SessionLocal()
    try:
        n = check_prices(db)
        n += check_strategies(db)
        return n
    except Exception:
        db.rollback()
        log.exception("alert check failed")
        return 0
    finally:
        db.close()

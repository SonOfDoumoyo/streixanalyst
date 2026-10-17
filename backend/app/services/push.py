"""Phone alerts through Web push: an alert reaches the phone or computer even when the site is closed.

Each device that switched phone alerts on has a PushSubscription row, and a user's alert goes to every one of their
devices. A device the push service reports as gone (404 or 410) is removed. Nothing is sent until the VAPID keys are
set (see .env.example)."""
import json
import logging

from sqlalchemy import select

from ..config import settings
from ..models import PushSubscription

log = logging.getLogger("streix.push")
TIMEOUT_S = 10


def _send_one(sub, payload):
    """Returns (outcome, detail). outcome is "sent", "gone" (remove this device) or "failed" (keep it, say why)."""
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
    try:
        webpush(
            subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
            data=json.dumps(payload),
            vapid_private_key=Vapid.from_string(settings.vapid_private_key),
            vapid_claims={"sub": settings.vapid_subject},
            ttl=3600,
            timeout=TIMEOUT_S,
        )
        return "sent", None
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (404, 410):
            return "gone", None
        return "failed", f"push service answered {code}: {str(e)[:160]}"


def send_to_user(db, user_id, title, body, link="/terminal"):
    """Push one alert to every device of the user. Returns counts. Does not commit (the caller does)."""
    counts = dict(sent=0, failed=0, removed=0, error=None)
    if not settings.push_enabled:
        return counts
    subs = db.execute(select(PushSubscription).where(PushSubscription.user_id == user_id)).scalars().all()
    payload = dict(title=(title or "StreixAnalyst")[:160], body=(body or "")[:400],
                   url=link if str(link or "").startswith("/") else "/terminal")
    for sub in subs:
        try:
            outcome, detail = _send_one(sub, payload)
        except Exception as e:                       # a bad key or a network fault: report it, keep the device
            outcome, detail = "failed", f"{type(e).__name__}: {str(e)[:160]}"
        if outcome == "sent":
            counts["sent"] += 1
        elif outcome == "gone":
            db.delete(sub)
            counts["removed"] += 1
        else:
            counts["failed"] += 1
            counts["error"] = detail
            log.warning("phone alert not delivered: %s", detail)
    return counts

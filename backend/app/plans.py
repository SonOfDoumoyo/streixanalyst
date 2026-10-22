"""Plans, features, daily limits, prices and usage counting.

Tiers (decided by `tier_of`):
  admin  – everything, no limits
  org    – member of an organization with an active subscription (Pro + classroom features, higher limits)
  pro    – paid Pro plan
  trial  – first TRIAL_DAYS days after sign-up: every feature, Pro limits
  free   – after the trial: charts, drawing, a few analyses and StreixAI messages a day
"""
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import select

from .config import settings
from .models import AppSetting, UsageCounter, jdump, jload, utcnow

FEATURES = {
    "analysis": "AI chart analysis (entry, SL, TP, levels, probabilities)",
    "review": "Trade review: grade your own entry, stop and target",
    "streixai": "StreixAI assistant",
    "news": "News & economic calendar inside the analysis",
    "beginner_mode": "Beginner explanations",
    "tv_mode": "TV / presentation mode",
    "strategy": "Strategy mode: analyse with your own strategy",
    "practice": "Draw & score: the AI grades your analysis",
    "alerts": "Price and setup alerts",
    "layouts": "Saved chart layouts",
    "multi_chart": "Multi-chart layouts",
    "export": "Export analyses and reports",
    "pro_report": "Full pro report with model statistics",
    "classroom": "Classroom: shared charts, exercises, student progress",
    "teach_mode": "Teach mode for presenting to students",
    "branding": "Organization branding",
    "replay": "Replay: analyse past moments and make your own calls on them",
    "class_live": "Classroom live: teachers expose their chart, students watch",
}
# Strategies are open to every plan (v1.3): everyone can build, run and save strategies, within the daily limit below.
FREE_FEATURES = {"analysis", "review", "streixai", "news", "beginner_mode", "tv_mode", "practice", "alerts", "layouts",
                 "strategy"}
PRO_FEATURES = set(FEATURES) - {"classroom", "teach_mode", "branding", "class_live"}
ORG_FEATURES = set(FEATURES)

LIMIT_NAMES = {"analysis": "analyses", "review": "trade reviews", "ai": "StreixAI messages",
               "strategy": "strategy runs", "practice": "draw & score checks", "alerts": "active alerts",
               "watchlist": "watchlist symbols", "layouts": "saved layouts"}
DEFAULT_LIMITS = {
    "free": dict(analysis=5, review=2, ai=10, strategy=40, practice=1, alerts=2, watchlist=12, layouts=1),
    "trial": dict(analysis=150, review=60, ai=200, strategy=40, practice=40, alerts=50, watchlist=200, layouts=20),
    "pro": dict(analysis=150, review=60, ai=200, strategy=40, practice=40, alerts=50, watchlist=200, layouts=20),
    "org": dict(analysis=300, review=150, ai=400, strategy=80, practice=100, alerts=100, watchlist=300, layouts=50),
}
ORG_SEAT_CAP = 500                   # most seats one organization can buy in a single checkout
DEFAULT_PRICING = {
    "currency": "USD",               # prices are shown in dollars
    "pro_monthly": 15,               # $ per month, for one person
    "org_seat_monthly": 10,          # $ per person per month on the Organization plan (admin can change it)
    "discounts": {"1": 0.0, "3": 0.10, "12": 0.20},
    "usd_rate": settings.usd_ngn_rate,   # ₦ per $1: card and bank payments are taken in naira at this rate
}


def get_setting(db, key, default):
    row = db.get(AppSetting, key)
    v = jload(row.value, None) if row else None
    if isinstance(default, dict) and isinstance(v, dict):
        out = dict(default)
        out.update(v)
        return out
    return default if v is None else v


def put_setting(db, key, value):
    row = db.get(AppSetting, key)
    if row:
        row.value = jdump(value)
    else:
        db.add(AppSetting(key=key, value=jdump(value)))
    db.commit()


def pricing(db):
    return get_setting(db, "pricing", DEFAULT_PRICING)


def limits_table(db):
    over = get_setting(db, "limits", {})
    out = {}
    for tier, lim in DEFAULT_LIMITS.items():
        d = dict(lim)
        d.update({k: int(v) for k, v in (over.get(tier) or {}).items() if k in d})
        out[tier] = d
    return out


def org_active(user):
    org = user.org
    return bool(org and org.plan_expires_at and org.plan_expires_at > utcnow())


def tier_of(user):
    if user.role == "admin":
        return "admin"
    now = utcnow()
    if user.org_id and org_active(user):
        return "org"
    if user.plan == "pro" and user.plan_expires_at and user.plan_expires_at > now:
        return "pro"
    if user.trial_ends_at and user.trial_ends_at > now:
        return "trial"
    return "free"


def features_of(tier):
    if tier in ("admin", "org"):
        return ORG_FEATURES
    if tier in ("pro", "trial"):
        return PRO_FEATURES
    return FREE_FEATURES


def limits_of(db, tier):
    if tier == "admin":
        return {k: None for k in DEFAULT_LIMITS["pro"]}
    return limits_table(db)[tier]


def today():
    return utcnow().strftime("%Y-%m-%d")


def usage_today(db, user):
    rows = db.execute(select(UsageCounter).where(UsageCounter.user_id == user.id, UsageCounter.day == today())).scalars()
    return {r.kind: r.count for r in rows}


def entitlements(db, user):
    tier = tier_of(user)
    now = utcnow()
    trial_left = None
    if user.trial_ends_at and user.trial_ends_at > now:
        trial_left = max(0, (user.trial_ends_at - now).days + (1 if (user.trial_ends_at - now).seconds else 0))
    return dict(tier=tier, features=sorted(features_of(tier)), limits=limits_of(db, tier), usage=usage_today(db, user),
                trial_days_left=trial_left,
                trial_ends_at=user.trial_ends_at.isoformat() + "Z" if user.trial_ends_at else None,
                plan_expires_at=(user.plan_expires_at.isoformat() + "Z") if user.plan == "pro" and user.plan_expires_at
                else None,
                org_expires_at=(user.org.plan_expires_at.isoformat() + "Z") if user.org and user.org.plan_expires_at
                else None)


def require_feature(user, feature):
    tier = tier_of(user)
    if feature not in features_of(tier):
        raise HTTPException(402, detail=dict(code="upgrade", feature=feature,
                                             message=f"{FEATURES.get(feature, feature)} is part of StreixAnalyst Pro. "
                                                     "Upgrade to unlock it."))
    return tier


def consume(db, user, kind, amount=1):
    """Count one use of `kind` today, refusing politely when the daily limit is reached."""
    tier = tier_of(user)
    lim = limits_of(db, tier).get(kind)
    day = today()
    row = db.execute(select(UsageCounter).where(UsageCounter.user_id == user.id, UsageCounter.day == day,
                                                UsageCounter.kind == kind)).scalar_one_or_none()
    used = row.count if row else 0
    if lim is not None and used + amount > lim:
        what = LIMIT_NAMES.get(kind, kind)
        msg = (f"You've used today's {lim} {what}." if lim else f"{what.capitalize()} are a Pro feature.")
        if tier == "free":
            msg += " Upgrade to Pro for more (or come back tomorrow)."
        else:
            msg += " The limit resets at 00:00 UTC."
        raise HTTPException(429, detail=dict(code="limit", kind=kind, limit=lim, used=used, message=msg))
    if row is None:
        row = UsageCounter(user_id=user.id, day=day, kind=kind, count=0)
        db.add(row)
    row.count = used + amount
    db.commit()
    return dict(used=row.count, limit=lim)


def refund(db, user, kind, amount=1):
    row = db.execute(select(UsageCounter).where(UsageCounter.user_id == user.id, UsageCounter.day == today(),
                                                UsageCounter.kind == kind)).scalar_one_or_none()
    if row and row.count > 0:
        row.count = max(0, row.count - amount)
        db.commit()


def quote(db, plan, months=1, seats=1):
    """Server-side price. The client never decides the amount.

    Prices are in dollars. The charge is in naira at the usd_rate setting, rounded to ₦50, and kobo is what Paystack
    expects. The Organization plan costs the per-seat price for every person the owner pays for (`seats`)."""
    P = pricing(db)
    months = int(months)
    if months not in (1, 3, 12):
        raise HTTPException(400, "Choose 1, 3 or 12 months.")
    disc = float(P["discounts"].get(str(months), 0.0))
    if plan == "pro":
        seats = 1
        usd = float(P["pro_monthly"]) * months * (1 - disc)
    elif plan == "org":
        seats = max(1, min(int(seats or 1), ORG_SEAT_CAP))
        usd = float(P["org_seat_monthly"]) * seats * months * (1 - disc)
    else:
        raise HTTPException(400, "Unknown plan.")
    rate = float(P.get("usd_rate") or settings.usd_ngn_rate)
    naira = int(round(usd * rate / 50.0) * 50)            # round to ₦50
    return dict(plan=plan, months=months, seats=seats, naira=naira, kobo=naira * 100, discount=disc,
                currency="NGN", usd=round(usd, 2), usd_approx=round(usd, 2), rate=rate)


def plans_overview(db):
    P = pricing(db)
    L = limits_table(db)
    return dict(
        currency=P["currency"], trial_days=settings.trial_days, pricing=P,
        quotes={"pro": {m: quote(db, "pro", m) for m in (1, 3, 12)},
                "org": {m: quote(db, "org", m) for m in (1, 3, 12)}},
        features=FEATURES,
        tiers={"free": dict(features=sorted(FREE_FEATURES), limits=L["free"]),
               "pro": dict(features=sorted(PRO_FEATURES), limits=L["pro"]),
               "org": dict(features=sorted(ORG_FEATURES), limits=L["org"])},
        limit_names=LIMIT_NAMES)


def extend(dt, months):
    now = utcnow()
    start = dt if dt and dt > now else now
    return start + timedelta(days=30 * int(months))

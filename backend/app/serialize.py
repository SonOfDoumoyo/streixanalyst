"""JSON shapes returned to the frontend."""
from datetime import timedelta

from .config import settings
from .models import iso, jload, utcnow
from .plans import entitlements


def touch_streak(db, user):
    """Daily-visit streak (a small, honest engagement loop)."""
    today = utcnow().date()
    last = user.streak_last
    if last == today.isoformat():
        return
    if last == (today - timedelta(days=1)).isoformat():
        user.streak_days = (user.streak_days or 0) + 1
    else:
        user.streak_days = 1
    user.streak_last = today.isoformat()
    db.commit()


def user_out(db, user):
    org = user.org
    return dict(
        id=user.id, email=user.email, first_name=user.first_name, last_name=user.last_name, name=user.name,
        experience=user.experience, phone=user.phone, avatar_url=user.avatar_url, role=user.role,
        has_password=bool(user.password_hash), created_at=iso(user.created_at), streak_days=user.streak_days or 0,
        settings=jload(user.settings_json, {}),
        org=None if not org else dict(id=org.id, name=org.name, seats=org.seats, role=user.org_role,
                                      expires_at=iso(org.plan_expires_at),
                                      invite_code=org.invite_code if user.org_role in ("owner", "teacher") else None),
        entitlements=entitlements(db, user),
        needs_onboarding=not user.experience,
        # Terms: the web app shows the gate until the person has accepted the current version
        terms_version=user.terms_version, terms_ok=user.terms_version == settings.terms_version,
        learn_consent=bool(user.learn_consent),
    )


def payment_out(p, admin=False):
    d = dict(id=p.id, reference=p.reference, provider=p.provider, method=p.method, plan=p.plan, months=p.months,
             seats=p.seats, amount=p.amount_kobo / 100, paid=None if p.paid_kobo is None else p.paid_kobo / 100,
             currency=p.currency, status=p.status, applied=p.applied, account_label=p.account_label,
             payer_name=p.payer_name, has_proof=bool(p.proof_path), note=p.note, created_at=iso(p.created_at),
             verified_at=iso(p.verified_at))
    if admin:
        u = p.user
        d.update(user=dict(id=u.id, email=u.email, name=u.name) if u else None, provider_ref=p.provider_ref,
                 verified_by=p.verified_by)
    return d

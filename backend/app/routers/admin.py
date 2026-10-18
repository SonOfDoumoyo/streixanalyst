"""Admin console: stats, users, payment approval, prices/limits/accounts, system status."""
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import admin_user
from ..models import AdminAction, AnalysisLog, ChatMessage, Organization, Payment, User, iso, jload, utcnow
from ..plans import DEFAULT_LIMITS, DEFAULT_PRICING, get_setting, limits_table, pricing, put_setting, tier_of
from ..security import hash_password
from ..serialize import payment_out
from ..services import billing, catalog, engine, mailer, streixai

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/stats")
def stats(admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    now = utcnow()
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    users = db.execute(select(User)).scalars().all()
    tiers = {}
    for u in users:
        t = tier_of(u)
        tiers[t] = tiers.get(t, 0) + 1
    rev30 = db.execute(select(func.coalesce(func.sum(Payment.paid_kobo), 0)).where(
        Payment.applied.is_(True), Payment.verified_at >= now - timedelta(days=30))).scalar() or 0
    rev_all = db.execute(select(func.coalesce(func.sum(Payment.paid_kobo), 0)).where(Payment.applied.is_(True))).scalar() or 0
    return dict(
        users=len(users), new_7d=sum(1 for u in users if u.created_at and u.created_at >= now - timedelta(days=7)),
        active_24h=sum(1 for u in users if u.last_seen_at and u.last_seen_at >= now - timedelta(days=1)),
        tiers=tiers, revenue_30d=rev30 / 100, revenue_all=rev_all / 100,
        pending_reviews=db.execute(select(func.count(Payment.id)).where(Payment.status == "review")).scalar(),
        analyses_today=db.execute(select(func.count(AnalysisLog.id)).where(AnalysisLog.created_at >= day0)).scalar(),
        ai_messages_today=db.execute(select(func.count(ChatMessage.id)).where(ChatMessage.created_at >= day0,
                                                                             ChatMessage.role == "user")).scalar(),
        orgs=db.execute(select(func.count(Organization.id))).scalar())


def _user_row(u):
    return dict(id=u.id, email=u.email, name=u.name, experience=u.experience, role=u.role, is_active=u.is_active,
                tier=tier_of(u), plan=u.plan, plan_expires_at=iso(u.plan_expires_at), trial_ends_at=iso(u.trial_ends_at),
                org=u.org.name if u.org else None, org_role=u.org_role, created_at=iso(u.created_at),
                last_seen_at=iso(u.last_seen_at), streak_days=u.streak_days, phone=u.phone)


@router.get("/users")
def users(q: str = "", page: int = 1, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    stmt = select(User)
    if q.strip():
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(User.email).like(like), func.lower(User.first_name).like(like),
                              func.lower(User.last_name).like(like)))
    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar()
    rows = db.execute(stmt.order_by(User.id.desc()).offset((max(1, page) - 1) * 50).limit(50)).scalars()
    return dict(total=total, page=page, users=[_user_row(u) for u in rows])


class UserPatch(BaseModel):
    role: str | None = None
    is_active: bool | None = None
    pro_days: int | None = Field(None, ge=-3650, le=3650)     # add (or remove) Pro days
    trial_days: int | None = Field(None, ge=-365, le=365)     # add (or remove) trial days
    experience: str | None = None
    note: str | None = None


@router.patch("/users/{user_id}")
def patch_user(user_id: int, body: UserPatch, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found.")
    now = utcnow()
    if body.role is not None:
        if body.role not in ("user", "admin"):
            raise HTTPException(422, "Role must be user or admin.")
        if u.id == admin.id and body.role != "admin":
            raise HTTPException(409, "You can't remove your own admin role.")
        u.role = body.role
    if body.is_active is not None:
        if u.id == admin.id and not body.is_active:
            raise HTTPException(409, "You can't disable yourself.")
        u.is_active = body.is_active
        if not body.is_active:
            u.token_version += 1
    if body.pro_days:
        base = u.plan_expires_at if (u.plan == "pro" and u.plan_expires_at and u.plan_expires_at > now) else now
        u.plan, u.plan_expires_at = "pro", base + timedelta(days=body.pro_days)
    if body.trial_days:
        base = u.trial_ends_at if (u.trial_ends_at and u.trial_ends_at > now) else now
        u.trial_ends_at = base + timedelta(days=body.trial_days)
    if body.experience in ("beginner", "intermediate", "advanced"):
        u.experience = body.experience
    billing.audit(db, "user_updated", u.email, body.model_dump(exclude_none=True), admin.id)
    db.commit()
    return dict(user=_user_row(u))


@router.post("/users/{user_id}/password")
def reset_password(user_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found.")
    temp = "Sx-" + secrets.token_urlsafe(9)
    u.password_hash = hash_password(temp)
    u.token_version += 1
    billing.audit(db, "password_reset", u.email, None, admin.id)
    db.commit()
    return dict(temporary_password=temp, message="Share this once with the user and ask them to change it in Settings.")


@router.get("/payments")
def payments(status: str | None = None, q: str = "", admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    stmt = select(Payment)
    if status:
        stmt = stmt.where(Payment.status == status)
    if q.strip():
        stmt = stmt.join(User, User.id == Payment.user_id).where(or_(Payment.reference.ilike(f"%{q.strip()}%"),
                                                                     User.email.ilike(f"%{q.strip()}%")))
    rows = db.execute(stmt.order_by(Payment.id.desc()).limit(200)).scalars()
    return dict(payments=[payment_out(p, admin=True) for p in rows])


class Decision(BaseModel):
    note: str | None = Field(None, max_length=500)
    plan: str | None = None
    months: int | None = None
    seats: int | None = None
    paid_naira: float | None = Field(None, ge=0)


@router.post("/payments/{payment_id}/approve")
def approve(payment_id: int, body: Decision, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    pay = db.get(Payment, payment_id)
    if not pay:
        raise HTTPException(404, "Payment not found.")
    if pay.applied:
        raise HTTPException(409, "Already applied.")
    if body.plan in ("pro", "org"):
        pay.plan = body.plan
    if body.months in (1, 3, 6, 12):
        pay.months = body.months
    if body.seats:
        pay.seats = max(1, body.seats)
    db.commit()
    paid = int(round(body.paid_naira * 100)) if body.paid_naira else (pay.paid_kobo or pay.amount_kobo)
    ok = billing.apply_payment(db, pay, paid, pay.provider_ref, None, pay.method, admin.id,
                               note=(body.note or pay.note))
    if not ok:
        raise HTTPException(409, "Already applied.")
    return dict(payment=payment_out(db.get(Payment, payment_id), admin=True))


@router.post("/payments/{payment_id}/reject")
def reject(payment_id: int, body: Decision, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    pay = db.get(Payment, payment_id)
    if not pay:
        raise HTTPException(404, "Payment not found.")
    if pay.applied:
        raise HTTPException(409, "This payment was already applied; change the user's plan instead.")
    pay.status, pay.note, pay.verified_by, pay.verified_at = "rejected", body.note or "Rejected by admin", admin.id, utcnow()
    billing.audit(db, "payment_rejected", pay.reference, dict(note=body.note), admin.id)
    db.commit()
    u = db.get(User, pay.user_id)
    mailer.send(u.email, "About your StreixAnalyst payment",
                f"Hi {u.first_name or 'there'},\n\nWe couldn't confirm your payment {pay.reference}. Reason: "
                f"{pay.note}.\n\nReply to this email or upload a clearer receipt from the Billing page.\n\nStreixAnalyst")
    return dict(payment=payment_out(pay, admin=True))


@router.post("/payments/{payment_id}/recheck")
def recheck(payment_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    pay = db.get(Payment, payment_id)
    if not pay:
        raise HTTPException(404, "Payment not found.")
    if pay.provider == "paystack":
        res = billing.verify_paystack(db, pay)
    elif pay.provider == "opay":
        res = billing.verify_opay(db, pay)
    else:
        res = dict(ok=pay.applied, status=pay.status, message="Manual payments are checked by hand.")
    return dict(result=res, payment=payment_out(db.get(Payment, payment_id), admin=True))


@router.get("/payments/{payment_id}/proof")
def proof(payment_id: int, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    pay = db.get(Payment, payment_id)
    if not pay or not pay.proof_path:
        raise HTTPException(404, "No receipt.")
    path = (settings.upload_dir / pay.proof_path).resolve()
    if settings.upload_dir.resolve() not in path.parents or not path.exists():
        raise HTTPException(404, "File missing.")
    return FileResponse(path, headers={"Cache-Control": "private, no-store"})


class SettingsIn(BaseModel):
    pricing: dict | None = None
    limits: dict | None = None
    manual_accounts: list | None = None
    announcement: str | None = Field(None, max_length=400)


@router.get("/settings")
def get_settings(admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    return dict(pricing=pricing(db), default_pricing=DEFAULT_PRICING, limits=limits_table(db),
                default_limits=DEFAULT_LIMITS, manual_accounts=billing.manual_accounts(db),
                announcement=get_setting(db, "announcement", ""))


@router.put("/settings")
def put_settings(body: SettingsIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    if body.pricing is not None:
        p = dict(DEFAULT_PRICING)
        for k in ("pro_monthly", "org_seat_monthly", "usd_rate"):    # dollars per month (per person for orgs), naira per $1
            if k in body.pricing:
                v = float(body.pricing[k])
                if v <= 0:
                    raise HTTPException(422, f"{k} must be positive.")
                p[k] = int(v) if v.is_integer() else round(v, 2)
        if isinstance(body.pricing.get("discounts"), dict):
            p["discounts"] = {str(k): min(0.9, max(0.0, float(v))) for k, v in body.pricing["discounts"].items()
                              if str(k) in ("1", "3", "12")}
        put_setting(db, "pricing", p)
    if body.limits is not None:
        clean = {}
        for tier, lim in body.limits.items():
            if tier in DEFAULT_LIMITS and isinstance(lim, dict):
                clean[tier] = {k: max(0, int(v)) for k, v in lim.items() if k in DEFAULT_LIMITS[tier]}
        put_setting(db, "limits", clean)
    if body.manual_accounts is not None:
        accts = []
        for a in body.manual_accounts[:10]:
            if isinstance(a, dict) and a.get("number"):
                accts.append(dict(bank=str(a.get("bank", ""))[:60], number=str(a["number"])[:30],
                                  name=str(a.get("name", ""))[:120]))
        put_setting(db, "manual_accounts", accts)
    if body.announcement is not None:
        put_setting(db, "announcement", body.announcement.strip())
    billing.audit(db, "settings_updated", None, body.model_dump(exclude_none=True), admin.id)
    db.commit()
    return get_settings(admin, db)


@router.get("/system")
def system(admin: User = Depends(admin_user)):
    return dict(engine=engine.status(), catalog=catalog.status(), ai_provider=streixai.provider(),
                paystack=settings.paystack_enabled, dedicated_accounts=settings.paystack_dva_enabled,
                opay=settings.opay_enabled, email=mailer.configured(), google=settings.google_enabled,
                linkedin=settings.linkedin_enabled, env=settings.env, database=settings.database_url.split(":")[0])


@router.post("/brain/reload")
def brain_reload(admin: User = Depends(admin_user)):
    engine.load_brain()
    return engine.status()


@router.post("/brain/upload")
async def brain_upload(file: UploadFile = File(...), admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Upload guru_brain.joblib from the notebook. Only load files you trained yourself (joblib runs code)."""
    if not (file.filename or "").endswith(".joblib"):
        raise HTTPException(415, "Upload the guru_brain.joblib file from the notebook.")
    target = settings.brain_path
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".upload")
    size = 0
    with open(tmp, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > 600 * 1024 * 1024:
                f.close()
                tmp.unlink(missing_ok=True)
                raise HTTPException(413, "File too large.")
            f.write(chunk)
    backup = target.with_suffix(".previous")
    if target.exists():
        target.replace(backup)
    tmp.replace(target)
    st = engine.load_brain()
    if st["status"] != "trained":
        detail = st["detail"]
        if backup.exists():
            backup.replace(target)
        else:
            target.unlink(missing_ok=True)
        engine.load_brain()
        raise HTTPException(422, f"That file didn't load, so it wasn't used. {detail}")
    billing.audit(db, "brain_uploaded", file.filename, dict(size=size), admin.id)
    db.commit()
    return engine.status()


@router.post("/catalog/refresh")
def catalog_refresh(admin: User = Depends(admin_user)):
    catalog.refresh(force=True)
    return catalog.status()


@router.get("/analyses")
def analyses(limit: int = 100, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    rows = db.execute(select(AnalysisLog).order_by(AnalysisLog.id.desc()).limit(min(limit, 500))).scalars()
    return dict(items=[dict(id=r.id, user_id=r.user_id, kind=r.kind, symbol=r.symbol, tf=r.tf, price=r.price,
                            action=r.action, grade=r.grade, side=r.side, entry=r.entry, sl=r.sl, tp=r.tp, p_tp=r.p_tp,
                            outcome=r.outcome, created_at=iso(r.created_at)) for r in rows])


@router.get("/actions")
def actions(admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    rows = db.execute(select(AdminAction).order_by(AdminAction.id.desc()).limit(200)).scalars()
    return dict(items=[dict(id=r.id, admin_id=r.admin_id, action=r.action, target=r.target, detail=jload(r.detail),
                            created_at=iso(r.created_at)) for r in rows])


# ───────────────────────────── verified learning data ─────────────────────────────
LEARN_MIN_SCORE = 70


@router.get("/learning")
def learning(admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    """What the verified-learning pipeline has to work with. Only calls whose outcome was measured on real candles
    after the call, and practice analyses the analyst scored highly, are offered for export."""
    from ..models import PracticeAttempt
    by = dict(db.execute(select(AnalysisLog.outcome, func.count(AnalysisLog.id))
                         .where(AnalysisLog.kind.in_(("analysis", "replay")))
                         .group_by(AnalysisLog.outcome)).all())
    resolved = sum(by.get(k, 0) for k in ("tp", "sl", "time"))
    prac = db.execute(select(func.count(PracticeAttempt.id))).scalar()
    good = db.execute(select(func.count(PracticeAttempt.id)).where(PracticeAttempt.score >= LEARN_MIN_SCORE)).scalar()
    last = db.execute(select(AdminAction).where(AdminAction.action == "learning_export")
                      .order_by(AdminAction.id.desc()).limit(1)).scalar_one_or_none()
    return dict(calls=dict(resolved=resolved, by_outcome={(k or "untracked"): v for k, v in by.items()}),
                practice=dict(total=prac, accurate=good, min_score=LEARN_MIN_SCORE),
                last_export=dict(at=iso(last.created_at), detail=jload(last.detail, None)) if last else None,
                note="Exports are for offline retraining in the notebook. Nothing is learned automatically: a new "
                     "brain only goes live when you upload it after checking its out-of-sample report.")


@router.get("/learning/export")
def learning_export(dataset: str = "calls", min_score: int = LEARN_MIN_SCORE, admin: User = Depends(admin_user),
                    db: Session = Depends(get_db)):
    import json as _json

    from fastapi.responses import StreamingResponse

    from ..models import PracticeAttempt
    if dataset not in ("calls", "practice"):
        raise HTTPException(422, "dataset must be 'calls' or 'practice'.")
    if dataset == "calls":
        # only accounts that ticked "learn from my charts" at sign-up (or later) are exported
        consenting = select(User.id).where(User.learn_consent.is_(True))
        rows = db.execute(select(AnalysisLog).where(AnalysisLog.kind.in_(("analysis", "replay")), AnalysisLog.dup_of.is_(None),
                                                    AnalysisLog.outcome.in_(("tp", "sl", "time")),
                                                    AnalysisLog.user_id.in_(consenting))
                          .order_by(AnalysisLog.id)).scalars().all()

        def rec(r):
            return dict(id=r.id, created_at=iso(r.created_at), symbol=r.symbol, tf=r.tf, side=r.side, type=r.plan_type,
                        called=r.called, grade=r.grade, entry=r.entry, sl=r.sl, tp=r.tp, p_tp=r.p_tp,
                        outcome=r.outcome, r=r.outcome_r, filled_at=iso(r.filled_at), outcome_at=iso(r.outcome_at),
                        exit=r.exit_price, analysis=jload(r.summary, None))
    else:
        consenting = select(User.id).where(User.learn_consent.is_(True))
        rows = db.execute(select(PracticeAttempt).where(PracticeAttempt.score >= max(0, min(100, min_score)),
                                                        PracticeAttempt.user_id.in_(consenting))
                          .order_by(PracticeAttempt.id)).scalars().all()

        def rec(r):
            return dict(id=r.id, created_at=iso(r.created_at), symbol=r.symbol, tf=r.tf, price=r.price, bias=r.bias,
                        score=r.score, grade=r.grade, breakdown=jload(r.breakdown, None), drawings=jload(r.drawings, []),
                        trade=jload(r.trade, None))
    data = [rec(r) for r in rows]          # read everything before the commit expires the rows
    billing.audit(db, "learning_export", dataset, dict(rows=len(data), min_score=min_score), admin.id)
    db.commit()
    stamp = utcnow().strftime("%Y%m%d-%H%M")

    def gen():
        for d in data:
            yield _json.dumps(d, default=str) + "\n"
    return StreamingResponse(gen(), media_type="application/x-ndjson",
                             headers={"Content-Disposition": f'attachment; filename="streix-{dataset}-{stamp}.jsonl"'})

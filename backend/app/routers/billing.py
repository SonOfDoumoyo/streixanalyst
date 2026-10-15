"""Plans and payments: Paystack (card, USSD, bank, transfer), personal virtual account numbers,
OPay checkout, and direct transfer to the company accounts with proof upload + admin approval."""
import json
import logging
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import current_user
from ..models import Payment, User, VirtualAccount, iso
from ..plans import plans_overview, quote
from ..security import random_code
from ..serialize import payment_out, user_out
from ..services import billing, opay, paystack

log = logging.getLogger("streix.billing")
router = APIRouter(prefix="/billing", tags=["billing"])
CHANNELS = {"card": ["card"], "ussd": ["ussd"], "bank": ["bank"], "bank_transfer": ["bank_transfer"],
            "any": None}
PROOF_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf"}


class CheckoutIn(BaseModel):
    plan: str
    months: int = 1
    seats: int = 1
    provider: str = "paystack"          # paystack | opay
    channel: str = "any"                # card | ussd | bank | bank_transfer | any


class IntentIn(BaseModel):
    plan: str
    months: int = 1
    seats: int = 1


class ManualIn(IntentIn):
    account: int = Field(0, ge=0, le=20)


def methods(db):
    return dict(paystack=settings.paystack_enabled, opay=settings.opay_enabled,
                dedicated_account=settings.paystack_enabled and settings.paystack_dva_enabled,
                manual=bool(billing.manual_accounts(db)))


@router.get("/plans")
def plans(db: Session = Depends(get_db)):
    out = plans_overview(db)
    out["methods"] = methods(db)
    out["manual_accounts"] = billing.manual_accounts(db)
    return out


def _new_payment(db, user, body, provider, method=None, status="pending", prefix="SA"):
    q = quote(db, body.plan, body.months, body.seats)
    pay = Payment(user_id=user.id, reference=billing.new_reference(prefix), provider=provider, method=method,
                  plan=q["plan"], months=q["months"], seats=q["seats"], amount_kobo=q["kobo"], currency="NGN",
                  status=status)
    db.add(pay)
    db.commit()
    return pay, q


@router.post("/checkout")
def checkout(body: CheckoutIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.provider == "paystack":
        if not settings.paystack_enabled:
            raise HTTPException(503, "Card/USSD payments aren't switched on yet. Use bank transfer for now.")
        pay, q = _new_payment(db, user, body, "paystack", body.channel)
        try:
            data = paystack.initialize(user.email, pay.amount_kobo, pay.reference,
                                       f"{settings.frontend_url}/billing/callback",
                                       metadata=dict(user_id=user.id, plan=pay.plan, months=pay.months, seats=pay.seats,
                                                     custom_fields=[dict(display_name="Plan", variable_name="plan",
                                                                         value=billing.plan_label(pay))]),
                                       channels=CHANNELS.get(body.channel))
        except paystack.PaystackError as e:
            pay.status, pay.note = "failed", str(e)[:300]
            db.commit()
            raise HTTPException(502, f"Paystack: {e}")
        pay.provider_ref = data.get("access_code")
        db.commit()
        return dict(reference=pay.reference, url=data["authorization_url"], amount=q["naira"], provider="paystack")
    if body.provider == "opay":
        if not settings.opay_enabled:
            raise HTTPException(503, "OPay checkout isn't switched on yet. Use bank transfer to our OPay account.")
        pay, q = _new_payment(db, user, body, "opay", "opay")
        try:
            data = opay.create_cashier(pay.reference, pay.amount_kobo,
                                       f"{settings.frontend_url}/billing/callback?reference={pay.reference}",
                                       f"{settings.public_api_url}/billing/opay/callback",
                                       f"{settings.frontend_url}/billing?cancelled=1", user.email, user.name, user.id,
                                       "StreixAnalyst " + billing.plan_label(pay), "StreixAnalyst subscription")
        except opay.OPayError as e:
            pay.status, pay.note = "failed", str(e)[:300]
            db.commit()
            raise HTTPException(502, f"OPay: {e}")
        pay.provider_ref = data.get("orderNo")
        db.commit()
        return dict(reference=pay.reference, url=data.get("cashierUrl"), amount=q["naira"], provider="opay")
    raise HTTPException(422, "Unknown payment provider.")


def _mine(db, user, reference):
    pay = db.execute(select(Payment).where(Payment.reference == reference)).scalar_one_or_none()
    if not pay or (pay.user_id != user.id and user.role != "admin"):
        raise HTTPException(404, "Payment not found.")
    return pay


@router.get("/verify")
def verify(reference: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    pay = _mine(db, user, reference.strip())
    result = dict(ok=pay.applied, status=pay.status)
    if not pay.applied:
        if pay.provider == "paystack":
            result = billing.verify_paystack(db, pay)
        elif pay.provider == "opay":
            result = billing.verify_opay(db, pay)
        db.refresh(pay)
    db.refresh(user)
    return dict(result=result, payment=payment_out(pay), user=user_out(db, user))


@router.post("/paystack/webhook")
async def paystack_webhook(request: Request, db: Session = Depends(get_db)):
    raw = await request.body()
    if not paystack.valid_signature(raw, request.headers.get("x-paystack-signature")):
        log.warning("Paystack webhook with a bad signature from %s", request.client.host if request.client else "?")
        raise HTTPException(401, "bad signature")
    try:
        event = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "bad json")
    try:
        outcome = billing.handle_paystack_event(db, event)
    except Exception:
        log.exception("Paystack webhook handling failed")
        raise HTTPException(500, "error")           # Paystack retries failed deliveries
    return dict(ok=True, outcome=outcome)


@router.post("/opay/callback")
async def opay_callback(request: Request, db: Session = Depends(get_db)):
    """OPay's notification only tells us to look again; the signed status query decides."""
    try:
        body = await request.json()
    except Exception:
        return dict(ok=True)
    payload = body.get("payload") if isinstance(body, dict) else None
    ref = (payload or body or {}).get("reference") if isinstance(payload or body, dict) else None
    if ref:
        pay = db.execute(select(Payment).where(Payment.reference == ref, Payment.provider == "opay")).scalar_one_or_none()
        if pay and not pay.applied:
            billing.verify_opay(db, pay)
    return dict(ok=True)


# ── personal account numbers (Paystack dedicated virtual accounts)
def _va_out(va):
    if not va:
        return None
    return dict(account_number=va.account_number, account_name=va.account_name, bank_name=va.bank_name,
                status=va.status, created_at=iso(va.created_at))


@router.get("/dva")
def get_dva(user: User = Depends(current_user), db: Session = Depends(get_db)):
    va = db.execute(select(VirtualAccount).where(VirtualAccount.user_id == user.id)).scalar_one_or_none()
    return dict(enabled=methods(db)["dedicated_account"], account=_va_out(va))


@router.post("/dva")
def create_dva(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not methods(db)["dedicated_account"]:
        raise HTTPException(503, "Personal account numbers aren't switched on yet.")
    if not user.phone:
        raise HTTPException(422, "Add your phone number in Settings first (the bank needs it to open your account "
                                 "number).")
    va = db.execute(select(VirtualAccount).where(VirtualAccount.user_id == user.id)).scalar_one_or_none()
    if va and va.status == "active" and va.account_number:
        return dict(account=_va_out(va))
    try:
        if not va:
            cust = paystack.create_customer(user.email, user.first_name or "StreixAnalyst",
                                            user.last_name or "User", user.phone)
            va = VirtualAccount(user_id=user.id, customer_code=cust["customer_code"], status="pending")
            db.add(va)
            db.commit()
        else:
            paystack.update_customer(va.customer_code, user.first_name or "StreixAnalyst", user.last_name or "User",
                                     user.phone)
        data = paystack.create_dedicated_account(va.customer_code, settings.paystack_dva_bank)
    except paystack.PaystackError as e:
        raise HTTPException(502, f"Couldn't create your account number: {e}")
    if data and data.get("account_number"):
        va.account_number, va.account_name = data.get("account_number"), data.get("account_name")
        va.bank_name, va.status = (data.get("bank") or {}).get("name"), "active"
        db.commit()
    return dict(account=_va_out(va))


@router.post("/dva/intent")
def dva_intent(body: IntentIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    va = db.execute(select(VirtualAccount).where(VirtualAccount.user_id == user.id)).scalar_one_or_none()
    if not va or va.status != "active":
        raise HTTPException(409, "Create your account number first.")
    for old in db.execute(select(Payment).where(Payment.user_id == user.id, Payment.provider == "paystack_dva",
                                                Payment.status == "pending", Payment.applied.is_(False))).scalars():
        old.status = "cancelled"
    pay, q = _new_payment(db, user, body, "paystack_dva", "bank_transfer", prefix="SA-DVA")
    return dict(payment=payment_out(pay), account=_va_out(va), amount=q["naira"])


# ── transfer to the company's OPay / UBA accounts, then upload proof
@router.post("/manual/start")
def manual_start(body: ManualIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    accts = billing.manual_accounts(db)
    if not accts:
        raise HTTPException(503, "Bank transfer isn't available right now.")
    if body.account >= len(accts):
        raise HTTPException(422, "Choose one of the listed accounts.")
    a = accts[body.account]
    pay, q = _new_payment(db, user, body, "manual", "bank_transfer", status="awaiting_transfer", prefix="SA")
    pay.reference = "SA" + random_code(6)
    pay.account_label = f"{a.get('bank')} · {a.get('number')} · {a.get('name')}"
    db.commit()
    return dict(payment=payment_out(pay), account=a, amount=q["naira"],
                instructions=f"Transfer exactly ₦{q['naira']:,} to {a.get('bank')} {a.get('number')} "
                             f"({a.get('name')}). Put {pay.reference} in the narration/remark, then upload your "
                             "receipt. We confirm the money has arrived before unlocking your plan.")


@router.post("/manual/{reference}/proof")
async def manual_proof(reference: str, payer_name: str = Form(..., max_length=160), note: str = Form("", max_length=500),
                       file: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    pay = _mine(db, user, reference)
    if pay.provider != "manual" or pay.status not in ("awaiting_transfer", "review", "rejected"):
        raise HTTPException(409, "This payment can't take a receipt.")
    ext = PROOF_TYPES.get((file.content_type or "").lower())
    if not ext:
        raise HTTPException(415, "Upload a PNG, JPG, WEBP screenshot or a PDF receipt.")
    data = await file.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(413, "The receipt must be under 8 MB.")
    head = data[:8]
    if not (head.startswith(b"\x89PNG") or head.startswith(b"\xff\xd8") or head[:4] == b"RIFF" or head.startswith(b"%PDF")):
        raise HTTPException(415, "That file doesn't look like an image or PDF.")
    folder = settings.upload_dir / "proofs"
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{pay.reference}-{uuid.uuid4().hex[:8]}{ext}"
    (folder / name).write_bytes(data)
    pay.proof_path, pay.payer_name, pay.status = f"proofs/{name}", payer_name.strip(), "review"
    pay.note = (note or "").strip() or None
    billing.audit(db, "manual_proof_uploaded", pay.reference, dict(user=user.id, payer=payer_name))
    db.commit()
    return dict(payment=payment_out(pay), message="Thanks! We'll confirm your transfer shortly — usually within a few "
                                                   "hours. You'll see your plan unlock here.")


@router.get("/payments")
def my_payments(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Payment).where(Payment.user_id == user.id).order_by(Payment.id.desc()).limit(50)).scalars()
    return dict(payments=[payment_out(p) for p in rows])


@router.post("/payments/{reference}/cancel")
def cancel(reference: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    pay = _mine(db, user, reference)
    if pay.applied or pay.status not in ("pending", "awaiting_transfer"):
        raise HTTPException(409, "This payment can't be cancelled.")
    pay.status = "cancelled"
    db.commit()
    return dict(payment=payment_out(pay))

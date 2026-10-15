"""Turning verified payments into subscriptions — exactly once per payment.

A payment unlocks a plan only when:
  * Paystack: the webhook signature is valid AND Paystack's verify API says success, with the right reference,
    currency and at least the amount we priced on the server;
  * OPay: OPay's signed status query says SUCCESS with the right amount;
  * Bank transfer to the company accounts: an admin has checked the money arrived and approved the proof.
The `applied` flag is flipped with a conditional UPDATE, so a payment can never be applied twice
(duplicate webhooks, a user refreshing the callback page, an admin double-clicking)."""
import logging

from sqlalchemy import select, update

from ..config import settings
from ..models import AdminAction, Organization, Payment, User, jdump, utcnow
from ..plans import extend, get_setting
from ..security import random_code
from . import donations, mailer, opay, paystack

log = logging.getLogger("streix.billing")


def manual_accounts(db):
    accts = get_setting(db, "manual_accounts", None)
    if accts is None:
        accts = settings.manual_accounts
    return [a for a in accts if a.get("number")]


def new_reference(prefix="SA"):
    return f"{prefix}-{random_code(10)}"


def plan_label(p):
    if p.plan == "org":
        return f"Organization (whole team) · {p.months} month{'s' if p.months > 1 else ''}"
    return f"Pro · {p.months} month{'s' if p.months > 1 else ''}"


def audit(db, action, target=None, detail=None, admin_id=None):
    db.add(AdminAction(admin_id=admin_id, action=action, target=target, detail=jdump(detail) if detail else None))


def apply_payment(db, pay, paid_kobo=None, provider_ref=None, raw=None, method=None, admin_id=None, note=None):
    """Unlock the plan for a verified payment. Returns True if this call applied it, False if it already was."""
    res = db.execute(update(Payment).where(Payment.id == pay.id, Payment.applied.is_(False))
                     .values(applied=True, status="success", verified_at=utcnow(), verified_by=admin_id,
                             paid_kobo=paid_kobo if paid_kobo is not None else pay.amount_kobo,
                             provider_ref=provider_ref or pay.provider_ref, method=method or pay.method,
                             raw=jdump(raw)[:20000] if raw is not None else pay.raw,
                             note=note if note is not None else pay.note))
    if res.rowcount != 1:
        db.rollback()
        return False
    user = db.get(User, pay.user_id)
    if pay.plan == "pro":
        user.plan_expires_at = extend(user.plan_expires_at if user.plan == "pro" else None, pay.months)
        user.plan = "pro"
    else:
        org = db.get(Organization, user.org_id) if (user.org_id and user.org_role == "owner") else None
        if org is None:
            org = Organization(name=f"{user.name}'s organization", owner_id=user.id, seats=pay.seats,
                               invite_code=random_code(10))
            db.add(org)
            db.flush()
        org.seats = max(org.seats or 0, pay.seats)
        org.plan_expires_at = extend(org.plan_expires_at, pay.months)
        user.org_id, user.org_role = org.id, "owner"
    audit(db, "payment_applied", pay.reference, dict(plan=pay.plan, months=pay.months, seats=pay.seats,
                                                     provider=pay.provider, paid_kobo=paid_kobo), admin_id)
    db.commit()
    db.refresh(pay)
    mailer.send(user.email, "Your StreixAnalyst payment is confirmed",
                f"Hi {user.first_name or 'there'},\n\nWe've confirmed your payment of ₦{(paid_kobo or pay.amount_kobo) / 100:,.2f} "
                f"(ref {pay.reference}). {plan_label(pay)} is now active.\n\nHappy trading,\nStreixAnalyst")
    log.info("applied payment %s for user %s", pay.reference, user.id)
    return True


def check_paystack_data(pay, data):
    """None if the Paystack transaction proves this payment; otherwise the reason it doesn't."""
    if not data:
        return "no data from Paystack"
    if data.get("status") != "success":
        return f"transaction status is '{data.get('status')}'"
    if data.get("reference") != pay.reference:
        return "reference mismatch"
    if (data.get("currency") or "").upper() != pay.currency:
        return f"currency {data.get('currency')} instead of {pay.currency}"
    if int(data.get("amount") or 0) < pay.amount_kobo:
        return f"paid ₦{int(data.get('amount') or 0) / 100:,.2f} but ₦{pay.amount_kobo / 100:,.2f} was due"
    return None


def verify_paystack(db, pay):
    """Ask Paystack about this payment and apply it if it's genuinely paid."""
    try:
        data = paystack.verify(pay.reference)
    except paystack.PaystackError as e:
        return dict(ok=False, status=pay.status, message=str(e))
    problem = check_paystack_data(pay, data)
    if problem is None:
        apply_payment(db, pay, int(data["amount"]), str(data.get("id")), data, data.get("channel"))
        return dict(ok=True, status="success")
    st = data.get("status") if data else None
    if st in ("failed", "abandoned", "reversed"):
        pay.status = st
        db.commit()
    elif st == "success":                       # paid, but something doesn't match: a human must look
        pay.status, pay.note = "review", f"Paystack says success but {problem}."
        pay.raw = jdump(data)[:20000]
        db.commit()
    return dict(ok=False, status=pay.status, message=problem)


def verify_opay(db, pay):
    try:
        data = opay.query_status(pay.reference)
    except opay.OPayError as e:
        return dict(ok=False, status=pay.status, message=str(e))
    st = str(data.get("status", "")).upper()
    amt = data.get("amount") or {}
    total = int(float(amt.get("total") or 0))
    cur = (amt.get("currency") or "").upper()
    if st == "SUCCESS" and total >= pay.amount_kobo and cur == pay.currency and data.get("reference", pay.reference) == pay.reference:
        apply_payment(db, pay, total, data.get("orderNo"), data, "opay")
        return dict(ok=True, status="success")
    if st == "SUCCESS":
        pay.status, pay.note = "review", f"OPay says success but amount/currency don't match ({total} {cur})."
        db.commit()
    elif st in ("FAIL", "CLOSE"):
        pay.status = "failed"
        db.commit()
    return dict(ok=False, status=pay.status, message=f"OPay status {st or 'unknown'}")


def handle_paystack_event(db, event):
    """Webhook events (signature already checked). Always re-verifies with the API before unlocking anything."""
    kind = event.get("event")
    data = event.get("data") or {}
    if kind == "charge.success":
        ref = data.get("reference")
        pay = db.execute(select(Payment).where(Payment.reference == ref)).scalar_one_or_none() if ref else None
        if pay is not None:
            if not pay.applied:
                verify_paystack(db, pay)
            return "ok"
        if donations.is_donation_ref(ref):          # a donation: ask Paystack again before counting it
            return donations.verify(db, str(ref)).get("status", "ok")
        channel = data.get("channel") or (data.get("authorization") or {}).get("channel")
        if channel == "dedicated_nuban":
            return _dedicated_transfer(db, data)
        return "unknown reference"
    if kind in ("dedicatedaccount.assign.success", "assigndedicatedaccount.success"):
        from ..models import VirtualAccount
        cust = (data.get("customer") or {}).get("customer_code")
        acct = data.get("dedicated_account") or {}
        va = db.execute(select(VirtualAccount).where(VirtualAccount.customer_code == cust)).scalar_one_or_none()
        if va and acct.get("account_number"):
            va.account_number, va.account_name = acct.get("account_number"), acct.get("account_name")
            va.bank_name, va.status = (acct.get("bank") or {}).get("name"), "active"
            db.commit()
        return "ok"
    if kind in ("dedicatedaccount.assign.failed", "assigndedicatedaccount.failed"):
        from ..models import VirtualAccount
        cust = (data.get("customer") or {}).get("customer_code")
        va = db.execute(select(VirtualAccount).where(VirtualAccount.customer_code == cust)).scalar_one_or_none()
        if va:
            va.status = "failed"
            db.commit()
        return "ok"
    return "ignored"


def _dedicated_transfer(db, data):
    """Money sent to a user's own virtual account number."""
    from ..models import VirtualAccount
    ref = data.get("reference")
    if db.execute(select(Payment).where(Payment.provider_ref == f"dva:{ref}")).scalar_one_or_none():
        return "duplicate"
    try:                                          # never trust the webhook body alone
        data = paystack.verify(ref)
    except paystack.PaystackError as e:
        log.warning("DVA verify failed for %s: %s", ref, e)
        return "verify failed"
    if data.get("status") != "success" or (data.get("currency") or "").upper() != "NGN":
        return "not successful"
    cust = (data.get("customer") or {}).get("customer_code")
    va = db.execute(select(VirtualAccount).where(VirtualAccount.customer_code == cust)).scalar_one_or_none()
    if not va:
        log.warning("DVA transfer %s for unknown customer %s", ref, cust)
        return "unknown customer"
    paid = int(data.get("amount") or 0)
    intents = db.execute(select(Payment).where(Payment.user_id == va.user_id, Payment.provider == "paystack_dva",
                                               Payment.status == "pending", Payment.applied.is_(False))
                         .order_by(Payment.id.desc())).scalars().all()
    match = next((p for p in intents if p.amount_kobo <= paid), None)
    if match:
        match.provider_ref = f"dva:{ref}"
        db.commit()
        apply_payment(db, match, paid, f"dva:{ref}", data, "bank_transfer")
        return "applied"
    pay = Payment(user_id=va.user_id, reference=new_reference("SA-DVA"), provider="paystack_dva",
                  method="bank_transfer", plan="pro", months=1, seats=1, amount_kobo=paid, paid_kobo=paid,
                  status="review", provider_ref=f"dva:{ref}", raw=jdump(data)[:20000],
                  note=f"Transfer of ₦{paid / 100:,.2f} to the user's account number with no matching plan "
                       "(or too small). Approve with the right plan, or refund.")
    db.add(pay)
    db.commit()
    return "review"

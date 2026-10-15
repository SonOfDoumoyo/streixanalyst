"""Donations: a voluntary gift in naira through Paystack.

A donation never unlocks a feature, so the plan code doesn't read it. Every donation gets its own reference that starts
with DON. Both the thank-you page and the Paystack webhook ask Paystack (not our own record) whether the money really
arrived, and only then mark the donation as paid. The amount and currency must match what was asked for."""
import logging
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Donation, utcnow
from . import paystack

log = logging.getLogger("streix.donations")
PREFIX = "DON"
MIN_NAIRA = 500
MAX_NAIRA = 5_000_000
PRESETS = [1000, 2500, 5000, 10000]


def is_donation_ref(reference):
    return bool(reference) and str(reference).startswith(PREFIX)


def new_reference():
    return PREFIX + secrets.token_hex(8).upper()


def verify(db: Session, reference: str):
    """Ask Paystack about one donation and mark it paid only when the amount and currency match."""
    don = db.execute(select(Donation).where(Donation.reference == reference)).scalar_one_or_none()
    if don is None:
        return dict(ok=False, status="unknown", message="We couldn't find that donation.")
    if don.status == "success":
        return dict(ok=True, status="success", amount=don.amount_kobo / 100)
    try:
        data = paystack.verify(reference) or {}
    except paystack.PaystackError as e:
        return dict(ok=False, status=don.status, message=str(e))
    st = data.get("status")
    if st == "success":
        if int(data.get("amount") or 0) == don.amount_kobo and data.get("currency", "NGN") == "NGN":
            don.status, don.paid_at = "success", utcnow()
            db.commit()
            return dict(ok=True, status="success", amount=don.amount_kobo / 100)
        log.warning("donation %s: Paystack says success but the amount or currency differs", reference)
        return dict(ok=False, status=don.status, message="The amount didn't match, so we're checking it.")
    if st in ("failed", "abandoned", "reversed"):
        don.status = "failed"
        db.commit()
    return dict(ok=False, status=don.status, message="Not paid yet.")

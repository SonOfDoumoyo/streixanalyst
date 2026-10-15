"""Donations: a voluntary gift in naira through Paystack. Signed-in or not, nothing is unlocked by giving."""
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import client_ip, optional_user
from ..models import Donation, User
from ..security import RateLimiter
from ..services import donations, paystack

router = APIRouter(prefix="/donate", tags=["donate"])
donate_limiter = RateLimiter(20, 60 * 60)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class DonateIn(BaseModel):
    amount: int = Field(ge=donations.MIN_NAIRA, le=donations.MAX_NAIRA)     # whole naira
    name: str | None = Field(None, max_length=120)
    email: str | None = Field(None, max_length=255)     # only needed when not signed in (for the receipt)
    message: str | None = Field(None, max_length=500)


@router.get("/config")
def config():
    return dict(enabled=settings.paystack_enabled, currency="NGN", min=donations.MIN_NAIRA,
                max=donations.MAX_NAIRA, presets=donations.PRESETS, company="Streixcorp")


@router.post("")
def donate(body: DonateIn, request: Request, user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    if not donate_limiter.hit(client_ip(request)):
        raise HTTPException(429, "Too many donation attempts from this network. Please try again later.")
    if not settings.paystack_enabled:
        raise HTTPException(503, "Donations aren't switched on yet. Thank you for wanting to give.")
    email = user.email if user else (body.email or "").strip().lower()
    if not EMAIL_RE.match(email or ""):
        raise HTTPException(422, "Enter an email address for your receipt.")
    don = Donation(reference=donations.new_reference(), user_id=user.id if user else None,
                   name=(body.name or "").strip() or (user.name if user else ""), email=email,
                   message=(body.message or "").strip() or None, amount_kobo=body.amount * 100)
    db.add(don)
    db.commit()
    try:
        data = paystack.initialize(email, don.amount_kobo, don.reference,
                                   f"{settings.frontend_url}/donate/thanks",
                                   metadata=dict(purpose="donation", donation_ref=don.reference))
    except paystack.PaystackError as e:
        don.status = "failed"
        db.commit()
        raise HTTPException(502, f"Paystack: {e}")
    return dict(reference=don.reference, url=data["authorization_url"], amount=body.amount)


@router.get("/verify/{reference}")
def verify(reference: str, db: Session = Depends(get_db)):
    """The thank-you page calls this. It only says 'paid' once Paystack confirms the amount."""
    ref = reference.strip().upper()
    if not donations.is_donation_ref(ref):
        raise HTTPException(404, "Donation not found.")
    return donations.verify(db, ref)

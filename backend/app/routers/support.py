"""Support: the Support page sends a message here. It is always kept in the database, and emailed to the company
when email is set up (SMTP_* and CONTACT_COMPANY_EMAIL in .env)."""
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import admin_user, client_ip, optional_user
from ..models import SupportTicket, User, iso
from ..security import RateLimiter
from ..services import billing, mailer

log = logging.getLogger("streix.support")
router = APIRouter(prefix="/support", tags=["support"])
admin_router = APIRouter(prefix="/admin/support", tags=["admin"])
support_limiter = RateLimiter(12, 60 * 60)
CATEGORIES = ("account", "payments", "trading", "classroom", "bug", "other")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class TicketIn(BaseModel):
    name: str | None = Field(None, max_length=120)
    email: str | None = Field(None, max_length=255)      # needed when not signed in
    category: str = "other"
    subject: str = Field(min_length=3, max_length=160)
    message: str = Field(min_length=10, max_length=4000)
    website: str | None = Field(None, max_length=200)    # honeypot: people never fill this hidden field in


class StatusIn(BaseModel):
    status: str


@router.post("")
def open_ticket(body: TicketIn, request: Request, user: User | None = Depends(optional_user),
                db: Session = Depends(get_db)):
    if body.website:                       # a bot filled in the hidden field: act as if it worked, store nothing
        return dict(ok=True, id=None, emailed=False, message="Thanks. We've got your message.")
    if not support_limiter.hit(client_ip(request)):
        raise HTTPException(429, "You've sent several messages in a short time. Please try again later.")
    email = user.email if user else (body.email or "").strip().lower()
    if not EMAIL_RE.match(email or ""):
        raise HTTPException(422, "Enter an email address we can reply to.")
    category = body.category if body.category in CATEGORIES else "other"
    name = (body.name or "").strip() or (user.name if user else "")
    ticket = SupportTicket(user_id=user.id if user else None, name=name[:120], email=email, category=category,
                           subject=body.subject.strip(), message=body.message.strip())
    db.add(ticket)
    db.commit()
    emailed = False
    to = settings.contact.get("company_email")
    if to and mailer.configured():
        emailed = mailer.send(to, f"[StreixAnalyst support #{ticket.id}] {ticket.subject}",
                              f"From: {name or 'Guest'} <{email}>\nCategory: {category}\n"
                              f"Account: {user.id if user else 'not signed in'}\n\n{ticket.message}")
    return dict(ok=True, id=ticket.id, emailed=bool(emailed),
                message="Thanks. We've got your message and will reply to your email.")


@admin_router.get("")
def list_tickets(status: str = "open", admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    """Newest first. Open tickets by default."""
    q = select(SupportTicket).order_by(SupportTicket.id.desc()).limit(200)
    if status in ("open", "closed"):
        q = q.where(SupportTicket.status == status)
    rows = db.execute(q).scalars().all()
    open_count = db.execute(select(func.count()).select_from(SupportTicket)
                            .where(SupportTicket.status == "open")).scalar_one()
    return dict(open=open_count, tickets=[dict(
        id=t.id, created_at=iso(t.created_at), name=t.name, email=t.email, category=t.category, subject=t.subject,
        message=t.message, status=t.status, user_id=t.user_id) for t in rows])


@admin_router.post("/{ticket_id}/status")
def set_status(ticket_id: int, body: StatusIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    if body.status not in ("open", "closed"):
        raise HTTPException(422, "Status must be open or closed.")
    ticket = db.get(SupportTicket, ticket_id)
    if ticket is None:
        raise HTTPException(404, "Ticket not found.")
    ticket.status = body.status
    billing.audit(db, "support_" + body.status, str(ticket.id), {}, admin.id)
    db.commit()
    return dict(ok=True)

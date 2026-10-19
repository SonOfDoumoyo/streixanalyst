"""Request dependencies: who is calling, and are they allowed."""
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from .models import User, utcnow
from .security import COOKIE, read_token
from .services import mailer

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
UNVERIFIED_MESSAGE = ("Confirm your email first. Check your inbox for the link, or ask for a new one "
                      "from your account page.")


def _token_from(request: Request):
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip(), "bearer"
    tok = request.cookies.get(COOKIE)
    return (tok, "cookie") if tok else (None, None)


def optional_user(request: Request, db: Session = Depends(get_db)):
    token, how = _token_from(request)
    if not token:
        return None
    data = read_token(token)
    if not data:
        return None
    try:
        user = db.get(User, int(data["sub"]))
    except (KeyError, ValueError):
        return None
    if not user or not user.is_active or int(data.get("v", -1)) != user.token_version:
        return None
    # Cookie sessions: state-changing calls must come from our own pages (custom header → CORS preflight).
    if how == "cookie" and request.method not in SAFE_METHODS and not request.headers.get("x-requested-with"):
        raise HTTPException(403, "Missing X-Requested-With header.")
    now = utcnow()
    if user.last_seen_at is None or (now - user.last_seen_at).total_seconds() > 300:
        user.last_seen_at = now
        db.commit()
    return user


def current_user(user: User | None = Depends(optional_user)):
    if user is None:
        raise HTTPException(401, "Please sign in.")
    return user


def check_verified(user: User | None):
    """Once email is set up on this server, a signed-in account must confirm its email before it can act.
    Reading the chart, the account and support stay open so the person can get to the confirmation."""
    if user is not None and mailer.configured() and not user.email_verified:
        raise HTTPException(403, detail=dict(code="email_unverified", message=UNVERIFIED_MESSAGE))


def verified_user(user: User = Depends(current_user)):
    check_verified(user)
    return user


def admin_user(user: User = Depends(current_user)):
    if user.role != "admin":
        raise HTTPException(403, "Admins only.")
    return user


def client_ip(request: Request):
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"

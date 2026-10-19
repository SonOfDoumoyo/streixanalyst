"""Accounts: email/password, Google, LinkedIn, profile, password reset."""
import re
from datetime import timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import client_ip, current_user, optional_user
from ..models import OAuthAccount, Organization, User, WatchItem, jdump, utcnow
from ..security import (ACCOUNT_LOCK_AFTER, account_failures, clear_session_cookie, hash_password, login_limiter,
                        make_token, password_problem, random_code, set_session_cookie, sha256, sign, signup_limiter,
                        suspended_message, unsign, verify_password)
from ..serialize import touch_streak, user_out
from ..services import mailer, oauth

router = APIRouter(prefix="/auth", tags=["auth"])
EXPERIENCE = ("beginner", "intermediate", "advanced")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DEFAULT_WATCHLIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XAUUSD", "EURUSD", "GBPUSD", "NAS100", "US30"]


class SignupIn(BaseModel):
    email: str = Field(max_length=255)
    password: str = Field(max_length=200)
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    experience: str
    invite_code: str | None = None
    accept_terms: bool = False      # must be true: the Terms and Privacy Policy were ticked
    learn: bool = False             # optional: may StreixAnalyst learn from this account's charts (default off)


class LoginIn(BaseModel):
    email: str = Field(max_length=255)
    password: str = Field(max_length=200)


class ProfileIn(BaseModel):
    first_name: str | None = Field(None, max_length=80)
    last_name: str | None = Field(None, max_length=80)
    experience: str | None = None
    phone: str | None = Field(None, max_length=32)
    settings: dict | None = None
    learn_consent: bool | None = None          # may StreixAI learn from this person's charts and practice?


class TermsIn(BaseModel):
    accept_terms: bool = False                 # must be true: the Terms are not accepted by default
    learn: bool | None = None                  # optional learning choice; None keeps the current one


class PasswordIn(BaseModel):
    current_password: str | None = None
    new_password: str = Field(max_length=200)


class ForgotIn(BaseModel):
    email: str = Field(max_length=255)


class VerifyIn(BaseModel):
    token: str


class ResetIn(BaseModel):
    token: str
    new_password: str = Field(max_length=200)


def new_user(db, email, first_name="", last_name="", experience=None, password=None, verified=False, avatar=None):
    u = User(email=email, first_name=first_name.strip()[:80], last_name=last_name.strip()[:80],
             experience=experience if experience in EXPERIENCE else None,
             password_hash=hash_password(password) if password else None, email_verified=verified,
             avatar_url=avatar, trial_ends_at=utcnow() + timedelta(days=settings.trial_days))
    db.add(u)
    db.flush()
    for i, sym in enumerate(DEFAULT_WATCHLIST):
        db.add(WatchItem(user_id=u.id, symbol=sym, position=i))
    return u


def record_terms(user, learn):
    """Keep proof of what the person agreed to: the time, the Terms version and their learning choice."""
    user.terms_accepted_at = utcnow()
    user.terms_version = settings.terms_version
    user.learn_consent = bool(learn)


def join_org(db, user, code):
    org = db.execute(select(Organization).where(Organization.invite_code == code.strip().upper())).scalar_one_or_none()
    if not org:
        raise HTTPException(404, "That invite code isn't valid.")
    used = db.query(User).filter(User.org_id == org.id).count()
    if used >= org.seats and user.org_id != org.id:
        raise HTTPException(409, "This organization has no free seats. Ask the owner to add seats.")
    user.org_id, user.org_role = org.id, user.org_role if user.org_id == org.id else "member"
    return org


def session_response(db, user, status=200, request: Request | None = None):
    """Sets the session cookie (web). Native apps send `X-Client: app` and get a Bearer token in the body."""
    token = make_token(user)
    body = dict(user=user_out(db, user))
    if request is not None and request.headers.get("x-client") == "app":
        body["token"] = token
    resp = JSONResponse(body, status_code=status)
    set_session_cookie(resp, token)
    return resp


def send_verification(user):
    """Put a fresh confirmation link in the inbox (valid 48 hours). The caller commits."""
    token = random_code(32, "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
    user.verify_token_hash, user.verify_token_expires = sha256(token), utcnow() + timedelta(hours=48)
    link = f"{settings.frontend_url}/verify?token={token}"
    mailer.send(user.email, "Confirm your StreixAnalyst email",
                f"Hi {user.first_name or 'there'},\n\nConfirm your email to finish setting up your StreixAnalyst account:\n"
                f"{link}\n\nThe link works for 48 hours. If you didn't create an account, ignore this email.\n\n— StreixAnalyst")


@router.post("/signup")
def signup(body: SignupIn, request: Request, db: Session = Depends(get_db)):
    if not signup_limiter.hit(client_ip(request)):
        raise HTTPException(429, "Too many sign-ups from this network. Try again later.")
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Enter a valid email address.")
    if body.experience not in EXPERIENCE:
        raise HTTPException(422, "Choose your trading experience.")
    if not body.accept_terms:
        raise HTTPException(422, "Please read and accept the Terms of Service and Privacy Policy to create an account.")
    prob = password_problem(body.password)
    if prob:
        raise HTTPException(422, prob)
    if db.execute(select(User).where(User.email == email)).scalar_one_or_none():
        raise HTTPException(409, "An account with this email already exists. Sign in instead.")
    u = new_user(db, email, body.first_name, body.last_name, body.experience, body.password)
    record_terms(u, body.learn)
    if mailer.configured():
        send_verification(u)
    else:
        u.email_verified = True      # no email server yet: nothing to confirm with
    if body.invite_code:
        join_org(db, u, body.invite_code)
    db.commit()
    return session_response(db, u, 201, request)


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if not login_limiter.hit(f"{client_ip(request)}|{email}"):
        raise HTTPException(429, "Too many attempts. Wait 15 minutes and try again.")
    # an account under a password-guessing attack locks for a while, whichever addresses the guesses come from
    if account_failures.count(email) >= ACCOUNT_LOCK_AFTER:
        raise HTTPException(429, "Too many wrong passwords for this account. Wait 30 minutes, or reset your password.")
    u = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if not u or not verify_password(body.password, u.password_hash):
        if u and not u.password_hash:
            raise HTTPException(401, "This account uses Google or LinkedIn sign-in. Use that button, or reset your "
                                     "password to add one.")
        account_failures.hit(email)
        raise HTTPException(401, "Wrong email or password.")
    if not u.is_active:
        raise HTTPException(403, suspended_message(u))
    return session_response(db, u, request=request)


@router.post("/logout")
def logout():
    resp = JSONResponse(dict(ok=True))
    clear_session_cookie(resp)
    return resp


@router.get("/me")
def me(user: User | None = Depends(optional_user), db: Session = Depends(get_db)):
    if user is None:
        return dict(user=None)
    touch_streak(db, user)
    return dict(user=user_out(db, user))


@router.patch("/me")
def update_me(body: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.first_name is not None:
        user.first_name = body.first_name.strip()
    if body.last_name is not None:
        user.last_name = body.last_name.strip()
    if body.experience is not None:
        if body.experience not in EXPERIENCE:
            raise HTTPException(422, "Experience must be beginner, intermediate or advanced.")
        user.experience = body.experience
    if body.phone is not None:
        phone = re.sub(r"[^\d+]", "", body.phone)
        if phone and not re.fullmatch(r"\+?\d{10,15}", phone):
            raise HTTPException(422, "Enter a valid phone number, e.g. +2348012345678.")
        user.phone = phone or None
    if body.learn_consent is not None:
        user.learn_consent = bool(body.learn_consent)     # the person can switch this off at any time
    if body.settings is not None:
        blob = jdump(body.settings)
        if len(blob) > 30000:
            raise HTTPException(413, "Settings are too large.")
        user.settings_json = blob
    db.commit()
    return dict(user=user_out(db, user))


@router.post("/accept-terms")
def accept_terms(body: TermsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Accounts made before a Terms update accept the current version once, before using the app."""
    if not body.accept_terms:
        raise HTTPException(422, "Tick the Terms of Service and Privacy Policy to carry on.")
    record_terms(user, body.learn if body.learn is not None else user.learn_consent)
    db.commit()
    return dict(user=user_out(db, user))


@router.post("/password")
def change_password(body: PasswordIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.password_hash and not verify_password(body.current_password or "", user.password_hash):
        raise HTTPException(401, "Your current password is wrong.")
    prob = password_problem(body.new_password)
    if prob:
        raise HTTPException(422, prob)
    user.password_hash = hash_password(body.new_password)
    user.token_version += 1                       # signs out other devices
    db.commit()
    return session_response(db, user)


@router.post("/verify-email")
def verify_email(body: VerifyIn, db: Session = Depends(get_db)):
    u = db.execute(select(User).where(User.verify_token_hash == sha256(body.token.strip()))).scalar_one_or_none()
    if not u or not u.verify_token_expires or u.verify_token_expires < utcnow():
        raise HTTPException(400, "This confirmation link has expired. Ask for a new one from your account.")
    u.email_verified = True
    u.verify_token_hash = u.verify_token_expires = None
    db.commit()
    return session_response(db, u)


@router.post("/resend-verification")
def resend_verification(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.email_verified:
        return dict(ok=True, message="Your email is already confirmed.")
    if not mailer.configured():
        raise HTTPException(503, "Email isn't set up on this server yet, so there is nothing to confirm.")
    if not login_limiter.hit(f"verify|{user.id}"):
        raise HTTPException(429, "Please wait a few minutes before asking for another link.")
    send_verification(user)
    db.commit()
    return dict(ok=True, message="We've sent a new confirmation link to your email.")


@router.post("/forgot")
def forgot(body: ForgotIn, request: Request, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if not login_limiter.hit(f"forgot|{client_ip(request)}"):
        raise HTTPException(429, "Too many requests. Try again later.")
    u = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if u and u.is_active:
        token = random_code(32, "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        u.reset_token_hash, u.reset_token_expires = sha256(token), utcnow() + timedelta(hours=1)
        db.commit()
        link = f"{settings.frontend_url}/reset?token={token}"
        mailer.send(u.email, "Reset your StreixAnalyst password",
                    f"Hi {u.first_name or 'there'},\n\nUse this link within an hour to set a new password:\n{link}\n\n"
                    "If you didn't ask for this, ignore this email.\n\n— StreixAnalyst")
    # same answer whether or not the account exists
    return dict(ok=True, email_enabled=mailer.configured(),
                message="If that email has an account, a reset link is on its way." if mailer.configured() else
                "Email isn't set up on this server yet. Ask the admin to reset your password.")


@router.post("/reset")
def reset(body: ResetIn, db: Session = Depends(get_db)):
    h = sha256(body.token.strip())
    u = db.execute(select(User).where(User.reset_token_hash == h)).scalar_one_or_none()
    if not u or not u.reset_token_expires or u.reset_token_expires < utcnow():
        raise HTTPException(400, "This reset link has expired. Ask for a new one.")
    prob = password_problem(body.new_password)
    if prob:
        raise HTTPException(422, prob)
    u.password_hash = hash_password(body.new_password)
    u.reset_token_hash = u.reset_token_expires = None
    u.token_version += 1
    db.commit()
    return session_response(db, u)


@router.get("/providers")
def providers():
    return dict(google=oauth.enabled("google"), linkedin=oauth.enabled("linkedin"), email=True,
                password_reset_email=mailer.configured())


def _safe_next(nxt):
    if not nxt or not nxt.startswith("/") or nxt.startswith("//") or "\\" in nxt:
        return "/terminal"
    return nxt[:300]


@router.get("/oauth/{provider}/start")
def oauth_start(provider: str, next: str | None = None, invite: str | None = None, terms: str | None = None,
                learn: str | None = None):
    if provider not in oauth.PROVIDERS or not oauth.enabled(provider):
        return RedirectResponse(f"{settings.frontend_url}/login?error={quote(provider + ' sign-in is not set up yet')}",
                                status_code=302)
    state = random_code(24)
    resp = RedirectResponse(oauth.authorize_url(provider, state), status_code=302)
    resp.set_cookie("sa_oauth", sign(dict(state=state, provider=provider, next=_safe_next(next),
                                          invite=(invite or "")[:24], terms=terms == "1",
                                          learn=learn == "1"), minutes=15),
                    max_age=900, httponly=True, secure=settings.cookie_secure, samesite="lax",
                    domain=settings.cookie_domain, path="/")
    return resp


@router.get("/oauth/{provider}/callback")
def oauth_callback(provider: str, request: Request, code: str | None = None, state: str | None = None,
                   error: str | None = None, db: Session = Depends(get_db)):
    def fail(msg, page="login"):
        r = RedirectResponse(f"{settings.frontend_url}/{page}?error={quote(msg)}", status_code=302)
        r.delete_cookie("sa_oauth", domain=settings.cookie_domain, path="/")
        return r

    if error:
        return fail("Sign-in was cancelled.")
    saved = unsign(request.cookies.get("sa_oauth", ""))
    if not saved or saved.get("provider") != provider or not state or saved.get("state") != state or not code:
        return fail("Sign-in expired. Please try again.")
    try:
        prof = oauth.fetch_profile(provider, code)
    except oauth.OAuthError as e:
        return fail(f"{provider.capitalize()} sign-in failed: {e}.")
    except Exception:
        return fail(f"Couldn't reach {provider.capitalize()}. Try again.")
    link = db.execute(select(OAuthAccount).where(OAuthAccount.provider == provider,
                                                 OAuthAccount.subject == prof["sub"])).scalar_one_or_none()
    is_new = False
    if link:
        user = db.get(User, link.user_id)
    else:
        user = db.execute(select(User).where(User.email == prof["email"])).scalar_one_or_none()
        if user and not prof["email_verified"]:
            return fail("That email already has an account. Sign in with your password first.")
        if not user:
            if not saved.get("terms"):
                # a new Google account is created on the sign-up page, where the Terms box is
                return fail("Tick the Terms of Service and Privacy Policy box, then continue with Google to create your account.", "signup")
            user = new_user(db, prof["email"], prof["first_name"], prof["last_name"], None, None,
                            prof["email_verified"], prof["picture"])
            record_terms(user, saved.get("learn"))
            is_new = True
        db.add(OAuthAccount(user_id=user.id, provider=provider, subject=prof["sub"], email=prof["email"]))
    if not user or not user.is_active:
        return fail(suspended_message(user) if user else "This account is disabled.")
    if prof["email_verified"]:
        user.email_verified = True
    if not user.avatar_url and prof["picture"]:
        user.avatar_url = prof["picture"]
    if saved.get("invite"):
        try:
            join_org(db, user, saved["invite"])
        except HTTPException:
            pass
    db.commit()
    nxt = saved.get("next") or "/terminal"
    if is_new or not user.experience:
        nxt = "/onboarding?next=" + quote(nxt)
    resp = RedirectResponse(settings.frontend_url + nxt, status_code=302)
    set_session_cookie(resp, make_token(user))
    resp.delete_cookie("sa_oauth", domain=settings.cookie_domain, path="/")
    return resp

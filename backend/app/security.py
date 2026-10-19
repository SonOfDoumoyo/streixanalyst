"""Passwords (scrypt), session tokens (JWT), cookies and a small in-memory rate limiter."""
import base64
import hashlib
import hmac
import secrets
import threading
import time
from datetime import timedelta

import jwt

from .config import settings
from .models import utcnow

COOKIE = "sa_session"
_SCRYPT = dict(n=2 ** 14, r=8, p=1, dklen=32)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, maxmem=64 * 1024 * 1024, **_SCRYPT)
    return "scrypt${n}${r}${p}${s}${h}".format(n=_SCRYPT["n"], r=_SCRYPT["r"], p=_SCRYPT["p"],
                                                s=base64.b64encode(salt).decode(), h=base64.b64encode(dk).decode())


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not password:
        return False
    try:
        algo, n, r, p, s, h = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(s), n=int(n), r=int(r), p=int(p),
                            dklen=len(base64.b64decode(h)), maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(dk, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


def password_problem(password: str) -> str | None:
    if not password or len(password) < 8:
        return "Use at least 8 characters."
    if len(password) > 200:
        return "That password is too long."
    if not any(c.isalpha() for c in password) or all(c.isalpha() for c in password):
        return "Mix letters with at least one number or symbol."
    if password.lower() in ("password1", "password123", "qwerty123", "12345678a", "abc12345", "trading123"):
        return "That password is too common."
    return None


def make_token(user, days=None, purpose="session", extra=None):
    now = utcnow()
    payload = dict(sub=str(user.id), v=user.token_version, typ=purpose, iat=int(now.timestamp()),
                   exp=int((now + timedelta(days=days or settings.session_days)).timestamp()))
    if extra:
        payload.update(extra)
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def read_token(token, purpose="session"):
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if data.get("typ") != purpose:
        return None
    return data


def sign(payload: dict, minutes=10, purpose="state"):
    now = int(time.time())
    return jwt.encode(dict(payload, typ=purpose, iat=now, exp=now + minutes * 60), settings.secret_key, algorithm="HS256")


def unsign(token, purpose="state"):
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return data if data.get("typ") == purpose else None


def set_session_cookie(response, token):
    response.set_cookie(COOKIE, token, max_age=settings.session_days * 86400, httponly=True,
                        secure=settings.cookie_secure, samesite=settings.cookie_samesite,
                        domain=settings.cookie_domain, path="/")


def clear_session_cookie(response):
    response.delete_cookie(COOKIE, domain=settings.cookie_domain, path="/")


def random_code(n=8, alphabet="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"):
    return "".join(secrets.choice(alphabet) for _ in range(n))


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


class RateLimiter:
    """At most `limit` hits per `window` seconds per key (memory only; one instance per process)."""

    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self.hits = {}
        self.lock = threading.Lock()

    def hit(self, key) -> bool:
        now = time.monotonic()
        with self.lock:
            q = [t for t in self.hits.get(key, []) if now - t < self.window]
            if len(q) >= self.limit:
                self.hits[key] = q
                return False
            q.append(now)
            self.hits[key] = q
            if len(self.hits) > 20000:                       # keep memory bounded
                for k in list(self.hits)[:5000]:
                    self.hits.pop(k, None)
            return True


class WindowCounter:
    """Requests per key in fixed one-minute windows: cheap enough to run on every request (two numbers per key)."""

    def __init__(self, limit, window=60):
        self.limit, self.window = limit, window
        self.counts = {}
        self.lock = threading.Lock()

    def hit(self, key) -> bool:
        slot = int(time.monotonic() // self.window)
        with self.lock:
            s, n = self.counts.get(key, (slot, 0))
            if s != slot:
                s, n = slot, 0
            n += 1
            self.counts[key] = (s, n)
            if len(self.counts) > 50000:                      # keep memory bounded under a flood of addresses
                for k in [k for k, (ks, _) in self.counts.items() if ks != slot][:25000]:
                    self.counts.pop(k, None)
            return n <= self.limit


class FailureCounter(RateLimiter):
    """Failures per key in a rolling window; `count` reads without adding one."""

    def count(self, key) -> int:
        now = time.monotonic()
        with self.lock:
            q = [t for t in self.hits.get(key, []) if now - t < self.window]
            self.hits[key] = q
            return len(q)


def suspended_message(user):
    reason = getattr(user, "suspended_reason", None)
    return ("This account is suspended" + (f": {reason}" if reason else "") +
            ". Contact support if you think this is a mistake.")


login_limiter = RateLimiter(10, 15 * 60)
ACCOUNT_LOCK_AFTER = 20
account_failures = FailureCounter(ACCOUNT_LOCK_AFTER, 30 * 60)   # wrong passwords per account, from any address
api_limiter = WindowCounter(settings.api_rate_per_min)          # every /api request, per address
signup_limiter = RateLimiter(40, 60 * 60)          # classrooms sign up from one network
market_limiter = RateLimiter(240, 60)

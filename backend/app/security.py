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


login_limiter = RateLimiter(10, 15 * 60)
signup_limiter = RateLimiter(40, 60 * 60)          # classrooms sign up from one network
market_limiter = RateLimiter(240, 60)

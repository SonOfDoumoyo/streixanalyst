"""StreixAnalyst API (FastAPI). Run: uvicorn app.main:app --host 0.0.0.0 --port 8000"""
import logging
import threading
import time
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select, update

from .config import settings
from .db import SessionLocal, init_db
from .models import Payment, User, utcnow
from .plans import get_setting
from .security import hash_password, verify_password

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("streix")
VERSION = "1.0.0"


def seed_admin():
    """The admin account comes from ADMIN_EMAIL / ADMIN_PASSWORD (env is the source of truth)."""
    if not settings.admin_email or not settings.admin_password:
        log.warning("ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin account.")
        return
    db = SessionLocal()
    try:
        u = db.execute(select(User).where(User.email == settings.admin_email)).scalar_one_or_none()
        if u is None:
            u = User(email=settings.admin_email, first_name="Admin", last_name="", experience="advanced", role="admin",
                     password_hash=hash_password(settings.admin_password), email_verified=True)
            db.add(u)
            log.info("created admin %s", settings.admin_email)
        else:
            u.role, u.is_active = "admin", True
            if not verify_password(settings.admin_password, u.password_hash):
                u.password_hash = hash_password(settings.admin_password)
                u.token_version += 1
        db.commit()
    finally:
        db.close()


def housekeeping():
    db = SessionLocal()
    try:
        db.execute(update(Payment).where(Payment.status.in_(("awaiting_transfer", "pending")),
                                         Payment.applied.is_(False),
                                         Payment.created_at < utcnow() - timedelta(days=7)).values(status="expired"))
        db.commit()
    finally:
        db.close()


def _background():
    from .services import catalog
    catalog.load_disk()
    while True:
        try:
            catalog.refresh()
        except Exception:
            log.exception("catalog refresh failed")
        try:
            housekeeping()
        except Exception:
            log.exception("housekeeping failed")
        time.sleep(1800)


def _fast_background():
    """Alerts every 30 s; the track-record tracker every 3 minutes."""
    from .services import alerts as alert_svc
    from .services import tracker
    time.sleep(20)                      # let the brain and the catalog load first
    i = 0
    while True:
        try:
            alert_svc.run_once()
        except Exception:
            log.exception("alerts failed")
        if i % 6 == 0:
            try:
                tracker.run_once()
            except Exception:
                log.exception("tracker failed")
        try:
            from .services import crypto
            with SessionLocal() as db:
                crypto.sweep(db)
        except Exception:
            log.exception("crypto sweep failed")
        i += 1
        time.sleep(30)


@asynccontextmanager
async def lifespan(app):
    init_db()
    seed_admin()
    from .services import engine
    threading.Thread(target=engine.load_brain, daemon=True).start()
    if settings.enable_background:
        threading.Thread(target=_background, daemon=True).start()
        threading.Thread(target=_fast_background, daemon=True).start()
    yield


app = FastAPI(title="StreixAnalyst API", version=VERSION, lifespan=lifespan, docs_url="/api/docs",
              openapi_url="/api/openapi.json", redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    return resp


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.exception("unhandled error on %s", request.url.path)
    return JSONResponse({"detail": "Something went wrong on our side. Please try again."}, status_code=500)


from .routers import (admin, ai, alerts, analysis, auth, billing, donate, market, news, practice,  # noqa: E402
                      push, replay, site, strategy, support, track, user)

for r in (auth.router, user.router, market.router, analysis.router, news.router, ai.router, billing.router,
          practice.router, strategy.router, track.router, alerts.router, push.router, replay.router, admin.router, site.router,
          donate.router, support.router, support.admin_router):
    app.include_router(r, prefix="/api")


@app.get("/api/health")
def health():
    from .services import engine
    return dict(ok=True, version=VERSION, brain=engine.BRAIN["status"])


@app.get("/api/config")
def public_config():
    from .services import oauth
    db = SessionLocal()
    try:
        ann = get_setting(db, "announcement", "")
    finally:
        db.close()
    return dict(app="StreixAnalyst", version=VERSION, trial_days=settings.trial_days, announcement=ann or None,
                google=oauth.enabled("google"), linkedin=oauth.enabled("linkedin"))

"""Email: confirmation links, password resets, payment and alert emails.

Three ways to send, picked by EMAIL_PROVIDER (auto picks the first one set up, in this order):
  * brevo  – Brevo's HTTPS API (BREVO_API_KEY). Free plan, and the sender can be one verified address such as a Gmail
             address, so no domain is needed.
  * resend – Resend's HTTPS API (RESEND_API_KEY). Needs a domain verified with Resend.
  * smtp   – any SMTP server (SMTP_HOST ...), Gmail included with an App Password.

Render's free web services block outgoing SMTP (ports 25, 465 and 587), so on the free plan SMTP mail, Gmail's
included, never leaves the server. The two API providers send over HTTPS (port 443), which works on every plan.

Sending happens in the background so a page never waits on email, and a failure never breaks a request. The last
result is kept (`status()`), and the admin console can send a test email that shows the exact error and how to fix it.
Without any provider, emails are skipped and accounts count as confirmed."""
import html as htmllib
import logging
import re
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage
from email.utils import parseaddr

import httpx

from ..config import settings

log = logging.getLogger("streix.mail")
BREVO_URL = "https://api.brevo.com/v3/smtp/email"
RESEND_URL = "https://api.resend.com/emails"
_state = {"last_ok": None, "last_error": None, "last_hint": None, "sent": 0, "failed": 0}
_lock = threading.Lock()
_client = {"c": None}


class MailError(Exception):
    pass


def set_client(c):
    _client["c"] = c


def _http():
    if _client["c"] is None:
        _client["c"] = httpx.Client(timeout=httpx.Timeout(20.0))
    return _client["c"]


def provider():
    p = settings.email_provider
    have = dict(brevo=bool(settings.brevo_api_key), resend=bool(settings.resend_api_key), smtp=bool(settings.smtp_host))
    if p in have:
        return p if have[p] else None
    for name in ("brevo", "resend", "smtp"):
        if have[name]:
            return name
    return None


def configured():
    return provider() is not None


def sender():
    """(name, address) of the From line, from EMAIL_FROM (or SMTP_FROM), e.g. 'StreixAnalyst <you@gmail.com>'."""
    name, addr = parseaddr(settings.email_from or "")
    if not addr and settings.smtp_user and "@" in settings.smtp_user:
        addr = settings.smtp_user
    return (name or "StreixAnalyst"), addr


def text_to_html(text):
    """The plain-text email as simple HTML, with links clickable."""
    esc = htmllib.escape(text)
    esc = re.sub(r"(https?://[^\s<]+)", r'<a href="\1">\1</a>', esc)
    body = "".join(f"<p>{p.replace(chr(10), '<br>')}</p>" for p in esc.split("\n\n"))
    return f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">{body}</div>'


def hint_for(err):
    """What to do about a failure, in plain words."""
    e = str(err)
    low = e.lower()
    if "network is unreachable" in low or "timed out" in low or "errno 101" in low or "connection refused" in low:
        return ("The server could not reach the SMTP server. Render's free plan blocks outgoing SMTP, so Gmail SMTP "
                "cannot work there. Set BREVO_API_KEY (free, sends over HTTPS), or move the API to a paid instance.")
    if "535" in e or "username and password not accepted" in low or "badcredentials" in low:
        return ("Gmail refused the sign-in. Use an App Password (Google account → Security → 2-Step Verification on → "
                "App passwords), not your normal Gmail password, and put the full Gmail address in SMTP_USER.")
    if "534" in e or "application-specific password" in low:
        return "Gmail wants an App Password for this account (Google account → Security → App passwords)."
    if "sender" in low and ("not valid" in low or "not verified" in low or "not allowed" in low):
        return ("The From address is not verified with the email provider. In Brevo: Senders, domains & IPs → add and "
                "confirm the address in EMAIL_FROM. In Resend: verify the domain of the From address.")
    if "401" in e or "unauthorized" in low or "key not found" in low or "invalid api key" in low:
        return "The email provider rejected the API key. Copy a fresh key into BREVO_API_KEY or RESEND_API_KEY."
    if "domain" in low and "verify" in low:
        return "Resend only sends from a domain you have verified with it. Verify the domain, or use Brevo instead."
    return None


def _smtp(to, subject, text, html):
    name, addr = sender()
    msg = EmailMessage()
    msg["From"] = f"{name} <{addr}>" if addr else settings.email_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(html or text_to_html(text), subtype="html")
    ctx = ssl.create_default_context()
    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=ctx, timeout=20) as s:
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password or "")
            s.send_message(msg)
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
            s.starttls(context=ctx)
            if settings.smtp_user:
                s.login(settings.smtp_user, settings.smtp_password or "")
            s.send_message(msg)


def _brevo(to, subject, text, html):
    name, addr = sender()
    if not addr:
        raise MailError("EMAIL_FROM has no address. Set it to a sender verified in Brevo, e.g. StreixAnalyst <you@gmail.com>.")
    body = dict(sender=dict(name=name, email=addr), to=[dict(email=to)], subject=subject,
                htmlContent=html or text_to_html(text))
    r = _http().post(BREVO_URL, json=body, headers={"api-key": settings.brevo_api_key, "accept": "application/json",
                                                     "content-type": "application/json"})
    if r.status_code >= 300:
        raise MailError(f"Brevo HTTP {r.status_code}: {r.text[:300]}")


def _resend(to, subject, text, html):
    name, addr = sender()
    if not addr:
        raise MailError("EMAIL_FROM has no address. Set it to an address on a domain verified in Resend.")
    body = {"from": f"{name} <{addr}>", "to": [to], "subject": subject, "text": text, "html": html or text_to_html(text)}
    r = _http().post(RESEND_URL, json=body, headers={"Authorization": f"Bearer {settings.resend_api_key}"})
    if r.status_code >= 300:
        raise MailError(f"Resend HTTP {r.status_code}: {r.text[:300]}")


SENDERS = {"smtp": _smtp, "brevo": _brevo, "resend": _resend}


def deliver(to, subject, text, html=None):
    """Send now, in this thread. Raises MailError with the provider's answer when it fails."""
    p = provider()
    if p is None:
        raise MailError("No email provider is set up (BREVO_API_KEY, RESEND_API_KEY or SMTP_HOST).")
    try:
        SENDERS[p](to, subject, text, html)
    except MailError:
        raise
    except Exception as e:
        raise MailError(f"{type(e).__name__}: {e}") from e


def _record(ok, err=None):
    with _lock:
        if ok:
            _state["last_ok"] = time.time()
            _state["sent"] += 1
        else:
            _state["failed"] += 1
            _state["last_error"] = dict(at=time.time(), error=str(err)[:400])
            _state["last_hint"] = hint_for(err)


def _send(to, subject, text, html=None):
    try:
        deliver(to, subject, text, html)
        _record(True)
    except Exception as e:                       # never break a request because email failed
        _record(False, e)
        log.warning("email to %s failed (%s): %s", to, provider(), e)


def send(to, subject, text, html=None):
    if not configured():
        log.info("email not set up; skipped '%s' to %s", subject, to)
        return False
    threading.Thread(target=_send, args=(to, subject, text, html), daemon=True).start()
    return True


def status():
    name, addr = sender()
    with _lock:
        st = dict(_state)
    return dict(provider=provider(), configured=configured(), sender=addr or None, sender_name=name, **st)

"""Plain SMTP email (password resets, payment confirmations). Silently skipped when SMTP isn't configured."""
import logging
import smtplib
import ssl
import threading
from email.message import EmailMessage

from ..config import settings

log = logging.getLogger("streix.mail")


def configured():
    return bool(settings.smtp_host)


def _send(to, subject, text, html=None):
    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    try:
        if settings.smtp_port == 465:
            with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, context=ssl.create_default_context(),
                                  timeout=20) as s:
                if settings.smtp_user:
                    s.login(settings.smtp_user, settings.smtp_password or "")
                s.send_message(msg)
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
                s.starttls(context=ssl.create_default_context())
                if settings.smtp_user:
                    s.login(settings.smtp_user, settings.smtp_password or "")
                s.send_message(msg)
    except Exception as e:                       # never break a request because email failed
        log.warning("email to %s failed: %s", to, e)


def send(to, subject, text, html=None):
    if not configured():
        log.info("SMTP not configured; skipped email '%s' to %s", subject, to)
        return False
    threading.Thread(target=_send, args=(to, subject, text, html), daemon=True).start()
    return True

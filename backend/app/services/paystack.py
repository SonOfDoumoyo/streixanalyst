"""Paystack API (card, bank, USSD, bank transfer, dedicated virtual accounts). Amounts are in kobo."""
import hashlib
import hmac

import httpx

from ..config import settings

_client = {"c": None}


class PaystackError(Exception):
    pass


def set_client(c):
    _client["c"] = c


def _http():
    if _client["c"] is None:
        _client["c"] = httpx.Client(timeout=25)
    return _client["c"]


def _call(method, path, **kw):
    if not settings.paystack_secret_key:
        raise PaystackError("Paystack is not configured on this server.")
    headers = {"Authorization": f"Bearer {settings.paystack_secret_key}", "Content-Type": "application/json"}
    try:
        r = _http().request(method, settings.paystack_base_url + path, headers=headers, **kw)
    except httpx.HTTPError as e:
        raise PaystackError(f"Couldn't reach Paystack ({type(e).__name__}).")
    try:
        js = r.json()
    except ValueError:
        raise PaystackError(f"Paystack returned HTTP {r.status_code}.")
    if r.status_code >= 400 or not js.get("status"):
        raise PaystackError(js.get("message") or f"Paystack HTTP {r.status_code}")
    return js.get("data")


def initialize(email, amount_kobo, reference, callback_url, metadata=None, channels=None):
    body = dict(email=email, amount=int(amount_kobo), currency="NGN", reference=reference, callback_url=callback_url,
                metadata=metadata or {})
    if channels:
        body["channels"] = channels
    return _call("POST", "/transaction/initialize", json=body)


def verify(reference):
    return _call("GET", f"/transaction/verify/{reference}")


def create_customer(email, first_name, last_name, phone):
    return _call("POST", "/customer", json=dict(email=email, first_name=first_name, last_name=last_name, phone=phone))


def update_customer(code, first_name, last_name, phone):
    return _call("PUT", f"/customer/{code}", json=dict(first_name=first_name, last_name=last_name, phone=phone))


def create_dedicated_account(customer_code, preferred_bank):
    return _call("POST", "/dedicated_account", json=dict(customer=customer_code, preferred_bank=preferred_bank))


def valid_signature(raw_body: bytes, signature: str | None) -> bool:
    """Webhooks are signed with HMAC-SHA512 of the raw body using the secret key."""
    if not signature or not settings.paystack_secret_key:
        return False
    digest = hmac.new(settings.paystack_secret_key.encode(), raw_body, hashlib.sha512).hexdigest()
    return hmac.compare_digest(digest, signature.strip())

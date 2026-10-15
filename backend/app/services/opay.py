"""OPay Checkout (cashier) for Nigeria. A payment is only trusted after a signed server-to-server status query:
callbacks are treated as a hint to re-check, never as proof. Endpoint base is configurable (OPAY_BASE_URL)
because OPay issues sandbox and live hosts per merchant."""
import hashlib
import hmac
import json

import httpx

from ..config import settings

_client = {"c": None}


class OPayError(Exception):
    pass


def set_client(c):
    _client["c"] = c


def _http():
    if _client["c"] is None:
        _client["c"] = httpx.Client(timeout=25)
    return _client["c"]


def _post(path, body, auth):
    raw = json.dumps(body, separators=(",", ":"))
    headers = {"Authorization": f"Bearer {auth(raw)}", "MerchantId": settings.opay_merchant_id or "",
               "Content-Type": "application/json"}
    try:
        r = _http().post(settings.opay_base_url + path, content=raw.encode(), headers=headers)
    except httpx.HTTPError as e:
        raise OPayError(f"Couldn't reach OPay ({type(e).__name__}).")
    try:
        js = r.json()
    except ValueError:
        raise OPayError(f"OPay returned HTTP {r.status_code}.")
    if str(js.get("code")) not in ("00000", "00"):
        raise OPayError(js.get("message") or f"OPay error {js.get('code')}")
    return js.get("data") or {}


def signature(raw: str) -> str:
    return hmac.new((settings.opay_secret_key or "").encode(), raw.encode(), hashlib.sha512).hexdigest()


def create_cashier(reference, amount_kobo, return_url, callback_url, cancel_url, user_email, user_name, user_id,
                   product_name, product_desc):
    if not settings.opay_enabled:
        raise OPayError("OPay is not configured on this server.")
    body = dict(country="NG", reference=reference, amount=dict(total=int(amount_kobo), currency="NGN"),
                returnUrl=return_url, callbackUrl=callback_url, cancelUrl=cancel_url, expireAt=30,
                userInfo=dict(userEmail=user_email, userId=str(user_id), userName=user_name),
                product=dict(name=product_name, description=product_desc))
    return _post("/api/v1/international/cashier/create", body, lambda raw: settings.opay_public_key)


def query_status(reference):
    if not settings.opay_enabled:
        raise OPayError("OPay is not configured on this server.")
    return _post("/api/v1/international/cashier/status", dict(country="NG", reference=reference), signature)

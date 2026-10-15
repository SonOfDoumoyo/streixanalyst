"""Sign in with Google and LinkedIn (OpenID Connect, authorization-code flow)."""
from urllib.parse import urlencode

import httpx

from ..config import settings

PROVIDERS = {
    "google": dict(auth="https://accounts.google.com/o/oauth2/v2/auth", token="https://oauth2.googleapis.com/token",
                   userinfo="https://openidconnect.googleapis.com/v1/userinfo", scope="openid email profile",
                   extra=dict(prompt="select_account", access_type="online")),
    "linkedin": dict(auth="https://www.linkedin.com/oauth/v2/authorization",
                     token="https://www.linkedin.com/oauth/v2/accessToken",
                     userinfo="https://api.linkedin.com/v2/userinfo", scope="openid profile email", extra={}),
}


class OAuthError(Exception):
    pass


def enabled(provider):
    return {"google": settings.google_enabled, "linkedin": settings.linkedin_enabled}.get(provider, False)


def credentials(provider):
    if provider == "google":
        return settings.google_client_id, settings.google_client_secret
    return settings.linkedin_client_id, settings.linkedin_client_secret


def redirect_uri(provider):
    return f"{settings.public_api_url}/auth/oauth/{provider}/callback"


def authorize_url(provider, state):
    p = PROVIDERS[provider]
    cid, _ = credentials(provider)
    q = dict(client_id=cid, redirect_uri=redirect_uri(provider), response_type="code", scope=p["scope"], state=state)
    q.update(p["extra"])
    return p["auth"] + "?" + urlencode(q)


def fetch_profile(provider, code, client=None):
    """Exchange the code for a token, then read the user's OpenID profile."""
    p = PROVIDERS[provider]
    cid, secret = credentials(provider)
    own = client is None
    client = client or httpx.Client(timeout=15)
    try:
        r = client.post(p["token"], data=dict(grant_type="authorization_code", code=code,
                                              redirect_uri=redirect_uri(provider), client_id=cid,
                                              client_secret=secret),
                        headers={"Accept": "application/json"})
        if r.status_code != 200:
            raise OAuthError(f"token exchange failed ({r.status_code})")
        token = r.json().get("access_token")
        if not token:
            raise OAuthError("no access token returned")
        u = client.get(p["userinfo"], headers={"Authorization": f"Bearer {token}"})
        if u.status_code != 200:
            raise OAuthError(f"profile request failed ({u.status_code})")
        info = u.json()
    finally:
        if own:
            client.close()
    sub = str(info.get("sub") or "")
    email = (info.get("email") or "").strip().lower()
    if not sub or not email:
        raise OAuthError("the provider did not share an email address")
    verified = info.get("email_verified")
    verified = verified if isinstance(verified, bool) else str(verified).lower() == "true"
    return dict(sub=sub, email=email, email_verified=bool(verified), first_name=info.get("given_name") or "",
                last_name=info.get("family_name") or "", picture=info.get("picture"))

"""Who is calling. Organization identity comes only from a verified token, never from the request body.

IDENTITY_ADAPTER selects the adapter:
  cognito    claims already verified by the API Gateway JWT authorizer (requestContext.authorizer.jwt.claims);
             accepted only for an ID token (token_use "id") whose iss is COGNITO_ISSUER and aud is COGNITO_CLIENT_ID.
             Either variable unset: every signed-in request is 503 identity_unavailable, logged as a configuration
             error. A token without a valid, unexpired exp is refused.
  dev-hs256  DEV ONLY, never production: an HS256 bearer token checked against DEV_TOKEN_SECRET (>= 32 bytes)
Unset or unknown: every request is 401, logged as a configuration error.
"""
import base64
import hashlib
import hmac
import json
import re
import sys
from typing import NamedTuple

ORG_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")  # no '#': it is the key separator
ROLES = ("admin", "pilot")


class Identity(NamedTuple):
    sub: str
    org_id: str
    role: str


def _config_error(msg):
    print(json.dumps({"level": "error", "msg": f"identity config: {msg}"}), file=sys.stderr)


def _identity(sub, org_id, role):
    if not (isinstance(sub, str) and 0 < len(sub) <= 128 and isinstance(org_id, str) and ORG_ID.fullmatch(org_id)
            and role in ROLES):
        return None
    return Identity(sub, org_id, role)


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text):
    if not re.fullmatch(r"[A-Za-z0-9_-]*", text):
        raise ValueError("bad base64url")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def make_dev_token(secret, sub, org_id, role, exp):
    """Tests and the LocalStack script only."""
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps({"sub": sub, "org_id": org_id, "role": role, "exp": exp}).encode())
    sig = _b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"


def _dev(headers, env, now):
    secret = env.get("DEV_TOKEN_SECRET", "")
    if len(secret.encode()) < 32:
        _config_error("DEV_TOKEN_SECRET missing or shorter than 32 bytes")
        return None
    auth = headers.get("authorization", "")
    if not auth.startswith("Bearer ") or len(auth) > 2048:
        return None
    parts = auth[7:].split(".")
    if len(parts) != 3:
        return None
    try:
        head = json.loads(_unb64(parts[0]))
        expect = hmac.new(secret.encode(), f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest()
        if not isinstance(head, dict) or head.get("alg") != "HS256" or not hmac.compare_digest(expect, _unb64(parts[2])):
            return None
        claims = json.loads(_unb64(parts[1]))
    except (ValueError, RecursionError):
        return None
    if not isinstance(claims, dict):
        return None
    exp = claims.get("exp")
    if not isinstance(exp, int) or isinstance(exp, bool) or exp <= now:
        return None
    return _identity(claims.get("sub"), claims.get("org_id"), claims.get("role"))


def _cognito(event, env, now):
    issuer, client_id = env.get("COGNITO_ISSUER", ""), env.get("COGNITO_CLIENT_ID", "")
    if not issuer or not client_id:
        _config_error("COGNITO_ISSUER and COGNITO_CLIENT_ID must both be set for the cognito adapter")
        # The service is misconfigured, not the caller: 503 so the console can show sign-in as unavailable.
        # app.py's HttpError is what app.handle maps to a status; imported here because app imports this module.
        from .app import HttpError
        raise HttpError(503, "identity_unavailable")
    claims = event
    for key in ("requestContext", "authorizer", "jwt", "claims"):
        claims = claims.get(key) if isinstance(claims, dict) else None
    if not isinstance(claims, dict):
        return None
    # An access token also passes the authorizer; only the ID token is for this API (AD-3).
    if claims.get("token_use") != "id" or claims.get("iss") != issuer or claims.get("aud") != client_id:
        return None
    # The authorizer checks exp as well; refuse here too, and refuse a token without one. HTTP API passes strings.
    exp = claims.get("exp")
    if isinstance(exp, bool) or not (isinstance(exp, int) or (isinstance(exp, str) and re.fullmatch(r"[0-9]{1,12}", exp))):
        return None
    if int(exp) <= now:
        return None
    # Org and role only from the admin-set custom attributes (the app client cannot write them).
    return _identity(claims.get("sub"), claims.get("custom:org_id"), claims.get("custom:role"))


def identify(event, headers, env, now):
    adapter = env.get("IDENTITY_ADAPTER", "")
    if adapter == "cognito":
        return _cognito(event, env, now)
    if adapter == "dev-hs256":
        return _dev(headers, env, now)
    _config_error(f"IDENTITY_ADAPTER {adapter!r} is not 'cognito' or 'dev-hs256'")
    return None

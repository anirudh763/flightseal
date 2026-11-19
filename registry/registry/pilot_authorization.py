"""Pilot key authorizations (signing Option B, design §4.2): the company key vouches for one pilot key until a date.

Signed bytes are exactly these four lines joined by "\\n", no trailing newline:

    hashwing-pilot-authorization v1
    pilot_key=<64 lowercase hex raw public key>
    company_key=<64 lowercase hex raw public key>
    not_after=<YYYY-MM-DDTHH:MM:SSZ>

It travels as base64url without padding plus a 128-lowercase-hex signature, and in a receipt message as one line
`Authorized by company key: <base64url>.<sig>`. Encoding is canonical: anything that does not rebuild to the same
characters is `malformed`. The prefix differs from `fseal-receipt v1` and both challenge prefixes, so no signature
crosses formats. Shared vectors: tests/fixtures/pilot-authorization.json (make_pilot_authorization.py there).
"""
import base64
import calendar
import re
import time
from typing import NamedTuple

from . import ed25519

PREFIX = "hashwing-pilot-authorization v1"
LINE_PREFIX = "Authorized by company key: "
DEFAULT_DAYS = 14
MAX_DAYS = 30
DAY = 86400

_B64 = re.compile(r"[A-Za-z0-9_-]+")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_HEX128 = re.compile(r"[0-9a-f]{128}")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")

# check() reasons, in the order they are tested, and the registry error each maps to.
REGISTRY_ERROR = {
    "malformed": "bad_authorization",
    "weak_pilot_key": "bad_authorization",
    "same_key": "bad_authorization",
    "not_pilot_key": "bad_authorization",
    "bad_signature": "bad_authorization",
    "ended": "authorization_expired",
    "too_long": "authorization_expired",
    "not_company_key": "company_key_not_active",
}


class Authorization(NamedTuple):
    pilot_key: bytes
    company_key: bytes
    not_after: int  # epoch seconds


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def statement(pilot_key, company_key, not_after):
    return "\n".join((PREFIX, "pilot_key=" + pilot_key.hex(), "company_key=" + company_key.hex(),
                      "not_after=" + iso(not_after))).encode()


def encode(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def parse(authorization_b64):
    """The Authorization, or None unless the text is exactly the canonical encoding of a canonical statement."""
    if not isinstance(authorization_b64, str) or not _B64.fullmatch(authorization_b64):
        return None
    try:
        raw = base64.urlsafe_b64decode(authorization_b64 + "=" * (-len(authorization_b64) % 4))
        lines = raw.decode("ascii").split("\n")
    except (ValueError, UnicodeDecodeError):
        return None
    if len(lines) != 4 or lines[0] != PREFIX:
        return None
    fields = {}
    for name, ln in zip(("pilot_key", "company_key", "not_after"), lines[1:]):
        if not ln.startswith(name + "="):
            return None
        fields[name] = ln[len(name) + 1:]
    if not (_HEX64.fullmatch(fields["pilot_key"]) and _HEX64.fullmatch(fields["company_key"])
            and _DATE.fullmatch(fields["not_after"])):
        return None
    try:
        not_after = calendar.timegm(time.strptime(fields["not_after"], "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, OverflowError):
        return None
    auth = Authorization(bytes.fromhex(fields["pilot_key"]), bytes.fromhex(fields["company_key"]), not_after)
    # Rebuild and compare the characters: catches second 60, loose trailing base64 bits and anything else non-canonical.
    if encode(statement(*auth)) != authorization_b64:
        return None
    return auth


def check(authorization_b64, sig_hex, pilot_key, company_key, now):
    """(reason or None, Authorization or None). Reasons are tested in REGISTRY_ERROR's order.

    `pilot_key` is the key that must be authorized (the receipt's or the enrolling key). `company_key` is the expected
    company key, or None when the caller compares it itself (the registry holds only the ACTIVE_KEY fingerprint).
    `now` is the checker's own clock, never a sender or receipt time.
    """
    auth = parse(authorization_b64)
    if auth is None or not isinstance(sig_hex, str) or not _HEX128.fullmatch(sig_hex):
        return "malformed", None
    if ed25519.weak_key(auth.pilot_key):
        return "weak_pilot_key", auth
    if auth.pilot_key == auth.company_key:
        return "same_key", auth
    if auth.pilot_key != pilot_key:
        return "not_pilot_key", auth
    if not ed25519.verify(auth.company_key, statement(*auth), bytes.fromhex(sig_hex)):
        return "bad_signature", auth
    if auth.not_after <= now:
        return "ended", auth
    if auth.not_after > now + MAX_DAYS * DAY:
        return "too_long", auth
    if company_key is not None and auth.company_key != company_key:
        return "not_company_key", auth
    return None, auth


def parse_line(message):
    """(authorization_b64, sig_hex) from the one `Authorized by company key:` line of a receipt message, or None when
    there is none. More than one such line, or one not of the form `<base64url>.<sig>`, raises ValueError."""
    found = [ln for ln in message.split("\n") if ln.startswith(LINE_PREFIX.rstrip())]
    if not found:
        return None
    if len(found) > 1 or not found[0].startswith(LINE_PREFIX) or found[0].count(".") != 1:
        raise ValueError("malformed")
    auth, sig = found[0][len(LINE_PREFIX):].split(".")
    return auth, sig


def to_line(authorization_b64, sig_hex):
    return f"{LINE_PREFIX}{authorization_b64}.{sig_hex}"

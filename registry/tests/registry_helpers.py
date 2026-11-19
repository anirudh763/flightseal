"""Shared helpers for the registry tests (not a conftest.py: tests/test_tools.py imports `conftest` by name)."""
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "registry"))

from registry import ed25519, pilot_authorization, receipt  # noqa: E402
from registry.app import App  # noqa: E402
from registry.enroll_challenge import bytes_to_sign  # noqa: E402
from registry.identity import make_dev_token  # noqa: E402
from registry.store import MemoryTable  # noqa: E402

SECRET = "registry-test-secret-0123456789abcdef"
T0 = 1_800_000_000
SEED_A = bytes(range(32))
SEED_B = bytes(range(1, 33))


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def make_app(table=None, **env):
    base = {"IDENTITY_ADAPTER": "dev-hs256", "DEV_TOKEN_SECRET": SECRET}
    base.update({k: str(v) for k, v in env.items()})
    clock = Clock()
    table = table if table is not None else MemoryTable()
    return App(table, base, clock), table, clock


def token(clock, org="orgA", role="pilot", sub="pilot-1", ttl=3600, secret=SECRET):
    return make_dev_token(secret, sub, org, role, clock.t + ttl)


def call(app, method, path, tok=None, body=None, raw=None, query=None, v1=False):
    headers = {"Authorization": f"Bearer {tok}"} if tok else {}
    data = raw if raw is not None else (json.dumps(body) if body is not None else "")
    if v1:
        event = {"httpMethod": method, "path": path, "headers": headers, "body": data, "queryStringParameters": query}
    else:
        event = {"version": "2.0", "rawPath": path, "requestContext": {"http": {"method": method}}, "headers": headers,
                 "body": data, "queryStringParameters": query}
    r = app.handle(event)
    return r["statusCode"], json.loads(r["body"]), r["headers"]


def line(seed, count, head=b"\x11" * 32):
    sig = ed25519.sign(seed, receipt.signed_message(count, head))
    return receipt.to_line(receipt.Receipt(count, head, ed25519.public_key(seed), sig))


def enroll(app, clock, seed=SEED_A, org="orgA", confirm=None):
    admin = token(clock, org=org, role="admin", sub="admin-1")
    s, ch, _ = call(app, "GET", "/v1/keys/challenge", admin)
    assert s == 200, ch
    body = {"public_key": ed25519.public_key(seed).hex(), "nonce": ch["nonce"],
            "signature": ed25519.sign(seed, bytes_to_sign(org, ch)).hex()}
    if confirm is not None:
        body["confirm_replace"] = confirm
    return call(app, "POST", "/v1/keys", admin, body)


def authorize(company_seed, pilot_pub, not_after):
    """What the company computer hands back: (authorization base64url, signature hex) for one pilot key."""
    text = pilot_authorization.statement(pilot_pub, ed25519.public_key(company_seed), not_after)
    return pilot_authorization.encode(text), ed25519.sign(company_seed, text).hex()


def pilot_enroll(app, clock, seed, company_seed=SEED_A, org="orgA", sub="pilot-1", days=14, auth=None, **override):
    """POST /v1/pilot-keys as a pilot on their own device: pilot challenge, then key + authorization."""
    tok = token(clock, org=org, sub=sub)
    s, ch, _ = call(app, "GET", "/v1/pilot-keys/challenge", tok)
    if s != 200:
        return s, ch, None
    pub = ed25519.public_key(seed)
    a, a_sig = auth or authorize(company_seed, pub, clock.t + days * 86400)
    body = {"public_key": pub.hex(), "nonce": ch["nonce"],
            "signature": ed25519.sign(seed, bytes_to_sign(org, ch, "pilot")).hex(),
            "authorization": a, "authorization_sig": a_sig, **override}
    return call(app, "POST", "/v1/pilot-keys", tok, body)


def envelope(app, tok):
    s, out, _ = call(app, "POST", "/v1/envelopes", tok, {})
    assert s == 201, out
    return out["envelope_id"]


def register(app, tok, receipt_line, idem="idem-key-0000000001", env_id=None):
    env_id = env_id or envelope(app, tok)
    return call(app, "POST", "/v1/registrations", tok,
                {"receipt": receipt_line, "idempotency_key": idem, "envelope_id": env_id})


def fseal_bin():
    path = Path(os.environ.get("FSEAL_BIN", ROOT / "build" / "fseal"))
    return path if path.exists() else None


def fseal_receipts(tmp_path):
    """Seal 4 records with the real C++ sealer; return (seed, receipt lines)."""
    exe = str(fseal_bin())
    key, log, rec = tmp_path / "k.pem", tmp_path / "f.fseal", tmp_path / "f.receipts"
    subprocess.run([exe, "keygen", str(key)], check=True, capture_output=True)
    lines = "".join(f"{1000 * (i + 1)}\t{{\"i\":{i}}}\n" for i in range(4))
    subprocess.run([exe, "append", str(log), "--key", str(key), "--receipts", str(rec), "--every", "2"],
                   input=lines, text=True, check=True, capture_output=True)
    der = base64.b64decode("".join(key.read_text().splitlines()[1:-1]))
    return der[-32:], rec.read_text().splitlines()


def share(app, tok, rid, share_token=None, idem=None, **extra):
    """POST /v1/shares the way a client does: it makes the token and sends only its SHA-256.

    Returns (status, out, share_token); on success `out["path"]` is the link the client builds from its token."""
    import hashlib
    import secrets

    share_token = share_token or secrets.token_urlsafe(32)
    idem = idem or "share-" + secrets.token_hex(12)
    body = {"registration_id": rid, "token_hash": hashlib.sha256(share_token.encode()).hexdigest(),
            "idempotency_key": idem, **extra}
    s, out, _ = call(app, "POST", "/v1/shares", tok, body)
    if s in (200, 201):
        out = {**out, "path": "/v1/shares/" + share_token}
    return s, out, share_token

"""Receipt registry routes. Stores commitments only: org, key fingerprint, head, count and server time.

Request order: size -> auth -> schema -> idempotency lookup -> envelope -> receipt/signature -> key state -> transaction.
Any store error while reading state fails closed with 503.
"""
import base64
import hashlib
import json
import re
import secrets
import sys
import time

from . import ed25519, receipt
from .identity import identify
from .store import ConditionFailed, StoreUnavailable, TransactionCanceled

MAX_BODY = 4096
MAX_SHARES = 10
PAGE = 50
DAY = 86400
IDEM_KEY = re.compile(r"[A-Za-z0-9_-]{16,128}")
HEX32 = re.compile(r"[0-9a-f]{32}")
HEX64 = re.compile(r"[0-9a-f]{64}")
HEX128 = re.compile(r"[0-9a-f]{128}")
SHARE_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")  # secrets.token_urlsafe(32)
HEADERS = {"content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
           "referrer-policy": "no-referrer"}
ANY, ADMIN, PUBLIC = "any", "admin", "public"

ROUTES = [
    ("POST", r"/v1/envelopes", "envelope", ANY),
    ("POST", r"/v1/registrations", "register", ANY),
    ("GET", r"/v1/registrations", "list_registrations", ANY),
    ("DELETE", r"/v1/registrations/([0-9a-f]{32})", "delete_registration", ADMIN),
    ("GET", r"/v1/keys/challenge", "challenge", ADMIN),
    ("POST", r"/v1/keys", "enroll", ADMIN),
    ("GET", r"/v1/keys", "list_keys", ANY),
    ("POST", r"/v1/keys/([0-9a-f]{64})/compromised", "compromise", ADMIN),
    ("POST", r"/v1/epoch", "epoch", ADMIN),
    ("POST", r"/v1/shares", "create_share", ANY),
    ("GET", r"/v1/shares/([A-Za-z0-9_-]{1,128})", "get_share", PUBLIC),
    ("DELETE", r"/v1/shares/([A-Za-z0-9_-]{1,128})", "withdraw_share", ANY),
]
ROUTES = [(m, re.compile(p), name, access) for m, p, name, access in ROUTES]


class HttpError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


NOT_FOUND = HttpError(404, "not_found")


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def _sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def _no_duplicates(pairs):
    out = {}
    for k, v in pairs:
        if k in out:
            raise ValueError("duplicate key")
        out[k] = v
    return out


def _int_env(env, name, default):
    try:
        return int(env.get(name, default))
    except (TypeError, ValueError):
        return default


def _event_parts(event):
    if "requestContext" in event and "http" in (event.get("requestContext") or {}):  # HTTP API v2
        method, path = event["requestContext"]["http"].get("method", ""), event.get("rawPath", "")
    else:  # REST API v1 proxy
        method, path = event.get("httpMethod", ""), event.get("path", "")
    headers = {str(k).lower(): str(v) for k, v in (event.get("headers") or {}).items()}
    query = event.get("queryStringParameters") or {}
    return method.upper(), path, headers, query


class App:
    def __init__(self, table, env, clock=time.time):
        self.t, self.env, self.clock = table, env, clock
        self.quota = _int_env(env, "REG_QUOTA_PER_MONTH", 2000)
        self.dedupe = _int_env(env, "DEDUPE_SECONDS", 7 * DAY)
        self.envelope_seconds = _int_env(env, "ENVELOPE_SECONDS", 7 * DAY)
        self.restored_from = env.get("RESTORED_FROM", "")
        self._restore_ok = False

    def now(self):
        return int(self.clock())

    # ------------------------------------------------------------ plumbing

    def handle(self, event):
        name = "unrouted"
        try:
            self._check_restore()
            body = event.get("body") or ""
            if event.get("isBase64Encoded"):
                if len(body) > MAX_BODY * 2:
                    raise HttpError(413, "body_too_large")
                body = base64.b64decode(body)
            raw = body.encode() if isinstance(body, str) else body
            if len(raw) > MAX_BODY:
                raise HttpError(413, "body_too_large")
            method, path, headers, query = _event_parts(event)
            route = self._route(method, path)
            if route is None:
                raise NOT_FOUND
            name, access, args = route
            ident = None
            if access != PUBLIC:
                ident = identify(event, headers, self.env, self.now())
                if ident is None:
                    raise HttpError(401, "unauthorized")
                if access == ADMIN and ident.role != "admin":
                    raise HttpError(403, "forbidden")
            status, out = getattr(self, name)(ident, self._json(raw, method), query, *args)
        except HttpError as err:
            status, out = err.status, {"error": err.code}
        except StoreUnavailable:
            status, out = 503, {"error": "unavailable"}
        except ConditionFailed:
            status, out = 409, {"error": "conflict"}
        print(json.dumps({"route": name, "status": status}), file=sys.stderr)
        return {"statusCode": status, "headers": dict(HEADERS), "body": json.dumps(out)}

    def _check_restore(self):
        if not self.restored_from or self._restore_ok:
            return
        marker = self.t.get("SYSTEM", "RESTORE")
        if not marker or marker.get("source") != self.restored_from:
            raise HttpError(503, "restore_pending")
        self._restore_ok = True

    def _route(self, method, path):
        for m, pattern, name, access in ROUTES:
            hit = pattern.fullmatch(path)
            if hit and m == method:
                return name, access, hit.groups()
        return None

    def _json(self, raw, method):
        if method != "POST" or not raw.strip():
            return {}
        try:
            body = json.loads(raw, object_pairs_hook=_no_duplicates)
        except (ValueError, UnicodeDecodeError):
            raise HttpError(400, "bad_json") from None
        if not isinstance(body, dict):
            raise HttpError(400, "bad_json")
        return body

    @staticmethod
    def _fields(body, required=(), optional=()):
        if set(body) - set(required) - set(optional):
            raise HttpError(400, "unexpected_field")
        if any(f not in body for f in required):
            raise HttpError(400, "missing_field")
        return body

    @staticmethod
    def _str(body, name, pattern):
        v = body.get(name)
        if not isinstance(v, str) or not pattern.fullmatch(v):
            raise HttpError(400, "bad_request")
        return v

    def _transact(self, ops):
        try:
            self.t.transact(ops)
            return None
        except TransactionCanceled as err:
            return err.reasons

    # ------------------------------------------------------------ registrations

    def _ack(self, reg, received_at):
        return {"registration_id": reg["SK"][4:], "received_at": _iso(received_at), "count": reg["count"],
                "head": reg["head"], "key_fingerprint": reg["fp"], "disposition": reg["state"]}

    def _existing(self, pk, rid):
        reg = self.t.get(pk, "REG#" + rid)
        if reg is None:
            return None
        if reg["state"] != "active":
            raise HttpError(410, "registration_deleted")
        return 200, self._ack(reg, reg["received_at"])

    def _replay(self, pk, idem):
        reg = self.t.get(pk, "REG#" + idem["rid"])
        if reg is None:
            raise HttpError(410, "registration_deleted")
        return 200, self._ack(reg, idem["received_at"])  # the original ack, with the current disposition

    def _envelope_ok(self, pk, envelope_id, ident, now):
        env = self.t.get(pk, "ENV#" + envelope_id)
        if not env or env.get("expires_at", 0) <= now or env.get("sub") != ident.sub:
            return False
        epoch = self.t.get(pk, "EPOCH")
        return env.get("epoch", -1) >= (epoch or {}).get("epoch", 0)

    def register(self, ident, body, _query):
        self._fields(body, required=("receipt", "idempotency_key", "envelope_id"))
        idem_key = self._str(body, "idempotency_key", IDEM_KEY)
        envelope_id = self._str(body, "envelope_id", HEX32)
        text = body["receipt"]
        if not isinstance(text, str):
            raise HttpError(400, "bad_receipt")
        pk, now = f"ORG#{ident.org_id}", self.now()
        payload_hash = _sha(json.dumps({"receipt": text, "envelope_id": envelope_id}, sort_keys=True,
                                       separators=(",", ":")))

        idem = self.t.get(pk, "IDEM#" + idem_key)
        if idem and idem.get("expires_at", 0) > now:
            if idem["payload_hash"] != payload_hash:
                raise HttpError(409, "idempotency_conflict")
            return self._replay(pk, idem)

        r = receipt.parse(text)
        rid = None
        if r is not None:
            fp = receipt.fingerprint(r.key)
            rid = _sha(f"{ident.org_id}|{fp}|{r.head.hex()}|{r.count}")[:32]
        if not self._envelope_ok(pk, envelope_id, ident, now):
            committed = self._existing(pk, rid) if rid else None
            if committed:
                return committed
            raise HttpError(422, "envelope_expired")
        if r is None:
            raise HttpError(400, "bad_receipt")
        if not receipt.signature_ok(r):
            raise HttpError(422, "bad_signature")
        key = self.t.get(pk, "KEY#" + fp)
        if key is None:
            raise HttpError(403, "key_not_enrolled")
        if key.get("state") != "active":
            raise HttpError(403, "key_not_active")

        reg = {"PK": pk, "SK": "REG#" + rid, "fp": fp, "head": r.head.hex(), "count": r.count, "received_at": now,
               "state": "active", "share_hashes": []}
        idem_item = {"PK": pk, "SK": "IDEM#" + idem_key, "payload_hash": payload_hash, "rid": rid, "received_at": now,
                     "expires_at": now + self.dedupe, "ttl": now + self.dedupe + DAY}
        month = time.strftime("%Y%m", time.gmtime(now))
        failed = self._transact([
            {"op": "put", "item": reg, "cond": [("not_exists",)]},
            {"op": "put", "item": idem_item, "cond": [("or", ("not_exists",), ("lt", "expires_at", now + 1))]},
            {"op": "update", "key": (pk, "QUOTA#" + month), "add": {"n": 1},
             "cond": [("or", ("missing", "n"), ("lt", "n", self.quota))]},
        ])
        if failed is None:
            return 201, self._ack(reg, now)
        if failed[1]:  # a concurrent request with the same idempotency key won
            idem = self.t.get(pk, "IDEM#" + idem_key)
            if idem and idem.get("expires_at", 0) > now:
                if idem["payload_hash"] != payload_hash:
                    raise HttpError(409, "idempotency_conflict")
                return self._replay(pk, idem)
            raise StoreUnavailable("idempotency record vanished")
        if failed[0]:
            committed = self._existing(pk, rid)
            if committed:
                return committed
            raise StoreUnavailable("registration vanished")
        raise HttpError(429, "quota_exceeded")

    def list_registrations(self, ident, _body, query):
        limit = query.get("limit", str(PAGE))
        if not re.fullmatch(r"[0-9]{1,2}", limit) or not 1 <= int(limit) <= PAGE:
            raise HttpError(400, "bad_request")
        cursor = query.get("cursor")
        if cursor is not None and not HEX32.fullmatch(cursor):
            raise HttpError(400, "bad_request")
        items, last = self.t.query(f"ORG#{ident.org_id}", "REG#", int(limit), "REG#" + cursor if cursor else None)
        out = []
        for reg in items:
            row = {"registration_id": reg["SK"][4:], "count": reg["count"], "head": reg["head"],
                   "key_fingerprint": reg["fp"], "disposition": reg["state"]}
            if "received_at" in reg:
                row["received_at"] = _iso(reg["received_at"])
            out.append(row)
        return 200, {"registrations": out, "next_cursor": last[4:] if last else None}

    def delete_registration(self, ident, _body, _query, rid):
        pk, now = f"ORG#{ident.org_id}", self.now()
        reg = self.t.get(pk, "REG#" + rid)
        if reg is None:
            raise NOT_FOUND
        if reg["state"] == "deleted":
            return 200, {"registration_id": rid, "disposition": "deleted"}
        ops = [
            {"op": "update", "key": (pk, "REG#" + rid), "set": {"state": "deleted", "deleted_at": now},
             "remove": ["received_at"], "cond": [("eq", "state", "active")]},
            {"op": "put", "item": {"PK": f"TOMB#{ident.org_id}#{rid}", "SK": "TOMB", "kind": "registration",
                                   "org": ident.org_id, "ref": rid, "at": now}},
        ]
        for h in reg.get("share_hashes", []):
            ops.append({"op": "update", "key": ("SHARE#" + h, "SHARE"), "set": {"state": "withdrawn", "withdrawn_at": now}})
            ops.append({"op": "put", "item": {"PK": f"TOMB#{ident.org_id}#{h}", "SK": "TOMB", "kind": "share",
                                              "org": ident.org_id, "ref": h, "at": now}})
        if self._transact(ops):
            raise HttpError(409, "conflict")
        return 200, {"registration_id": rid, "disposition": "deleted"}

    def envelope(self, ident, body, _query):
        self._fields(body)
        pk, now = f"ORG#{ident.org_id}", self.now()
        epoch = (self.t.get(pk, "EPOCH") or {}).get("epoch", 0)
        envelope_id = secrets.token_hex(16)
        expires = now + self.envelope_seconds
        self.t.put({"PK": pk, "SK": "ENV#" + envelope_id, "sub": ident.sub, "epoch": epoch, "expires_at": expires,
                    "ttl": expires + DAY}, cond=[("not_exists",)])
        return 201, {"envelope_id": envelope_id, "expires_at": _iso(expires), "epoch": epoch}

    def epoch(self, ident, body, _query):
        self._fields(body)
        item = self.t.update(f"ORG#{ident.org_id}", "EPOCH", add={"epoch": 1})
        return 200, {"epoch": item["epoch"]}

    # ------------------------------------------------------------ keys

    @staticmethod
    def challenge_message(org_id, nonce):
        return b"hashwing-key-enroll v1\n" + org_id.encode() + b"\n" + nonce.encode()

    def challenge(self, ident, _body, _query):
        nonce, now = secrets.token_hex(16), self.now()
        self.t.put({"PK": f"ORG#{ident.org_id}", "SK": "CHAL#" + nonce, "sub": ident.sub, "expires_at": now + 300,
                    "ttl": now + 300 + DAY}, cond=[("not_exists",)])
        return 200, {"nonce": nonce, "expires_at": _iso(now + 300),
                     "message": self.challenge_message(ident.org_id, nonce).decode()}

    def enroll(self, ident, body, _query):
        self._fields(body, required=("public_key", "nonce", "signature"), optional=("confirm_replace",))
        pub = bytes.fromhex(self._str(body, "public_key", HEX64))
        nonce = self._str(body, "nonce", HEX32)
        sig = bytes.fromhex(self._str(body, "signature", HEX128))
        confirm = body.get("confirm_replace", False)
        if not isinstance(confirm, bool):
            raise HttpError(400, "bad_request")
        if not ed25519.verify(pub, self.challenge_message(ident.org_id, nonce), sig):
            raise HttpError(422, "bad_signature")
        pk, now, fp = f"ORG#{ident.org_id}", self.now(), receipt.fingerprint(pub)
        if self.t.get(pk, "KEY#" + fp) is not None:
            raise HttpError(409, "key_exists")
        old = (self.t.get(pk, "ACTIVE_KEY") or {}).get("fp")
        if old and not confirm:
            raise HttpError(409, "confirm_required")
        ops = [
            {"op": "delete", "key": (pk, "CHAL#" + nonce),
             "cond": [("exists",), ("eq", "sub", ident.sub), ("gt", "expires_at", now)]},
            {"op": "put", "item": {"PK": pk, "SK": "KEY#" + fp, "state": "active", "enrolled_at": now,
                                   "enrolled_by": ident.sub, "changed_at": now}, "cond": [("not_exists",)]},
        ]
        if old:
            ops.append({"op": "update", "key": (pk, "KEY#" + old), "set": {"state": "rotated", "changed_at": now},
                        "cond": [("eq", "state", "active")]})
            ops.append({"op": "put", "item": {"PK": pk, "SK": "ACTIVE_KEY", "fp": fp}, "cond": [("eq", "fp", old)]})
        else:
            ops.append({"op": "put", "item": {"PK": pk, "SK": "ACTIVE_KEY", "fp": fp}, "cond": [("not_exists",)]})
        failed = self._transact(ops)
        if failed:
            if failed[0]:
                raise HttpError(400, "bad_challenge")
            raise HttpError(409, "key_exists" if failed[1] else "conflict")
        return 201, {"key_fingerprint": fp, "state": "active", "replaced": old}

    def list_keys(self, ident, _body, _query):
        items, _ = self.t.query(f"ORG#{ident.org_id}", "KEY#", PAGE)
        return 200, {"keys": [{"key_fingerprint": k["SK"][4:], "state": k["state"], "enrolled_at": _iso(k["enrolled_at"]),
                               "changed_at": _iso(k["changed_at"])} for k in items]}

    def compromise(self, ident, body, _query, fp):
        self._fields(body)
        pk, now = f"ORG#{ident.org_id}", self.now()
        key = self.t.get(pk, "KEY#" + fp)
        if key is None:
            raise NOT_FOUND
        ops = [{"op": "update", "key": (pk, "KEY#" + fp), "set": {"state": "compromised", "changed_at": now},
                "cond": [("exists",)]}]
        if (self.t.get(pk, "ACTIVE_KEY") or {}).get("fp") == fp:
            ops.append({"op": "delete", "key": (pk, "ACTIVE_KEY"), "cond": [("eq", "fp", fp)]})
        if self._transact(ops):
            raise HttpError(409, "conflict")
        return 200, {"key_fingerprint": fp, "state": "compromised"}

    # ------------------------------------------------------------ shares

    def create_share(self, ident, body, _query):
        self._fields(body, required=("registration_id",), optional=("expires_days",))
        rid = self._str(body, "registration_id", HEX32)
        days = body.get("expires_days", 30)
        if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 365:
            raise HttpError(400, "bad_request")
        pk, now = f"ORG#{ident.org_id}", self.now()
        reg = self.t.get(pk, "REG#" + rid)
        if reg is None or reg["state"] != "active":
            raise NOT_FOUND
        hashes = reg.get("share_hashes", [])
        if len(hashes) >= MAX_SHARES:
            raise HttpError(409, "share_limit")
        token = secrets.token_urlsafe(32)
        h, expires = _sha(token), now + days * DAY
        failed = self._transact([
            {"op": "put", "item": {"PK": "SHARE#" + h, "SK": "SHARE", "org": ident.org_id, "rid": rid,
                                   "state": "active", "created_at": now, "expires_at": expires, "ttl": expires + DAY},
             "cond": [("not_exists",)]},
            {"op": "update", "key": (pk, "REG#" + rid), "set": {"share_hashes": hashes + [h]},
             "cond": [("eq", "state", "active"), ("eq", "share_hashes", hashes)]},
        ])
        if failed:
            raise HttpError(409, "conflict")
        return 201, {"token": token, "path": "/v1/shares/" + token, "expires_at": _iso(expires)}

    def get_share(self, _ident, _body, _query, token):
        if not SHARE_TOKEN.fullmatch(token):
            raise NOT_FOUND
        share = self.t.get("SHARE#" + _sha(token), "SHARE")
        if (not share or share.get("state") != "active" or share.get("expires_at", 0) <= self.now()
                or "org" not in share):
            raise NOT_FOUND
        reg = self.t.get(f"ORG#{share['org']}", "REG#" + share["rid"])
        if not reg or reg.get("state") != "active" or "received_at" not in reg:
            raise NOT_FOUND
        return 200, {"head": reg["head"], "count": reg["count"], "key_fingerprint": reg["fp"],
                     "received_at": _iso(reg["received_at"])}

    def withdraw_share(self, ident, _body, _query, token):
        if not SHARE_TOKEN.fullmatch(token):
            raise NOT_FOUND
        h, now = _sha(token), self.now()
        share = self.t.get("SHARE#" + h, "SHARE")
        if not share or share.get("org") != ident.org_id:
            raise NOT_FOUND
        if share.get("state") != "withdrawn":
            failed = self._transact([
                {"op": "update", "key": ("SHARE#" + h, "SHARE"), "set": {"state": "withdrawn", "withdrawn_at": now},
                 "cond": [("eq", "org", ident.org_id)]},
                {"op": "put", "item": {"PK": f"TOMB#{ident.org_id}#{h}", "SK": "TOMB", "kind": "share",
                                       "org": ident.org_id, "ref": h, "at": now}},
            ])
            if failed:
                raise HttpError(409, "conflict")
        return 200, {"disposition": "withdrawn"}


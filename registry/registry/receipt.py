"""Receipt v1 lines, parsed the way src/fseal.cpp parse_line does, but stricter (see the matrix in the plan).

Line: `fseal-receipt v1 count=<dec> head=<64 hex> key=<64 hex> sig=<128 hex>`, lowercase hex only.
Unlike parse_line, extra tokens and count=0 are rejected.
"""
import hashlib
import re
from typing import NamedTuple

from . import ed25519

_HEX = {32: re.compile(r"[0-9a-f]{64}"), 64: re.compile(r"[0-9a-f]{128}")}
_COUNT = re.compile(r"[0-9]{1,20}")


class Receipt(NamedTuple):
    count: int
    head: bytes
    key: bytes
    sig: bytes


def _hex(token, name, n):
    if not token.startswith(name):
        return None
    value = token[len(name):]
    return bytes.fromhex(value) if _HEX[n].fullmatch(value) else None


def parse(line):
    """Return a Receipt, or None for anything that is not exactly one well-formed v1 line."""
    if not isinstance(line, str) or not line.isascii():
        return None
    tokens = line.split()
    if len(tokens) != 6 or tokens[0] != "fseal-receipt" or tokens[1] != "v1":
        return None
    if not tokens[2].startswith("count=") or not _COUNT.fullmatch(tokens[2][6:]):
        return None
    count = int(tokens[2][6:])
    if count == 0 or count >= 2**64:
        return None
    head, key, sig = _hex(tokens[3], "head=", 32), _hex(tokens[4], "key=", 32), _hex(tokens[5], "sig=", 64)
    if head is None or key is None or sig is None:
        return None
    return Receipt(count, head, key, sig)


def signed_message(count, head):
    return b"fseal-receipt v1" + count.to_bytes(8, "little") + head


def signature_ok(r):
    return ed25519.verify(r.key, signed_message(r.count, r.head), r.sig)


def fingerprint(key):
    return hashlib.sha256(key).hexdigest()


def to_line(r):
    return f"fseal-receipt v1 count={r.count} head={r.head.hex()} key={r.key.hex()} sig={r.sig.hex()}"

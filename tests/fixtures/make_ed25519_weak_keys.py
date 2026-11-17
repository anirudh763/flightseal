"""Writes tests/fixtures/ed25519-weak-keys.json: Ed25519 public keys a verifier must refuse, with forged receipts.

  python3 tests/fixtures/make_ed25519_weak_keys.py

A key is weak when its encoding is non-canonical (y >= p) or it decodes to one of the 8 small-order points. The
small-order encodings are libsodium's has_small_order blacklist (src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c),
matched with the sign bit ignored; this script derives them from the curve instead of copying them, and checks the
two lists agree. For each small-order key it searches for a receipt signature (R = a small-order point, S = 0) that
the plain Ed25519 equation accepts for ANY message, the forgery these keys allow. forge() is also used by
tests/test_weak_keys.py to forge receipts for a real log.
"""
import hashlib
import json
import struct
from pathlib import Path

p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
d = -121665 * pow(121666, p - 2, p) % p
I = pow(2, (p - 1) // 4, p)  # sqrt(-1)
LABEL = b"fseal-receipt v1"
MESSAGE = "fseal-receipt v1 || u64le(count) || head"
HEAD = bytes([0xAB]) * 32
WEAK_KEY_MESSAGE = "This public key is weak and can't prove anything"

# libsodium has_small_order blacklist (top bit masked off before comparing).
LIBSODIUM = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]


def recover_x(y, sign):
    if y >= p:
        return None
    x2 = (y * y - 1) * pow(d * y * y + 1, p - 2, p) % p
    if x2 == 0:  # lenient like OpenSSL: x = 0 with the sign bit set still decodes (to x = 0)
        return 0
    x = pow(x2, (p + 3) // 8, p)
    if (x * x - x2) % p:
        x = x * I % p
    if (x * x - x2) % p:
        return None
    return p - x if (x & 1) != sign else x


def add(P, Q):
    (x1, y1), (x2, y2) = P, Q
    t = d * x1 * x2 * y1 * y2 % p
    return ((x1 * y2 + x2 * y1) * pow(1 + t, p - 2, p) % p, (y1 * y2 + x1 * x2) * pow(1 - t, p - 2, p) % p)


def mul(k, P):
    Q = (0, 1)
    while k:
        if k & 1:
            Q = add(Q, P)
        P, k = add(P, P), k >> 1
    return Q


def encode(P):
    x, y = P
    return (y | (x & 1) << 255).to_bytes(32, "little")


def decode(b):
    """Decodes like a lenient verifier: y is taken mod 2^255 and NOT required to be below p."""
    v = int.from_bytes(b, "little")
    y, sign = v & (2**255 - 1), v >> 255
    x = recover_x(y % p, sign)
    return None if x is None else (x, y % p)


def message(count, head):
    return LABEL + struct.pack("<Q", count) + head


def forge(key, count, head):
    """A signature R || 0 that passes [S]B == R + [h]A for this message, or None. Works only for small-order A."""
    A = decode(key)
    if A is None:
        return None
    for R in TORSION:
        r = encode(R)
        h = int.from_bytes(hashlib.sha512(r + key + message(count, head)).digest(), "little") % L
        if add(R, mul(h, A)) == (0, 1):  # [0]B == identity
            return r + bytes(32)
    return None


# The 8-torsion: [L]P for a curve point P has order dividing 8; one of order 8 generates all of them.
_B = (recover_x(4 * pow(5, p - 2, p) % p, 0), 4 * pow(5, p - 2, p) % p)
_P = next(Q for Q in ((recover_x(y, 0), y) for y in range(2, 100)) if Q[0] is not None and mul(4, mul(L, Q)) != (0, 1))
_T = mul(L, _P)
TORSION = [mul(k, _T) for k in range(8)]


def weak_encodings():
    out = set()
    for x, y in TORSION:  # canonical encoding, plus the other sign bit when x = 0 (non-canonical)
        out.add(encode((x, y)))
        out.add((y | (1 - (x & 1)) << 255).to_bytes(32, "little"))
    for y in range(p, 2**255):  # y >= p: every non-canonical y, either sign
        out.update((y | s << 255).to_bytes(32, "little") for s in (0, 1))
    return sorted(out)


def main():
    keys = weak_encodings()
    torsion_y = {y.to_bytes(32, "little").hex() for _, y in TORSION}
    assert torsion_y == set(LIBSODIUM[:5]), "derived small-order points disagree with libsodium"
    assert all(int.from_bytes(bytes.fromhex(k), "little") >= p for k in LIBSODIUM[5:])  # the rest are y >= p
    entries = []
    for key in keys:
        entry = {"key": key.hex(), "small_order": decode(key) is not None and mul(8, decode(key)) == (0, 1), "count": None, "head": None, "sig": None}
        if entry["small_order"]:
            for count in range(1, 64):
                sig = forge(key, count, HEAD)
                if sig:
                    entry.update(count=count, head=HEAD.hex(), sig=sig.hex())
                    break
            assert entry["sig"], key.hex()
        entries.append(entry)
    control = (p - 2).to_bytes(32, "little").hex()  # off-by-one control: canonical, not small order
    doc = {
        "error": WEAK_KEY_MESSAGE,
        "message": MESSAGE,
        "source": "Non-canonical (y >= p) and small-order Ed25519 encodings; the small-order set equals libsodium's has_small_order blacklist (crypto_core/ed25519/ref10/ed25519_ref10.c) with the sign bit ignored. Generated by tests/fixtures/make_ed25519_weak_keys.py.",
        "weak": entries,
        "not_weak": [control],
        "rfc8032": [  # RFC 8032 section 7.1, TEST 1-3
            {"key": "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "msg": "", "sig": "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
            {"key": "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "msg": "72", "sig": "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
            {"key": "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "msg": "af82", "sig": "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"},
        ],
    }
    out = Path(__file__).with_name("ed25519-weak-keys.json")
    # One entry per line so the C++ test can read it without a JSON parser.
    lines = [f'  {json.dumps(k)}: {json.dumps(v)},' for k, v in doc.items() if not isinstance(v, list)]
    for k in ("weak", "not_weak", "rfc8032"):
        lines.append(f'  "{k}": [\n' + ",\n".join("    " + json.dumps(e) for e in doc[k]) + "\n  ],")
    out.write_text("{\n" + "\n".join(lines)[:-1] + "\n}\n")
    print(f"{out}: {len(entries)} weak keys, {sum(1 for e in entries if e['sig'])} with a forged receipt")


if __name__ == "__main__":
    main()

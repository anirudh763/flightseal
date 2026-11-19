"""Pure-Python Ed25519 (RFC 8032), standard library only.

The registry verifies public data (receipts and enrollment challenges), so constant time is not required.
`sign` exists for tests and the LocalStack script; the server never holds a private key.
"""
import hashlib

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def _sha512_int(*parts):
    return int.from_bytes(hashlib.sha512(b"".join(parts)).digest(), "little")


# Points in extended coordinates (X, Y, Z, T) with x = X/Z, y = Y/Z, x*y = T/Z.
def _add(p, q):
    a = (p[1] - p[0]) * (q[1] - q[0]) % P
    b = (p[1] + p[0]) * (q[1] + q[0]) % P
    c = 2 * p[3] * q[3] * D % P
    d = 2 * p[2] * q[2] % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _mul(s, p):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _encode(p):
    zinv = pow(p[2], P - 2, P)
    x, y = p[0] * zinv % P, p[1] * zinv % P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _recover_x(y, sign):
    if y >= P:
        return None
    x2 = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P:
        return None
    if (x & 1) != sign:
        x = P - x
    return x


def _decode(b):
    if len(b) != 32:
        return None
    n = int.from_bytes(b, "little")
    y, sign = n & ((1 << 255) - 1), n >> 255
    x = _recover_x(y, sign)  # rejects non-canonical y >= p and points not on the curve
    if x is None:
        return None
    return (x, y, 1, x * y % P)


_GY = 4 * pow(5, P - 2, P) % P
B = (_recover_x(_GY, 0), _GY, 1, _recover_x(_GY, 0) * _GY % P)


def _strong_point(pub):
    """The decoded point, or None for a malformed, non-canonical or small-order key."""
    if not isinstance(pub, bytes) or len(pub) != 32:
        return None
    a = _decode(pub)
    if a is None:
        return None
    a8 = _mul(8, a)
    if a8[0] % P == 0 and (a8[1] - a8[2]) % P == 0:  # small-order key: [8]A is the identity, forges for any message
        return None
    return a


def weak_key(pub):
    """True for any public key that `verify` refuses outright: wrong length, non-canonical, off-curve or small order."""
    return _strong_point(pub) is None


def verify(pub, msg, sig):
    """True only for a valid signature; any malformed input is False."""
    if not (isinstance(sig, bytes) and len(sig) == 64):
        return False
    a = _strong_point(pub)
    if a is None:
        return False
    s = int.from_bytes(sig[32:], "little")
    if s >= L:
        return False
    k = _sha512_int(sig[:32], pub, msg) % L
    # Cofactorless equation, compared byte for byte: encode([S]B - [k]A) == R. Stricter than OpenSSL: small-order
    # and non-canonical public keys are rejected above, so a key that verifies every message cannot be enrolled.
    neg_a = ((P - a[0]) % P, a[1], a[2], (P - a[3]) % P)
    return _encode(_add(_mul(s, B), _mul(k, neg_a))) == sig[:32]


def _expand(seed):
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def public_key(seed):
    a, _ = _expand(seed)
    return _encode(_mul(a, B))


def sign(seed, msg):
    """Test and script helper: RFC 8032 signing from a 32-byte seed."""
    a, prefix = _expand(seed)
    pub = _encode(_mul(a, B))
    r = _sha512_int(prefix, msg) % L
    rb = _encode(_mul(r, B))
    s = (r + _sha512_int(rb, pub, msg) * a) % L
    return rb + s.to_bytes(32, "little")

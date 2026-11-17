import pytest
from registry_helpers import ROOT, SEED_A, call, enroll, fseal_bin, fseal_receipts, make_app, register, token

from registry import ed25519, receipt

# RFC 8032 section 7.1, tests 1-3: (secret seed, public key, message, signature)
RFC = [
    ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
     "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
     "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
     "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
]


@pytest.mark.parametrize("seed,pub,msg,sig", RFC)
def test_rfc8032_vectors(seed, pub, msg, sig):
    seed, pub, msg, sig = map(bytes.fromhex, (seed, pub, msg, sig))
    assert ed25519.public_key(seed) == pub
    assert ed25519.sign(seed, msg) == sig
    assert ed25519.verify(pub, msg, sig)
    assert not ed25519.verify(pub, msg + b"x", sig)


def test_rejects_s_at_or_above_l_and_bad_points():
    seed, pub, msg, sig = map(bytes.fromhex, RFC[0])
    s = int.from_bytes(sig[32:], "little")
    assert not ed25519.verify(pub, msg, sig[:32] + (s + ed25519.L).to_bytes(32, "little"))  # malleated S
    assert not ed25519.verify(pub, msg, sig[:32] + ed25519.L.to_bytes(32, "little"))
    assert not ed25519.verify((ed25519.P + 1).to_bytes(32, "little"), msg, sig)  # non-canonical y >= p
    assert not ed25519.verify((2).to_bytes(32, "little"), msg, sig)  # y=2 is not on the curve
    assert not ed25519.verify(pub[:31], msg, sig) and not ed25519.verify(pub, msg, sig[:63])


def test_sample_receipts_verify():
    lines = (ROOT / "docs" / "samples" / "flight.receipts").read_text().splitlines()
    assert len(lines) == 8
    for text in lines:
        r = receipt.parse(text)
        assert r is not None and receipt.signature_ok(r)
        assert receipt.to_line(r) == text


def _flips(data):
    for i in range(len(data) * 8):
        b = bytearray(data)
        b[i // 8] ^= 1 << (i % 8)
        yield bytes(b)


def test_every_single_bit_flip_fails():
    r = receipt.parse((ROOT / "docs" / "samples" / "flight.receipts").read_text().splitlines()[0])
    for i in range(64):
        assert not receipt.signature_ok(r._replace(count=r.count ^ (1 << i)))
    for head in _flips(r.head):
        assert not receipt.signature_ok(r._replace(head=head))
    for sig in _flips(r.sig):
        assert not receipt.signature_ok(r._replace(sig=sig))
    for key in _flips(r.key):
        assert not receipt.signature_ok(r._replace(key=key))


@pytest.mark.skipif(fseal_bin() is None, reason="build/fseal missing (cmake --build build)")
def test_fresh_cxx_receipt_registers_and_bit_flips_are_rejected(tmp_path):
    seed, lines = fseal_receipts(tmp_path)
    assert len(lines) == 2
    app, _, clock = make_app()
    assert enroll(app, clock, seed=seed)[0] == 201
    pilot = token(clock)
    s, out, _ = register(app, pilot, lines[1])
    assert s == 201 and out["count"] == 4, out
    r = receipt.parse(lines[0])
    assert receipt.signature_ok(r)
    for i in range(64):
        assert not receipt.signature_ok(r._replace(count=r.count ^ (1 << i)))
    for head in _flips(r.head):
        assert not receipt.signature_ok(r._replace(head=head))
    for sig in _flips(r.sig):
        assert not receipt.signature_ok(r._replace(sig=sig))
    # one bit flipped in the text that reaches the API: rejected as a bad signature
    flipped = lines[0].replace("head=" + r.head.hex(), "head=" + bytes([r.head[0] ^ 1]).hex() + r.head.hex()[2:])
    s, out, _ = register(app, pilot, flipped, idem="idem-key-flipped-0001")
    assert (s, out["error"]) == (422, "bad_signature")


def test_unrelated_key_does_not_verify():
    r = receipt.parse((ROOT / "docs" / "samples" / "flight.receipts").read_text().splitlines()[0])
    assert not receipt.signature_ok(r._replace(key=ed25519.public_key(SEED_A)))


def test_registration_route_rejects_bad_signature_from_enrolled_key():
    app, _, clock = make_app()
    enroll(app, clock)
    r = receipt.parse((ROOT / "docs" / "samples" / "flight.receipts").read_text().splitlines()[0])
    forged = receipt.to_line(r._replace(key=ed25519.public_key(SEED_A)))
    s, out, _ = register(app, token(clock), forged)
    assert (s, out["error"]) == (422, "bad_signature")
    assert call(app, "GET", "/v1/registrations", token(clock))[1]["registrations"] == []

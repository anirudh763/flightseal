"""Pilot key authorization format (Option B, design §4.2 and §10 "PR 3"): the shared vectors, and the cross-format
rule with ONE key signing a receipt, a company challenge, a pilot challenge and an authorization."""
import json
import subprocess
import sys

import pytest
from registry_helpers import (ROOT, SEED_A, SEED_B, authorize, call, enroll, fseal_bin, fseal_receipts, make_app, register, token)

from registry import ed25519, pilot_authorization as pa, receipt
from registry.app import App
from registry.enroll_challenge import bytes_to_sign

sys.path.insert(0, str(ROOT / "tests" / "fixtures"))
import make_pilot_authorization as gen  # noqa: E402

VECTORS = json.loads((ROOT / "tests/fixtures/pilot-authorization.json").read_text())
SEED_C = bytes(range(2, 34))
SEEDS = {ed25519.public_key(s).hex(): s for s in (SEED_A, SEED_B, SEED_C)}


NOT_FOUND = object()  # no authorization line: nothing is authorized (signer not confirmed)


def evaluate(case):
    try:
        found = pa.parse_line(case["line"])
    except ValueError:
        return "malformed"
    if found is None:
        return NOT_FOUND
    return pa.check(*found, bytes.fromhex(case["pilot_key"]), bytes.fromhex(case["company_key"]), case["now"])[0]


def test_vector_file_is_what_the_generator_writes():
    assert (ROOT / "tests/fixtures/pilot-authorization.json").read_text() == gen.build()


def test_vector_constants():
    assert (VECTORS["prefix"], VECTORS["default_days"], VECTORS["max_days"]) == (pa.PREFIX, 14, 30)
    assert (VECTORS["pilot_key_cap"], VECTORS["recipient_compromised_cap"]) == (50, 500)
    assert [r["reason"] for r in VECTORS["reasons"]] == list(pa.REGISTRY_ERROR)
    reasons = {c["reason"] for c in VECTORS["cases"]}
    assert reasons == set(pa.REGISTRY_ERROR) | {None}  # every reason has a vector


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_vector(case):
    result = evaluate(case)
    assert (result is not NOT_FOUND) is case["found"]
    if case["found"]:
        assert result == case["reason"]
    assert pa.REGISTRY_ERROR.get(case["reason"]) == case["registry_error"]


@pytest.mark.parametrize("case", [c for c in VECTORS["cases"] if c["found"] and c["pilot_key"] in SEEDS and "\n" not in c["line"]],
                         ids=lambda c: c["name"])
def test_vector_through_the_registry(case):
    """POST /v1/pilot-keys answers each vector's registry_error, with the expected company key as ACTIVE_KEY."""
    app, _, clock = make_app(PILOT_KEYS_ORGS="orgA")
    clock.t = case["now"]
    assert enroll(app, clock, seed=SEEDS[case["company_key"]])[0] == 201
    pilot = SEEDS[case["pilot_key"]]
    tok = token(clock)
    ch = call(app, "GET", "/v1/pilot-keys/challenge", tok)[1]
    body = {"public_key": case["pilot_key"], "nonce": ch["nonce"],
            "signature": ed25519.sign(pilot, bytes_to_sign("orgA", ch, "pilot")).hex(),
            "authorization": case["authorization"], "authorization_sig": case["authorization_sig"]}
    s, out, _ = call(app, "POST", "/v1/pilot-keys", tok, body)
    if case["registry_error"] is None:
        assert s == 201, out
    else:
        assert (s, out) == (422, {"error": case["registry_error"]})


def test_parse_line():
    assert pa.parse_line("no authorization here\n") is None
    a0, s0 = authorize(SEED_A, ed25519.public_key(SEED_B), 1_800_000_000)
    for indent in (" ", "\t", "x"):  # only a line that starts exactly with the prefix counts; no trimming
        assert pa.parse_line(indent + pa.to_line(a0, s0)) is None
    a, s = authorize(SEED_A, ed25519.public_key(SEED_B), 1_800_000_000)
    assert pa.parse_line("note\n" + pa.to_line(a, s)) == (a, s)
    for bad in ("Authorized by company key:abc." + "0" * 128, "Authorized by company key: a.b.c",
                "Authorized by company key: abc"):
        with pytest.raises(ValueError):
            pa.parse_line(bad)


def test_weak_key_helper_matches_the_shared_weak_key_vectors():
    weak = json.loads((ROOT / "tests/fixtures/ed25519-weak-keys.json").read_text())
    assert all(ed25519.weak_key(bytes.fromhex(e["key"])) for e in weak["weak"])
    # The CLI's not_weak control is canonical but not a curve point: verify refuses it, so weak_key says weak too.
    assert weak["not_weak"] == [gen.OFF_CURVE.hex()] and ed25519.weak_key(gen.OFF_CURVE)
    assert not any(ed25519.weak_key(ed25519.public_key(s)) for s in (SEED_A, SEED_B, SEED_C))


# ------------------------------------------------------------ cross-format: one key, four formats, five checkers

COUNT, HEAD = 7, b"\x22" * 32
FORMATS = ("receipt", "company_challenge", "pilot_challenge", "authorization")


def _sigs(seed, nonce, stmt, org="orgA"):
    """The same key signing each format. Both challenges use the same nonce, so only the prefix differs."""
    return {"receipt": ed25519.sign(seed, receipt.signed_message(COUNT, HEAD)),
            "company_challenge": ed25519.sign(seed, App.challenge_message(org, nonce, "company")),
            "pilot_challenge": ed25519.sign(seed, App.challenge_message(org, nonce, "pilot")),
            "authorization": ed25519.sign(seed, stmt)}


def _stmt(clock, pilot_pub=None):
    return pa.statement(pilot_pub or ed25519.public_key(SEED_B), ed25519.public_key(SEED_A), clock.t + 14 * 86400)


@pytest.mark.parametrize("fmt", FORMATS)
def test_cross_format_receipt_checkers(fmt):
    app, _, clock = make_app()
    enroll(app, clock)
    sig = _sigs(SEED_A, "0" * 32, _stmt(clock))[fmt]
    r = receipt.Receipt(COUNT, HEAD, ed25519.public_key(SEED_A), sig)
    assert receipt.signature_ok(r) is (fmt == "receipt")
    s, out, _ = register(app, token(clock), receipt.to_line(r))
    assert (s, out.get("error")) == ((201, None) if fmt == "receipt" else (422, "bad_signature"))


@pytest.mark.parametrize("fmt", FORMATS)
def test_cross_format_company_enroll(fmt):
    app, table, clock = make_app()
    admin = token(clock, role="admin", sub="admin-1")
    nonce = call(app, "GET", "/v1/keys/challenge", admin)[1]["nonce"]
    sig = _sigs(SEED_A, nonce, _stmt(clock))[fmt]
    body = {"public_key": ed25519.public_key(SEED_A).hex(), "nonce": nonce, "signature": sig.hex()}
    s, out, _ = call(app, "POST", "/v1/keys", admin, body)
    assert (s, out.get("error")) == ((201, None) if fmt == "company_challenge" else (422, "bad_signature"))


@pytest.mark.parametrize("fmt", FORMATS)
def test_cross_format_pilot_challenge_signature(fmt):
    """The key is the pilot here: its signature goes in `signature`, with a valid authorization from SEED_C."""
    app, _, clock = make_app(PILOT_KEYS_ORGS="orgA")
    enroll(app, clock, seed=SEED_C)
    tok = token(clock)
    nonce = call(app, "GET", "/v1/pilot-keys/challenge", tok)[1]["nonce"]
    pub = ed25519.public_key(SEED_A)
    a, a_sig = authorize(SEED_C, pub, clock.t + 14 * 86400)
    sig = _sigs(SEED_A, nonce, _stmt(clock))[fmt]
    body = {"public_key": pub.hex(), "nonce": nonce, "signature": sig.hex(), "authorization": a,
            "authorization_sig": a_sig}
    s, out, _ = call(app, "POST", "/v1/pilot-keys", tok, body)
    assert (s, out.get("error")) == ((201, None) if fmt == "pilot_challenge" else (422, "bad_signature"))


@pytest.mark.parametrize("fmt", FORMATS)
def test_cross_format_authorization_signature(fmt):
    """The key is the company key here: its signature goes in `authorization_sig`, for pilot SEED_B."""
    app, _, clock = make_app(PILOT_KEYS_ORGS="orgA")
    enroll(app, clock)
    tok = token(clock)
    ch = call(app, "GET", "/v1/pilot-keys/challenge", tok)[1]
    stmt = _stmt(clock)
    sig = _sigs(SEED_A, ch["nonce"], stmt)[fmt]
    body = {"public_key": ed25519.public_key(SEED_B).hex(), "nonce": ch["nonce"],
            "signature": ed25519.sign(SEED_B, bytes_to_sign("orgA", ch, "pilot")).hex(),
            "authorization": pa.encode(stmt), "authorization_sig": sig.hex()}
    s, out, _ = call(app, "POST", "/v1/pilot-keys", tok, body)
    assert (s, out.get("error")) == ((201, None) if fmt == "authorization" else (422, "bad_authorization"))


@pytest.mark.skipif(fseal_bin() is None, reason="build/fseal missing (cmake --build build)")
def test_fseal_cli_rejects_challenge_and_authorization_signatures_in_a_receipt(tmp_path):
    seed, lines = fseal_receipts(tmp_path)
    log, pub = tmp_path / "f.fseal", ed25519.public_key(seed).hex()

    def verify(path):
        return subprocess.run([str(fseal_bin()), "verify", str(log), "--receipts", str(path), "--pubkey", pub],
                              capture_output=True, text=True)

    ok = verify(tmp_path / "f.receipts")
    assert ok.returncode == 0, ok.stdout + ok.stderr
    stmt = pa.statement(ed25519.public_key(SEED_B), ed25519.public_key(seed), 1_800_000_000)
    r = receipt.parse(lines[-1])
    for fmt, sig in _sigs(seed, "0" * 32, stmt).items():
        if fmt == "receipt":
            continue
        bad = tmp_path / f"{fmt}.receipts"
        bad.write_text("\n".join(lines[:-1] + [receipt.to_line(r._replace(sig=sig))]) + "\n")
        v = verify(bad)
        assert v.returncode == 3 and "RESULT: UNVERIFIED" in v.stdout, (fmt, v.stdout + v.stderr)


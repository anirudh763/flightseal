"""Company keys, server half (design PR #57 §4.1 and §10 "PR 1", spine AD-21): compromise idempotency, the key list,
the client-side challenge builder and cross-format signatures (a challenge signature is never a receipt, and back)."""
import copy
import json
import re
import subprocess

import pytest
from registry_helpers import (Clock, SEED_A, SEED_B, call, enroll, fseal_bin, fseal_receipts, line, make_app,
                              register, token)

from registry import ed25519, receipt
from registry.enroll_challenge import bytes_to_sign
from registry.restore import apply_tombstones
from registry.store import MemoryTable

FP_A = receipt.fingerprint(ed25519.public_key(SEED_A))
FP_B = receipt.fingerprint(ed25519.public_key(SEED_B))


def _admin(clock, org="orgA"):
    return token(clock, org=org, role="admin", sub="admin-1")  # the sub `enroll()` uses


def _key_items(table, fp=FP_A, org="orgA"):
    key, tomb = (f"ORG#{org}", "KEY#" + fp), (f"TOMB#{org}#KEY#{fp}", "TOMB")
    return copy.deepcopy((table.items.get(key), table.items.get(tomb)))


def _compromise(app, tok, fp=FP_A):
    return call(app, "POST", f"/v1/keys/{fp}/compromised", tok, {})[:2]


# ------------------------------------------------------------ compromise

def test_first_compromise_updates_key_and_tomb_and_clears_active_key():
    app, table, clock = make_app()
    assert enroll(app, clock)[0] == 201
    clock.t += 60
    s, out = _compromise(app, _admin(clock))
    assert (s, out) == (200, {"key_fingerprint": FP_A, "state": "compromised", "changed_at": "2027-01-15T08:01:00Z"})
    key, tomb = _key_items(table)
    assert key["state"] == "compromised" and key["changed_at"] == clock.t
    assert (tomb["state"], tomb["at"]) == ("compromised", clock.t)
    assert ("ORG#orgA", "ACTIVE_KEY") not in table.items


def test_repeat_compromise_keeps_the_first_date_and_writes_nothing():
    app, table, clock = make_app()
    enroll(app, clock)
    first = _compromise(app, _admin(clock))
    before = _key_items(table)
    clock.t += 1800
    assert _compromise(app, _admin(clock)) == first
    assert _key_items(table) == before


@pytest.mark.parametrize("flip_to, expected", [("compromised", 200), ("rotated", 409)])
def test_racing_compromise_rereads_after_a_cancel(flip_to, expected):
    app, table, clock = make_app()
    enroll(app, clock)
    raced_at = clock.t - 5
    real = table.transact

    def racing(ops):  # another request changes the key between our read and our write
        table.items[("ORG#orgA", "KEY#" + FP_A)].update(state=flip_to, changed_at=raced_at)
        table.transact = real
        return real(ops)

    table.transact = racing
    clock.t += 60
    s, out = _compromise(app, _admin(clock))
    if expected == 200:
        assert (s, out) == (200, {"key_fingerprint": FP_A, "state": "compromised",
                                  "changed_at": "2027-01-15T07:59:55Z"})
    else:
        assert (s, out) == (409, {"error": "conflict"})
    assert table.items[("ORG#orgA", "KEY#" + FP_A)]["state"] == flip_to  # the cancelled write left nothing


def test_register_racing_a_compromise_is_refused_and_writes_nothing():
    app, table, clock = make_app()
    enroll(app, clock)
    real = table.transact

    def racing(ops):  # the key is marked compromised between register's key read and its write
        if any(op["op"] == "put" and op["item"]["SK"].startswith("REG#") for op in ops):
            table.items[("ORG#orgA", "KEY#" + FP_A)].update(state="compromised", changed_at=clock.t)
            table.transact = real
        return real(ops)

    table.transact = racing
    s, out, _ = register(app, token(clock), line(SEED_A, 1))
    assert (s, out) == (403, {"error": "key_not_active"})
    assert not any(sk.startswith("REG#") for (_, sk) in table.items)


def test_compromise_of_an_unknown_or_other_orgs_key_is_404():
    app, _, clock = make_app()
    enroll(app, clock, seed=SEED_B, org="orgB")
    for fp in (FP_A, FP_B):  # unknown anywhere; enrolled, but in orgB
        assert _compromise(app, _admin(clock), fp) == (404, {"error": "not_found"})


def test_compromise_as_member_is_403():
    app, table, clock = make_app()
    enroll(app, clock)
    before = _key_items(table)
    assert _compromise(app, token(clock)) == (403, {"error": "forbidden"})
    assert _key_items(table) == before


def test_restore_after_two_compromises_keeps_the_first_date():
    app, live, clock = make_app()
    enroll(app, clock)
    backup = MemoryTable()
    backup.items = copy.deepcopy(live.items)  # key active
    first_at = clock.t + 60
    clock.t = first_at
    _compromise(app, _admin(clock))
    clock.t += 1800
    _compromise(app, _admin(clock))
    apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live", clock=Clock())
    assert backup.items[("ORG#orgA", "KEY#" + FP_A)]["changed_at"] == first_at


# ------------------------------------------------------------ list

def test_list_keys_says_which_is_active_and_who_enrolled_without_a_sub():
    app, _, clock = make_app()
    enroll(app, clock)
    clock.t += 10
    enroll(app, clock, seed=SEED_B, confirm=True)
    for tok, mine in ((token(clock), False), (_admin(clock), True)):
        s, out, _ = call(app, "GET", "/v1/keys", tok)
        assert s == 200 and set(out) == {"keys", "active_key", "next_cursor", "pilot_keys"}
        assert out["pilot_keys"] is False  # PILOT_KEYS_ORGS unset
        assert out["active_key"] == FP_B and out["next_cursor"] is None
        assert {k["key_fingerprint"]: k["state"] for k in out["keys"]} == {FP_A: "rotated", FP_B: "active"}
        for row in out["keys"]:
            assert set(row) == {"key_fingerprint", "kind", "state", "enrolled_at", "changed_at", "enrolled_by_me"}
            assert row["kind"] == "company"
            assert row["enrolled_by_me"] is mine
        assert "admin-1" not in json.dumps(out) and "pilot-1" not in json.dumps(out)


def _seed_keys(table, n, org="orgA"):
    fps = sorted(f"{i:064x}" for i in range(n))
    for fp in fps:
        table.items[(f"ORG#{org}", "KEY#" + fp)] = {"PK": f"ORG#{org}", "SK": "KEY#" + fp, "state": "rotated",
                                                    "enrolled_at": 1, "enrolled_by": "admin-1", "changed_at": 1}
    return fps


def test_list_keys_pages_past_50():
    app, table, clock = make_app()
    fps = _seed_keys(table, 53)
    s, page1, _ = call(app, "GET", "/v1/keys", token(clock))
    assert s == 200 and len(page1["keys"]) == 50 and page1["next_cursor"] == fps[49]
    s, page2, _ = call(app, "GET", "/v1/keys", token(clock), query={"cursor": page1["next_cursor"]})
    assert s == 200 and [k["key_fingerprint"] for k in page2["keys"]] == fps[50:] and page2["next_cursor"] is None
    assert [k["key_fingerprint"] for k in page1["keys"] + page2["keys"]] == fps


def test_list_keys_exactly_full_page_may_return_a_cursor_to_an_empty_page():
    app, table, clock = make_app()
    _seed_keys(table, 50)
    page1 = call(app, "GET", "/v1/keys", token(clock))[1]
    assert len(page1["keys"]) == 50 and page1["next_cursor"]
    page2 = call(app, "GET", "/v1/keys", token(clock), query={"cursor": page1["next_cursor"]})[1]
    assert page2 == {"keys": [], "active_key": None, "next_cursor": None, "pilot_keys": False}


@pytest.mark.parametrize("cursor", ["", "ab" * 31, "AB" * 32, "ab" * 32 + "0", "g" * 64, "KEY#" + "a" * 60])
def test_list_keys_bad_cursor_is_400(cursor):
    app, _, clock = make_app()
    assert call(app, "GET", "/v1/keys", token(clock), query={"cursor": cursor})[:2] == (400, {"error": "bad_request"})


def test_restored_stub_key_is_not_enrolled_by_me():
    app, table, clock = make_app()
    pk = "ORG#orgA"
    table.items[(pk, "KEY#" + FP_A)] = {"PK": pk, "SK": "KEY#" + FP_A, "state": "compromised", "enrolled_at": 5,
                                        "enrolled_by": "restore", "changed_at": 7}
    table.items[(pk, "KEY#" + FP_B)] = {"PK": pk, "SK": "KEY#" + FP_B, "state": "rotated", "changed_at": 7}
    for sub in ("admin-1", "pilot-1"):
        rows = {r["key_fingerprint"]: r for r in call(app, "GET", "/v1/keys", token(clock, sub=sub))[1]["keys"]}
        assert [r["enrolled_by_me"] for r in rows.values()] == [False, False]
        assert "enrolled_at" not in rows[FP_B]  # omitted, never invented from the current time


def test_lost_enroll_response_retry_is_key_exists_and_the_key_is_active():
    """Design §10: the enroll committed but its response was lost. The identical retry says 409 key_exists, and the
    list then shows that fingerprint as the active key."""
    app, _, clock = make_app()
    admin = _admin(clock)
    ch = call(app, "GET", "/v1/keys/challenge", admin)[1]
    body = {"public_key": ed25519.public_key(SEED_A).hex(), "nonce": ch["nonce"],
            "signature": ed25519.sign(SEED_A, bytes_to_sign("orgA", ch)).hex()}
    assert call(app, "POST", "/v1/keys", admin, body)[0] == 201  # response lost
    assert call(app, "POST", "/v1/keys", admin, body)[:2] == (409, {"error": "key_exists"})
    assert call(app, "GET", "/v1/keys", token(clock))[1]["active_key"] == FP_A


# ------------------------------------------------------------ challenge bytes and the client builder

def test_challenge_message_is_byte_exact():
    app, _, clock = make_app()
    for org in ("orgA", "orgB"):
        s, ch, _ = call(app, "GET", "/v1/keys/challenge", _admin(clock, org))
        assert s == 200 and re.fullmatch(r"[0-9a-f]{32}", ch["nonce"])
        assert ch["message"] == "hashwing-key-enroll v1\n" + org + "\n" + ch["nonce"]
        assert bytes_to_sign(org, ch) == ch["message"].encode()


def test_client_builder_refuses_anything_but_its_own_bytes():
    nonce = "0123456789abcdef" * 2
    good = {"nonce": nonce, "message": f"hashwing-key-enroll v1\norgA\n{nonce}"}
    assert bytes_to_sign("orgA", good) == good["message"].encode()
    receipt_text = receipt.signed_message(1, b"\x11" * 32).decode("latin-1")
    for bad_org, ch in (
        ("orgA", {**good, "message": receipt_text}),
        ("orgA", {**good, "message": "fseal-receipt v1 count=1"}),
        ("orgA", {**good, "message": f"hashwing-key-enroll v1\norgB\n{nonce}"}),
        ("orgB", good),
        ("orgA", {**good, "message": good["message"] + "\n"}),
        ("orgA", {**good, "message": "\n" + good["message"]}),
        ("orgA", {**good, "message": good["message"].replace("v1", "v2")}),
        ("orgA", {"nonce": nonce.upper(), "message": f"hashwing-key-enroll v1\norgA\n{nonce.upper()}"}),
        ("orgA", {"nonce": nonce[:-1], "message": f"hashwing-key-enroll v1\norgA\n{nonce[:-1]}"}),
        ("orgA", {"nonce": nonce + "\n", "message": good["message"] + "\n"}),
        ("orgA", {"nonce": nonce}),
        ("orgA", {"message": good["message"]}),
        ("orgA", {"nonce": 5, "message": good["message"]}),
        ("orgA", {**good, "message": good["message"].encode()}),
        ("", {"nonce": nonce, "message": f"hashwing-key-enroll v1\n\n{nonce}"}),
    ):
        with pytest.raises(ValueError):
            bytes_to_sign(bad_org, ch)


def test_test_helper_enroll_signs_nothing_when_the_server_message_differs():
    app, table, clock = make_app()
    real = app.challenge
    app.challenge = lambda *a: (lambda s, out: (s, {**out, "message": out["message"] + "\n"}))(*real(*a))
    with pytest.raises(ValueError):
        enroll(app, clock)
    assert not any(sk.startswith("KEY#") for _, sk in table.items)


# ------------------------------------------------------------ cross-format

def _challenge_sig(app, clock, seed=SEED_A, org="orgA"):
    ch = call(app, "GET", "/v1/keys/challenge", _admin(clock, org))[1]
    return ed25519.sign(seed, bytes_to_sign(org, ch))


def test_challenge_signature_is_not_a_receipt():
    app, _, clock = make_app()
    enroll(app, clock)
    sig = _challenge_sig(app, clock)
    r = receipt.Receipt(7, b"\x22" * 32, ed25519.public_key(SEED_A), sig)
    assert not receipt.signature_ok(r)
    s, out, _ = register(app, token(clock), receipt.to_line(r))
    assert (s, out) == (422, {"error": "bad_signature"})


def test_receipt_signature_is_not_an_enroll_signature():
    app, table, clock = make_app()
    admin = _admin(clock)
    ch = call(app, "GET", "/v1/keys/challenge", admin)[1]
    r = receipt.parse(line(SEED_A, 3))
    body = {"public_key": ed25519.public_key(SEED_A).hex(), "nonce": ch["nonce"], "signature": r.sig.hex()}
    assert call(app, "POST", "/v1/keys", admin, body)[:2] == (422, {"error": "bad_signature"})
    assert not any(sk.startswith("KEY#") for _, sk in table.items)


@pytest.mark.skipif(fseal_bin() is None, reason="build/fseal missing (cmake --build build)")
def test_fseal_cli_rejects_a_challenge_signature_in_a_receipt(tmp_path):
    seed, lines = fseal_receipts(tmp_path)
    log, rec, pub = tmp_path / "f.fseal", tmp_path / "f.receipts", ed25519.public_key(seed).hex()

    def verify(path):
        return subprocess.run([str(fseal_bin()), "verify", str(log), "--receipts", str(path), "--pubkey", pub],
                              capture_output=True, text=True)

    ok = verify(rec)
    assert ok.returncode == 0, ok.stdout + ok.stderr  # the untouched receipts verify with this key
    app, _, clock = make_app()
    sig = _challenge_sig(app, clock, seed=seed)
    r = receipt.parse(lines[-1])
    swapped = lines[:-1] + [receipt.to_line(r._replace(sig=sig))]
    bad = tmp_path / "swapped.receipts"
    bad.write_text("\n".join(swapped) + "\n")
    v = verify(bad)
    assert v.returncode == 3 and "RESULT: UNVERIFIED" in v.stdout, v.stdout + v.stderr


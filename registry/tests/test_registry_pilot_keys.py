"""Signing Option B, server half (design §4.2, §5, §10 "PR 3"; spine AD-23, AD-24): the PILOT_KEYS_ORGS switch,
/v1/pilot-keys, the register checks, retire, compromise, the key list and restore. One test or more per matrix row."""
import copy
import re

import pytest
from registry_helpers import (SEED_A, SEED_B, T0, App, authorize, call, enroll, line, make_app, pilot_enroll,
                              register, token)

from registry import ed25519, pilot_authorization as pa, receipt
from registry.enroll_challenge import bytes_to_sign
from registry.restore import apply_tombstones
from registry.store import MemoryTable

SEED_C = bytes(range(2, 34))
DAY = 86400
FP = {s: receipt.fingerprint(ed25519.public_key(s)) for s in (SEED_A, SEED_B, SEED_C)}
ON = {"PILOT_KEYS_ORGS": "orgA"}


def _seed(i):
    return bytes([i]) * 32


def _fp(seed):
    return receipt.fingerprint(ed25519.public_key(seed))


def _admin(clock, org="orgA"):
    return token(clock, org=org, role="admin", sub="admin-1")


def _world(**env):
    """orgA on, company key SEED_A enrolled."""
    app, table, clock = make_app(**{**ON, **env})
    assert enroll(app, clock)[0] == 201
    return app, table, clock


def _keys(table):
    return {k: v for k, v in table.items.items() if k[1].startswith(("KEY#", "CHAL#")) or k[1] == "PILOT_COUNT"
            or k[0].startswith("TOMB#")}


def _count(table, org="orgA"):
    return (table.items.get((f"ORG#{org}", "PILOT_COUNT")) or {}).get("n", 0)


def _retire(app, clock, fp, tok=None):
    return call(app, "POST", f"/v1/pilot-keys/{fp}/retire", tok or _admin(clock), {})[:2]


def _no_reg(table):
    return not any(sk.startswith("REG#") for _, sk in table.items)


# ------------------------------------------------------------ switch

@pytest.mark.parametrize("value", [None, "", " ", ",", "*", "orgA ", " orgA", "orgB", "orgA;orgB", "org#A", "*,orgB"])
def test_switch_off_answers_pilot_keys_off_before_schema_and_writes_nothing(value):
    env = {} if value is None else {"PILOT_KEYS_ORGS": value}
    app, table, clock = make_app(**env)
    enroll(app, clock)
    before = copy.deepcopy(table.items)
    for method, path in (("GET", "/v1/pilot-keys/challenge"), ("POST", "/v1/pilot-keys")):
        s, out, _ = call(app, method, path, token(clock), raw="{not json")
        assert (s, out) == (403, {"error": "pilot_keys_off"}), (value, path)
    assert table.items == before
    assert call(app, "GET", "/v1/keys", token(clock))[1]["pilot_keys"] is False


@pytest.mark.parametrize("value", ["orgA", "orgB,orgA", "orgA,,*, orgC"])
def test_switch_on_for_exact_entries(value):
    app, _, clock = make_app(PILOT_KEYS_ORGS=value)
    assert call(app, "GET", "/v1/pilot-keys/challenge", token(clock))[0] == 200
    assert call(app, "GET", "/v1/pilot-keys/challenge", token(clock, org="orgC"))[:2] == (403, {"error": "pilot_keys_off"})


def test_identity_and_role_come_before_the_switch():
    app, _, clock = make_app()
    assert call(app, "GET", "/v1/pilot-keys/challenge")[:2] == (401, {"error": "unauthorized"})
    assert _retire(app, clock, FP[SEED_B], token(clock)) == (403, {"error": "forbidden"})


# ------------------------------------------------------------ challenge

def test_pilot_challenge_for_any_member():
    app, table, clock = make_app(**ON)
    s, ch, _ = call(app, "GET", "/v1/pilot-keys/challenge", token(clock))
    assert s == 200 and set(ch) == {"nonce", "expires_at", "message"} and re.fullmatch(r"[0-9a-f]{32}", ch["nonce"])
    assert ch["message"] == "hashwing-pilot-key-enroll v1\norgA\n" + ch["nonce"]
    assert bytes_to_sign("orgA", ch, "pilot") == ch["message"].encode()
    with pytest.raises(ValueError):
        bytes_to_sign("orgA", ch)  # the company builder refuses a pilot challenge
    item = table.items[("ORG#orgA", "CHAL#" + ch["nonce"])]
    assert (item["kind"], item["sub"], item["expires_at"]) == ("pilot", "pilot-1", clock.t + 300)
    company = call(app, "GET", "/v1/keys/challenge", _admin(clock))[1]
    assert table.items[("ORG#orgA", "CHAL#" + company["nonce"])]["kind"] == "company"


# ------------------------------------------------------------ enroll

def test_pilot_enroll_happy_path():
    app, table, clock = _world()
    s, out, _ = pilot_enroll(app, clock, SEED_B)
    not_after = clock.t + 14 * DAY
    assert (s, out) == (201, {"key_fingerprint": FP[SEED_B], "kind": "pilot", "state": "active",
                              "company_fingerprint": FP[SEED_A], "not_after": pa.iso(not_after)})
    key = table.items[("ORG#orgA", "KEY#" + FP[SEED_B])]
    assert key == {"PK": "ORG#orgA", "SK": "KEY#" + FP[SEED_B], "kind": "pilot", "company_fp": FP[SEED_A],
                   "not_after": not_after, "state": "active", "enrolled_at": clock.t, "enrolled_by": "pilot-1",
                   "changed_at": clock.t}
    tomb = table.items[(f"TOMB#orgA#KEY#{FP[SEED_B]}", "TOMB")]
    assert (tomb["kind"], tomb["key_kind"], tomb["company_fp"], tomb["not_after"], tomb["state"]) == \
        ("key", "pilot", FP[SEED_A], not_after, "active")
    assert _count(table) == 1
    assert not any(sk.startswith("CHAL#") for _, sk in table.items)  # single use
    assert table.items[("ORG#orgA", "ACTIVE_KEY")]["fp"] == FP[SEED_A]  # company keys only
    assert "public_key" not in str(table.items)  # AD-2: no public key stored


def test_company_challenge_cannot_enroll_a_pilot_key():
    app, table, clock = _world()
    tok = token(clock, role="admin", sub="admin-1")
    nonce = call(app, "GET", "/v1/keys/challenge", tok)[1]["nonce"]  # company kind
    pub = ed25519.public_key(SEED_B)
    a, a_sig = authorize(SEED_A, pub, clock.t + 14 * DAY)
    body = {"public_key": pub.hex(), "nonce": nonce, "authorization": a, "authorization_sig": a_sig,
            "signature": ed25519.sign(SEED_B, app.challenge_message("orgA", nonce, "pilot")).hex()}
    before = _keys(table)
    assert call(app, "POST", "/v1/pilot-keys", tok, body)[:2] == (400, {"error": "bad_challenge"})
    assert _keys(table) == before


def test_pilot_challenge_cannot_enroll_a_company_key():
    app, table, clock = make_app(**ON)
    admin = _admin(clock)
    nonce = call(app, "GET", "/v1/pilot-keys/challenge", admin)[1]["nonce"]  # pilot kind, same sub
    body = {"public_key": ed25519.public_key(SEED_A).hex(), "nonce": nonce,
            "signature": ed25519.sign(SEED_A, app.challenge_message("orgA", nonce)).hex()}
    assert call(app, "POST", "/v1/keys", admin, body)[:2] == (400, {"error": "bad_challenge"})
    assert not any(sk.startswith("KEY#") for _, sk in table.items)


def test_company_enroll_still_accepts_a_challenge_without_kind():
    app, table, clock = make_app()
    admin = _admin(clock)
    ch = call(app, "GET", "/v1/keys/challenge", admin)[1]
    del table.items[("ORG#orgA", "CHAL#" + ch["nonce"])]["kind"]  # written before pilot keys existed
    body = {"public_key": ed25519.public_key(SEED_A).hex(), "nonce": ch["nonce"],
            "signature": ed25519.sign(SEED_A, bytes_to_sign("orgA", ch)).hex()}
    assert call(app, "POST", "/v1/keys", admin, body)[0] == 201


def test_other_subs_or_expired_pilot_challenge_is_bad_challenge():
    app, table, clock = _world()
    ch = call(app, "GET", "/v1/pilot-keys/challenge", token(clock, sub="pilot-2"))[1]
    pub = ed25519.public_key(SEED_B)
    a, a_sig = authorize(SEED_A, pub, clock.t + 14 * DAY)
    body = {"public_key": pub.hex(), "nonce": ch["nonce"], "authorization": a, "authorization_sig": a_sig,
            "signature": ed25519.sign(SEED_B, bytes_to_sign("orgA", ch, "pilot")).hex()}
    assert call(app, "POST", "/v1/pilot-keys", token(clock), body)[:2] == (400, {"error": "bad_challenge"})
    clock.t += 301
    assert call(app, "POST", "/v1/pilot-keys", token(clock, sub="pilot-2"), body)[:2] == (400, {"error": "bad_challenge"})
    assert _count(table) == 0


def test_bad_challenge_signature_or_weak_key_is_bad_signature():
    app, table, clock = _world()
    assert pilot_enroll(app, clock, SEED_B, signature="00" * 64)[:2] == (422, {"error": "bad_signature"})
    weak = "01" + "00" * 31
    a, a_sig = authorize(SEED_A, bytes.fromhex(weak), clock.t + DAY)
    assert pilot_enroll(app, clock, SEED_B, public_key=weak, auth=(a, a_sig))[:2] == (422, {"error": "bad_signature"})
    assert _count(table) == 0


@pytest.mark.parametrize("fault", ["unparsable", "padding", "not_pilot_key", "not_by_company_key", "weak_pilot",
                                   "same_key", "sig_not_hex"])
def test_bad_authorization(fault):
    app, table, clock = _world()
    seed, na = SEED_B, clock.t + 14 * DAY
    a, a_sig = authorize(SEED_A, ed25519.public_key(SEED_B), na)
    if fault == "unparsable":
        a = "not an authorization"
    elif fault == "padding":
        a += "=" * (-len(a) % 4) or "=="
    elif fault == "not_pilot_key":
        a, a_sig = authorize(SEED_A, ed25519.public_key(SEED_C), na)
    elif fault == "not_by_company_key":
        text = pa.statement(ed25519.public_key(SEED_B), ed25519.public_key(SEED_A), na)
        a_sig = ed25519.sign(SEED_C, text).hex()
    elif fault == "weak_pilot":
        a, a_sig = authorize(SEED_A, bytes([1]) + bytes(31), na)
    elif fault == "same_key":
        seed = SEED_A
        a, a_sig = authorize(SEED_A, ed25519.public_key(SEED_A), na)
    elif fault == "sig_not_hex":
        a_sig = a_sig.upper()
    before = _keys(table)
    s, out, _ = pilot_enroll(app, clock, seed, auth=(a, a_sig))
    assert (s, out) == (422, {"error": "bad_authorization"})
    assert {k: v for k, v in _keys(table).items() if not k[1].startswith("CHAL#")} == \
        {k: v for k, v in before.items() if not k[1].startswith("CHAL#")}


@pytest.mark.parametrize("offset, ok", [(0, False), (-1, False), (1, True), (14 * DAY, True), (30 * DAY, True),
                                        (30 * DAY + 1, False)])
def test_authorization_time_window(offset, ok):
    """not_after is compared with the registry clock only: it must be in (now, now + 30 days]."""
    app, _, clock = _world()
    s, out, _ = pilot_enroll(app, clock, SEED_B, auth=authorize(SEED_A, ed25519.public_key(SEED_B), clock.t + offset))
    assert (s, out.get("error")) == ((201, None) if ok else (422, "authorization_expired"))


@pytest.mark.parametrize("case", ["rotated", "compromised", "other_org", "none"])
def test_company_key_not_active(case):
    app, table, clock = make_app(**ON)
    company = SEED_A
    if case == "rotated":
        enroll(app, clock)
        enroll(app, clock, seed=SEED_C, confirm=True)
    elif case == "compromised":
        enroll(app, clock)
        call(app, "POST", f"/v1/keys/{FP[SEED_A]}/compromised", _admin(clock), {})
    elif case == "other_org":
        enroll(app, clock, seed=SEED_C)
        enroll(app, clock, org="orgB")  # SEED_A is orgB's active key, not orgA's
    s, out, _ = pilot_enroll(app, clock, SEED_B, company_seed=company)
    assert (s, out) == (422, {"error": "company_key_not_active"})
    assert ("ORG#orgA", "KEY#" + FP[SEED_B]) not in table.items


def test_company_key_replaced_during_the_enroll_transaction():
    app, table, clock = _world()
    real = table.transact

    def racing(ops):
        table.transact = real
        assert enroll(app, clock, seed=SEED_C, confirm=True)[0] == 201
        return real(ops)

    table.transact = racing
    assert pilot_enroll(app, clock, SEED_B)[:2] == (422, {"error": "company_key_not_active"})
    assert ("ORG#orgA", "KEY#" + FP[SEED_B]) not in table.items and _count(table) == 0


def test_duplicate_fingerprint_any_state_is_key_exists_only_after_both_signatures():
    app, table, clock = _world()
    assert pilot_enroll(app, clock, SEED_B)[0] == 201
    assert _retire(app, clock, FP[SEED_B])[0] == 200
    assert pilot_enroll(app, clock, SEED_B)[:2] == (409, {"error": "key_exists"})  # a retired key never returns
    assert pilot_enroll(app, clock, SEED_B, signature="00" * 64)[:2] == (422, {"error": "bad_signature"})
    assert pilot_enroll(app, clock, SEED_B, authorization="x")[:2] == (422, {"error": "bad_authorization"})
    # A rotated company key cannot come back as a pilot key either.
    enroll(app, clock, seed=SEED_C, confirm=True)
    assert pilot_enroll(app, clock, SEED_A, company_seed=SEED_C)[:2] == (409, {"error": "key_exists"})
    assert _count(table) == 0


def test_pilot_key_limit():
    app, table, clock = _world()
    table.items[("ORG#orgA", "PILOT_COUNT")] = {"PK": "ORG#orgA", "SK": "PILOT_COUNT", "n": 50}
    assert pilot_enroll(app, clock, SEED_B)[:2] == (409, {"error": "pilot_key_limit"})
    assert ("ORG#orgA", "KEY#" + FP[SEED_B]) not in table.items and _count(table) == 50
    table.items[("ORG#orgA", "PILOT_COUNT")]["n"] = 49
    assert pilot_enroll(app, clock, SEED_B)[0] == 201 and _count(table) == 50


def test_racing_enrolls_never_pass_the_cap():
    app, table, clock = _world()
    table.items[("ORG#orgA", "PILOT_COUNT")] = {"PK": "ORG#orgA", "SK": "PILOT_COUNT", "n": 49}
    real, inner = table.transact, []

    def racing(ops):  # the second enroll commits between the first one's reads and its transaction
        table.transact = real
        inner.append(pilot_enroll(app, clock, SEED_C, sub="pilot-2")[:2])
        return real(ops)

    table.transact = racing
    outer = pilot_enroll(app, clock, SEED_B)[:2]
    assert inner[0][0] == 201 and outer == (409, {"error": "pilot_key_limit"})
    assert _count(table) == 50
    assert ("ORG#orgA", "KEY#" + FP[SEED_B]) not in table.items


def test_fifty_real_enrolls_then_the_limit():
    app, table, clock = _world()
    for i in range(50):
        assert pilot_enroll(app, clock, _seed(100 + i))[0] == 201
    assert pilot_enroll(app, clock, _seed(200))[:2] == (409, {"error": "pilot_key_limit"})
    assert _retire(app, clock, _fp(_seed(100)))[0] == 200
    assert pilot_enroll(app, clock, _seed(200))[0] == 201 and _count(table) == 50


# ------------------------------------------------------------ register

def test_register_with_an_active_pilot_key():
    app, table, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    s, out, _ = register(app, token(clock), line(SEED_B, 3))
    assert s == 201 and out["key_fingerprint"] == FP[SEED_B]


def _refuse(case, app, table, clock):
    if case == "org_off":
        return App(table, {**app.env, "PILOT_KEYS_ORGS": ""}, clock)
    if case == "retired":
        assert _retire(app, clock, FP[SEED_B])[0] == 200
    elif case == "compromised":
        assert call(app, "POST", f"/v1/keys/{FP[SEED_B]}/compromised", _admin(clock), {})[0] == 200
    elif case == "ended":
        clock.t += 14 * DAY
    elif case == "parent_rotated":
        assert enroll(app, clock, seed=SEED_C, confirm=True)[0] == 201
    elif case == "parent_compromised":
        assert call(app, "POST", f"/v1/keys/{FP[SEED_A]}/compromised", _admin(clock), {})[0] == 200
    elif case == "no_parent":
        del table.items[("ORG#orgA", "KEY#" + FP[SEED_B])]["company_fp"]
    return app


@pytest.mark.parametrize("case", ["org_off", "retired", "compromised", "ended", "parent_rotated",
                                  "parent_compromised", "no_parent"])
def test_register_refuses_a_pilot_key_that_is_not_usable(case):
    app, table, clock = _world()
    assert pilot_enroll(app, clock, SEED_B)[0] == 201
    app = _refuse(case, app, table, clock)
    s, out, _ = register(app, token(clock), line(SEED_B, 3))
    assert (s, out) == (403, {"error": "key_not_active"})
    assert _no_reg(table)


def test_register_still_works_one_second_before_not_after():
    app, table, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    clock.t += 14 * DAY - 1
    assert register(app, token(clock), line(SEED_B, 3))[0] == 201


@pytest.mark.parametrize("change", ["retire", "compromise", "parent_rotated", "parent_compromised", "not_after"])
def test_change_committed_during_registration_blocks_it(change):
    app, table, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    tok = token(clock)
    real = table.transact

    def racing(ops):  # the change commits between register's reads and its transaction
        if any(op["op"] == "put" and op["item"]["SK"].startswith("REG#") for op in ops):
            table.transact = real
            if change == "retire":
                assert _retire(app, clock, FP[SEED_B])[0] == 200
            elif change == "compromise":
                assert call(app, "POST", f"/v1/keys/{FP[SEED_B]}/compromised", _admin(clock), {})[0] == 200
            elif change == "parent_rotated":
                assert enroll(app, clock, seed=SEED_C, confirm=True)[0] == 201
            elif change == "not_after":  # only the in-transaction `not_after > now` condition can catch this
                table.items[("ORG#orgA", "KEY#" + FP[SEED_B])]["not_after"] = clock.t
            else:
                assert call(app, "POST", f"/v1/keys/{FP[SEED_A]}/compromised", _admin(clock), {})[0] == 200
        return real(ops)

    table.transact = racing
    s, out, _ = register(app, tok, line(SEED_B, 3))
    assert (s, out) == (403, {"error": "key_not_active"})
    assert _no_reg(table)


@pytest.mark.parametrize("env", [{}, {"PILOT_KEYS_ORGS": ""}, ON])
def test_company_key_register_is_exactly_as_before_whatever_the_switch(env):
    """Switch off (unset or empty) or on: a company-key registration sends the same four-item transaction as before
    Option B (REG, IDEM, QUOTA, KEY check on state only) and gets the same ack."""
    app, table, clock = make_app(**env)
    assert enroll(app, clock)[0] == 201
    real, sent = table.transact, []
    table.transact = lambda ops: (sent.append(copy.deepcopy(ops)), real(ops))[1]
    s, ack, _ = register(app, token(clock), line(SEED_A, 3))
    assert s == 201 and set(ack) == {"registration_id", "received_at", "count", "head", "key_fingerprint",
                                     "disposition"}
    [ops] = [o for o in sent if any(op["op"] == "put" and op["item"]["SK"].startswith("REG#") for op in o)]
    assert [op["op"] for op in ops] == ["put", "put", "update", "check"]
    assert ops[3] == {"op": "check", "key": ("ORG#orgA", "KEY#" + FP[SEED_A]), "cond": [("eq", "state", "active")]}


def test_authorization_from_one_org_is_refused_in_another():
    """An authorization names no org: it is bound to the org whose ACTIVE_KEY signed it, and to one pilot key."""
    app, table, clock = make_app(PILOT_KEYS_ORGS="orgA,orgB")
    assert enroll(app, clock)[0] == 201  # orgA: SEED_A
    assert enroll(app, clock, seed=SEED_C, org="orgB")[0] == 201  # orgB: SEED_C
    auth = authorize(SEED_A, ed25519.public_key(SEED_B), clock.t + 14 * DAY)
    assert pilot_enroll(app, clock, SEED_B, org="orgB", auth=auth)[:2] == (422, {"error": "company_key_not_active"})
    assert pilot_enroll(app, clock, _seed(9), auth=auth)[:2] == (422, {"error": "bad_authorization"})  # other pilot
    assert pilot_enroll(app, clock, SEED_B, auth=auth)[0] == 201


def test_company_key_register_path_is_unchanged_with_the_switch_on():
    app, table, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    assert register(app, token(clock), line(SEED_A, 3))[0] == 201


# ------------------------------------------------------------ retire

def test_retire():
    app, table, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    clock.t += 60
    assert _retire(app, clock, FP[SEED_B]) == (200, {"key_fingerprint": FP[SEED_B], "state": "retired",
                                                     "changed_at": pa.iso(clock.t)})
    key = table.items[("ORG#orgA", "KEY#" + FP[SEED_B])]
    assert (key["state"], key["changed_at"], key["kind"]) == ("retired", clock.t, "pilot")
    tomb = table.items[(f"TOMB#orgA#KEY#{FP[SEED_B]}", "TOMB")]
    assert (tomb["state"], tomb["key_kind"], tomb["company_fp"], tomb["enrolled_by"]) == \
        ("retired", "pilot", FP[SEED_A], "pilot-1")
    assert _count(table) == 0
    first = _retire(app, clock, FP[SEED_B])
    before = copy.deepcopy(table.items)
    clock.t += 60
    assert _retire(app, clock, FP[SEED_B]) == first and table.items == before  # no write
    # Compromise after retire: no second decrement.
    assert call(app, "POST", f"/v1/keys/{FP[SEED_B]}/compromised", _admin(clock), {})[0] == 200
    assert _count(table) == 0
    assert _retire(app, clock, FP[SEED_B]) == (200, {"key_fingerprint": FP[SEED_B], "state": "compromised",
                                                     "changed_at": pa.iso(clock.t)})


def test_retire_unknown_other_org_or_company_key_is_404_and_member_is_403():
    app, table, clock = make_app(PILOT_KEYS_ORGS="orgA,orgB")
    enroll(app, clock)
    enroll(app, clock, seed=SEED_C, org="orgB")
    pilot_enroll(app, clock, SEED_B, company_seed=SEED_C, org="orgB")
    for fp in (_fp(_seed(9)), FP[SEED_B], FP[SEED_A]):  # unknown; orgB's pilot; orgA's company key
        assert _retire(app, clock, fp) == (404, {"error": "not_found"})
    pilot_enroll(app, clock, _seed(9))
    before = copy.deepcopy(table.items)
    assert _retire(app, clock, _fp(_seed(9)), token(clock)) == (403, {"error": "forbidden"})
    assert table.items == before


def test_retire_racing_a_compromise_reports_the_winner():
    app, table, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    real = table.transact

    def racing(ops):
        table.transact = real
        assert call(app, "POST", f"/v1/keys/{FP[SEED_B]}/compromised", _admin(clock), {})[0] == 200
        return real(ops)

    table.transact = racing
    clock.t += 5
    assert _retire(app, clock, FP[SEED_B])[1]["state"] == "compromised"
    assert _count(table) == 0


# ------------------------------------------------------------ compromise, list

def test_compromise_of_an_active_pilot_key():
    app, table, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    pilot_enroll(app, clock, SEED_C)
    clock.t += 60
    s, out, _ = call(app, "POST", f"/v1/keys/{FP[SEED_B]}/compromised", _admin(clock), {})
    assert (s, out) == (200, {"key_fingerprint": FP[SEED_B], "state": "compromised", "changed_at": pa.iso(clock.t)})
    tomb = table.items[(f"TOMB#orgA#KEY#{FP[SEED_B]}", "TOMB")]
    assert (tomb["state"], tomb["key_kind"], tomb["company_fp"], tomb["not_after"]) == \
        ("compromised", "pilot", FP[SEED_A], T0 + 14 * DAY)
    assert _count(table) == 1
    assert table.items[("ORG#orgA", "ACTIVE_KEY")]["fp"] == FP[SEED_A]
    assert call(app, "POST", f"/v1/keys/{FP[SEED_B]}/compromised", _admin(clock), {})[0] == 200
    assert _count(table) == 1  # idempotent: no second decrement


def test_company_key_tombstones_carry_their_kind():
    app, table, clock = _world()
    enroll(app, clock, seed=SEED_C, confirm=True)
    for fp in (FP[SEED_A], FP[SEED_C]):
        tomb = table.items[(f"TOMB#orgA#KEY#{fp}", "TOMB")]
        assert tomb["key_kind"] == "company" and "company_fp" not in tomb and "not_after" not in tomb


def test_list_keys_shows_kind_and_pilot_fields():
    app, _, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    s, out, _ = call(app, "GET", "/v1/keys", token(clock))
    assert s == 200 and out["pilot_keys"] is True and out["active_key"] == FP[SEED_A]
    rows = {r["key_fingerprint"]: r for r in out["keys"]}
    assert set(rows[FP[SEED_A]]) == {"key_fingerprint", "kind", "state", "enrolled_at", "changed_at", "enrolled_by_me"}
    assert rows[FP[SEED_A]]["kind"] == "company"
    assert rows[FP[SEED_B]] == {"key_fingerprint": FP[SEED_B], "kind": "pilot", "state": "active",
                                "enrolled_by_me": True, "enrolled_at": pa.iso(T0), "changed_at": pa.iso(T0),
                                "company_fingerprint": FP[SEED_A], "not_after": pa.iso(T0 + 14 * DAY)}


# ------------------------------------------------------------ store guard

def test_memory_table_refuses_a_transaction_naming_an_item_twice():
    t = MemoryTable()
    with pytest.raises(ValueError):
        t.transact([{"op": "put", "item": {"PK": "a", "SK": "b"}}, {"op": "check", "key": ("a", "b"), "cond": []}])
    assert t.items == {}


# ------------------------------------------------------------ restore

def _restore(live, backup):
    return apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live")


def test_restore_keeps_pilot_keys_and_recomputes_active_key_and_count():
    app, live, clock = _world()
    pilot_enroll(app, clock, _seed(50))  # in the backup
    backup = MemoryTable()
    backup.items = copy.deepcopy(live.items)
    for i in (51, 52, 53):
        assert pilot_enroll(app, clock, _seed(i))[0] == 201
    clock.t += 60
    assert _retire(app, clock, _fp(_seed(52)))[0] == 200
    assert enroll(app, clock, seed=SEED_C, confirm=True)[0] == 201  # company rotation
    _restore(live, backup)
    assert backup.items[("ORG#orgA", "ACTIVE_KEY")]["fp"] == FP[SEED_C]
    assert backup.items[("ORG#orgA", "KEY#" + FP[SEED_A])]["state"] == "rotated"
    for i, state in ((50, "active"), (51, "active"), (52, "retired"), (53, "active")):
        key = backup.items[("ORG#orgA", "KEY#" + _fp(_seed(i)))]
        assert (key["state"], key["kind"], key["company_fp"], key["not_after"]) == \
            (state, "pilot", FP[SEED_A], T0 + 14 * DAY), i
    assert _count(backup) == 3
    restored = App(backup, {**app.env, "RESTORED_FROM": "live", "RESTORE_ID": "r1", "TABLE_NAME": "restored"}, clock)
    rows = {r["key_fingerprint"]: r for r in call(restored, "GET", "/v1/keys", token(clock))[1]["keys"]}
    assert rows[_fp(_seed(53))]["kind"] == "pilot"
    # A retired pilot key stays retired after restore, so its authorization can't be replayed.
    assert pilot_enroll(restored, clock, _seed(52), company_seed=SEED_C)[:2] == (409, {"error": "key_exists"})


def test_restore_merge_order_most_revoked_wins():
    app, live, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    pilot_enroll(app, clock, SEED_C)
    backup = MemoryTable()
    backup.items = copy.deepcopy(live.items)
    backup.items[("ORG#orgA", "KEY#" + FP[SEED_B])]["state"] = "retired"  # the target is ahead of its tombstone
    clock.t += 60
    _retire(app, clock, FP[SEED_C])
    _restore(live, backup)
    assert backup.items[("ORG#orgA", "KEY#" + FP[SEED_B])]["state"] == "retired"
    assert backup.items[("ORG#orgA", "KEY#" + FP[SEED_C])]["state"] == "retired"
    assert _count(backup) == 0


@pytest.mark.parametrize("where", ["tomb", "key"])
def test_restore_refuses_a_kind_disagreement_and_keeps_the_gate_closed(where):
    app, live, clock = _world()
    pilot_enroll(app, clock, SEED_B)
    backup = MemoryTable()
    backup.items = copy.deepcopy(live.items)
    if where == "tomb":  # the tombstone says company, the key item says pilot
        tomb = live.items[(f"TOMB#orgA#KEY#{FP[SEED_B]}", "TOMB")]
        for f in ("company_fp", "not_after"):
            del tomb[f]
        tomb["key_kind"] = "company"
    else:  # the key item in the backup says company, the tombstone says pilot
        key = backup.items[("ORG#orgA", "KEY#" + FP[SEED_B])]
        for f in ("company_fp", "not_after"):
            del key[f]
        key["kind"] = "company"
    with pytest.raises(ValueError):
        _restore(live, backup)
    assert ("SYSTEM", "RESTORE") not in backup.items


# ------------------------------------------------------------ slots: only usable pilot keys hold one (design §4.2)

def _active_pilots(table, org="orgA"):
    return sum(1 for (pk, sk), v in table.items.items() if pk == f"ORG#{org}" and sk.startswith("KEY#")
               and v.get("kind") == "pilot" and v["state"] == "active")


def _invariant(table, org="orgA"):
    """PILOT_COUNT.n is exactly the number of active pilot keys, after every operation."""
    assert _count(table, org) == _active_pilots(table, org)
    return _count(table, org)


def _state(table, seed):
    return table.items[("ORG#orgA", "KEY#" + _fp(seed))]["state"]


def _fill(app, clock, seeds, days=14, company_seed=SEED_A):
    for s in seeds:
        assert pilot_enroll(app, clock, s, days=days, company_seed=company_seed)[0] == 201


FULL = [_seed(100 + i) for i in range(50)]
EXPIRED = FULL[0]


def _at_cap_with_one_ended(app, clock):
    """50 active pilot keys: FULL[0]'s authorization has ended (1 day), the other 49 are still usable."""
    _fill(app, clock, FULL[:1], days=1)
    _fill(app, clock, FULL[1:])
    clock.t += DAY


def _key_and_tomb_items(table):
    return {k: v for k, v in _keys(table).items() if not k[1].startswith("CHAL#")}


def test_renewal_cycles_never_fill_the_cap():
    """10 pilots each renew with a new key every 14 days for 8 cycles (80 keys): every enroll succeeds."""
    app, table, clock = _world()
    seeds = []
    for cycle in range(8):
        for p in range(10):
            seed = _seed(100 + cycle * 10 + p)
            assert pilot_enroll(app, clock, seed, sub=f"pilot-{p}")[0] == 201, (cycle, p)
            seeds.append(seed)
            assert _invariant(table) <= 50
        clock.t += 14 * DAY  # this cycle's keys have now ended (not_after == registry clock)
    retired = [s for s in seeds if _state(table, s) == "retired"]
    assert retired == seeds[:50]  # the first enroll past the cap freed every ended key, and only those
    for s in retired:
        tomb = table.items[(f"TOMB#orgA#KEY#{_fp(s)}", "TOMB")]
        key = table.items[("ORG#orgA", "KEY#" + _fp(s))]
        assert (tomb["state"], tomb["key_kind"], tomb["not_after"]) == ("retired", "pilot", key["not_after"])
        assert key["not_after"] <= key["changed_at"]  # retired only once its authorization had ended
    assert _invariant(table) == 30


def test_fifty_usable_keys_hold_the_cap_and_nothing_is_retired():
    app, table, clock = _world()
    _fill(app, clock, FULL)
    clock.t += 14 * DAY - 1  # one second before they end: all still usable
    before = _key_and_tomb_items(table)
    assert pilot_enroll(app, clock, _seed(200))[:2] == (409, {"error": "pilot_key_limit"})
    assert _key_and_tomb_items(table) == before
    assert _invariant(table) == 50


def test_an_ended_key_frees_its_slot():
    app, table, clock = _world()
    _at_cap_with_one_ended(app, clock)
    assert pilot_enroll(app, clock, _seed(200))[0] == 201
    assert _state(table, EXPIRED) == "retired"
    assert table.items[("ORG#orgA", "KEY#" + _fp(EXPIRED))]["changed_at"] == clock.t
    assert table.items[("ORG#orgA", "KEY#" + _fp(EXPIRED))]["not_after"] == T0 + DAY  # never changed
    tomb = table.items[(f"TOMB#orgA#KEY#{_fp(EXPIRED)}", "TOMB")]
    assert (tomb["state"], tomb["at"], tomb["company_fp"]) == ("retired", clock.t, FP[SEED_A])
    assert all(_state(table, s) == "active" for s in FULL[1:])
    assert _invariant(table) == 50


@pytest.mark.parametrize("change", ["rotated", "compromised"])
def test_a_replaced_or_compromised_company_key_frees_its_pilots_slots(change):
    app, table, clock = _world()
    _fill(app, clock, FULL)
    if change == "rotated":
        assert enroll(app, clock, seed=SEED_C, confirm=True)[0] == 201
    else:
        assert call(app, "POST", f"/v1/keys/{FP[SEED_A]}/compromised", _admin(clock), {})[0] == 200
        assert enroll(app, clock, seed=SEED_C)[0] == 201
    assert pilot_enroll(app, clock, _seed(200), company_seed=SEED_C)[0] == 201
    assert all(_state(table, s) == "retired" for s in FULL)
    assert _state(table, _seed(200)) == "active"
    assert _invariant(table) == 1


def test_a_reclaimed_key_never_comes_back():
    app, table, clock = _world()
    _at_cap_with_one_ended(app, clock)
    assert pilot_enroll(app, clock, _seed(200))[0] == 201
    assert pilot_enroll(app, clock, EXPIRED)[:2] == (409, {"error": "key_exists"})
    assert register(app, token(clock), line(EXPIRED, 3))[:2] == (403, {"error": "key_not_active"})
    assert _no_reg(table) and _invariant(table) == 50


@pytest.mark.parametrize("where", ["enroll", "reclaim"])
def test_racing_enrolls_at_the_cap_take_one_freed_slot(where):
    """49 usable + 1 ended. The second enroll commits between the first one's reads and its enroll (or its reclaim)
    transaction: exactly one of them gets the freed slot."""
    app, table, clock = _world()
    _at_cap_with_one_ended(app, clock)
    real, inner = table.transact, []

    def racing(ops):
        hit = ops[0]["op"] == "delete" if where == "enroll" else ops[0].get("set", {}).get("state") == "retired"
        if hit:
            table.transact = real
            inner.append(pilot_enroll(app, clock, _seed(201), sub="pilot-2")[:2])
        return real(ops)

    table.transact = racing
    outer = pilot_enroll(app, clock, _seed(200))[:2]
    assert inner[0][0] == 201 and outer == (409, {"error": "pilot_key_limit"})
    assert ("ORG#orgA", "KEY#" + _fp(_seed(200))) not in table.items
    assert _state(table, EXPIRED) == "retired"
    assert _invariant(table) == 50


@pytest.mark.parametrize("admin", ["retire", "compromise"])
def test_an_admin_change_committed_during_a_reclaim_decrements_once(admin):
    app, table, clock = _world()
    _at_cap_with_one_ended(app, clock)
    real, answers = table.transact, []
    fp = _fp(EXPIRED)

    def racing(ops):  # the admin's change commits between the reclaim's read and its transaction
        if ops[0]["key"] == ("ORG#orgA", "KEY#" + fp) and ops[0].get("set", {}).get("state") == "retired":
            table.transact = real
            if admin == "retire":
                answers.append(_retire(app, clock, fp))
            else:
                answers.append(call(app, "POST", f"/v1/keys/{fp}/compromised", _admin(clock), {})[:2])
        return real(ops)

    table.transact = racing
    assert pilot_enroll(app, clock, _seed(200))[0] == 201
    state = "retired" if admin == "retire" else "compromised"
    assert answers == [(200, {"key_fingerprint": fp, "state": state, "changed_at": pa.iso(clock.t)})]
    assert _state(table, EXPIRED) == state
    assert _invariant(table) == 50


def test_a_reclaim_committed_during_a_compromise_never_refuses_it():
    app, table, clock = _world()
    _at_cap_with_one_ended(app, clock)
    real, enrolled = table.transact, []
    fp = _fp(EXPIRED)

    def racing(ops):  # the reclaim (another pilot's enroll) commits between the compromise's read and its transaction
        if ops[0].get("set", {}).get("state") == "compromised":
            table.transact = real
            enrolled.append(pilot_enroll(app, clock, _seed(200))[0])
        return real(ops)

    table.transact = racing
    s, out, _ = call(app, "POST", f"/v1/keys/{fp}/compromised", _admin(clock), {})
    assert (s, out) == (200, {"key_fingerprint": fp, "state": "compromised", "changed_at": pa.iso(clock.t)})
    assert enrolled == [201]
    assert _state(table, EXPIRED) == "compromised"
    assert table.items[(f"TOMB#orgA#KEY#{fp}", "TOMB")]["state"] == "compromised"
    assert _invariant(table) == 50


@pytest.mark.parametrize("value", [None, ""])
def test_switch_off_retire_still_works_and_switching_off_frees_nothing(value):
    app, table, clock = _world()
    _fill(app, clock, FULL)
    clock.t += 15 * DAY  # every key has ended, but nothing enrolls while the org is off
    off = App(table, {k: v for k, v in {**app.env, "PILOT_KEYS_ORGS": value}.items() if v is not None}, clock)
    for method, path in (("GET", "/v1/pilot-keys/challenge"), ("POST", "/v1/pilot-keys")):
        assert call(off, method, path, token(clock), {})[:2] == (403, {"error": "pilot_keys_off"})
    assert all(_state(table, s) == "active" for s in FULL) and _invariant(table) == 50
    assert _retire(off, clock, _fp(FULL[0])) == (200, {"key_fingerprint": _fp(FULL[0]), "state": "retired",
                                                       "changed_at": pa.iso(clock.t)})
    assert _retire(off, clock, _fp(_seed(9))) == (404, {"error": "not_found"})
    assert all(_state(table, s) == "active" for s in FULL[1:])
    assert _invariant(table) == 49


# ------------------------------------------------------------ restore: items written before pilot keys existed

def test_restore_of_pre_pilot_key_items_and_tombstones_reads_them_as_company_keys():
    """The shapes written before PR #60 merged (467cd91^1, and 537b937 for the stateless compromise tombstone): KEY
    items without `kind`, tombstones without `key_kind`. A in the backup and replaced after it; B in the backup and
    compromised after it (a tombstone with no `state`); C enrolled after the backup (absent from it)."""
    app, _, clock = make_app()
    live, backup, t0 = MemoryTable(), MemoryTable(), T0 - 10 * DAY
    for table in (live, backup):
        table.items = {
            ("ORG#orgA", "KEY#" + FP[SEED_A]): {"PK": "ORG#orgA", "SK": "KEY#" + FP[SEED_A], "state": "active",
                                                 "enrolled_at": t0, "enrolled_by": "admin-1", "changed_at": t0},
            ("ORG#orgA", "KEY#" + FP[SEED_B]): {"PK": "ORG#orgA", "SK": "KEY#" + FP[SEED_B], "state": "rotated",
                                                 "enrolled_at": t0 - DAY, "enrolled_by": "admin-1", "changed_at": t0},
            ("ORG#orgA", "ACTIVE_KEY"): {"PK": "ORG#orgA", "SK": "ACTIVE_KEY", "fp": FP[SEED_A]},
        }

    def tomb(fp, **fields):
        live.items[(f"TOMB#orgA#KEY#{fp}", "TOMB")] = {"PK": f"TOMB#orgA#KEY#{fp}", "SK": "TOMB", "kind": "key",
                                                        "org": "orgA", "ref": fp, **fields}

    tomb(FP[SEED_B], at=t0 + DAY)  # 537b937: compromise, no state
    tomb(FP[SEED_C], state="active", at=t0 + 2 * DAY, enrolled_at=t0 + 2 * DAY, enrolled_by="admin-2")
    tomb(FP[SEED_A], state="rotated", at=t0 + 2 * DAY)
    live.items[("ORG#orgA", "KEY#" + FP[SEED_C])] = {"PK": "ORG#orgA", "SK": "KEY#" + FP[SEED_C], "state": "active",
                                                      "enrolled_at": t0 + 2 * DAY, "enrolled_by": "admin-2",
                                                      "changed_at": t0 + 2 * DAY}
    assert _restore(live, backup) == 3
    assert backup.items[("SYSTEM", "RESTORE")]["restore_id"] == "r1"
    keys = {sk[4:]: v for (pk, sk), v in backup.items.items() if sk.startswith("KEY#")}
    assert {fp: (k["kind"], k["state"]) for fp, k in keys.items()} == {
        FP[SEED_A]: ("company", "rotated"), FP[SEED_B]: ("company", "compromised"), FP[SEED_C]: ("company", "active")}
    assert not any("company_fp" in k or "not_after" in k for k in keys.values())
    assert keys[FP[SEED_C]]["enrolled_by"] == "admin-2"
    assert backup.items[("ORG#orgA", "ACTIVE_KEY")]["fp"] == FP[SEED_C]
    assert _count(backup) == 0
    restored = App(backup, {**app.env, "RESTORED_FROM": "live", "RESTORE_ID": "r1", "TABLE_NAME": "restored"}, clock)
    s, out, _ = call(restored, "GET", "/v1/keys", token(clock))
    assert s == 200 and out["active_key"] == FP[SEED_C] and {r["kind"] for r in out["keys"]} == {"company"}
    assert register(restored, token(clock), line(SEED_C, 3))[0] == 201
    assert register(restored, token(clock), line(SEED_A, 4), idem="idem-key-0000000002")[:2] == \
        (403, {"error": "key_not_active"})


def test_compromise_of_a_pilot_key_gives_up_with_409_when_every_attempt_races():
    app, table, clock = _world()
    assert pilot_enroll(app, clock, SEED_B)[0] == 201
    real, flips = table.transact, iter(["retired", "active"])

    def racing(ops):  # each attempt loses to another change of state (not to a compromise)
        table.items[("ORG#orgA", "KEY#" + FP[SEED_B])]["state"] = next(flips)
        return real(ops)

    table.transact = racing
    s, out, _ = call(app, "POST", f"/v1/keys/{FP[SEED_B]}/compromised", _admin(clock), {})
    assert (s, out) == (409, {"error": "conflict"})
    assert table.items[("ORG#orgA", "KEY#" + FP[SEED_B])]["state"] == "active"  # both attempts were read and retried

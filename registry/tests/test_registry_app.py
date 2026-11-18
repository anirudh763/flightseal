"""One test (or more) per row of the plan's I/O and edge-case matrix, over MemoryTable and an injected clock."""
import base64
import json

from registry_helpers import (SEED_A, SEED_B, call, enroll, envelope, line, make_app, register, share, token)

from registry import ed25519, receipt
from registry.store import MemoryTable

ACK = {"registration_id", "received_at", "count", "head", "key_fingerprint", "disposition"}


def setup(**env):
    app, table, clock = make_app(**env)
    assert enroll(app, clock)[0] == 201
    return app, table, clock, token(clock)


def regs(table):
    return [k for k in table.items if k[1].startswith("REG#")]


def test_authorized_register():
    app, table, clock, pilot = setup()
    s, out, _ = register(app, pilot, line(SEED_A, 5))
    assert s == 201 and set(out) == ACK and out["disposition"] == "active" and out["count"] == 5
    assert len(regs(table)) == 1


def test_register_accepts_rest_v1_and_base64_events():
    app, _, clock, pilot = setup()
    env_id = envelope(app, pilot)
    body = json.dumps({"receipt": line(SEED_A, 5), "idempotency_key": "idem-key-0000000001", "envelope_id": env_id})
    event = {"httpMethod": "POST", "path": "/v1/registrations", "headers": {"AUTHORIZATION": f"Bearer {pilot}"},
             "body": base64.b64encode(body.encode()).decode(), "isBase64Encoded": True}
    assert app.handle(event)["statusCode"] == 201


def test_wrong_org_gets_403_and_writes_nothing():
    app, table, clock, _ = setup()
    other = token(clock, org="orgB")
    s, out, _ = register(app, other, line(SEED_A, 5))
    assert (s, out["error"]) == (403, "key_not_enrolled")
    assert regs(table) == [] and not [k for k in table.items if k[1].startswith(("IDEM#", "QUOTA#"))]


def test_unexpected_fields_are_400_and_write_nothing():
    app, table, clock, pilot = setup()
    env_id = envelope(app, pilot)
    for extra in ({"org_id": "orgA"}, {"filename": "f.ulg"}, {"manifest": []}, {"gps": 1}):
        body = {"receipt": line(SEED_A, 5), "idempotency_key": "idem-key-0000000001", "envelope_id": env_id, **extra}
        s, out, _ = call(app, "POST", "/v1/registrations", pilot, body)
        assert (s, out["error"]) == (400, "unexpected_field")
    assert regs(table) == []
    s, out, _ = call(app, "POST", "/v1/registrations", pilot, raw='{"receipt":"a","receipt":"b"}')
    assert (s, out["error"]) == (400, "bad_json")


def test_no_route_accepts_private_key_material():
    # R71: an invitation or enrollment never moves a company private key; every POST route refuses one.
    app, table, clock, pilot = setup()
    admin = token(clock, role="admin", sub="admin-1")
    before = dict(table.items)
    for field in ("private_key", "privateKeyPem", "seed"):
        secret = {field: SEED_B.hex()}
        for path, tok, body in (
                ("/v1/envelopes", pilot, {}), ("/v1/epoch", admin, {}), (f"/v1/keys/{'ab' * 32}/compromised", admin, {}),
                ("/v1/keys", admin, {"public_key": "00" * 32, "nonce": "n", "signature": "00" * 64}),
                ("/v1/registrations", pilot, {"receipt": "r", "idempotency_key": "idem-key-0000000001", "envelope_id": "e"}),
                ("/v1/shares", pilot, {"registration_id": "0" * 32, "token_hash": "0" * 64,
                                       "idempotency_key": "idem-key-0000000001"})):
            s, out, _ = call(app, "POST", path, tok, {**body, **secret})
            assert (s, out["error"]) == (400, "unexpected_field"), (path, field)
    assert table.items == before


def test_malformed_receipt_is_400():
    app, _, _, pilot = setup()
    s, out, _ = register(app, pilot, line(SEED_A, 5) + " extra")
    assert (s, out["error"]) == (400, "bad_receipt")


def test_bad_signature_is_422():
    app, _, _, pilot = setup()
    good = line(SEED_A, 5)
    sig = good.split("sig=")[1]
    bad = good.replace("sig=" + sig, "sig=" + sig[:-1] + ("0" if sig[-1] != "0" else "1"))
    s, out, _ = register(app, pilot, bad)
    assert (s, out["error"]) == (422, "bad_signature")
    s, out, _ = register(app, pilot, good.replace("count=5", "count=6"), idem="idem-key-0000000002")
    assert (s, out["error"]) == (422, "bad_signature")


def test_unenrolled_rotated_and_compromised_keys():
    app, _, clock, pilot = setup()
    assert register(app, pilot, line(SEED_B, 1))[1]["error"] == "key_not_enrolled"
    assert enroll(app, clock, seed=SEED_B, confirm=True)[0] == 201  # rotates key A
    s, out, _ = register(app, pilot, line(SEED_A, 1), idem="idem-key-0000000002")
    assert (s, out["error"]) == (403, "key_not_active")
    admin = token(clock, role="admin")
    fp_b = receipt.fingerprint(ed25519.public_key(SEED_B))
    assert call(app, "POST", f"/v1/keys/{fp_b}/compromised", admin, {})[0] == 200
    s, out, _ = register(app, pilot, line(SEED_B, 1), idem="idem-key-0000000003")
    assert (s, out["error"]) == (403, "key_not_active")
    states = {k["key_fingerprint"]: k["state"] for k in call(app, "GET", "/v1/keys", pilot)[1]["keys"]}
    assert sorted(states.values()) == ["compromised", "rotated"]


def test_identical_retry_and_lost_ack_return_the_original():
    app, table, clock, pilot = setup(REG_QUOTA_PER_MONTH=5)
    env_id = envelope(app, pilot)
    s1, first, _ = register(app, pilot, line(SEED_A, 5), env_id=env_id)  # "lost": the client never saw it
    clock.t += 60
    s2, again, _ = register(app, pilot, line(SEED_A, 5), env_id=env_id)
    assert (s1, s2) == (201, 200) and again == first
    assert len(regs(table)) == 1
    quota = [v for k, v in table.items.items() if k[1].startswith("QUOTA#")]
    assert quota[0]["n"] == 1


def test_conflicting_retry_is_409():
    app, _, _, pilot = setup()
    env_id = envelope(app, pilot)
    register(app, pilot, line(SEED_A, 5), env_id=env_id)
    s, out, _ = register(app, pilot, line(SEED_A, 6), env_id=env_id)
    assert (s, out["error"]) == (409, "idempotency_conflict")


def test_same_receipt_new_key_and_after_dedupe_expiry():
    app, table, clock, pilot = setup(DEDUPE_SECONDS=10)
    _, first, _ = register(app, pilot, line(SEED_A, 5))
    s, out, _ = register(app, pilot, line(SEED_A, 5), idem="idem-key-0000000002")
    assert s == 200 and out == first
    clock.t += 11  # dedupe expired, IDEM item still present (TTL is background cleanup only)
    pilot = token(clock)
    s, out, _ = register(app, pilot, line(SEED_A, 5))
    assert s == 200 and out == first and len(regs(table)) == 1
    admin = token(clock, role="admin")
    assert call(app, "DELETE", f"/v1/registrations/{first['registration_id']}", admin)[0] == 200
    s, out, _ = register(app, pilot, line(SEED_A, 5), idem="idem-key-0000000003")
    assert (s, out["error"]) == (410, "registration_deleted")


def test_stale_idempotency_record_is_overwritten_not_blocking():
    app, table, clock, pilot = setup(DEDUPE_SECONDS=10)
    register(app, pilot, line(SEED_A, 5))
    clock.t += 11
    pilot = token(clock)
    s, out, _ = register(app, pilot, line(SEED_A, 6))  # same idempotency key, expired record
    assert s == 201 and out["count"] == 6


def test_expired_wrong_sub_and_stale_epoch_envelopes():
    app, _, clock, pilot = setup(ENVELOPE_SECONDS=100)
    env_id = envelope(app, pilot)
    clock.t += 101
    pilot = token(clock)
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id=env_id)
    assert (s, out["error"]) == (422, "envelope_expired")
    other_sub = token(clock, sub="pilot-2")
    s, out, _ = register(app, other_sub, line(SEED_A, 5), env_id=envelope(app, pilot), idem="idem-key-0000000002")
    assert (s, out["error"]) == (422, "sub_mismatch")
    other_org = token(clock, org="orgB")
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id=envelope(app, other_org), idem="idem-key-0000000003")
    assert (s, out["error"]) == (422, "envelope_expired")
    env_id = envelope(app, pilot)
    _, committed, _ = register(app, pilot, line(SEED_A, 9), env_id=env_id, idem="idem-key-0000000004")
    assert call(app, "POST", "/v1/epoch", token(clock, role="admin"), {})[1] == {"epoch": 1}
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id=env_id, idem="idem-key-0000000005")
    assert (s, out["error"]) == (422, "epoch_mismatch")
    # a retry of an already-committed registration still gets its original ack
    s, out, _ = register(app, pilot, line(SEED_A, 9), env_id=env_id, idem="idem-key-0000000004")
    assert s == 200 and out == committed
    s, out, _ = register(app, pilot, line(SEED_A, 9), env_id=env_id, idem="idem-key-0000000006")
    assert s == 200 and out == committed
    assert call(app, "POST", "/v1/epoch", pilot, {})[0] == 403


def test_quota_is_enforced_in_the_transaction():
    app, table, clock, pilot = setup(REG_QUOTA_PER_MONTH=2)
    for i in (1, 2):
        assert register(app, pilot, line(SEED_A, i), idem=f"idem-key-000000000{i}")[0] == 201
    snapshot = dict(table.items)
    s, out, _ = register(app, pilot, line(SEED_A, 3), idem="idem-key-0000000003")
    assert (s, out["error"]) == (429, "quota_exceeded")
    assert {k for k in table.items if not k[1].startswith("ENV#")} == {k for k in snapshot if not k[1].startswith("ENV#")}
    assert len(regs(table)) == 2


def test_body_too_big_is_413_before_parsing():
    app, _, clock, pilot = setup()
    s, out, _ = call(app, "POST", "/v1/registrations", None, raw="x" * 4097)
    assert (s, out["error"]) == (413, "body_too_large")
    assert call(app, "POST", "/v1/registrations", pilot, raw="{" * 4096)[1]["error"] == "bad_json"


def _share(app, tok, rid, **extra):
    s, out, _ = share(app, tok, rid, **extra)
    return s, out, None


def test_share_lifecycle_and_identical_404s():
    app, table, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    s, share, _ = _share(app, pilot, reg["registration_id"], expires_days=1)
    assert s == 201
    s, view, headers = call(app, "GET", share["path"])
    assert s == 200 and view == {k: reg[k] for k in ("head", "count", "key_fingerprint", "received_at")}
    assert headers["cache-control"] == "no-store"
    unknown = call(app, "GET", "/v1/shares/" + "A" * 43)
    malformed = call(app, "GET", "/v1/shares/short")
    _, other, _ = _share(app, pilot, reg["registration_id"])
    assert call(app, "DELETE", other["path"], token(clock, org="orgB"))[0] == 404  # not theirs
    assert call(app, "DELETE", other["path"], pilot)[0] == 200
    withdrawn = call(app, "GET", other["path"])
    clock.t += 86401
    expired = call(app, "GET", share["path"])
    assert unknown == malformed == withdrawn == expired and unknown[0] == 404
    assert not any("token" in v for v in table.items.values())  # the token itself is never stored


def test_share_limit_and_deleted_registration():
    app, _, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    paths = [_share(app, pilot, reg["registration_id"])[1]["path"] for _ in range(10)]
    assert _share(app, pilot, reg["registration_id"])[1]["error"] == "share_limit"
    assert call(app, "DELETE", f"/v1/registrations/{reg['registration_id']}", pilot)[0] == 403  # admin only
    assert call(app, "DELETE", f"/v1/registrations/{reg['registration_id']}", token(clock, role="admin"))[0] == 200
    assert all(call(app, "GET", p)[0] == 404 for p in paths)
    assert _share(app, pilot, reg["registration_id"])[0] == 404
    rows = call(app, "GET", "/v1/registrations", pilot)[1]["registrations"]
    assert rows[0]["disposition"] == "deleted" and "received_at" not in rows[0]


def test_withdrawn_share_stays_withdrawn_after_replay():
    app, table, clock, pilot = setup()
    env_id = envelope(app, pilot)
    _, reg, _ = register(app, pilot, line(SEED_A, 5), env_id=env_id)
    _, share, _ = _share(app, pilot, reg["registration_id"])
    call(app, "DELETE", share["path"], pilot)
    shares_before = [k for k in table.items if k[0].startswith("SHARE#")]
    assert register(app, pilot, line(SEED_A, 5), env_id=env_id)[0] == 200
    assert call(app, "GET", share["path"])[0] == 404
    assert [k for k in table.items if k[0].startswith("SHARE#")] == shares_before


def test_identical_retry_after_deletion_reports_current_disposition():
    app, _, clock, pilot = setup()
    env_id = envelope(app, pilot)
    _, reg, _ = register(app, pilot, line(SEED_A, 5), env_id=env_id)
    call(app, "DELETE", f"/v1/registrations/{reg['registration_id']}", token(clock, role="admin"))
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id=env_id)
    assert s == 200 and out == {**reg, "disposition": "deleted"}


def test_list_pages_are_bounded():
    app, _, clock, pilot = setup()
    for i in range(1, 5):
        register(app, pilot, line(SEED_A, i), idem=f"idem-key-000000000{i}")
    s, page, _ = call(app, "GET", "/v1/registrations", pilot, query={"limit": "2"})
    assert s == 200 and len(page["registrations"]) == 2 and page["next_cursor"]
    _, rest, _ = call(app, "GET", "/v1/registrations", pilot, query={"limit": "2", "cursor": page["next_cursor"]})
    # like DynamoDB, a full final page still returns a cursor; it leads to an empty page
    assert len(rest["registrations"]) == 2 and rest["next_cursor"]
    _, end, _ = call(app, "GET", "/v1/registrations", pilot, query={"limit": "2", "cursor": rest["next_cursor"]})
    assert end == {"registrations": [], "next_cursor": None}
    assert call(app, "GET", "/v1/registrations", pilot, query={"limit": "51"})[0] == 400


def test_store_errors_fail_closed():
    """A read error on share, registration, key, idempotency or restore-marker state is 503, never a served view."""
    for failing, check in (
        (lambda pk, sk: pk.startswith("SHARE#"), "share"),
        (lambda pk, sk: sk.startswith("REG#"), "share"),
        (lambda pk, sk: sk.startswith("KEY#"), "register"),
        (lambda pk, sk: sk.startswith("IDEM#"), "register"),
    ):
        app, table, clock, pilot = setup()
        _, reg, _ = register(app, pilot, line(SEED_A, 5))
        _, share, _ = _share(app, pilot, reg["registration_id"])
        table.fail = lambda op, pk, sk, f=failing: op == "get" and f(pk, sk)
        if check == "share":
            assert call(app, "GET", share["path"])[:2] == (503, {"error": "unavailable"})
        else:
            got = register(app, pilot, line(SEED_A, 6), idem="idem-key-0000000002")[:2]
            assert got == (503, {"error": "unavailable"})
    app, table, clock = make_app(RESTORED_FROM="live")
    table.fail = lambda op, pk, sk: pk == "SYSTEM"
    assert call(app, "GET", "/v1/shares/" + "A" * 43)[:2] == (503, {"error": "unavailable"})


def test_key_enrollment_rules():
    app, table, clock = make_app()
    pilot, admin = token(clock), token(clock, role="admin")
    assert call(app, "GET", "/v1/keys/challenge", pilot)[0] == 403
    s, ch, _ = call(app, "GET", "/v1/keys/challenge", admin)
    body = {"public_key": ed25519.public_key(SEED_A).hex(), "nonce": ch["nonce"],
            "signature": ed25519.sign(SEED_A, ch["message"].encode()).hex()}
    assert call(app, "POST", "/v1/keys", pilot, body)[0] == 403
    bad = {**body, "signature": ed25519.sign(SEED_B, ch["message"].encode()).hex()}
    assert call(app, "POST", "/v1/keys", admin, bad)[1]["error"] == "bad_signature"
    assert call(app, "POST", "/v1/keys", admin, {**body, "org_id": "orgB"})[1]["error"] == "unexpected_field"
    assert call(app, "POST", "/v1/keys", admin, body)[0] == 201
    # reuse of the consumed challenge with a new key
    reuse = {"public_key": ed25519.public_key(SEED_B).hex(), "nonce": ch["nonce"], "confirm_replace": True,
             "signature": ed25519.sign(SEED_B, ch["message"].encode()).hex()}
    assert call(app, "POST", "/v1/keys", admin, reuse)[:2] == (400, {"error": "bad_challenge"})
    # expired challenge
    s, ch2, _ = call(app, "GET", "/v1/keys/challenge", admin)
    clock.t += 301
    admin = token(clock, role="admin")
    late = {**reuse, "nonce": ch2["nonce"], "signature": ed25519.sign(SEED_B, ch2["message"].encode()).hex()}
    assert call(app, "POST", "/v1/keys", admin, late)[:2] == (400, {"error": "bad_challenge"})
    # replacing the active key requires confirmation
    assert enroll(app, clock, seed=SEED_B)[:2] == (409, {"error": "confirm_required"})
    s, out, _ = enroll(app, clock, seed=SEED_B, confirm=True)
    assert s == 201 and out["replaced"]
    states = sorted(k["state"] for k in call(app, "GET", "/v1/keys", pilot)[1]["keys"])
    assert states == ["active", "rotated"]
    assert enroll(app, clock, seed=SEED_A, confirm=True)[:2] == (409, {"error": "key_exists"})
    # a challenge issued to one admin cannot be used by another
    s, ch3, _ = call(app, "GET", "/v1/keys/challenge", admin)
    other_admin = token(clock, role="admin", sub="admin-2")
    seed_c = bytes(32)
    steal = {"public_key": ed25519.public_key(seed_c).hex(), "nonce": ch3["nonce"], "confirm_replace": True,
             "signature": ed25519.sign(seed_c, ch3["message"].encode()).hex()}
    assert call(app, "POST", "/v1/keys", other_admin, steal)[1]["error"] == "bad_challenge"


def test_unknown_route_is_404():
    app, _, clock, pilot = setup()
    assert call(app, "GET", "/v1/nothing", pilot)[0] == 404
    assert call(app, "PUT", "/v1/registrations", pilot)[0] == 404


def test_restore_pending_closes_every_route():
    table = MemoryTable()
    app, _, clock = make_app(table=table, RESTORED_FROM="live-table", RESTORE_ID="r1", TABLE_NAME="restored")
    for method, path in (("GET", "/v1/shares/" + "A" * 43), ("POST", "/v1/registrations"), ("GET", "/v1/keys")):
        assert call(app, method, path, token(clock))[:2] == (503, {"error": "restore_pending"})
    table.put({"PK": "SYSTEM", "SK": "RESTORE", "source": "other-table"})
    assert call(app, "GET", "/v1/keys", token(clock))[0] == 503
    table.put({"PK": "SYSTEM", "SK": "RESTORE", "source": "live-table", "target": "other", "restore_id": "r1"})
    assert call(app, "GET", "/v1/keys", token(clock))[0] == 503
    table.put({"PK": "SYSTEM", "SK": "RESTORE", "source": "live-table", "target": "restored", "restore_id": "r1"})
    assert call(app, "GET", "/v1/keys", token(clock))[0] == 200


def test_repeated_404s_do_not_accumulate_state():
    """A shared exception instance would keep every request's traceback (and event) alive in a warm Lambda."""
    app, _, _ = make_app()
    errors = []
    for _ in range(3):
        try:
            app.get_share(None, {}, {}, "short")
        except Exception as err:  # noqa: BLE001
            errors.append(err)
    assert len({id(e) for e in errors}) == 3
    depth, tb = 0, errors[-1].__traceback__
    while tb:
        depth, tb = depth + 1, tb.tb_next
    assert depth == 2  # this test's frame and get_share, nothing from earlier requests


def test_deeply_nested_json_is_400():
    app, _, clock, pilot = setup()
    assert call(app, "POST", "/v1/registrations", pilot, raw="[" * 2000 + "]" * 2000)[:2] == (400, {"error": "bad_json"})


def test_small_order_key_is_rejected_and_cannot_be_enrolled():
    identity = (1).to_bytes(32, "little")  # the neutral point: R = identity, S = 0 would "verify" any message
    forged = identity + bytes(32)
    assert not ed25519.verify(identity, b"anything", forged)
    app, _, clock = make_app()
    admin = token(clock, role="admin")
    _, ch, _ = call(app, "GET", "/v1/keys/challenge", admin)
    body = {"public_key": identity.hex(), "nonce": ch["nonce"], "signature": forged.hex()}
    assert call(app, "POST", "/v1/keys", admin, body)[:2] == (422, {"error": "bad_signature"})
    assert call(app, "GET", "/v1/keys", admin)[1]["keys"] == []


def test_bad_base64_body_is_400():
    app, _, clock, pilot = setup()
    event = {"httpMethod": "POST", "path": "/v1/registrations", "headers": {"authorization": f"Bearer {pilot}"},
             "body": "not*base64!", "isBase64Encoded": True}
    r = app.handle(event)
    assert (r["statusCode"], json.loads(r["body"])) == (400, {"error": "bad_request"})


def test_deleting_a_registration_whose_share_record_is_gone_leaves_a_withdrawn_stub():
    app, table, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    _, share, _ = _share(app, pilot, reg["registration_id"])
    key = next(k for k in table.items if k[0].startswith("SHARE#"))
    del table.items[key]  # TTL already removed it
    assert call(app, "DELETE", f"/v1/registrations/{reg['registration_id']}", token(clock, role="admin"))[0] == 200
    assert table.items[key]["state"] == "withdrawn" and "ttl" not in table.items[key]  # a permanent claim on the hash
    assert call(app, "GET", share["path"])[0] == 404

"""Contract fixes found while building the browser outbox: CORS, idempotent share creation, epoch read and the
three envelope error codes."""
import hashlib

from registry_helpers import SEED_A, call, enroll, envelope, line, make_app, register, share, token

ORIGINS = "https://anirudh763.github.io,http://127.0.0.1:*"
GOOD, DEV = "https://anirudh763.github.io", "http://127.0.0.1:5173"


def setup(**env):
    app, table, clock = make_app(**env)
    assert enroll(app, clock)[0] == 201
    return app, table, clock, token(clock)


def raw(app, method, path, headers, body=""):
    event = {"version": "2.0", "rawPath": path, "requestContext": {"http": {"method": method}}, "headers": headers,
             "body": body}
    return app.handle(event)


def preflight(app, origin, path="/v1/registrations", method="POST"):
    return raw(app, "OPTIONS", path, {"Origin": origin, "Access-Control-Request-Method": method,
                                      "Access-Control-Request-Headers": "authorization,content-type"})


# ------------------------------------------------------------------ CORS

def test_preflight_from_an_allowlisted_origin():
    app, *_ = setup(CORS_ORIGINS=ORIGINS)
    for origin in (GOOD, DEV):
        r = preflight(app, origin)
        h = r["headers"]
        assert r["statusCode"] == 204
        assert h["access-control-allow-origin"] == origin
        assert {"authorization", "content-type", "idempotency-key"} <= set(h["access-control-allow-headers"].split(","))
        assert "POST" in h["access-control-allow-methods"]
        assert "origin" in h["vary"].lower()
        assert "access-control-allow-credentials" not in h


def test_preflight_and_responses_for_other_origins_carry_no_cors_grant():
    app, _, clock, pilot = setup(CORS_ORIGINS=ORIGINS)
    for origin in ("https://evil.example", "http://127.0.0.1.evil.example:80", "http://localhost:5173",
                   "https://anirudh763.github.io.evil.example", "null"):
        r = preflight(app, origin)
        assert r["statusCode"] == 403
        assert "access-control-allow-origin" not in r["headers"]
        r = raw(app, "GET", "/v1/keys", {"Origin": origin, "Authorization": "Bearer " + pilot})
        assert r["statusCode"] == 200 and "access-control-allow-origin" not in r["headers"]


def test_an_allowlisted_origin_gets_its_own_origin_back_never_a_wildcard():
    app, _, clock, pilot = setup(CORS_ORIGINS=ORIGINS)
    r = raw(app, "GET", "/v1/keys", {"Origin": GOOD, "Authorization": "Bearer " + pilot})
    assert r["statusCode"] == 200
    assert r["headers"]["access-control-allow-origin"] == GOOD
    assert "access-control-allow-credentials" not in r["headers"]
    r = raw(app, "GET", "/v1/keys", {"Origin": GOOD})  # 401s are readable too, so the client can ask for sign-in
    assert r["statusCode"] == 401 and r["headers"]["access-control-allow-origin"] == GOOD


def test_a_wildcard_entry_is_ignored_and_no_allowlist_means_no_cors():
    app, _, clock, pilot = setup(CORS_ORIGINS="*, https://*.github.io")
    assert preflight(app, GOOD)["statusCode"] == 403
    app, _, clock, pilot = setup()
    assert preflight(app, GOOD)["statusCode"] == 403
    r = raw(app, "GET", "/v1/keys", {"Origin": GOOD, "Authorization": "Bearer " + pilot})
    assert "access-control-allow-origin" not in r["headers"]


def test_public_share_view_allows_any_origin_without_credentials():
    app, _, clock, pilot = setup(CORS_ORIGINS=ORIGINS)
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    _, out, _ = share(app, pilot, reg["registration_id"])
    for origin in ("https://insurer.example", GOOD):
        r = raw(app, "GET", out["path"], {"Origin": origin})
        assert r["statusCode"] == 200 and r["headers"]["access-control-allow-origin"] == "*"
        assert "access-control-allow-credentials" not in r["headers"]
    missing = raw(app, "GET", "/v1/shares/" + "A" * 43, {"Origin": "https://insurer.example"})
    assert missing["statusCode"] == 404 and missing["headers"]["access-control-allow-origin"] == "*"


def test_every_404_on_the_public_share_route_has_identical_headers_and_body():
    app, *_ = setup(CORS_ORIGINS=ORIGINS)
    for origin in ("https://insurer.example", GOOD):
        unknown = raw(app, "GET", "/v1/shares/" + "A" * 43, {"Origin": origin})
        assert unknown["statusCode"] == 404
        for tail in ("A" * 42, "A" * 129, "bad!token", "", "a/b", "A" * 43 + "/x"):
            assert raw(app, "GET", "/v1/shares/" + tail, {"Origin": origin}) == unknown, tail


# ------------------------------------------------------------------ shares

def test_share_retry_after_a_lost_response_returns_the_same_share():
    app, table, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    rid = reg["registration_id"]
    s1, first, tok = share(app, pilot, rid, idem="share-key-000000001", expires_days=3)
    assert s1 == 201 and first["disposition"] == "active"
    clock.t += 60
    pilot = token(clock)
    s2, again, _ = share(app, pilot, rid, share_token=tok, idem="share-key-000000001", expires_days=3)
    assert s2 == 200 and again == first
    assert call(app, "GET", first["path"])[0] == 200
    assert len([k for k in table.items if k[0].startswith("SHARE#")]) == 1
    assert table.items[(f"ORG#orgA", "REG#" + rid)]["share_hashes"] == [hashlib.sha256(tok.encode()).hexdigest()]
    assert not any(tok in repr(v) for v in table.items.values())  # only the hash is stored


def test_share_idempotency_key_is_bound_to_registration_and_token():
    app, _, clock, pilot = setup()
    _, a, _ = register(app, pilot, line(SEED_A, 5), idem="idem-key-0000000001")
    _, b, _ = register(app, pilot, line(SEED_A, 6), idem="idem-key-0000000002")
    _, _, tok = share(app, pilot, a["registration_id"], idem="share-key-000000001")
    assert share(app, pilot, a["registration_id"], idem="share-key-000000001")[1] == {"error": "idempotency_conflict"}
    assert share(app, pilot, b["registration_id"], share_token=tok, idem="share-key-000000001")[1] == \
        {"error": "idempotency_conflict"}
    # the same token hash under a new key is refused: one token, one share
    assert share(app, pilot, b["registration_id"], share_token=tok, idem="share-key-000000002")[1] == \
        {"error": "conflict"}
    # another org with the same idempotency key is independent
    app_b_tok = token(clock, org="orgB")
    assert share(app, app_b_tok, a["registration_id"], idem="share-key-000000001")[0] == 404


def test_share_body_is_strict():
    app, _, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    rid = reg["registration_id"]
    assert call(app, "POST", "/v1/shares", pilot, {"registration_id": rid})[1] == {"error": "missing_field"}
    for bad in ("A" * 64, "0" * 63, "g" * 64):
        body = {"registration_id": rid, "token_hash": bad, "idempotency_key": "share-key-000000001"}
        assert call(app, "POST", "/v1/shares", pilot, body)[1] == {"error": "bad_request"}
    body = {"registration_id": rid, "token_hash": "0" * 64, "idempotency_key": "short"}
    assert call(app, "POST", "/v1/shares", pilot, body)[1] == {"error": "bad_request"}
    body = {"registration_id": rid, "token_hash": "0" * 64, "idempotency_key": "share-key-000000001", "token": "x"}
    assert call(app, "POST", "/v1/shares", pilot, body)[1] == {"error": "unexpected_field"}


def test_retrying_a_withdrawn_share_never_reopens_it():
    app, _, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    _, first, tok = share(app, pilot, reg["registration_id"], idem="share-key-000000001")
    assert call(app, "DELETE", first["path"], pilot)[0] == 200
    s, again, _ = share(app, pilot, reg["registration_id"], share_token=tok, idem="share-key-000000001")
    assert s == 200 and again["disposition"] == "withdrawn"
    assert call(app, "GET", first["path"])[0] == 404


def test_share_retry_at_the_limit_still_returns_the_original():
    app, _, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    rid = reg["registration_id"]
    _, first, tok = share(app, pilot, rid, idem="share-key-000000000")
    for i in range(1, 10):
        assert share(app, pilot, rid, idem=f"share-key-00000000{i}")[0] == 201
    assert share(app, pilot, rid)[1] == {"error": "share_limit"}
    assert share(app, pilot, rid, share_token=tok, idem="share-key-000000000")[0] == 200


# ------------------------------------------------------------------ epoch and envelope errors

def test_get_epoch_for_any_signed_in_caller():
    app, _, clock, pilot = setup()
    assert call(app, "GET", "/v1/epoch", pilot)[:2] == (200, {"epoch": 0})
    assert call(app, "POST", "/v1/epoch", token(clock, role="admin"), {})[1] == {"epoch": 1}
    assert call(app, "GET", "/v1/epoch", pilot)[:2] == (200, {"epoch": 1})
    assert call(app, "GET", "/v1/epoch")[0] == 401


def test_envelope_errors_are_distinguished():
    app, _, clock, pilot = setup(ENVELOPE_SECONDS=100)
    other_sub = token(clock, sub="pilot-2")
    s, out, _ = register(app, other_sub, line(SEED_A, 5), env_id=envelope(app, pilot), idem="idem-key-0000000001")
    assert (s, out["error"]) == (422, "sub_mismatch")
    stale = envelope(app, pilot)
    call(app, "POST", "/v1/epoch", token(clock, role="admin"), {})
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id=stale, idem="idem-key-0000000002")
    assert (s, out["error"]) == (422, "epoch_mismatch")
    old = envelope(app, pilot)
    clock.t += 101
    pilot = token(clock)
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id=old, idem="idem-key-0000000003")
    assert (s, out["error"]) == (422, "envelope_expired")
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id="0" * 32, idem="idem-key-0000000004")
    assert (s, out["error"]) == (422, "envelope_expired")  # unknown: indistinguishable from TTL-deleted
    s, out, _ = register(app, pilot, line(SEED_A, 5), env_id=envelope(app, token(clock, org="orgB")),
                         idem="idem-key-0000000005")
    assert (s, out["error"]) == (422, "envelope_expired")  # another org's envelope does not exist here


# ------------------------------------------------------------------ review: a client-chosen hash is never reusable

def test_a_share_token_hash_is_never_reusable_and_share_records_never_expire():
    app, table, clock, pilot = setup()
    _, a, _ = register(app, pilot, line(SEED_A, 5), idem="idem-key-0000000001")
    _, b, _ = register(app, pilot, line(SEED_A, 6), idem="idem-key-0000000002")
    _, first, tok = share(app, pilot, a["registration_id"], expires_days=1)
    assert call(app, "DELETE", first["path"], pilot)[0] == 200
    clock.t += 400 * 86400  # long past the share's expiry and the dedupe window
    pilot = token(clock)
    assert all("ttl" not in v for k, v in table.items.items() if k[0].startswith("SHARE#"))
    # same org, another registration; another org entirely: both refused, the old link stays dead
    assert share(app, pilot, b["registration_id"], share_token=tok)[:2] == (409, {"error": "conflict"})
    seed_c = bytes(range(2, 34))
    assert enroll(app, clock, org="orgB", seed=seed_c)[0] == 201
    other = token(clock, org="orgB")
    _, c, _ = register(app, other, line(seed_c, 7), idem="idem-key-0000000003")
    assert share(app, other, c["registration_id"], share_token=tok)[:2] == (409, {"error": "conflict"})
    assert call(app, "GET", first["path"])[0] == 404


def test_deleting_a_registration_leaves_permanent_withdrawn_share_records():
    app, table, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    _, out, tok = share(app, pilot, reg["registration_id"])
    key = next(k for k in table.items if k[0].startswith("SHARE#"))
    del table.items[key]  # lost by any means: the delete must still leave a claim on the hash
    assert call(app, "DELETE", f"/v1/registrations/{reg['registration_id']}", token(clock, role="admin"))[0] == 200
    stub = table.items[key]
    assert stub["state"] == "withdrawn" and "ttl" not in stub and stub["org"] == "orgA"
    assert call(app, "GET", out["path"])[0] == 404


def test_a_late_share_retry_after_the_dedupe_window_still_gets_its_share():
    app, _, clock, pilot = setup(DEDUPE_SECONDS=10)
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    _, first, tok = share(app, pilot, reg["registration_id"], idem="share-key-000000001")
    clock.t += 11
    pilot = token(clock)
    s, again, _ = share(app, pilot, reg["registration_id"], share_token=tok, idem="share-key-000000001")
    assert (s, again) == (200, first)


def test_a_concurrent_create_with_the_same_key_gets_the_winners_share():
    app, table, clock, pilot = setup()
    _, reg, _ = register(app, pilot, line(SEED_A, 5))
    rid = reg["registration_id"]
    _, first, tok = share(app, pilot, rid, idem="share-key-000000001")
    real_get, hidden = app.t.get, {"done": False}

    def racy_get(pk, sk):  # the second request's first SIDEM read happens before the winner committed
        if sk.startswith("SIDEM#") and not hidden["done"]:
            hidden["done"] = True
            return None
        return real_get(pk, sk)

    app.t.get = racy_get
    s, again, _ = share(app, pilot, rid, share_token=tok, idem="share-key-000000001")
    assert (s, again) == (200, first)


def test_restore_never_reopens_a_share_created_and_withdrawn_after_the_backup():
    from registry.restore import apply_tombstones
    from registry.store import MemoryTable

    app, live, clock = make_app(TABLE_NAME="live")
    enroll(app, clock)
    pilot = token(clock)
    _, reg, _ = register(app, pilot, line(SEED_A, 1))
    backup = MemoryTable()
    backup.items = {k: dict(v) for k, v in live.items.items()}  # before the share existed
    _, first, tok = share(app, pilot, reg["registration_id"], idem="share-key-000000001")
    assert call(app, "DELETE", first["path"], pilot)[0] == 200
    apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live")
    restored, _, _ = make_app(table=backup, TABLE_NAME="restored", RESTORED_FROM="live", RESTORE_ID="r1")
    restored.clock = clock
    # the client's documented lost-response retry, same token and key, against the restored table
    s, again, _ = share(restored, pilot, reg["registration_id"], share_token=tok, idem="share-key-000000001")
    assert s == 200 and again["disposition"] == "withdrawn"
    assert call(restored, "GET", first["path"])[0] == 404

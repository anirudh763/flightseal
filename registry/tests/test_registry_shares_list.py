"""R36: admins list the org's share links (newest first, bounded pages) and withdraw one by its id, no raw token."""
import copy
import hashlib

import pytest
from registry_helpers import SEED_A, T0, Clock, call, enroll, line, make_app, register, share, token

from registry.restore import apply_tombstones
from registry.store import MemoryTable

DAY = 86400


def _world(n=3, org="orgA"):
    """n shares on one registration, one second apart, oldest first. Returns app, table, clock, rid, [(id, token)]."""
    app, table, clock = make_app()
    enroll(app, clock, org=org)
    pilot = token(clock, org=org)
    _, reg, _ = register(app, pilot, line(SEED_A, 1))
    rid, shares = reg["registration_id"], []
    for i in range(n):
        clock.t += 1
        s, _, tok = share(app, pilot, rid, expires_days=7 if i == 1 else 30)
        assert s == 201
        shares.append((hashlib.sha256(tok.encode()).hexdigest(), tok))
    return app, table, clock, rid, shares


def _admin(clock, org="orgA"):
    return token(clock, org=org, role="admin", sub="admin-1")


def test_list_newest_first_with_states_and_no_token():
    app, _, clock, rid, shares = _world()
    call(app, "DELETE", "/v1/shares/" + shares[2][1], token(clock))  # withdrawn
    clock.t += 7 * DAY + 10  # shares[1] (7 days) is now expired, shares[0] (30 days) still active
    s, out, headers = call(app, "GET", "/v1/shares", _admin(clock))
    assert s == 200 and out["next_cursor"] is None
    assert [r["share_id"] for r in out["shares"]] == [shares[2][0], shares[1][0], shares[0][0]]
    assert [r["state"] for r in out["shares"]] == ["withdrawn", "expired", "active"]
    assert all(set(r) == {"share_id", "registration_id", "state", "created_at", "expires_at"} for r in out["shares"])
    assert all(r["registration_id"] == rid for r in out["shares"])
    assert out["shares"][2]["created_at"] == "2027-01-15T08:00:01Z"
    assert out["shares"][2]["expires_at"] == "2027-02-14T08:00:01Z"
    body = str(out)
    assert not any(tok in body for _, tok in shares)
    assert "access-control-allow-origin" not in headers  # never the share view's "*"


def test_list_paging_one_per_page_no_repeats():
    app, _, clock, _, shares = _world()
    seen, cursor, pages = [], None, 0
    while True:
        q = {"limit": "1", **({"cursor": cursor} if cursor else {})}
        s, out, _ = call(app, "GET", "/v1/shares", _admin(clock), query=q)
        assert s == 200 and len(out["shares"]) <= 1
        seen += [r["share_id"] for r in out["shares"]]
        cursor, pages = out["next_cursor"], pages + 1
        if cursor is None:
            break
        assert len(cursor) == 76 and "#" not in cursor
    assert seen == [h for h, _ in reversed(shares)]
    assert pages in (3, 4)  # an exactly full last page may hand back a cursor to an empty page


@pytest.mark.parametrize("query", [{"limit": "0"}, {"limit": "51"}, {"limit": "x"}, {"limit": "001"},
                                   {"cursor": "abc"}, {"cursor": "0" * 12 + "#" + "a" * 64},
                                   {"cursor": "0" * 12 + "A" * 64}])
def test_list_bad_limit_or_cursor(query):
    app, _, clock, _, _ = _world(1)
    assert call(app, "GET", "/v1/shares", _admin(clock), query=query)[:2] == (400, {"error": "bad_request"})


def test_list_access():
    app, table, clock, _, _ = _world()
    assert call(app, "GET", "/v1/shares", token(clock))[:2] == (403, {"error": "forbidden"})
    assert call(app, "GET", "/v1/shares")[:2] == (401, {"error": "unauthorized"})
    s, out, _ = call(app, "GET", "/v1/shares", _admin(clock, org="orgB"))
    assert (s, out) == (200, {"shares": [], "next_cursor": None})


def test_list_skips_an_index_row_whose_share_is_missing_or_another_orgs():
    app, table, clock, _, shares = _world(2)
    del table.items[("SHARE#" + shares[0][0], "SHARE")]
    table.items[("SHARE#" + shares[1][0], "SHARE")]["org"] = "orgB"
    s, out, _ = call(app, "GET", "/v1/shares", _admin(clock))
    assert (s, out["shares"]) == (200, [])


def test_list_restored_stub_is_withdrawn_with_no_created_at():
    """A share created after the backup and withdrawn: the restore writes a withdrawn stub and its index row."""
    app, live, clock, rid, _ = _world(0)
    backup = MemoryTable()
    backup.items = copy.deepcopy(live.items)
    clock.t += 1
    _, _, tok = share(app, token(clock), rid)
    clock.t += 1
    call(app, "DELETE", "/v1/shares/" + tok, token(clock))
    apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live",
                     clock=Clock(clock.t))
    restored, _, _ = make_app(table=backup, RESTORED_FROM="live", RESTORE_ID="r1", TABLE_NAME="restored")
    restored.clock = clock
    s, out, _ = call(restored, "GET", "/v1/shares", _admin(clock))
    assert s == 200 and out["shares"] == [{"share_id": hashlib.sha256(tok.encode()).hexdigest(),
                                          "registration_id": rid, "state": "withdrawn",
                                          "created_at": None, "expires_at": None}]


# ------------------------------------------------------------ withdraw by id

def _path(rid, h):
    return f"/v1/registrations/{rid}/shares/{h}"


def test_withdraw_by_id_then_link_404_and_list_shows_it_withdrawn():
    app, table, clock, rid, shares = _world(2)
    h, tok = shares[0]
    _, page, _ = call(app, "GET", "/v1/shares", _admin(clock))
    assert call(app, "GET", "/v1/shares/" + tok)[0] == 200
    unknown = call(app, "GET", "/v1/shares/" + "A" * 43)
    assert call(app, "DELETE", _path(rid, page["shares"][1]["share_id"]), _admin(clock))[:2] == \
        (200, {"withdrawn": True})
    assert call(app, "GET", "/v1/shares/" + tok)[:2] == unknown[:2] == (404, {"error": "not_found"})
    tomb = table.items[(f"TOMB#orgA#{h}", "TOMB")]
    assert (tomb["kind"], tomb["ref"], tomb["rid"], tomb["at"]) == ("share", h, rid, clock.t)
    states = {r["share_id"]: r["state"] for r in call(app, "GET", "/v1/shares", _admin(clock))[1]["shares"]}
    assert states == {h: "withdrawn", shares[1][0]: "active"}
    before = copy.deepcopy(table.items)
    clock.t += 5
    assert call(app, "DELETE", _path(rid, h), _admin(clock))[:2] == (200, {"withdrawn": True})  # repeat: nothing written
    assert table.items == before


def test_withdraw_by_id_identical_404s():
    app, table, clock, rid, shares = _world(1)
    h = shares[0][0]
    other_rid = "0" * 32
    expect = call(app, "DELETE", _path(rid, "f" * 64), _admin(clock))  # unknown id
    assert expect[:2] == (404, {"error": "not_found"})
    for path, tok in [(_path(rid, h), _admin(clock, org="orgB")),  # another org
                      (_path(other_rid, h), _admin(clock)),  # wrong registration id
                      (f"/v1/registrations/{rid}/shares/{h[:-1]}", _admin(clock)),  # malformed
                      (f"/v1/registrations/{rid}/shares/{h.upper()}", _admin(clock))]:
        assert call(app, "DELETE", path, tok)[:2] == expect[:2], path
    assert table.items[("SHARE#" + h, "SHARE")]["state"] == "active"


def test_withdraw_by_id_needs_the_registration_and_an_admin():
    app, table, clock, rid, shares = _world(1)
    h = shares[0][0]
    assert call(app, "DELETE", _path(rid, h), token(clock))[:2] == (403, {"error": "forbidden"})
    assert call(app, "DELETE", _path(rid, h))[:2] == (401, {"error": "unauthorized"})
    del table.items[("ORG#orgA", "REG#" + rid)]
    assert call(app, "DELETE", _path(rid, h), _admin(clock))[:2] == (404, {"error": "not_found"})


def test_withdraw_by_id_race_is_a_conflict():
    app, table, clock, rid, shares = _world(1)
    h = shares[0][0]
    real = table.transact

    def lose_registration(ops):  # the registration vanishes between the read and the transaction
        table.items.pop(("ORG#orgA", "REG#" + rid))
        return real(ops)
    table.transact = lose_registration
    assert call(app, "DELETE", _path(rid, h), _admin(clock))[:2] == (409, {"error": "conflict"})
    assert table.items[("SHARE#" + h, "SHARE")]["state"] == "active"

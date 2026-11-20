"""R52: actor IDs are scrubbed 90 days after enrollment; expired challenges and envelopes are deleted."""
import copy
import json

import pytest
from registry_helpers import SEED_A, T0, Clock, call, enroll, make_app, token

from registry import ed25519, receipt, scrub
from registry.restore import apply_tombstones
from registry.store import MemoryTable, StoreUnavailable

DAY = 86400
FP = receipt.fingerprint(ed25519.public_key(SEED_A))
KEY = ("ORG#orgA", "KEY#" + FP)
TOMB = (f"TOMB#orgA#KEY#{FP}", "TOMB")


def _enrolled():
    app, table, clock = make_app()
    assert enroll(app, clock)[0] == 201
    assert table.items[KEY]["enrolled_by"] == "admin-1" and table.items[TOMB]["enrolled_by"] == "admin-1"
    return app, table, clock


def test_day_89_keeps_the_actor_id():
    _, table, _ = _enrolled()
    before = copy.deepcopy(table.items)
    assert scrub.scrub(table, T0 + 89 * DAY) == 0
    assert table.items == before


@pytest.mark.parametrize("days", [90, 91])
def test_day_90_and_91_scrub_key_and_tombstone_and_nothing_else(days):
    _, table, _ = _enrolled()
    before = copy.deepcopy(table.items)
    assert scrub.scrub(table, T0 + days * DAY) == 2
    for key in (KEY, TOMB):
        assert table.items[key] == {**before[key], "enrolled_by": "scrubbed"}  # state, at, changed_at, kind unchanged
    assert {k: v for k, v in table.items.items() if k not in (KEY, TOMB)} == \
        {k: v for k, v in before.items() if k not in (KEY, TOMB)}


def test_rerun_writes_nothing():
    _, table, _ = _enrolled()
    scrub.scrub(table, T0 + 90 * DAY)
    after = copy.deepcopy(table.items)
    assert scrub.scrub(table, T0 + 90 * DAY) == 0
    assert table.items == after


def test_list_keys_after_scrub_says_not_enrolled_by_me():
    app, table, clock = _enrolled()
    scrub.scrub(table, T0 + 90 * DAY)
    rows = call(app, "GET", "/v1/keys", token(clock, role="admin", sub="admin-1"))[1]["keys"]
    assert [r["enrolled_by_me"] for r in rows] == [False]
    assert "scrubbed" not in json.dumps(rows)


@pytest.mark.parametrize("placeholder", ["restore", "unknown", "scrubbed"])
def test_placeholders_are_untouched(placeholder):
    table = MemoryTable()
    for pk, sk in (KEY, TOMB):
        table.items[(pk, sk)] = {"PK": pk, "SK": sk, "kind": "key", "enrolled_by": placeholder, "enrolled_at": 0}
    before = copy.deepcopy(table.items)
    assert scrub.scrub(table, T0) == 0
    assert table.items == before


def test_missing_enrolled_at_counts_as_zero():
    table = MemoryTable()
    table.items[KEY] = {"PK": KEY[0], "SK": KEY[1], "state": "active", "enrolled_by": "admin-1"}
    assert scrub.scrub(table, T0) == 1
    assert table.items[KEY]["enrolled_by"] == "scrubbed"


def test_only_key_tombstones_are_scrubbed():
    table = MemoryTable()
    other = ("TOMB#orgA#EPOCH", "TOMB")
    table.items[other] = {"PK": other[0], "SK": "TOMB", "kind": "epoch", "enrolled_by": "admin-1", "enrolled_at": 0}
    assert scrub.scrub(table, T0) == 0


def test_expired_challenges_and_envelopes_are_deleted_live_ones_kept():
    app, table, clock = make_app()
    admin, pilot = token(clock, role="admin", sub="admin-1"), token(clock)
    call(app, "GET", "/v1/keys/challenge", admin)  # expires T0 + 300
    call(app, "POST", "/v1/envelopes", pilot, {})  # expires T0 + 7 days
    clock.t = T0 + 8 * DAY
    call(app, "POST", "/v1/envelopes", token(clock), {})  # live
    kinds = lambda: sorted(sk.split("#")[0] for (_, sk) in table.items if sk.startswith(("CHAL#", "ENV#")))  # noqa: E731
    assert kinds() == ["CHAL", "ENV", "ENV"]
    assert scrub.scrub(table, clock.t) == 2
    assert kinds() == ["ENV"]
    live = [v for (_, sk), v in table.items.items() if sk.startswith("ENV#")]
    assert live[0]["expires_at"] > clock.t


def test_race_item_removed_between_scan_and_write_is_not_recreated():
    _, table, _ = _enrolled()
    table.items[("ORG#orgA", "ENV#" + "0" * 32)] = {"PK": "ORG#orgA", "SK": "ENV#" + "0" * 32, "expires_at": 1}
    real_scan = table.scan

    def scan_then_remove(prefix):
        rows = real_scan(prefix)
        for row in rows:  # removed after the scan read it
            table.items.pop((row["PK"], row["SK"]), None)
        return rows
    table.scan = scan_then_remove
    assert scrub.scrub(table, T0 + 90 * DAY) == 0
    assert KEY not in table.items and TOMB not in table.items and ("ORG#orgA", "ENV#" + "0" * 32) not in table.items


def test_handler_prints_only_the_count(monkeypatch, capsys):
    table = MemoryTable()
    table.items[KEY] = {"PK": KEY[0], "SK": KEY[1], "enrolled_by": "sub-123", "enrolled_at": 0}
    import registry.store
    monkeypatch.setattr(registry.store, "DynamoTable", lambda name: table)
    monkeypatch.setenv("TABLE_NAME", "t")
    assert scrub.handler({}, None) == {"scrubbed": 1}
    assert capsys.readouterr().out.strip() == '{"scrubbed": 1}'


# ------------------------------------------------------------ restore

def _old_backup():
    """A backup holding a key enrolled long ago (with a sub), and the live table it was taken from."""
    app, live, clock = _enrolled()
    backup = MemoryTable()
    backup.items = copy.deepcopy(live.items)
    del backup.items[TOMB]  # the backup has the key but not its tombstone
    return live, backup


def test_restore_of_an_old_backup_scrubs_before_the_marker():
    live, backup = _old_backup()
    apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live",
                     clock=Clock(T0 + 91 * DAY))
    assert backup.items[KEY]["enrolled_by"] == "scrubbed" and backup.items[TOMB]["enrolled_by"] == "scrubbed"
    assert backup.items[KEY]["state"] == "active"
    assert backup.items[("SYSTEM", "RESTORE")]["restore_id"] == "r1"


def test_restore_writes_no_marker_when_the_scrub_fails():
    live, backup = _old_backup()
    backup.fail = lambda op, pk, sk: op == "scan"
    with pytest.raises(StoreUnavailable):
        apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live",
                         clock=Clock(T0 + 91 * DAY))
    assert ("SYSTEM", "RESTORE") not in backup.items


def test_restore_within_90_days_keeps_the_actor_id():
    live, backup = _old_backup()
    apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live",
                     clock=Clock(T0 + 89 * DAY))
    assert backup.items[KEY]["enrolled_by"] == "admin-1"


def test_a_state_change_on_an_old_key_never_writes_the_sub_back_into_its_tombstone():
    """A KEY item read before a racing scrub still holds the sub; the tombstone the change writes must not."""
    app, table, clock = _enrolled()
    clock.t = T0 + 90 * DAY
    s, _, _ = call(app, "POST", f"/v1/keys/{FP}/compromised", token(clock, role="admin", sub="admin-1"), {})
    assert s == 200
    assert table.items[TOMB]["enrolled_by"] == "scrubbed" and table.items[TOMB]["state"] == "compromised"

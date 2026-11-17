import pytest
from registry_helpers import SEED_A, call, enroll, line, make_app, register, token

from registry.restore import apply_tombstones
from registry.store import MemoryTable, StoreUnavailable


def _world():
    app, live, clock = make_app()
    enroll(app, clock)
    pilot, admin = token(clock), token(clock, role="admin")
    ids, paths = [], []
    for i in (1, 2, 3):
        _, reg, _ = register(app, pilot, line(SEED_A, i), idem=f"idem-key-000000000{i}")
        ids.append(reg["registration_id"])
        paths.append(call(app, "POST", "/v1/shares", pilot, {"registration_id": reg["registration_id"]})[1]["path"])
    backup = MemoryTable()
    backup.items = {k: dict(v) for k, v in live.items.items()}  # the backup, taken before the changes below
    call(app, "DELETE", paths[0], pilot)  # withdraw share 0
    call(app, "DELETE", f"/v1/registrations/{ids[1]}", admin)  # delete registration 1 (and its share)
    return live, backup, paths, clock


def test_restore_reapplies_tombstones_then_opens():
    live, restored, paths, clock = _world()
    app, _, _ = make_app(table=restored, RESTORED_FROM="live")
    app.clock = clock
    assert call(app, "GET", paths[0])[:2] == (503, {"error": "restore_pending"})
    assert apply_tombstones(live, restored, source_name="live") == 3  # 1 share + 1 registration + its 1 share
    assert [call(app, "GET", p)[0] for p in paths] == [404, 404, 200]
    rows = call(app, "GET", "/v1/registrations", token(clock))[1]["registrations"]
    assert sorted(r["disposition"] for r in rows) == ["active", "active", "deleted"]


def test_restore_refuses_when_source_tombstones_are_unreadable():
    live, restored, paths, _ = _world()
    live.fail = lambda op, pk, sk: op == "scan"
    with pytest.raises(StoreUnavailable):
        apply_tombstones(live, restored, source_name="live")
    assert ("SYSTEM", "RESTORE") not in restored.items


def test_raw_backup_without_the_gate_would_serve_a_withdrawn_share():
    """Why the marker gate exists: the restored table alone still shows the withdrawn share."""
    _, restored, paths, clock = _world()
    app, _, _ = make_app(table=restored)
    app.clock = clock
    assert call(app, "GET", paths[0])[0] == 200

import pytest
from registry_helpers import SEED_A, call, enroll, line, make_app, register, share, token

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
        paths.append(share(app, pilot, reg["registration_id"])[1]["path"])
    backup = MemoryTable()
    backup.items = {k: dict(v) for k, v in live.items.items()}  # the backup, taken before the changes below
    call(app, "DELETE", paths[0], pilot)  # withdraw share 0
    call(app, "DELETE", f"/v1/registrations/{ids[1]}", admin)  # delete registration 1 (and its share)
    return live, backup, paths, clock


def test_restore_reapplies_tombstones_then_opens():
    live, restored, paths, clock = _world()
    app, _, _ = make_app(table=restored, RESTORED_FROM="live", RESTORE_ID="r1", TABLE_NAME="restored")
    app.clock = clock
    assert call(app, "GET", paths[0])[:2] == (503, {"error": "restore_pending"})
    assert apply_tombstones(live, restored, source_name="live", target_name="restored", restore_id="r1", served="live") == 4  # enrolled key + 1 share + 1 registration + its share
    assert [call(app, "GET", p)[0] for p in paths] == [404, 404, 200]
    rows = call(app, "GET", "/v1/registrations", token(clock))[1]["registrations"]
    assert sorted(r["disposition"] for r in rows) == ["active", "active", "deleted"]


def test_restore_refuses_when_source_tombstones_are_unreadable():
    live, restored, paths, _ = _world()
    live.fail = lambda op, pk, sk: op == "scan"
    with pytest.raises(StoreUnavailable):
        apply_tombstones(live, restored, source_name="live", target_name="restored", restore_id="r1", served="live")
    assert ("SYSTEM", "RESTORE") not in restored.items


def test_raw_backup_without_the_gate_would_serve_a_withdrawn_share():
    """Why the marker gate exists: the restored table alone still shows the withdrawn share."""
    _, restored, paths, clock = _world()
    app, _, _ = make_app(table=restored)
    app.clock = clock
    assert call(app, "GET", paths[0])[0] == 200


def test_restore_reapplies_compromised_keys_and_the_epoch():
    from registry import ed25519, receipt
    from registry_helpers import SEED_A, envelope

    app, live, clock = make_app()
    enroll(app, clock)
    pilot, admin = token(clock), token(clock, role="admin")
    old_envelope = envelope(app, pilot)
    backup = MemoryTable()
    backup.items = {k: dict(v) for k, v in live.items.items()}  # key active, epoch 0
    fp = receipt.fingerprint(ed25519.public_key(SEED_A))
    assert call(app, "POST", f"/v1/keys/{fp}/compromised", admin, {})[0] == 200
    assert call(app, "POST", "/v1/epoch", admin, {})[1] == {"epoch": 1}
    assert call(app, "POST", "/v1/epoch", admin, {})[1] == {"epoch": 2}

    restored, _, _ = make_app(table=backup, RESTORED_FROM="live", RESTORE_ID="r1", TABLE_NAME="restored")
    restored.clock = clock
    apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live")
    keys = call(restored, "GET", "/v1/keys", pilot)[1]["keys"]
    assert [k["state"] for k in keys] == ["compromised"]
    assert ("ORG#orgA", "ACTIVE_KEY") not in backup.items
    assert backup.items[("ORG#orgA", "EPOCH")]["epoch"] == 2
    s, out, _ = register(restored, pilot, line(SEED_A, 7), env_id=old_envelope)
    assert (s, out["error"]) == (422, "epoch_mismatch")
    s, out, _ = register(restored, pilot, line(SEED_A, 7), idem="idem-key-0000000009")
    assert (s, out["error"]) == (403, "key_not_active")

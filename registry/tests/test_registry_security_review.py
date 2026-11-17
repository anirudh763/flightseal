"""Regressions for the independent security review of PR #21 (rotation tombstones, restore lineage, existence oracle)."""
import pytest
from registry_helpers import SEED_A, SEED_B, call, enroll, envelope, line, make_app, register, token

from registry import ed25519, receipt
from registry.restore import apply_tombstones
from registry.store import MemoryTable


def _copy(table):
    out = MemoryTable()
    out.items = {k: dict(v) for k, v in table.items.items()}
    return out


def _restored(table, clock, name, source, restore_id):
    app, _, _ = make_app(table=table, TABLE_NAME=name, RESTORED_FROM=source, RESTORE_ID=restore_id)
    app.clock = clock
    return app


def test_restore_keeps_a_rotated_key_rotated():
    app, live, clock = make_app(TABLE_NAME="live")
    assert enroll(app, clock, SEED_A)[0] == 201
    backup = _copy(live)  # key A active
    assert enroll(app, clock, SEED_B, confirm=True)[0] == 201  # A rotated, B active

    restored = _restored(backup, clock, "restored", "live", "r1")
    apply_tombstones(live, backup, source_name="live", target_name="restored", restore_id="r1", served="live")
    states = {k["key_fingerprint"]: k["state"] for k in call(restored, "GET", "/v1/keys", token(clock))[1]["keys"]}
    fp_a, fp_b = (receipt.fingerprint(ed25519.public_key(s)) for s in (SEED_A, SEED_B))
    assert states == {fp_a: "rotated", fp_b: "active"}
    assert backup.items[("ORG#orgA", "ACTIVE_KEY")]["fp"] == fp_b
    pilot = token(clock)
    s, out, _ = register(restored, pilot, line(SEED_A, 5), idem="idem-key-0000000005")
    assert (s, out["error"]) == (403, "key_not_active")
    assert register(restored, pilot, line(SEED_B, 6), idem="idem-key-0000000006")[0] == 201


def test_a_marker_copied_into_a_later_backup_does_not_open_the_gate():
    app, live, clock = make_app(TABLE_NAME="live")
    enroll(app, clock)
    pilot = token(clock)
    _, reg, _ = register(app, pilot, line(SEED_A, 1))
    path = call(app, "POST", "/v1/shares", pilot, {"registration_id": reg["registration_id"]})[1]["path"]
    gen1 = _copy(live)
    apply_tombstones(live, gen1, source_name="live", target_name="gen1", restore_id="r1", served="live")
    serving = _restored(gen1, clock, "gen1", "live", "r1")
    assert call(serving, "GET", path)[0] == 200
    gen2 = _copy(gen1)  # backup of gen1, carrying gen1's marker
    assert call(serving, "DELETE", path, pilot)[0] == 200  # withdrawn after that backup, tombstone only in gen1

    for source, rid in (("live", "r1"), ("gen1", "r1"), ("gen1", "r2")):
        assert call(_restored(gen2, clock, "gen2", source, rid), "GET", path)[:2] == (503, {"error": "restore_pending"})
    with pytest.raises(ValueError):  # the stale source is not the table being served
        apply_tombstones(live, gen2, source_name="live", target_name="gen2", restore_id="r2", served="gen1")
    apply_tombstones(gen1, gen2, source_name="gen1", target_name="gen2", restore_id="r2", served="gen1")
    assert call(_restored(gen2, clock, "gen2", "gen1", "r2"), "GET", path)[0] == 404


def test_restore_gate_stays_closed_without_a_restore_id():
    app, live, clock = make_app(TABLE_NAME="live")
    target = _copy(live)
    apply_tombstones(live, target, source_name="live", target_name="t", restore_id="r1", served="live")
    assert call(_restored(target, clock, "t", "live", ""), "GET", "/v1/keys", token(clock))[0] == 503


def test_expired_envelope_with_a_forged_receipt_does_not_reveal_a_registration():
    app, _, clock = make_app()
    enroll(app, clock)
    pilot = token(clock)
    good = line(SEED_A, 3)
    assert register(app, pilot, good)[0] == 201
    old = envelope(app, pilot)
    clock.t += 8 * 86400  # past the envelope's expiry
    pilot = token(clock)
    forged = good[: good.index("sig=") + 4] + "0" * 128
    s, out, _ = register(app, pilot, forged, idem="idem-key-0000000077", env_id=old)
    assert (s, out["error"]) == (422, "bad_signature")
    assert register(app, pilot, good, idem="idem-key-0000000078", env_id=old)[0] == 200  # genuine lost-ack retry

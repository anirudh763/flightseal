"""The real-flight examples shipped with the verifier page (docs/samples/px4-*): pinned bytes, no location data,
and the CLI verdicts the page is tested against (tests/web/e2e.mjs compares the page's report with the CLI's)."""
import hashlib
import json
import re

from conftest import ROOT, run
from fseal_py import scan

SAMPLES = ROOT / "docs" / "samples"
# The log bytes do not depend on the signing key, so tools/make_px4_samples.py reproduces them exactly.
PINNED = {
    "px4-intact.fseal": "4ffb95595d7c8f1623823056daed4f4fd04deb4c9f1f68df60f42631c4cbbc79",
    "px4-tampered.fseal": "44ffa27f1f2d6af8e5130b0f3d378e33039497f8b906ec660ac3806fe8838f02",
}
LOCATION = re.compile(r"position|gps|global|(^|[^a-z])(local|lat|lon|alt|home|x|y|z)([^a-z]|$)", re.I)


def test_px4_samples_are_the_pinned_bytes():
    for name, digest in PINNED.items():
        assert hashlib.sha256((SAMPLES / name).read_bytes()).hexdigest() == digest, name


def test_px4_sample_has_no_position_or_gps_topic_or_field():
    s = scan(SAMPLES / "px4-intact.fseal")
    assert s.problem is None and len(s.items) == 2422
    topics, fields = set(), set()
    for r in s.items:
        sample = json.loads(r.payload)
        topics.add(sample["topic"])
        fields.update(sample)
    assert topics == {"actuator_outputs", "commander_state", "vehicle_status", "cpuload", "telemetry_status"}
    assert [t for t in topics if LOCATION.search(t)] == []
    assert [f for f in fields if LOCATION.search(f)] == []


def test_location_check_catches_position_and_gps_names():
    for name in ["vehicle_local_position", "vehicle_gps_position", "vehicle_global_position", "lat", "lon", "z",
                 "home_position", "alt"]:
        assert LOCATION.search(name), name
    for name in ["actuator_outputs", "output[0]", "main_state", "load", "rssi", "nav_state"]:
        assert not LOCATION.search(name), name


def test_px4_samples_verify_as_stated(fseal_bin):
    key = (SAMPLES / "px4-pubkey.txt").read_text().strip()
    args = ["--receipts", SAMPLES / "px4-flight.receipts", "--pubkey", key]
    intact = run(fseal_bin, "verify", SAMPLES / "px4-intact.fseal", *args)
    assert intact.returncode == 0 and "RESULT: INTACT" in intact.stdout and "25 of 25 match" in intact.stdout
    tampered = run(fseal_bin, "verify", SAMPLES / "px4-tampered.fseal", *args)
    assert tampered.returncode == 1
    assert "record 1476, byte 390987" in tampered.stdout and "[bad-link]" in tampered.stdout

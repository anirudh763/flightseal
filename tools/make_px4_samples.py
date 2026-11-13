"""Builds the real-flight example for the browser verifier (docs/samples/px4-*) with the real fseal CLI.

  python3 tools/make_px4_samples.py [--fseal build/fseal] [--out docs/samples] [--cache tests/.data]

Source: the public PX4 sample flight log in PX4/pyulog (test/sample.ulg, BSD-3-Clause, AUAV-X2.1 hardware),
pinned by commit and SHA-256 in tools/fetch_sample.py. Its licence is copied to docs/samples/LICENSE-pyulog.txt.
Only five topics with no position or GPS data are sealed, to keep the example small and free of location data:
actuator_outputs, commander_state, vehicle_status, cpuload and telemetry_status (2,422 of the log's 64,542 decoded
samples). The script refuses any topic or field whose name suggests position or GPS. This is a selection made
after download, like every FlightSeal conversion: it does not authenticate the original .ulg.

  px4-intact.fseal      the selected samples, sealed in timestamp order with a receipt every 100 records
  px4-tampered.fseal    one motor output (actuator_outputs output[0]) raised by 100, that record's checksum recomputed
  px4-flight.receipts   the receipts written while sealing
  px4-pubkey.txt        the sealer's public key (the private key is generated in a temporary folder and discarded)
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import fetch_sample  # noqa: E402
import tamper  # noqa: E402
import ulog_to_records  # noqa: E402

TOPICS = ("actuator_outputs", "commander_state", "vehicle_status", "cpuload", "telemetry_status")
EVERY = 100
EDIT_TOPIC, EDIT_NTH, EDIT_FIELD, EDIT_DELTA = "actuator_outputs", 600, "output[0]", 100.0
# Names that would mean position or GPS data; checked on every sealed topic and field (tests/test_web_samples.py too).
LOCATION_WORDS = ("position", "gps", "global", "local", "lat", "lon", "alt", "home", "x", "y", "z")


def selected_lines(ulg):
    import json

    keep = []
    for line in ulog_to_records.convert(ulg):
        sample = json.loads(line.split("\t", 1)[1])
        if sample["topic"] not in TOPICS:
            continue
        bad = [k for k in [sample["topic"], *sample] if location_name(k)]
        if bad:
            raise SystemExit(f"refusing to seal location data: {bad}")
        keep.append(line)
    return "".join(line + "\n" for line in keep), len(keep)


def location_name(name):
    """True if a topic or field name looks like position or GPS data (whole words, or the axes x/y/z)."""
    import re

    words = re.split(r"[^a-z0-9]+", name.lower())
    return any(w in LOCATION_WORDS for w in words) or any(k in name.lower() for k in ("position", "gps"))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--fseal", default=os.environ.get("FSEAL_BIN", str(ROOT / "build" / "fseal")))
    p.add_argument("--out", default=str(ROOT / "docs" / "samples"))
    p.add_argument("--cache", default=str(ROOT / "tests" / ".data"))
    a = p.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in ["px4-intact.fseal", "px4-tampered.fseal", "px4-flight.receipts", "px4-pubkey.txt"]:
        (out / name).unlink(missing_ok=True)

    ulg = fetch_sample.fetch(a.cache)
    text, count = selected_lines(ulg)
    with tempfile.TemporaryDirectory() as tmp:
        key = Path(tmp) / "px4.pem"
        pub = subprocess.run([a.fseal, "keygen", key], check=True, capture_output=True, text=True).stdout.strip()
        subprocess.run([a.fseal, "append", out / "px4-intact.fseal", "--key", key, "--receipts", out / "px4-flight.receipts",
                        "--every", str(EVERY)], input=text, check=True, capture_output=True, text=True)
    (out / "px4-pubkey.txt").write_text(pub + "\n")

    log = out / "px4-intact.fseal"
    n = tamper.find_record(log, EDIT_TOPIC, EDIT_NTH)
    tamper.edit_field(log, out / "px4-tampered.fseal", record=n, field=EDIT_FIELD, delta=EDIT_DELTA, fix_crc=True)
    print(f"sealed {count} records from {ulg.name}; edited record {n}")


if __name__ == "__main__":
    main()

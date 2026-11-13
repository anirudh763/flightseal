"""Builds the sample files for the browser verifier (docs/samples/) with the real fseal CLI.

  python3 tools/make_web_samples.py [--fseal build/fseal] [--out docs/samples]

The flight is synthetic and deterministic (take-off, a circle at 30 m, landing; 800 samples at 100 Hz), so
no third-party data is committed. It is sealed by `fseal append` with a receipt every 100 records, then
attacked with tools/tamper.py:

  intact.fseal     the sealed log as written
  tampered.fseal   one altitude reading changed by 10 m, that record's checksum recomputed (chain breaks there)
  rewritten.fseal  the same edit, then every later link and checksum recomputed (only the receipts catch it)
  truncated.fseal  the last 150 records deleted (only the receipts catch it)
  flight.receipts  the receipts a third party kept while the log was written
  pubkey.txt       the sealer's public key (the private key is generated in a temporary folder and discarded)

The log bytes are identical on every run; the key, and so the receipts' signatures, are new each time.
"""
import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import tamper  # noqa: E402

RECORDS = 800
EVERY = 100
EDIT_NTH = 120  # the 120th vehicle_local_position sample gets the altitude edit
DROP = 150


def synthetic_flight():
    """timestamp_us<TAB>json lines: local position every record, GPS every 5th, battery every 20th."""
    lines = []
    for i in range(RECORDS):
        t = i / 100.0  # seconds since boot
        ts = 1_000_000 + i * 10_000
        if t < 2:  # climb to 30 m
            z, x, y = -15.0 * t, 0.0, 0.0
        elif t < 6:  # circle of radius 20 m
            a = (t - 2) / 4 * 2 * math.pi
            z, x, y = -30.0, 20 * math.sin(a), 20 * (1 - math.cos(a))
        else:  # descend
            z, x, y = -30.0 + 15.0 * (t - 6), 0.0, 0.0
        if i % 20 == 19:
            sample = {"topic": "battery_status", "instance": 0, "voltage_v": round(16.4 - 0.0009 * i, 3),
                      "remaining": round(0.92 - 0.0001 * i, 4)}
        elif i % 5 == 4:
            sample = {"topic": "vehicle_gps_position", "instance": 0, "lat": round(33.2148 + y * 9e-6, 7),
                      "lon": round(-97.1331 + x * 1.1e-5, 7), "alt": round(190.0 - z, 2), "satellites_used": 14}
        else:
            sample = {"topic": "vehicle_local_position", "instance": 0, "x": round(x, 3), "y": round(y, 3),
                      "z": round(z, 3)}
        lines.append(f"{ts}\t{json.dumps(sample, separators=(',', ':'))}\n")
    return "".join(lines)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--fseal", default=os.environ.get("FSEAL_BIN", str(ROOT / "build" / "fseal")))
    p.add_argument("--out", default=str(ROOT / "docs" / "samples"))
    a = p.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in ["intact.fseal", "tampered.fseal", "rewritten.fseal", "truncated.fseal", "flight.receipts", "pubkey.txt"]:
        (out / name).unlink(missing_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        key = Path(tmp) / "sample.pem"
        pub = subprocess.run([a.fseal, "keygen", key], check=True, capture_output=True, text=True).stdout.strip()
        subprocess.run([a.fseal, "append", out / "intact.fseal", "--key", key, "--receipts", out / "flight.receipts",
                        "--every", str(EVERY)], input=synthetic_flight(), check=True, capture_output=True, text=True)
    (out / "pubkey.txt").write_text(pub + "\n")

    log = out / "intact.fseal"
    n = tamper.find_record(log, "vehicle_local_position", EDIT_NTH)
    tamper.edit_field(log, out / "tampered.fseal", record=n, field="z", delta=10.0, fix_crc=True)
    tamper.edit_field(log, out / "rewritten.fseal", record=n, field="z", delta=10.0, rewrite=True)
    tamper.drop_tail(log, out / "truncated.fseal", records=DROP)
    total = sum(f.stat().st_size for f in out.iterdir() if f.is_file())
    print(f"edited record {n}; wrote {out} ({total} bytes)")


if __name__ == "__main__":
    main()

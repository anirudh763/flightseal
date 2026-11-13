"""Builds the real-flight example for the browser verifier (docs/samples/px4-*) with the real fseal CLI.

  python3 tools/make_px4_samples.py [--fseal build/fseal] [--out docs/samples] [--cache tests/.data]

Source: the public PX4 sample flight log in PX4/pyulog (test/sample.ulg, BSD-3-Clause, AUAV-X2.1 hardware),
pinned by commit and SHA-256 in tools/fetch_sample.py. Its licence is copied to docs/samples/LICENSE-pyulog.txt.
The log has no GPS topic; the selected topics hold local position in metres from the take-off point.

Only three topics are sealed, to keep the example small enough to ship with the page:
vehicle_local_position, commander_state and vehicle_status (1,650 of the log's 64,542 decoded samples). This is
a selection made after download, like every FlightSeal conversion: it does not authenticate the original .ulg.

  px4-intact.fseal      the selected samples, sealed in timestamp order with a receipt every 100 records
  px4-tampered.fseal    one vehicle_local_position z changed by 10 m, that record's checksum recomputed
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

TOPICS = ("vehicle_local_position", "commander_state", "vehicle_status")
EVERY = 100
EDIT_NTH = 300  # the 300th vehicle_local_position sample gets the altitude edit


def selected_lines(ulg):
    import json

    keep = [line for line in ulog_to_records.convert(ulg) if json.loads(line.split("\t", 1)[1])["topic"] in TOPICS]
    return "".join(line + "\n" for line in keep), len(keep)


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
    n = tamper.find_record(log, "vehicle_local_position", EDIT_NTH)
    tamper.edit_field(log, out / "px4-tampered.fseal", record=n, field="z", delta=10.0, fix_crc=True)
    print(f"sealed {count} records from {ulg.name}; edited record {n}")


if __name__ == "__main__":
    main()

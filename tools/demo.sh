#!/usr/bin/env bash
# End-to-end demo on a real PX4 flight log: seal it, verify it, then attack it three ways.
# Usage: tools/demo.sh [output-dir]      (needs the CLI built in build/ and pyulog installed)
set -euo pipefail
cd "$(dirname "$0")/.."
FSEAL=${FSEAL_BIN:-build/fseal}
OUT=${1:-demo-out}
rm -rf "$OUT" && mkdir -p "$OUT"
ULG=$(python3 tools/fetch_sample.py tests/.data)

say() { printf '\n## %s\n' "$*"; }
run() { printf '$ %s\n' "$*"; "$@"; }
expect_fail() { printf '$ %s\n' "$*"; if "$@"; then echo "!! expected this check to fail"; exit 1; fi; }

say "1. The drone (or ground station) has a signing key; investigators get only the public half"
PUB=$("$FSEAL" keygen "$OUT/drone.pem")
echo "public key: $PUB"

say "2. Seal a real PX4 flight (public sample log, 69 s of flight); a receipt goes to a third party every 5000 records"
python3 tools/ulog_to_records.py "$ULG" > "$OUT/flight.tsv"
run "$FSEAL" append "$OUT/flight.fseal" --key "$OUT/drone.pem" --receipts "$OUT/flight.receipts" --every 5000 < "$OUT/flight.tsv"
run "$FSEAL" verify "$OUT/flight.fseal" --receipts "$OUT/flight.receipts" --pubkey "$PUB"

say "3. Attack: lower one altitude reading by 10 m and fix that record's checksum"
N=$(python3 -c "import sys; sys.path.insert(0, 'tools'); import tamper; print(tamper.find_record('$OUT/flight.fseal', 'vehicle_local_position', 200))")
run python3 tools/tamper.py edit "$OUT/flight.fseal" "$OUT/edited.fseal" --record "$N" --field z --delta 10 --fix-crc
expect_fail "$FSEAL" verify "$OUT/edited.fseal"

say "4. Attack: the file's holder makes the same edit and recomputes every link after it"
run python3 tools/tamper.py edit "$OUT/flight.fseal" "$OUT/rewritten.fseal" --record "$N" --field z --delta 10 --rewrite
echo "# the hash chain alone cannot tell:"
run "$FSEAL" verify "$OUT/rewritten.fseal"
echo "# the receipts the third party kept can:"
expect_fail "$FSEAL" verify "$OUT/rewritten.fseal" --receipts "$OUT/flight.receipts" --pubkey "$PUB"

say "5. Attack: delete the last 2000 records (the end of the flight)"
run python3 tools/tamper.py drop-tail "$OUT/flight.fseal" "$OUT/short.fseal" --records 2000
expect_fail "$FSEAL" verify "$OUT/short.fseal" --receipts "$OUT/flight.receipts" --pubkey "$PUB"

say "Every attack was caught."

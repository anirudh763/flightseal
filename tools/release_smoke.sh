#!/usr/bin/env bash
# Checks a built fseal binary against the shipped samples and a fresh seal/verify round trip.
# Used by tools/release_build.sh inside a clean ubuntu:24.04 container, and by the tests on the host.
#   tools/release_smoke.sh path/to/fseal
set -u
BIN=${1:?usage: release_smoke.sh FSEAL_BINARY}
cd "$(dirname "$0")/.."
S=docs/samples
PUB=$(tr -d '[:space:]' < "$S/pubkey.txt")
failed=0

expect() {  # expect EXIT_STATUS TEXT DESCRIPTION -- COMMAND...
  local want=$1 text=$2 what=$3
  shift 4
  local out status
  out=$("$@" 2>&1)
  status=$?
  if [ "$status" -eq "$want" ] && grep -qF -- "$text" <<<"$out"; then
    echo "ok   $what"
  else
    echo "FAIL $what (exit $status, want $want and \"$text\")"
    echo "$out" | sed 's/^/     /'
    failed=1
  fi
}

expect 0 "fseal " "--version exits 0" -- "$BIN" --version
expect 0 "fseal verify LOG" "--help exits 0" -- "$BIN" --help
expect 0 "RESULT: INTACT" "intact sample with receipts" -- "$BIN" verify "$S/intact.fseal" --receipts "$S/flight.receipts" --pubkey "$PUB"
expect 1 "[bad-link]" "tampered sample: chain breaks" -- "$BIN" verify "$S/tampered.fseal"
expect 0 "RESULT: INTACT" "rewritten sample without receipts (the chain alone cannot tell)" -- "$BIN" verify "$S/rewritten.fseal"
expect 1 "log does not match this receipt" "rewritten sample with receipts" -- "$BIN" verify "$S/rewritten.fseal" --receipts "$S/flight.receipts" --pubkey "$PUB"
expect 1 "log is shorter than the receipt" "truncated sample with receipts" -- "$BIN" verify "$S/truncated.fseal" --receipts "$S/flight.receipts" --pubkey "$PUB"

# Sign and verify with a new key: exercises OpenSSL's Ed25519 and SHA-256 at run time.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
key=$("$BIN" keygen "$tmp/k.pem")
printf '1000\t{"z":1}\n2000\t{"z":2}\n3000\t{"z":3}\n' | "$BIN" append "$tmp/f.fseal" --key "$tmp/k.pem" --receipts "$tmp/f.receipts" --every 2 2>/dev/null
expect 0 "receipts     2 of 2 match" "new key: seal 3 records and verify" -- "$BIN" verify "$tmp/f.fseal" --receipts "$tmp/f.receipts" --pubkey "$key"

if [ "$failed" -ne 0 ]; then
  echo "release checks FAILED"
  exit 1
fi
echo "all release checks passed"

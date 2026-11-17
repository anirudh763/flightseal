"""The CLI refuses weak Ed25519 trusted keys (small-order or non-canonical) instead of trusting forged receipts.

Uses the shared vectors in tests/fixtures/ed25519-weak-keys.json (see make_ed25519_weak_keys.py there).
"""
import json
import subprocess
import sys

from conftest import ROOT
from fseal_py import scan

sys.path.insert(0, str(ROOT / "tests" / "fixtures"))
from make_ed25519_weak_keys import forge  # noqa: E402

FIXTURE = json.loads((ROOT / "tests/fixtures/ed25519-weak-keys.json").read_text())
SAMPLES = ROOT / "docs" / "samples"


def verify(fseal_bin, log, receipts, key):
    return subprocess.run([fseal_bin, "verify", str(log), "--receipts", str(receipts), "--pubkey", key], capture_output=True, text=True)


def test_every_weak_key_is_refused_with_a_clear_error(fseal_bin, tmp_path):
    receipts = tmp_path / "forged.receipts"
    for entry in FIXTURE["weak"]:
        count, head, sig = entry["count"] or 1, entry["head"] or "ab" * 32, entry["sig"] or "00" * 64
        receipts.write_text(f"fseal-receipt v1 count={count} head={head} key={entry['key']} sig={sig}\n")
        r = verify(fseal_bin, SAMPLES / "intact.fseal", receipts, entry["key"])
        assert (r.returncode, r.stdout) == (2, ""), entry["key"]
        assert r.stderr == f"verify: {FIXTURE['error']}\n", entry["key"]


def test_a_forged_receipt_for_a_real_log_no_longer_passes_as_intact(fseal_bin, tmp_path):
    # The attack: rewrite a log, then hand over receipts "signed" by the identity key, which any message verifies under.
    log = SAMPLES / "rewritten.fseal"
    s = scan(log)
    key = "01" + "00" * 31
    sig = forge(bytes.fromhex(key), s.records, s.head)
    assert sig is not None
    receipts = tmp_path / "forged.receipts"
    receipts.write_text(f"fseal-receipt v1 count={s.records} head={s.head.hex()} key={key} sig={sig.hex()}\n")
    r = verify(fseal_bin, log, receipts, key)
    assert "RESULT: INTACT" not in r.stdout
    assert (r.returncode, r.stderr) == (2, f"verify: {FIXTURE['error']}\n")


def test_real_receipts_still_verify(fseal_bin):
    key = (SAMPLES / "pubkey.txt").read_text().strip()
    r = verify(fseal_bin, SAMPLES / "intact.fseal", SAMPLES / "flight.receipts", key)
    assert r.returncode == 0 and "RESULT: INTACT" in r.stdout

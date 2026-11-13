"""Fail closed on OpenSSL errors: every EVP_* failure makes keygen, append and verify exit 2 with a clear message,
print no partial report, never print INTACT and never seal or sign anything.

The failures are injected with tests/fault/evp_fault.cpp, an LD_PRELOAD shim built next to the CLI
(libfseal_evp_fault.so). Under an ASan build, LeakSanitizer exits 23 on a leak, so exit status 2 also means no
OpenSSL context leaked on the error path.
"""
import os
import subprocess
from pathlib import Path

import pytest

from conftest import ROOT

LINES = "".join(f"{1000 * (i + 1)}\t{{\"z\":{i}}}\n" for i in range(6))


@pytest.fixture(scope="session")
def fault_shim(fseal_bin):
    path = Path(os.environ.get("FSEAL_EVP_FAULT", Path(fseal_bin).parent / "libfseal_evp_fault.so"))
    if not path.exists():
        pytest.fail(f"build the fault shim first (cmake --build build); missing {path}")
    return str(path)


def run_faulty(shim, spec, *args, stdin=None):
    env = dict(os.environ, FSEAL_EVP_FAIL=spec, LD_PRELOAD=shim)
    # An ASan binary refuses to start unless libasan is first in the preload list; the shim does not need that.
    env["ASAN_OPTIONS"] = ":".join(filter(None, [os.environ.get("ASAN_OPTIONS"), "verify_asan_link_order=0"]))
    return subprocess.run([str(a) for a in args], input=stdin, capture_output=True, text=True, env=env)


def assert_failed_closed(r, spec):
    name = spec.split("@")[0]
    assert r.returncode == 2, f"{spec}: exit {r.returncode}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    assert r.stdout == "", f"{spec}: partial output on stdout:\n{r.stdout}"
    assert "INTACT" not in r.stdout + r.stderr
    assert "LeakSanitizer" not in r.stderr and "AddressSanitizer" not in r.stderr, r.stderr
    if name != "PEM_write_PrivateKey":
        assert f"OpenSSL {name}" in r.stderr and "failed" in r.stderr, r.stderr
    else:
        assert "could not write key" in r.stderr, r.stderr


@pytest.fixture
def sealed(fseal_bin, tmp_path):
    key, log, rec = tmp_path / "k.pem", tmp_path / "f.fseal", tmp_path / "f.receipts"
    pub = subprocess.run([fseal_bin, "keygen", key], capture_output=True, text=True, check=True).stdout.strip()
    subprocess.run([fseal_bin, "append", log, "--key", key, "--receipts", rec, "--every", "3"],
                   input=LINES, capture_output=True, text=True, check=True)
    ok = subprocess.run([fseal_bin, "verify", log, "--receipts", rec, "--pubkey", pub], capture_output=True, text=True)
    assert ok.returncode == 0 and "RESULT: INTACT" in ok.stdout  # the shim is not loaded here
    return key, log, rec, pub


def test_shim_passes_calls_through_when_nothing_is_targeted(fseal_bin, fault_shim, sealed):
    _, log, rec, pub = sealed
    r = run_faulty(fault_shim, "none", fseal_bin, "verify", log, "--receipts", rec, "--pubkey", pub)
    assert r.returncode == 0 and "RESULT: INTACT" in r.stdout, r.stdout + r.stderr


@pytest.mark.parametrize("spec", ["EVP_PKEY_CTX_new_id", "EVP_PKEY_keygen_init", "EVP_PKEY_keygen",
                                  "EVP_PKEY_get_raw_public_key", "PEM_write_PrivateKey"])
def test_keygen_fails_closed(fseal_bin, fault_shim, tmp_path, spec):
    key = tmp_path / "k.pem"
    r = run_faulty(fault_shim, spec, fseal_bin, "keygen", key)
    assert_failed_closed(r, spec)
    assert not key.exists(), "no key file may be left behind"


@pytest.mark.parametrize("spec", ["EVP_MD_CTX_new", "EVP_DigestInit_ex", "EVP_DigestUpdate", "EVP_DigestFinal_ex",
                                  "EVP_DigestFinal_ex@4",  # a later record of the chain
                                  "EVP_PKEY_new_raw_public_key", "EVP_DigestVerifyInit", "EVP_DigestVerify",
                                  "EVP_DigestVerify@2"])
def test_verify_fails_closed(fseal_bin, fault_shim, sealed, spec):
    _, log, rec, pub = sealed
    r = run_faulty(fault_shim, spec, fseal_bin, "verify", log, "--receipts", rec, "--pubkey", pub)
    assert_failed_closed(r, spec)


@pytest.mark.parametrize("spec", ["EVP_DigestFinal_ex", "EVP_DigestUpdate"])
def test_verify_without_receipts_fails_closed(fseal_bin, fault_shim, sealed, spec):
    _, log, _, _ = sealed
    r = run_faulty(fault_shim, spec, fseal_bin, "verify", log)
    assert_failed_closed(r, spec)


@pytest.mark.parametrize("spec", ["EVP_MD_CTX_new", "EVP_DigestInit_ex", "EVP_DigestUpdate", "EVP_DigestFinal_ex",
                                  "EVP_PKEY_get_raw_public_key", "EVP_DigestSignInit", "EVP_DigestSign",
                                  "EVP_PKEY_new_raw_public_key", "EVP_DigestVerifyInit", "EVP_DigestVerify"])
def test_append_fails_closed_before_touching_any_file(fseal_bin, fault_shim, sealed, tmp_path, spec):
    key = sealed[0]
    log, rec = tmp_path / "new.fseal", tmp_path / "new.receipts"
    r = run_faulty(fault_shim, spec, fseal_bin, "append", log, "--key", key, "--receipts", rec, stdin=LINES)
    assert_failed_closed(r, spec)
    assert not log.exists(), "nothing may be sealed"
    assert not rec.exists(), "no receipt may be written"


@pytest.mark.parametrize("spec", ["EVP_DigestFinal_ex@6", "EVP_DigestSign@2"])
def test_append_stops_on_a_later_failure_and_signs_nothing_more(fseal_bin, fault_shim, sealed, tmp_path, spec):
    key = sealed[0]
    log, rec = tmp_path / "new.fseal", tmp_path / "new.receipts"
    r = run_faulty(fault_shim, spec, fseal_bin, "append", log, "--key", key, "--receipts", rec, "--every", "100",
                   stdin=LINES)
    assert_failed_closed(r, spec)
    assert rec.read_text() == "", "no receipt after a crypto failure"
    # Whatever was sealed before the failure is still a valid chain (no zero hashes written).
    v = subprocess.run([str(Path(fseal_bin)), "verify", log], capture_output=True, text=True)
    assert v.returncode == 0 and "RESULT: INTACT" in v.stdout, v.stdout

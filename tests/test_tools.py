import json
import re
import shutil

import fseal_py
import tamper
from conftest import run
from ulog_to_records import convert

LINES = "".join(f"{1000 * (i + 1)}\t{{\"topic\":\"vehicle_local_position\",\"z\":-{10 + i}.5}}\n" for i in range(8))


def seal(fseal_bin, tmp_path, lines=LINES, every=4):
    key, log, rec = tmp_path / "k.pem", tmp_path / "f.fseal", tmp_path / "f.receipts"
    pub = run(fseal_bin, "keygen", key).stdout.strip()
    r = run(fseal_bin, "append", log, "--key", key, "--receipts", rec, "--every", every, stdin=lines)
    assert r.returncode == 0, r.stderr
    return log, rec, pub


def verify(fseal_bin, log, rec=None, pub=None):
    extra = ["--receipts", rec, "--pubkey", pub] if rec else []
    return run(fseal_bin, "verify", log, *extra)


def first_problem(output):
    m = re.search(r"record (\d+), byte \d+: .*\[([a-z-]+)\]", output)
    return (m.group(2), int(m.group(1))) if m else None


def test_keygen_prints_public_key_and_never_overwrites(fseal_bin, tmp_path):
    first = run(fseal_bin, "keygen", tmp_path / "k.pem")
    assert first.returncode == 0 and re.fullmatch(r"[0-9a-f]{64}\n", first.stdout)
    assert run(fseal_bin, "keygen", tmp_path / "k.pem").returncode == 2


def test_sealed_log_verifies_intact_with_receipts(fseal_bin, tmp_path):
    log, rec, pub = seal(fseal_bin, tmp_path)
    r = verify(fseal_bin, log, rec, pub)
    assert r.returncode == 0, r.stdout
    assert "RESULT: INTACT" in r.stdout
    assert len(rec.read_text().splitlines()) == 2  # after record 4 and record 8


def test_edit_is_reported_at_the_edited_record(fseal_bin, tmp_path):
    log, _, _ = seal(fseal_bin, tmp_path)
    tamper.edit_field(log, tmp_path / "t.fseal", record=5, field="z", delta=10.0, fix_crc=True)
    r = verify(fseal_bin, tmp_path / "t.fseal")
    assert r.returncode == 1 and "RESULT: TAMPERED" in r.stdout
    assert first_problem(r.stdout) == ("bad-link", 5)


def test_receipts_catch_a_full_rewrite(fseal_bin, tmp_path):
    log, rec, pub = seal(fseal_bin, tmp_path)
    tamper.edit_field(log, tmp_path / "t.fseal", record=5, field="z", delta=10.0, rewrite=True)
    assert verify(fseal_bin, tmp_path / "t.fseal").returncode == 0  # chain alone is fooled
    r = verify(fseal_bin, tmp_path / "t.fseal", rec, pub)
    assert r.returncode == 1 and "rewritten" in r.stdout


def test_receipts_catch_tail_deletion(fseal_bin, tmp_path):
    log, rec, pub = seal(fseal_bin, tmp_path)
    tamper.drop_tail(log, tmp_path / "t.fseal", records=3)
    assert verify(fseal_bin, tmp_path / "t.fseal").returncode == 0
    r = verify(fseal_bin, tmp_path / "t.fseal", rec, pub)
    assert r.returncode == 1 and "removed from the end" in r.stdout


def test_receipts_need_a_trusted_public_key(fseal_bin, tmp_path):
    log, rec, _ = seal(fseal_bin, tmp_path)
    assert run(fseal_bin, "verify", log, "--receipts", rec).returncode == 2


def test_recover_trims_a_torn_tail_and_nothing_else(fseal_bin, tmp_path):
    log, _, _ = seal(fseal_bin, tmp_path)
    data = log.read_bytes()
    log.write_bytes(data[:-7])
    assert verify(fseal_bin, log).returncode == 1
    r = run(fseal_bin, "recover", log)
    assert r.returncode == 0 and "trimmed" in r.stdout
    assert verify(fseal_bin, log).returncode == 0
    mid = bytearray(log.read_bytes())
    mid[60] ^= 1
    log.write_bytes(bytes(mid))
    assert run(fseal_bin, "recover", log).returncode == 1
    assert log.read_bytes() == bytes(mid)


def test_python_reader_agrees_with_the_cli_on_every_attack(fseal_bin, tmp_path):
    log, _, _ = seal(fseal_bin, tmp_path)
    attacks = {
        "flip": lambda o: tamper.flip_bit(log, o, record=3),
        "edit": lambda o: tamper.edit_field(log, o, record=3, field="z", delta=10.0),
        "edit-fix-crc": lambda o: tamper.edit_field(log, o, record=3, field="z", delta=10.0, fix_crc=True),
        "delete": lambda o: tamper.delete(log, o, record=3),
        "swap": lambda o: tamper.swap(log, o, record=3),
        "duplicate": lambda o: tamper.duplicate(log, o, record=3),
        "torn": lambda o: o.write_bytes(log.read_bytes()[:-5]),
    }
    for name, attack in attacks.items():
        out = tmp_path / f"{name}.fseal"
        attack(out)
        cli = first_problem(verify(fseal_bin, out).stdout)
        py = fseal_py.scan(out)
        assert cli is not None, name
        assert (py.problem, py.records) == cli, name
    shutil.copy(log, tmp_path / "clean.fseal")
    assert fseal_py.scan(tmp_path / "clean.fseal").problem is None


def test_px4_sample_converts_to_ordered_records(sample_ulg):
    lines = list(convert(sample_ulg))
    assert len(lines) == 64542
    stamps = [int(line.split("\t", 1)[0]) for line in lines]
    assert stamps == sorted(stamps)
    assert json.loads(lines[0].split("\t", 1)[1])["topic"]


def test_px4_flight_seals_and_an_altitude_edit_is_caught(fseal_bin, sample_ulg, tmp_path):
    lines = "".join(line + "\n" for line in convert(sample_ulg))
    log, rec, pub = seal(fseal_bin, tmp_path, lines=lines, every=5000)
    assert verify(fseal_bin, log, rec, pub).returncode == 0
    n = tamper.find_record(log, topic="vehicle_local_position", nth=200)
    tamper.edit_field(log, tmp_path / "t.fseal", record=n, field="z", delta=10.0, fix_crc=True)
    r = verify(fseal_bin, tmp_path / "t.fseal", rec, pub)
    assert r.returncode == 1 and first_problem(r.stdout) == ("bad-link", n)


def test_receipts_past_a_damaged_record_are_not_blamed_on_deletion(fseal_bin, tmp_path):
    log, rec, pub = seal(fseal_bin, tmp_path)
    tamper.flip_bit(log, tmp_path / "t.fseal", record=2)
    r = verify(fseal_bin, tmp_path / "t.fseal", rec, pub)
    assert r.returncode == 1 and first_problem(r.stdout) == ("bad-crc", 2)
    assert "removed from the end" not in r.stdout
    assert "cannot be checked past the first problem" in r.stdout

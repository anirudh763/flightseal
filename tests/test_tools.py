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


def test_append_refuses_a_receipts_path_it_cannot_open_before_sealing(fseal_bin, tmp_path):
    key = tmp_path / "k.pem"
    run(fseal_bin, "keygen", key)
    log = tmp_path / "f.fseal"
    r = run(fseal_bin, "append", log, "--key", key, "--receipts", tmp_path / "missing" / "f.receipts", stdin=LINES)
    assert r.returncode == 2, r.stderr
    assert "cannot write receipts" in r.stderr
    assert "issued" not in r.stderr
    assert not log.exists()  # nothing sealed without somewhere to put the receipts


def test_append_fails_when_a_receipt_cannot_be_written(fseal_bin, tmp_path):
    key = tmp_path / "k.pem"
    run(fseal_bin, "keygen", key)
    r = run(fseal_bin, "append", tmp_path / "f.fseal", "--key", key, "--receipts", "/dev/full", "--every", 4, stdin=LINES)
    assert r.returncode == 2, r.stderr
    assert "cannot write receipts" in r.stderr
    assert "issued" not in r.stderr


def test_receipts_signed_by_an_untrusted_key_are_unverified_not_tampered(fseal_bin, tmp_path):
    log, _, pub = seal(fseal_bin, tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    _, other_rec, _ = seal(fseal_bin, other)  # the same records, receipts signed by a key nobody trusts
    r = verify(fseal_bin, log, other_rec, pub)
    assert r.returncode == 3, r.stdout
    assert "RESULT: UNVERIFIED" in r.stdout and "TAMPERED" not in r.stdout
    assert "receipt 1 (count 4): signed by a different key than the one you trust (not evidence either way)" in r.stdout
    forged = tmp_path / "forged.receipts"  # the trusted key's name on it, but a signature anyone could write
    _, rec, _ = log, tmp_path / "f.receipts", pub
    forged.write_text("".join(line[: line.index("sig=") + 4] + "0" * 128 + "\n" for line in rec.read_text().splitlines()))
    r = verify(fseal_bin, log, forged, pub)
    assert r.returncode == 3 and "RESULT: UNVERIFIED" in r.stdout and "signature invalid" in r.stdout
    tamper.edit_field(log, tmp_path / "t.fseal", record=5, field="z", delta=10.0, fix_crc=True)
    r = verify(fseal_bin, tmp_path / "t.fseal", other_rec, pub)  # a broken chain is proof on its own
    assert r.returncode == 1 and "RESULT: TAMPERED" in r.stdout


def test_a_torn_log_with_only_untrusted_receipts_is_incomplete_not_tampered(fseal_bin, tmp_path):
    log, rec, pub = seal(fseal_bin, tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    _, other_rec, _ = seal(fseal_bin, other)
    log.write_bytes(log.read_bytes()[:-5])  # a crash cut the last record short
    r = verify(fseal_bin, log, other_rec, pub)
    assert r.returncode == 1 and "RESULT: INCOMPLETE" in r.stdout and "TAMPERED" not in r.stdout, r.stdout
    assert "cannot be checked" not in r.stdout  # an untrusted receipt is untrusted, wherever it points
    r = verify(fseal_bin, log, rec, pub)  # authenticated receipts keep the documented TAMPERED
    assert r.returncode == 1 and "RESULT: TAMPERED" in r.stdout


def test_recover_refuses_to_trim_complete_records_after_a_corrupt_length(fseal_bin, tmp_path):
    lines = "".join(f"{1000 * (i + 1)}\t{{\"z\":{i}}}\n" for i in range(100))
    log, rec, pub = seal(fseal_bin, tmp_path, lines=lines, every=10)
    data = bytearray(log.read_bytes())
    off = 8
    for _ in range(50):
        off += 20 + int.from_bytes(data[off:off + 4], "little") + 36
    data[off + 1] |= 0x40  # bit 14 of record 50's length
    log.write_bytes(bytes(data))
    r = run(fseal_bin, "recover", log)
    assert r.returncode != 0 and not re.search(r"trimmed \d+ bytes", r.stdout), r.stdout
    assert log.read_bytes() == bytes(data)
    r = run(fseal_bin, "append", log, stdin="99999\t{}\n")
    assert r.returncode != 0 and log.read_bytes() == bytes(data)
    v = verify(fseal_bin, log)
    assert first_problem(v.stdout) == ("bad-length", 50) and "INCOMPLETE" not in v.stdout


def test_verify_never_skips_receipts_silently(fseal_bin, tmp_path):
    log, rec, pub = seal(fseal_bin, tmp_path)
    tamper.drop_tail(log, tmp_path / "short.fseal", records=3)
    short = tmp_path / "short.fseal"
    (tmp_path / "empty.receipts").write_text("")
    for args in (["--receipt", rec, "--pubkey", pub], ["--pubkey", pub], ["--receipts", tmp_path / "empty.receipts", "--pubkey", pub]):
        r = run(fseal_bin, "verify", short, *args)
        assert r.returncode == 2, (args, r.stdout)
        assert "INTACT" not in r.stdout
    assert run(fseal_bin, "recover", short, "--force", "yes").returncode == 2
    assert run(fseal_bin, "append", short, "--keys", "k.pem", stdin="").returncode == 2


def test_append_checks_the_key_before_sealing_anything(fseal_bin, tmp_path):
    lines = "".join(f"{i + 1}\t{{\"z\":{i}}}\n" for i in range(1500))
    log = tmp_path / "f.fseal"
    r = run(fseal_bin, "append", log, "--key", tmp_path / "missing.pem", "--receipts", tmp_path / "f.receipts", stdin=lines)
    assert r.returncode == 2
    assert not log.exists() or len(fseal_py.scan(log).items) == 0


def test_append_issues_a_receipt_for_sealed_records_before_failing(fseal_bin, tmp_path):
    good = "".join(f"{i + 1}\t{{\"z\":{i}}}\n" for i in range(1499))
    key = tmp_path / "k.pem"
    run(fseal_bin, "keygen", key)
    for name, bad in (("blank", "\n"), ("oversize", "2000\t" + "x" * (fseal_py.MAX_PAYLOAD + 1) + "\n")):
        log, rec = tmp_path / f"{name}.fseal", tmp_path / f"{name}.receipts"
        r = run(fseal_bin, "append", log, "--key", key, "--receipts", rec, stdin=good + bad + "3000\t{}\n")
        assert r.returncode == 2, (name, r.stderr)
        assert rec.read_text().splitlines()[-1].split()[2] == "count=1499", name


def test_receipts_from_another_flight_with_the_same_key_are_not_called_a_rewrite(fseal_bin, tmp_path):
    key = tmp_path / "k.pem"
    pub = run(fseal_bin, "keygen", key).stdout.strip()
    for name, lines in (("a", LINES), ("b", LINES.replace("-1", "-2"))):
        run(fseal_bin, "append", tmp_path / f"{name}.fseal", "--key", key, "--receipts", tmp_path / f"{name}.receipts", "--every", 4, stdin=lines)
    r = verify(fseal_bin, tmp_path / "b.fseal", tmp_path / "a.receipts", pub)
    assert r.returncode == 1
    assert "or these receipts belong to another log sealed with the same key" in r.stdout


def test_a_crafted_tail_of_follow_on_candidates_is_fast_in_the_cli_and_the_python_reader(fseal_bin, tmp_path):
    import struct
    import time

    body = b"FLTSEAL1" + struct.pack("<IQQ", 0xF0000, 0, 0)
    data = body + struct.pack("<IQ", 500_000, 1) * ((980_000 - len(body)) // 12)
    log = tmp_path / "crafted.fseal"
    log.write_bytes(data)
    t = time.monotonic()
    v = verify(fseal_bin, log)
    r = run(fseal_bin, "recover", log)
    assert time.monotonic() - t < 4.0  # both commands; about a minute each before the candidate cap
    assert first_problem(v.stdout) == ("bad-length", 0)
    assert r.returncode == 1 and log.read_bytes() == data
    t = time.monotonic()
    assert fseal_py.scan(log).problem == "bad-length"
    assert time.monotonic() - t < 2.0

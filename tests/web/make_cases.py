"""Builds the files the JS cross-check test runs on, and records what the independent Python reader says.

  python3 tests/web/make_cases.py FSEAL_BIN OUT_DIR [PX4_ULG]   -> writes OUT_DIR/cases.json

Every case is a log (plus optional receipts and trusted key). The Node test runs the C++ CLI and the JS
verifier on each and requires identical reports; it also requires the JS scan to equal the Python scan here.
"""
import json
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import fseal_py  # noqa: E402
import tamper  # noqa: E402

# Same records as tests/test_tools.py: 8 records, a receipt every 4.
LINES = "".join(f"{1000 * (i + 1)}\t{{\"topic\":\"vehicle_local_position\",\"z\":-{10 + i}.5}}\n" for i in range(8))


def run(*args, stdin=None):
    return subprocess.run([str(a) for a in args], input=stdin, capture_output=True, text=True, check=True).stdout


def seal(fseal, folder, lines, every, tag):
    key, log, rec = folder / f"{tag}.pem", folder / f"{tag}.fseal", folder / f"{tag}.receipts"
    pub = run(fseal, "keygen", key).strip()
    run(fseal, "append", log, "--key", key, "--receipts", rec, "--every", every, stdin=lines)
    return log, rec, pub


def with_first_seq(log, seq):
    """The log with record 0's sequence number replaced and its checksum recomputed (so the seq check fires)."""
    recs = fseal_py.scan(log).items
    r = recs[0]
    recs[0] = fseal_py.Record(seq, r.timestamp_us, r.payload, r.link)
    return fseal_py.MAGIC + b"".join(x.encode() for x in recs)


def main():
    fseal, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    log, rec, pub = seal(fseal, out, LINES, 4, "base")
    _, other_rec, _ = seal(fseal, out, LINES, 4, "other")  # same records, a different signing key
    cases = []

    def add(name, path, receipts=None, key=None):
        cases.append({"name": name, "log": str(path), "receipts": str(receipts) if receipts else None, "pubkey": key})

    add("clean", log)
    add("clean+receipts", log, rec, pub)

    # The 7 attacks of tests/test_tools.py, each without and with receipts.
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
        path = out / f"{name}.fseal"
        attack(path)
        add(name, path)
        add(name + "+receipts", path, rec, pub)

    # Attacks only receipts can catch.
    tamper.edit_field(log, out / "rewrite.fseal", record=5, field="z", delta=10.0, rewrite=True)
    add("rewrite", out / "rewrite.fseal")
    add("rewrite+receipts", out / "rewrite.fseal", rec, pub)
    tamper.drop_tail(log, out / "drop-tail.fseal", records=3)
    add("drop-tail", out / "drop-tail.fseal")
    add("drop-tail+receipts", out / "drop-tail.fseal", rec, pub)

    # Receipt attacks on the untouched log.
    add("receipts-from-another-key", log, other_rec, pub)
    add("torn+receipts-from-another-key", out / "torn.fseal", other_rec, pub)
    add("flip+receipts-from-another-key", out / "flip.fseal", other_rec, pub)
    lines = rec.read_text().splitlines()
    sig_at = lines[0].index("sig=") + 4
    flipped = lines[0][:sig_at] + ("1" if lines[0][sig_at] != "1" else "2") + lines[0][sig_at + 1:]
    (out / "altered-sig.receipts").write_text("\n".join([flipped] + lines[1:]) + "\n")
    add("altered-signature", log, out / "altered-sig.receipts", pub)
    (out / "altered-count.receipts").write_text("\n".join([lines[0].replace("count=4", "count=3")] + lines[1:]) + "\n")
    add("altered-count", log, out / "altered-count.receipts", pub)
    (out / "empty.receipts").write_text("")
    add("empty-receipts-file", log, out / "empty.receipts", pub)
    add("torn+empty-receipts", out / "torn.fseal", out / "empty.receipts", pub)

    # Hostile and malformed logs.
    data = log.read_bytes()
    first_len = struct.unpack_from("<I", data, 8)[0]
    second = 8 + 20 + first_len + 36
    hostile = {
        "empty-file": b"",
        "magic-only": b"FLTSEAL1",
        "torn-magic": b"FLTS",
        "bad-header": b"NOTSEAL!" + data[8:],
        "short-garbage": b"\x00\xff",
        "length-0xffffffff": data[:second] + b"\xff\xff\xff\xff" + data[second + 4:],
        "length-max-payload-torn": data[:second] + struct.pack("<I", fseal_py.MAX_PAYLOAD) + data[second + 4:],
        "length-max-plus-one": data[:second] + struct.pack("<I", fseal_py.MAX_PAYLOAD + 1) + data[second + 4:],
        "header-only": data[:second + 20],
        "seq-2^32": with_first_seq(log, 1 << 32),
        "seq-2^63": with_first_seq(log, 1 << 63),
        "zeros-after-magic": b"FLTSEAL1" + bytes(4096),
        "random-after-magic": b"FLTSEAL1" + bytes((i * 2654435761 >> 7) & 0xFF for i in range(5000)),
    }
    for name, blob in hostile.items():
        (out / f"{name}.fseal").write_bytes(blob)
        add(name, out / f"{name}.fseal")
    add("bad-header+receipts", out / "bad-header.fseal", rec, pub)

    # Timestamps that go backwards are counted, not rejected.
    back, _, _ = seal(fseal, out, "10\ta\n5\tb\n20\tc\n3\td\n", 2, "backwards")
    add("time-reversals", back)

    # The committed browser samples must still verify the way the page says.
    samples = ROOT / "docs" / "samples"
    spub = (samples / "pubkey.txt").read_text().strip()
    for s in ["intact", "tampered", "rewritten", "truncated"]:
        add(f"sample-{s}", samples / f"{s}.fseal", samples / "flight.receipts", spub)
        add(f"sample-{s}-chain-only", samples / f"{s}.fseal")

    # Edits around the verifier's 256-record hashing batches (records 255, 256, 257 of the 800-record sample),
    # checksum fixed, so only the link check can catch them.
    for n in (255, 256, 257, 511, 512):
        path = out / f"batch-edge-{n}.fseal"
        tamper.edit_field(samples / "intact.fseal", path, record=n, field="instance", delta=1, fix_crc=True)
        add(f"batch-edge-{n}", path)
        add(f"batch-edge-{n}+receipts", path, samples / "flight.receipts", spub)

    # The real PX4 flight (64,542 records), if it has been downloaded.
    if len(sys.argv) > 3 and Path(sys.argv[3]).exists():
        sys.path.insert(0, str(ROOT / "tools"))
        from ulog_to_records import convert

        px4 = "".join(line + "\n" for line in convert(sys.argv[3]))
        plog, prec, ppub = seal(fseal, out, px4, 5000, "px4")
        n = tamper.find_record(plog, "vehicle_local_position", 200)
        tamper.edit_field(plog, out / "px4-edited.fseal", record=n, field="z", delta=10.0, fix_crc=True)
        tamper.edit_field(plog, out / "px4-rewritten.fseal", record=n, field="z", delta=10.0, rewrite=True)
        add("px4", plog, prec, ppub)
        add("px4-edited", out / "px4-edited.fseal", prec, ppub)
        add("px4-rewritten", out / "px4-rewritten.fseal", prec, ppub)

    for c in cases:
        s = fseal_py.scan(c["log"])
        c["python"] = {"problem": s.problem, "records": s.records, "head": s.head.hex()}

    # Malformed receipts files: the CLI and the JS parser must reject the same line.
    zero64, zero128 = "0" * 64, "0" * 128
    good = lines[0]
    bad_receipts = {
        "count-overflow": f"fseal-receipt v1 count=99999999999999999999 head={zero64} key={zero64} sig={zero128}",
        "count-2^64": f"fseal-receipt v1 count=18446744073709551616 head={zero64} key={zero64} sig={zero128}",
        "uppercase-hex": good[: good.index("head=") + 5] + good[good.index("head=") + 5 : good.index("head=") + 69].upper()
        + good[good.index("head=") + 69 :],
        "blank-line": "",
        "short-sig": good[:-2],
        "wrong-version": good.replace(" v1 ", " v2 "),
        "negative-count": good.replace("count=4", "count=-4"),
        "garbage": "hello world",
    }
    malformed = []
    for name, line in bad_receipts.items():
        path = out / f"malformed-{name}.receipts"
        path.write_text(good + "\n" + line + "\n" + lines[1] + "\n")
        malformed.append({"name": name, "log": str(log), "receipts": str(path), "pubkey": pub, "line": 2})
    # A UTF-8 byte-order mark: the CLI reads bytes and rejects line 1; a text decoder that strips it would not.
    (out / "malformed-bom.receipts").write_bytes(b"\xef\xbb\xbf" + rec.read_bytes())
    malformed.append({"name": "utf8-bom", "log": str(log), "receipts": str(out / "malformed-bom.receipts"), "pubkey": pub, "line": 1})

    # Unauthenticated receipts: right key, counts and heads, but every signature replaced by zeros (a forgery
    # anyone can write); and one bogus receipt claiming 2 records for a 1-record log.
    zeroed = [ln[: ln.index("sig=") + 4] + "0" * 128 for ln in lines]
    (out / "zero-sig.receipts").write_text("\n".join(zeroed) + "\n")
    one, _, one_pub = seal(fseal, out, "1000\t{\"z\":1}\n", 100, "one")
    (out / "bogus-count2.receipts").write_text(f"fseal-receipt v1 count=2 head={zero64} key={one_pub} sig={zero128}\n")
    unsigned = {
        "zero-sig": {"log": str(log), "receipts": str(out / "zero-sig.receipts"), "pubkey": pub},
        "zero-sig-on-edited-log": {"log": str(out / "edit-fix-crc.fseal"), "receipts": str(out / "zero-sig.receipts"), "pubkey": pub},
        "zero-sig-on-torn-log": {"log": str(out / "torn.fseal"), "receipts": str(out / "zero-sig.receipts"), "pubkey": pub},
        "other-key-on-torn-log": {"log": str(out / "torn.fseal"), "receipts": str(other_rec), "pubkey": pub},
        "bogus-count2-one-record": {"log": str(one), "receipts": str(out / "bogus-count2.receipts"), "pubkey": one_pub},
        "other-key-unsigned": {"log": str(log), "receipts": str(other_rec), "pubkey": pub},
    }

    (out / "cases.json").write_text(json.dumps({"cases": cases, "malformed": malformed, "unsigned": unsigned}, indent=1))


if __name__ == "__main__":
    main()

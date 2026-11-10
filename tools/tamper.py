"""Attack simulator: writes a tampered copy of a sealed log and leaves the original alone.

  python tools/tamper.py edit LOG OUT --record N [--field z --delta 10] [--fix-crc | --rewrite]
  python tools/tamper.py {flip,delete,swap,duplicate} LOG OUT --record N
  python tools/tamper.py drop-tail LOG OUT --records N

--fix-crc models someone who recomputes the checksum of the record they edited.
--rewrite models the file's holder recomputing every link and checksum after the edit.
"""
import argparse
import json

from fseal_py import HEADER, MAGIC, Record, link, scan


def _records(log):
    s = scan(log)
    if s.problem:
        raise SystemExit(f"{log}: already damaged ({s.problem} at record {s.records})")
    return s.items


def _write(out, records):
    with open(out, "wb") as f:
        f.write(MAGIC + b"".join(r.encode() for r in records))


def flip_bit(log, out, record):
    data = bytearray(open(log, "rb").read())
    offset = len(MAGIC) + sum(len(r.encode()) for r in _records(log)[:record])
    data[offset + HEADER.size] ^= 0x01  # first payload byte
    open(out, "wb").write(bytes(data))


def edit_field(log, out, record, field, delta, fix_crc=False, rewrite=False):
    recs = _records(log)
    r = recs[record]
    obj = json.loads(r.payload)
    obj[field] = obj[field] + delta
    payload = json.dumps(obj, separators=(",", ":")).encode()
    recs[record] = Record(r.seq, r.timestamp_us, payload, r.link, None if (fix_crc or rewrite) else r.crc)
    if rewrite:  # recompute every link from the edit onwards, as the file's holder could
        prev = recs[record - 1].link if record else bytes(32)
        for i in range(record, len(recs)):
            x = recs[i]
            recs[i] = Record(x.seq, x.timestamp_us, x.payload, link(prev, x.seq, x.timestamp_us, x.payload))
            prev = recs[i].link
    _write(out, recs)


def delete(log, out, record):
    recs = _records(log)
    _write(out, recs[:record] + recs[record + 1 :])


def swap(log, out, record):
    recs = _records(log)
    recs[record], recs[record + 1] = recs[record + 1], recs[record]
    _write(out, recs)


def duplicate(log, out, record):
    recs = _records(log)
    _write(out, recs[: record + 1] + [recs[record]] + recs[record + 1 :])


def drop_tail(log, out, records):
    _write(out, _records(log)[:-records])


def find_record(log, topic, nth=0):
    """Index of the nth record whose JSON payload has this topic."""
    hits = [i for i, r in enumerate(_records(log)) if json.loads(r.payload).get("topic") == topic]
    return hits[nth]


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("attack", choices=["edit", "flip", "delete", "swap", "duplicate", "drop-tail"])
    p.add_argument("log")
    p.add_argument("out")
    p.add_argument("--record", type=int, default=0)
    p.add_argument("--records", type=int, default=1)
    p.add_argument("--field", default="z")
    p.add_argument("--delta", type=float, default=10.0)
    p.add_argument("--fix-crc", action="store_true")
    p.add_argument("--rewrite", action="store_true")
    a = p.parse_args()
    if a.attack == "edit":
        edit_field(a.log, a.out, a.record, a.field, a.delta, a.fix_crc, a.rewrite)
    elif a.attack == "drop-tail":
        drop_tail(a.log, a.out, a.records)
    else:
        {"flip": flip_bit, "delete": delete, "swap": swap, "duplicate": duplicate}[a.attack](a.log, a.out, a.record)

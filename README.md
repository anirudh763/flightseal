# FlightSeal

**An evidence seal for drone flight logs: edit, delete or reorder one record and verification fails.**

![ci](https://github.com/anirudh763/flightseal/actions/workflows/ci.yml/badge.svg)

Drone flight logs end up as evidence: after a crash, an airspace violation, an insurance claim or a delivery dispute,
someone has to decide whether the log in front of them is the log the drone wrote. The usual practice is to hash the
file when an investigator receives it, which says nothing about what happened to it before that.

FlightSeal seals the log while it is being written. Every record is chained to the one before it, and every few
thousand records a signed receipt goes to someone else (an investigator, the operator's company, an insurer). Later,
anyone with the log, the receipts and the drone's public key can check that nothing was changed, removed or
reordered, and find the exact record where tampering starts.

C++17 core (OpenSSL SHA-256 and Ed25519), Python tools for PX4 flight logs, tests under AddressSanitizer and UBSan.

## See it work

Output from [`tools/demo.sh`](tools/demo.sh) on a public PX4 flight log (69 s of flight, 64,542 logged samples), with
paths and the key shortened and a few lines trimmed:

```
$ fseal append flight.fseal --key drone.pem --receipts flight.receipts --every 5000
sealed 64542 records (log now has 64542), issued 13 receipt(s) to flight.receipts

$ fseal verify flight.fseal --receipts flight.receipts --pubkey eed39ebf…681397
  records      64542 intact
  receipts     13 of 13 match; 0 record(s) after the last receipt are not covered
RESULT: INTACT

# Attack 1: lower one altitude reading by 10 m and recompute that record's checksum
$ fseal verify edited.fseal
  first problem  record 33843, byte 13382731: hash-chain break (a record's contents changed after sealing) [bad-link]
RESULT: TAMPERED

# Attack 2: the file's holder makes the same edit and recomputes every link after it
$ fseal verify rewritten.fseal                      # the hash chain alone cannot tell
RESULT: INTACT
$ fseal verify rewritten.fseal --receipts flight.receipts --pubkey eed39ebf…681397
  receipt 7 (count 35000): log does not match the receipt (it was rewritten after the receipt was issued)
RESULT: TAMPERED

# Attack 3: delete the last 2000 records (the end of the flight)
$ fseal verify short.fseal --receipts flight.receipts --pubkey eed39ebf…681397
  receipt 13 (count 64542): log is shorter than the receipt (records were removed from the end)
RESULT: TAMPERED
```

Attack 2 is the reason receipts exist: whoever holds the file can always rebuild a self-consistent chain. What they
cannot change is the receipts someone else already holds.

## What it proves, and what it does not

| Change made after sealing | Caught by | Reported at |
|---|---|---|
| Accidental damage, flipped bits | CRC-32 per record | that record |
| Edited value, even with the checksum fixed | SHA-256 hash chain | that record |
| Deleted, reordered or duplicated record | sequence numbers | that record |
| Records deleted from the end | a receipt kept by someone else | that receipt |
| Whole log rewritten after an edit | a receipt kept by someone else | first receipt after the edit |
| Forged or altered receipt | Ed25519 signature, checked against a key you trust | that receipt |
| Crash in the middle of a write | torn final record | `fseal recover` trims only that |

It does **not** prove that the data was true when it was sealed (a spoofed sensor or an edit before sealing looks
normal), it cannot protect records written after the last receipt, and it cannot help if the signing key leaks and
the receipt holder is compromised too. Timestamps are stored but not trusted: clocks reset at boot, so ordering uses
sequence numbers and `verify` reports timestamps that go backwards. The full list is in
[THREAT_MODEL.md](THREAT_MODEL.md).

## How it works

```
file     = "FLTSEAL1" record*
record   = length u32 | seq u64 | timestamp_us u64 | payload | link (32 bytes) | crc32 u32     (little-endian)
link[i]  = SHA-256(link[i-1] | seq | timestamp_us | length | payload),  link[-1] = 32 zero bytes
receipt  = fseal-receipt v1 count=N head=link[N-1] key=<Ed25519 public key> sig=<signature over count and head>
```

- **Checks, in order:** checksum, then sequence number, then link. The first failure names the record and the reason.
- **Receipts** are issued only after the records they cover are on disk (`fsync`), so a crash can never make an honest
  log look tampered.
- **Recovery** trims a final record that a crash cut short, and nothing else. A bad record in the middle, or a complete
  final record with a bad checksum, is reported and left in place: truncating it would destroy evidence.
- **Durability:** records are buffered and made durable every 1,000 records (or after every record with
  `--sync every`). Records acknowledged by a sync survive a crash; the kill -9 test checks exactly that.

Every design choice, the alternative that was rejected and why, is in [DECISIONS.md](DECISIONS.md).

## Quick start

```
sudo apt-get install cmake g++ libssl-dev libsqlite3-dev
pip install pyulog pytest
cmake -S . -B build && cmake --build build -j
ctest --test-dir build && python -m pytest -q    # C++ and Python tests
tools/demo.sh                                    # the demo above
```

Seal your own PX4 log:

```
build/fseal keygen drone.pem          # keep drone.pem secret; give the printed public key to investigators
python3 tools/ulog_to_records.py flight.ulg | build/fseal append flight.fseal --key drone.pem --receipts flight.receipts
build/fseal verify flight.fseal --receipts flight.receipts --pubkey <public key>
```

`fseal append` reads `timestamp_us<TAB>payload` lines, so any telemetry source can feed it.

## Results

Measured with `build-release/fseal-bench records.tsv <dir> 5` on the PX4 flight above (64,542 records, mean payload
413 bytes), median of 5 runs. Environment: Intel Xeon @ 2.10 GHz, 2 vCPUs, ext4 on a cloud VM disk, SQLite 3.45.1.

| system | made durable every | records | records/s | MB/s of payload | file size |
|---|---|---|---|---|---|
| plain append log (CRC only, no tamper evidence) | 1,000 records | 64,542 | 419,931 | 173.6 | 27.7 MB |
| **FlightSeal** | 1,000 records | 64,542 | **266,036** | **110.0** | 30.3 MB |
| SQLite, WAL mode, `synchronous=FULL` | 1,000 records | 64,542 | 271,519 | 112.2 | 30.4 MB |
| plain append log | every record | 5,000 | 5,313 | 3.2 | 3.1 MB |
| **FlightSeal** | every record | 5,000 | **5,605** | **3.4** | 3.3 MB |
| SQLite, WAL mode, `synchronous=FULL` | every record | 5,000 | 6,284 | 3.8 | 3.6 MB |

- Tamper evidence costs about 37% of raw append speed, and FlightSeal ingests at roughly the same rate as SQLite with
  the same durability. With one `fsync` per record, all three are limited by the disk.
- Verifying the whole flight (checksums, sequence numbers, SHA-256 chain): **213 ms**. Recovering after a torn final
  record (scan, trim, `fsync`): **339 ms**.
- The sample flight logged about 935 samples per second (64,542 in 69 s), far below either rate. These numbers come
  from one cloud VM; a drone's flight computer will be slower, so rerun the benchmark on the target hardware.

## Tests

- **C++** ([tests/test_fseal.cpp](tests/test_fseal.cpp)), built with AddressSanitizer and UBSan in CI: a flipped bit,
  an edit with a recomputed checksum, a deleted, reordered or duplicated record, a torn final record at every byte
  offset, corruption in the middle (never truncated), a wrong key, an altered receipt, records deleted from the end,
  a full rewrite, and **kill -9 at 25 random moments** with no acknowledged record lost. The kill test was checked
  against a deliberately broken `sync()`: it failed all 25 rounds.
- **Python** ([tests/test_tools.py](tests/test_tools.py)): an independent reader written from the format description
  ([tools/fseal_py.py](tools/fseal_py.py), no shared code) must agree with the CLI on 7 attacks; the real PX4 flight
  is sealed and an altitude edit is found at the right record.

## Why not immudb, Trillian or Sigstore Rekor?

They are services: an immutable database (immudb) and transparency logs (Trillian, Rekor) that run on servers and
answer queries. A drone or its ground station is often offline, and what an investigator receives is a file.
FlightSeal is a small library and a single-file format that works offline, and its receipts are one line of text that
can be emailed. Publishing those receipts to a transparency log like Rekor would remove the need to trust a single
receipt holder; that is a next step.

## Next steps

- Detect edits made *before* sealing by cross-checking sensors (GPS against IMU, barometer against GPS altitude,
  both against the flight controller's own position estimate).
- Merkle-tree proofs, so a single record can be checked without the whole log.
- Publish receipts to a public transparency log.
- Test durability under real power loss, not only process kills and torn writes.

## How this was built

Built by Anirudh Yadav Boosa with AI assistance (Claude) for design review and code. The design was pressure-tested
before any code was written, every decision is written down in [DECISIONS.md](DECISIONS.md), and every number in this
README comes from a run of the commands above.

## License

MIT. The PX4 sample flight log used by the tests and the demo is downloaded at run time from
[PX4/pyulog](https://github.com/PX4/pyulog) (BSD-3-Clause), pinned by commit and SHA-256, and is not included here.

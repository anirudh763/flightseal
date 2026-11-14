# Design decisions

Each decision, the alternative that was considered, and why this one was chosen.

### 1. Signed receipts kept by someone else, not just a hash chain
A hash chain inside the file can be rebuilt by whoever holds the file: edit a record, recompute every link after it,
and the chain checks out (the demo shows this). Protection only exists if something leaves the holder's control while
the log is being written. A receipt, "after N records the head link was H", signed by the sealing key and handed to a
witness, is that something. **Rejected:** a hash of the finished file given to an investigator later (says nothing
about what happened before); a hash chain alone (fooled by a rewrite).

### 2. Ed25519 for receipts
32-byte keys and 64-byte signatures fit on one line of text, signing is deterministic and fast, and OpenSSL has it.
**Rejected:** HMAC (the verifier would need the secret key, so the verifier could forge receipts); RSA (much larger
keys and signatures for no benefit here).

### 3. A receipt is issued only after `fsync`
If a receipt covered records still in memory, a crash would lose them and an honest log would then fail its own
receipt, which looks exactly like tampering. Syncing first means a receipt only ever describes records that are on
disk.

### 4. A hash chain, not a Merkle tree
Investigators verify a whole flight, and a chain does that in one pass with about ten lines of code. A Merkle tree
would let someone check a single record with a short proof, which is useful later and listed as a next step, but it
adds code to write, test and explain without making today's checks stronger.

### 5. Both a CRC-32 and a SHA-256 link in every record
The CRC catches accidental damage cheaply, and it lets recovery tell "a crash cut this record short" from "this record
was changed". The SHA-256 link catches deliberate changes, because unlike a CRC it cannot be fixed up to match a new
value. CRC-32 (the zlib one) was chosen over CRC-32C because Python's standard library has a fast version, which keeps
the independent verifier free of extra packages.

### 6. Recovery trims only a record cut short, never a bad record
After a crash, the last record may be incomplete; trimming it is safe and necessary. A bad record in the middle is
evidence, and truncating there would delete everything after it. A complete final record with a bad checksum is
ambiguous (a crash on some disks, or an edit), so it is also left in place and reported for a person to judge.

### 7. Sequence numbers in every record
The chain alone would catch a deleted or reordered record, but only as a generic link mismatch. A sequence number
says what happened (a gap, a repeat, a swap) and where.

### 8. Timestamps stored, not trusted
Flight-controller clocks reset at boot and different sensors disagree. Ordering and completeness use sequence numbers;
`verify` counts timestamps that go backwards so an analyst can look at them.

### 9. Durable every 1,000 records by default
Measured on the benchmark machine: making every record durable runs at about 5,600 records per second (limited by the
disk), batching every 1,000 at about 266,000. Batching bounds what a crash can lose to the last unsynced batch, and
`--sync every` is there when that is not acceptable.

### 10. One append-only file, not a database
A single file is easy to copy, hash and hand to an investigator, and appending never rewrites earlier bytes. The
benchmark shows ingest speed close to SQLite in WAL mode with the same durability.

### 11. The payload is opaque
The store never parses telemetry. PX4 samples arrive as JSON from the converter, but any format (ArduPilot,
MAVLink, IoT sensor readings) can be sealed the same way.

### 12. A second, independent reader in Python
`tools/fseal_py.py` was written from the format description without sharing code with the C++ reader, and the tests
require the two to agree on every attack. That shows the format is defined by its description, not by whatever the
C++ happens to do.

### 13. The sample flight is downloaded, not committed
The PX4 sample log is fetched by pinned commit and checked by SHA-256. That keeps the repository small and its
licensing clean, and it means the tests always use the same bytes.

### 14. Stream verification instead of reading the whole log into memory
The earlier `scan` loaded the whole file. Native and C++ WebAssembly verification now stream through bounded buffers
with explicit input limits; browser files are read-only in a disposable worker. The compiled Wasm module is about
1.8 MB. Native and Node evidence covers a 500 MiB input; the browser run is pending, so this is not a browser
capacity claim. The browser heap cap is 256 MiB and the input limit 500 MiB. **Rejected:** undocumented whole-file
buffering. Sandbox sealing is not durable on-drone signing; its private key is ephemeral. See [Wasm notes](wasm/README.md)
and [architecture/readiness](ARCHITECTURE.md).

### 15. Receipts not validly signed by the trusted key are UNVERIFIED, not TAMPERED
A receipt that names another key, or carries a signature that does not verify, can be written by anyone, so it is
no evidence that the log was or was not changed. `fseal verify` reports such receipts and ends with
`RESULT: UNVERIFIED` and exit status 3, unless the chain itself is broken or a validly signed receipt disagrees with
the log (TAMPERED, exit 1). The browser verifier follows the same rule, and when it cannot check Ed25519 at all it
treats every receipt as unauthenticated. **Rejected:** calling a forged receipt tampering (it would let anyone make
an honest log look tampered by sending a bad receipts file).

### 16. A length that runs past the end of the file is a crash only if nothing intact follows
A crash can cut the final record short, and recovery trims it. But one flipped bit in a length field also makes a
record "run past the end", and trimming there would delete every complete record after it. So before calling it a
torn tail, the reader looks within one maximum-size record for a complete record with the next sequence number and a
valid checksum; if it finds one, it reports corruption (`bad-length`) and recovery leaves the file alone. All three
readers (C++, Python, JavaScript) apply the same rule. At most 16 positions with the right sequence number are
checksummed, so a crafted tail cannot make the search slow; past that cap the answer is "corruption" (trim nothing).
Residual: a crash whose torn final record happens to contain a valid-looking next record makes recovery refuse.
That fails safe (nothing is deleted); by accident it is very unlikely, and a crafted payload can trigger it.

### Known limitation: receipts do not name their log
A receipt says "after N records the head was H", signed by the drone's key, but not which flight it belongs to. If
two flights are sealed with the same key, checking one against the other's receipts fails exactly as a rewrite
would, so `verify` names both causes. A log identifier in the file header, included in every receipt, would tell
them apart; it would change the file format, so it is left for a future version.

### 17. Keep cloud archive and managed signing optional until implemented and interoperable
The static verifier and CLI are local; no AWS account or resources are configured. S3 Object Lock/Lambda/Athena are
only a possible archive design. Although AWS KMS documents Ed25519, v1 interoperability needs a cross-verification
fixture for exact message bytes, message type, and public-key encoding; ECDSA cannot replace Ed25519.
**Rejected:** inferring source-data truth from object immutability or treating a proposal as free hosting/a deployed
backend. See [architecture](ARCHITECTURE.md) and [FinOps](FINOPS_AND_PRICING.md).

### 18. Reuse the native engine, keep the independent reader
The console calls C++/OpenSSL in a disposable WebAssembly worker, while the existing JavaScript reader supplies
bounded record rows and a cross-check. Reject a disagreement instead of choosing the more reassuring result.
This increases download size and local work, but avoids reimplementing signing in a new frontend. Missing-key
receipt status belongs to application evidence completeness; preserve the native chain result separately.

### 19. Static product first, no fictitious hosted tier
The console starts with an 800-record synthetic example. The 64,542-record PX4 example is optional because its
28.9 MiB transfer is unnecessary for the first check. Keep current GitHub Pages and prepare portable Amplify
artifacts without provisioning a billable backend. The proposed team price is a validation question; no checkout,
email collection or analytics runs without configured services. This gives up managed collaboration and custody.

### 20. Local media conversion stays isolated from verification
Video metadata helps inspect accompanying evidence, but video does not become a signed flight record. The static
UI cannot truthfully offer server transcoding at zero compute cost, so FFmpeg conversion is an explicit bounded
local tool and AVFoundation is an optional native helper. They do not change the FLTSEAL1 format or verification.

# Threat model

## Who is involved

- **Sealer**: the software that writes the log (on the drone's companion computer or the ground station). It holds the
  Ed25519 signing key.
- **Holder**: whoever stores the log file afterwards, usually the operator or pilot. The holder can read, copy, edit
  and rewrite the file.
- **Witness**: whoever receives the receipts while the flight is being logged: an investigator, the operator's
  company, an insurer, a regulator. The witness stores receipts somewhere the holder cannot change.
- **Verifier**: anyone with the log, the witness's receipts and the sealer's public key, obtained independently
  (not from the holder).

## What is protected

The records written after sealing starts: their contents, their order and their completeness up to the last receipt.

## Attacks

| Attack | Result | Why |
|---|---|---|
| Disk damage, flipped bits | detected, record named | CRC-32 over each record |
| Edit a value, leave the checksum | detected, record named | CRC-32 |
| Edit a value and recompute its checksum | detected, record named | the SHA-256 link no longer matches |
| Delete, reorder or duplicate a record | detected, record named | sequence numbers, then links |
| Delete records from the end | detected if a receipt covers them | the receipt's count is larger than the log |
| Edit, then recompute every link and checksum | detected if a receipt covers the edit | the receipt's head no longer matches |
| Forge or alter a receipt | detected | Ed25519 signature, checked against the trusted public key only |
| Present a receipt signed by another key | detected | the key must equal the one the verifier trusts |
| Crash in the middle of writing | not tampering | a torn final record; `fseal recover` trims only that |
| Edit records written **after the last receipt** | **not detected** | the holder can rebuild that part of the chain |
| Edit or fake data **before** it is sealed (spoofed GPS, altered sensor) | **not detected** | sealing proves what was written, not that it was true |
| Steal the signing key **and** replace the witness's receipts | **not detected** | both trust anchors are gone |
| Steal the signing key only | detected for everything the witness already holds | old receipts still pin the old log |

## Assumptions

- SHA-256 is collision resistant and Ed25519 signatures cannot be forged.
- The verifier gets the sealer's public key out of band (for example, registered with the operator's company), not
  from the holder.
- Receipts reach the witness promptly. The gap between receipts is the window an attacker can rewrite, so a
  deployment chooses `--every N` to match how much of a flight it can afford to leave unprotected.

## Durability claims

- Records acknowledged by `sync()` survive a process crash: the kill -9 test kills a writer at 25 random moments and
  checks that every acknowledged record is still there.
- A final record cut short at any byte offset is detected and trimmed; nothing else is ever truncated.
- Behaviour on real power loss depends on the disk honouring `fsync` and is not tested here.

## Timestamps

Timestamps are stored exactly as the source gives them and are not trusted. Flight-controller clocks reset at boot
and different sources disagree, so order and completeness rest on sequence numbers. `fseal verify` counts timestamps
that go backwards so an analyst can look at them.

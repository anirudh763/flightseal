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
| Forge or alter a receipt | detected, reported as UNVERIFIED | Ed25519 signature, checked against the trusted public key only; a forged receipt says nothing about the log |
| Present a receipt signed by another key | detected, reported as UNVERIFIED | the key must equal the one the verifier trusts |
| Crash in the middle of writing | not tampering | a torn final record; `fseal recover` trims only that |
| Edit records written **after the last receipt** | **not detected** | the holder can rebuild that part of the chain |
| Edit or fake data **before** it is sealed (spoofed GPS, altered sensor) | **not detected** | sealing proves what was written, not that it was true |
| Steal the signing key **and** replace the witness's receipts | **not detected** | both trust anchors are gone |
| Steal the signing key only | detected for everything the witness already holds | old receipts still pin the old log |

## Assumptions

- In Seal & send the verifier's trusted key is the one inside the receipt message they pasted. That is out of band
  only if they received the message from the sealer at sealing time and kept it; a message that arrives together
  with the file proves nothing. Without a saved signing key each file has its own key, discarded after sealing, so
  nothing links two flights to one operator.
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

## Receipt registry (optional server)

`registry/` and `infra/` describe an optional witness server (see [docs/aws/ARCHITECTURE_AWS.md](docs/aws/ARCHITECTURE_AWS.md)).
It has not been deployed to real AWS. It stores only commitments: org, key fingerprint, head, count, the time the
server received the receipt, idempotency records and share/withdrawal/deletion state. It never receives the log,
file names, manifests, salts, per-file digests, GPS or notes.

| Attack | Result | Why |
|---|---|---|
| Register a receipt for another company | refused (403) | the org comes only from the verified token; a body `org_id` is a 400; the key must be enrolled in the caller's org |
| Register a forged or altered receipt | refused (422) | Ed25519 verification against the receipt key, which must be the org's active enrolled key; S ≥ L and non-canonical points are rejected |
| Enroll an attacker's key | refused unless the attacker is an admin of that org | admin role, a single-use 5-minute challenge bound to the admin's `sub`, signed by the new key; replacing the active key needs `confirm_replace` |
| Keep registering with a stolen key | stopped once reported | `POST /v1/keys/{fp}/compromised`; earlier registrations keep their server-received time |
| Keep using an envelope after a pilot leaves | stopped | `POST /v1/epoch` invalidates every outstanding envelope |
| Replay a registration to resurrect a withdrawn share or a deleted registration | no effect | a retry returns the original ack (or 410) and never creates a share |
| Restore an old backup to bring back withdrawn shares | refused until tombstones are applied | `RESTORED_FROM` closes every route (503) until `apply_tombstones` writes its marker |
| Guess a share link | infeasible | 256-bit random token; only its SHA-256 is stored; unknown, withdrawn, expired and deleted links give the same 404 |
| Read state during a store outage | refused (503) | every read of share, registration, key or restore state fails closed |
| Run up the bill | **not prevented** | stage throttling bounds the rate; a budget only alerts and does not cap spend ([COST.md](docs/aws/COST.md)) |
| A compromised AWS account or Cognito administrator | **not detected** | they can rewrite the table, which is the witness record |
| Time the registry says it received a receipt | trusted only as far as the operator | `received_at` is the server's clock, not a timestamp authority |

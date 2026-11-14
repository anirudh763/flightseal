# Operations runbook

## Current local verification or sealing issue

1. Stop editing or retrying against the only copy. Preserve the original downloaded `.ulg`, `.fseal`, receipts,
   public key source, converter command/version, and relevant timestamps. Work from copies and record hashes.
2. Run `fseal verify LOG --receipts RECEIPTS --pubkey TRUSTED_KEY` when all inputs are available. Treat
   `UNVERIFIED` as no authenticated conclusion, and `INCOMPLETE` as an incomplete write; neither means INTACT.
3. If a final record is torn after a crash, copy the file, then run `fseal recover` on the copy and verify the
   recovered output against receipts. Never recover/truncate a complete bad record or corruption in the middle.
4. If valid receipts disagree with the chain, stop sealing under the affected key. Preserve all witness copies and
   investigate key provenance, flight identity, and the first mismatching receipt. Do not “repair” the chain.
5. If the private key may be compromised, isolate the signer and record the suspected exposure interval. Publish a
   replacement key through the organization's authenticated key channel and preserve the prior key and witness
   receipts for historical verification. FlightSeal has no automated revocation or trusted timestamp service.

## Proposed AWS archive response (not deployed)

There are no AWS resources, account credentials, dashboards, metrics endpoints, or alert rules configured today.
The steps below become actionable only after a separately approved deployment exists.

- **Upload rejected/too large:** keep the local source and receipts; check object bounds and account policy; do not
  weaken limits or delete local copies to force acceptance.
- **Lambda failure/retry storm:** inspect structured logs by request/object version ID; preserve the source object;
  retry only after confirming idempotency and parser fix. Quarantine failed references, not raw payload in logs.
- **Receipt signature check fails:** stop publishing a “validated” status; compare KMS algorithm, message type, exact
  bytes and public-key encoding with a known fixture. Do not substitute ECDSA for v1 Ed25519.
- **Unexpected delete/retention change:** suspend affected principals, preserve CloudTrail/S3 version history, and
  check Object Lock mode, retention date, bypass permission and lifecycle configuration. Governance mode can be
  bypassed by an authorized principal; compliance retention is not a remedy for inaccurate uploads.
- **Service/region unavailable:** use retained local artifacts and the native CLI for verification; do not claim
  recovery objectives until restore drills measure them.

## Operational signals and recovery objectives

At local scale, the actionable signal is the command result plus the artifact and receipt count. The current site is
static and does not emit a server metrics endpoint or application JSON event log. Do not invent one. If a backend is
implemented, emit bounded structured operational events (request ID, object version, stage, status, duration,
byte-count bucket); never log log payloads, filenames, receipt contents, keys, or user-provided narrative.

Candidate service targets for a future archive, **not measured or guaranteed**:

| Objective | Target | Assumptions and status |
|---|---|---|
| RPO for accepted immutable objects | 0 acknowledged object versions lost | Target assumes S3 accepted the object, versioning/Object Lock are correctly configured, and cross-account recovery is tested. No deployment or restore drill exists. |
| RTO for archive read/verification | 60 seconds | Ambitious planning target assumes the AWS control plane and an authorized operator are available, source copies exist, and no key compromise blocks trust. Unmeasured; not an SLA. |
| Receipt gap | Operator-selected batch size/cadence | Not a service RPO. The uncovered suffix remains changeable until an independent witness has the next receipt. |

Before adopting targets, run restore drills with locked object versions and receipts, capture elapsed time and data
loss, and update these values from evidence. Define escalation contacts, retention/legal requirements, and recovery
key custody before production use.

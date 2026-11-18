---
type: initiative
title: HashWing on AWS
parent: none
companions:
  - architecture-hashwing-aws/architecture-hashwing-aws.md
---

# HashWing on AWS

## Requirements

Distilled from the architecture memlog and the eleven-gaps plan (calendar dates and pricing removed by owner decision).

- **R1 (gap 3):** AWS work is infrastructure as code, exercised in LocalStack, with a coverage matrix that keeps local, LocalStack, real-AWS and designed-only results apart.
- **R2:** Sealing and verifying stay in the browser or CLI. The registry is optional and original files are never uploaded to it.
- **R3 (gap 9):** The registry receives only receipt v1 plus allowlisted opaque ids and ack metadata. Manifests, salts, per-file digests, names, GPS and notes stay with the operator and recipient.
- **R4 (gap 5):** A company admin enrolls a public key with proof of possession. Rotation and compromise have explicit outcomes. Org membership comes from the verified token, never the request body.
- **R5 (gap 6):** The registry's received time is the registry's assertion. Trusted time (RFC 3161) and retention (S3 Object Lock) are separate mechanisms and neither is implied by a DynamoDB write.
- **R6 (gap 8):** Share links can be withdrawn and registrations deleted. Expiry is checked on read, not left to TTL. A backup restore cannot republish withdrawn or deleted records.
- **R7 (gap 10):** Retries are idempotent: one registration per receipt, the original acceptance time, and no replay that reopens a withdrawn share.
- **R8:** Checking is public by link with minimal disclosure: only head, count, key fingerprint and received time.
- **R9:** Region us-east-1. $5 a month is a workload target, not a cap. No fixed-fee services.
- **R10:** Identity is an adapter: dev-only HS256 locally, Cognito JWT designed for real AWS.
- **R11:** Static hosting stays on GitHub Pages; nothing is provisioned on AWS without the owner's approval.

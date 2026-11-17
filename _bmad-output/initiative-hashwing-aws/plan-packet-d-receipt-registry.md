---
title: 'Packet D: receipt registry Lambda, CDK IaC, LocalStack integration, AWS docs'
type: feature
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: '57bbc28e1ab4e34d2d98de9580f616b38a35d7a8'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/THREAT_MODEL.md'
  - '{project-root}/DECISIONS.md'
warnings: [oversized, multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** HashWing has no server-side witness. Packet D (plus the server side of C and E) needs a receipt-only registry: it verifies a pilot's Ed25519 receipt v1 against an enrolled company key, stores only the commitment, and serves minimal public checks by unguessable link. Withdrawal and deletion must hold against replays and backup restores. The work also covers IaC, a real local integration run, and honest coverage and cost docs.

**Approach:** A Python 3.12 Lambda (stdlib + boto3 only) behind API Gateway, over one DynamoDB table. A swappable identity adapter: the dev HS256 adapter runs locally, and Cognito JWT is designed for AWS. CDK TypeScript in `infra/`, synth-only, never deployed to real AWS. A boto3-scripted LocalStack 4.12.0 community run goes through a REST API v1 stand-in (HTTP API and Cognito are license-blocked there). Docs live in `docs/aws/`.

## Boundaries & Constraints

**Always:**
- Organization identity comes only from the verified token: claims `sub`, `org_id`, `role` (admin|pilot). A body containing `org_id` or any non-allowlisted field gets a 400.
- Store only: org_id, key fingerprint (SHA-256 hex of the raw 32-byte key), head, count, server-received time, the idempotency record, and share/withdrawal/deletion state.
- Strict reads:
  - Use `ConsistentRead=True` for share, registration, key, envelope, challenge and restore-marker reads.
  - Check expiry explicitly on every read; TTL is background cleanup only.
  - Fail closed: any DynamoDB error while reading tombstone, share or key state denies (503), never serves.
- Bounded work: body ≤ 4096 bytes, at most 10 shares per registration, list pages ≤ 50, per-org monthly registration quota (env `REG_QUOTA_PER_MONTH`, default 2000).
- Keep the code Python 3.11-compatible: it runs on 3.11 locally and 3.12 in CI and on Lambda. Import boto3 lazily, only in the real-table adapter, so root `python -m pytest -q` works with no boto3.
- Write test-file names that do not clash with `tests/` (prefix `test_registry_`).
- Commit only after reading the full diff. Stage only explicit paths. Commit messages end `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Never:**
- Never create real AWS resources, read `~/.aws`, ask for credentials, or touch billing.
  - Emulator runs set `AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`, `AWS_CONFIG_FILE=/dev/null`, `AWS_SHARED_CREDENTIALS_FILE=/dev/null` and an explicit endpoint.
  - Bind containers to 127.0.0.1 only.
- Never `git add` `_bmad/`, `infra/node_modules`, `infra/cdk.out` or `build/`. Never push, merge or force-push; the caller does that.
- Never modify `newweb/src/main.jsx`, `newweb/src/style.css`, `docs/rawfile.js`, `wasm/`, `src/` or `tools/persistence.py`, and never deploy `tools/persistence.py`.
- Never add `cryptography`, PyNaCl or moto. Tests must not import them: a skip would silently drop signature checks in CI.
- Never store or accept file names, manifests, salts, per-file digests, GPS or notes.
- Never use the "AWS Emulator" product and call it LocalStack, call unit tests "integration", or call a REST v1 stand-in "the HTTP API".
- No fixed-fee services: no customer KMS keys, WAF, NAT, VPC, Route 53 zones or Secrets Manager.
- Never fill a price from memory.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Authorized register | pilot token, valid receipt from ACTIVE org key, valid envelope | 201 `{registration_id, received_at, count, head, key_fingerprint, disposition:"active"}` | none |
| No / bad token | missing, bad HMAC, expired `exp`, or adapter unset | 401 | identical body for all |
| Wrong org | key enrolled in org A, token org B | 403 `key_not_enrolled` | nothing written |
| Body carries org_id / filename / unknown field | extra key | 400 `unexpected_field` | nothing written |
| Malformed receipt | wrong tag/version, uppercase hex, wrong lengths, extra tokens, count ≥ 2^64, count=0 | 400 `bad_receipt` | |
| Bad signature | one-bit flip in sig, head or count; S ≥ L | 422 `bad_signature` | |
| Unenrolled / rotated / compromised key | fingerprint absent or state ≠ active | 403 `key_not_enrolled` / `key_not_active` | |
| Identical retry (incl. lost ack) | same idempotency_key + same payload hash | 200, the original body: same registration_id and original `received_at`, plus current `disposition` | no second item, quota not charged twice |
| Conflicting retry | same idempotency_key, different payload | 409 `idempotency_conflict` | |
| Same receipt, new key / after dedupe expiry | registration (org,fp,head,count) exists | 200 original ack if active; 410 `registration_deleted` if tombstoned | no new share, no republish |
| Expired / stale envelope | envelope past `expires_at`, wrong org/sub, or epoch < org epoch | 422 `envelope_expired` | a retry of an already-committed registration still returns its original ack |
| Quota exceeded | org monthly count = limit | 429 `quota_exceeded` | no partial write (single transaction) |
| Body too big | > 4096 bytes | 413 | before parsing |
| Share lifecycle | POST share → GET public | 200 `{head,count,key_fingerprint,received_at}` only | |
| Unknown / withdrawn / expired / deleted share | any of these | 404 with identical body and headers | |
| Withdrawn share after replay | withdraw, then identical register retry | GET still 404; replay creates no share | |
| Restore before tombstones applied | `RESTORED_FROM` set, marker missing | every route 503 `restore_pending` | |
| Restore after apply | marker present, tombstones copied | withdrawn/deleted views 404; active ones served | apply refuses if source tombstones are unreadable |
| Key enroll | admin, fresh challenge signed by the new key | 201; pilot → 403; reused/expired challenge → 400; active key exists without `confirm_replace:true` → 409 `confirm_required`; with it → old key `rotated` | |

</intent-contract>

## Code Map

- `src/fseal.cpp:280` `signed_message`: the signed bytes are `b"fseal-receipt v1" + count.to_bytes(8,"little") + head(32 bytes)`, pure Ed25519 (EVP_DigestSign, no prehash). Receipt line (`to_line`, `parse_line` :350-385): `fseal-receipt v1 count=<dec> head=<64 lowercase hex> key=<64 hex> sig=<128 hex>`, six whitespace-separated tokens, lowercase hex only.
- `docs/samples/flight.receipts`: real signed receipts (key `bd0d25ff…`) to use as a fixture.
- `tests/conftest.py` `fseal_bin`: builds `build/fseal`. Its fixture is not visible under `registry/`, so define your own that uses `FSEAL_BIN` or `build/fseal`. Build first with `cmake -S . -B build && cmake --build build -j`. Real receipt: `printf '1000\t{}\n2000\t{}\n' | build/fseal append f.fseal --key k.pem --receipts f.receipts --every 2` (see `tests/test_tools.py:14`; check `build/fseal --help` for keygen).
- `.github/workflows/ci.yml` job `test`: Python 3.12, `pip install pyulog==1.3.0 pytest pyyaml==6.0.2`, then `python -m pytest -q` at the root, which collects `registry/tests` automatically. Add a separate named step `python -m pytest -q registry/tests`, plus a new `infra` job (node 22, `npm ci`, build, synth test) in `infra/`.
- `AGENTS.md` "Test gates": add the registry and infra commands with real counts, and update the Python totals to the count you observe.
- `THREAT_MODEL.md`: append a "Receipt registry (optional server)" section; keep everything above it.
- `DECISIONS.md`: append decision 22 (registry design, pure-Python Ed25519 verify, REST stand-in in LocalStack).
- LocalStack facts already probed:
  - Image `localstack/localstack:4.12.0@sha256:0df3a97da57de03a588c05d9b8f390f15c7033fc7c4512f94619d344bc3cd317` (community, build 2025-12-11) starts with no token.
  - `apigatewayv2` CreateApi and `cognito-idp` CreateUserPool fail, verbatim: "The API for service 'apigatewayv2' is either not included in your current license plan or has not yet been emulated by LocalStack." (same wording for cognito-idp).
  - REST `apigateway`, `lambda`, `dynamodb`, `iam`, `logs` and `cloudformation` report available.
  - A REST API did not survive `docker restart` without a volume. DynamoDB persistence is unproven.
- Versions verified on npm today: `aws-cdk-lib` 2.277.0, `aws-cdk` 2.1148.1, `constructs` 10.8.1, `aws-cdk-local` 3.1.0, `typescript` 7.0.2. If TS 7 breaks the CDK toolchain, pin the latest 5.x and say why.

## Tasks & Acceptance

**Execution:**
- [x] `registry/registry/ed25519.py`: stdlib RFC 8032 `verify(pub32, msg, sig64) -> bool`.
  - Reject S ≥ L, non-canonical y ≥ p and undecodable points.
  - Check by computing R' = [S]B − [k]A and comparing its encoding to R. This is the cofactorless equation; the registry is stricter than OpenSSL because it also rejects small-order and non-canonical public keys (see Review Triage Log).
  - It handles public data only, so constant time is not required.
- [x] `registry/registry/receipt.py`: `parse(line)` (strict, mirrors `parse_line`), `signed_message`, `fingerprint`.
- [x] `registry/registry/identity.py`: `Identity(sub, org_id, role)`, selected by env `IDENTITY_ADAPTER`; unset or unknown → every request 401 (logged as a config error).
  - `cognito`: reads `requestContext.authorizer.jwt.claims` (`sub`, `custom:org_id`, `custom:role`), already verified by the API Gateway JWT authorizer.
  - `dev-hs256`: dev-only, never production. It verifies `Authorization: Bearer` HS256 against `DEV_TOKEN_SECRET` (≥ 32 bytes) and checks `exp`.
  - Include `make_dev_token()` for tests and the e2e script.
- [x] `registry/registry/store.py`: a `Table` protocol (get/put/update/delete/query/transact) with `DynamoTable` (boto3, lazy) and `MemoryTable`. MemoryTable is the test double; it must enforce conditions and roll back a whole transaction when any condition fails, reporting the cancellation reason per item.
- [x] `registry/registry/app.py` + `registry/handler.py` (Lambda entry `handler.handler`): route on method + path, from both HTTP API v2 events (`requestContext.http`, `rawPath`) and REST v1 proxy events (`httpMethod`, `path`). Use the Design Notes schema.
  - `POST /v1/envelopes`
  - `POST /v1/registrations`, `GET /v1/registrations`, `DELETE /v1/registrations/{id}` (admin)
  - `GET /v1/keys/challenge` (admin), `POST /v1/keys` (admin), `GET /v1/keys`, `POST /v1/keys/{fp}/compromised` (admin)
  - `POST /v1/epoch` (admin; increments the org epoch, invalidating outstanding envelopes)
  - `POST /v1/shares`, `GET /v1/shares/{token}` (public), `DELETE /v1/shares/{token}`
- [x] `registry/registry/restore.py`: `apply_tombstones(source, target)` copies every TOMB item and applies it (registration → deleted, shares → withdrawn), then writes the marker `PK=SYSTEM SK=RESTORE` last. It raises if the source is unreadable, and writes no marker in that case. CLI usage is documented in the runbook.
- [x] `registry/tests/test_registry_*.py`: pytest over MemoryTable and an injected clock, covering every matrix row. Also:
  - RFC 8032 test vectors 1–3, and `docs/samples/flight.receipts` lines verify.
  - A receipt freshly made by `build/fseal` verifies (skip only if the binary is missing; the CI test job builds it).
  - Per-field bit flips fail.
- [x] `registry/localstack/e2e.py` (run with `uv run --no-project --with boto3==<pinned> python registry/localstack/e2e.py`). Use a fresh random dev secret per run.
  - Run the pinned image on 127.0.0.1:4599, named volume `hashwing-localstack`, `PERSISTENCE=1`, docker.sock mounted.
  - Deploy the table, the Lambda (zip of `registry/registry` + `handler.py`, python3.12, arm64 when supported) and a REST v1 `{proxy+}` stand-in.
  - Through the API URL, run: authorized register; denied (no token, wrong org); duplicate retry; lost ack (commit, discard the response, retry); withdrawal; deletion; replay after deletion; replay after dedupe expiry (short `DEDUPE_SECONDS` env).
  - Persistence: write, `docker restart`, read back through the API and directly from DynamoDB. Then `docker rm` and recreate on the same volume and read again. Record exactly what survived; never reseed and call it persistence.
  - Write `docs/aws/evidence/localstack-4.12.0.json` (steps, pass/fail, version, digest, verbatim errors, no secrets). Tear down container and volume at the end.
- [x] `registry/localstack/deploy_cdklocal.sh`: exits 2 with a clear message unless `LOCALSTACK_AUTH_TOKEN` is set (never echo it); otherwise starts LocalStack, runs `npx cdklocal deploy` from `infra/`, then runs the e2e scenarios against the HTTP API URL (e2e.py `--api-url`). Not run here.
- [x] `infra/` (CDK TypeScript):
  - Exact-pinned deps and `package-lock.json`.
  - `.gitignore` for `node_modules` and `cdk.out`, and `cdk.json` with no lookups.
  - Stack: HTTP API (default stage throttling: rate 10, burst 20) with a Cognito JWT authorizer on every route except `GET /v1/shares/{token}`.
  - Lambda: python3.12, arm64, 128 MB, 5 s, `Code.fromAsset('../registry', {exclude tests/localstack})`, an explicit LogGroup with 7-day retention, env `IDENTITY_ADAPTER=cognito`, never any DEV_ vars.
  - DynamoDB: PAY_PER_REQUEST, TTL attribute `ttl`, PITR controlled by context `pitr` (default false, documented), RemovalPolicy DESTROY.
  - Cognito user pool: LITE feature plan, custom attributes `org_id` and `role` not writable by the app client, no self sign-up.
  - IAM: the grant is scoped to the table ARN with only Get/Put/Update/Delete/Query/TransactWrite/ConditionCheck.
  - Optional `AWS::Budgets::Budget`: created only when the CfnParameter `BudgetEmail` is non-empty (Condition), with a parameter amount defaulting to 5 USD. No hardcoded email.
- [x] `infra/test/stack.test.ts`: aws-cdk-lib/assertions on a synth with no credentials. Assert:
  - The resources above, and arm64.
  - Log retention 7.
  - No `"Resource": "*"` and no DEV_ env in the Lambda policy or function.
  - The budget is conditional.
  - Throttle settings, and the public route has no authorizer.
- [x] `docs/aws/ARCHITECTURE_AWS.md`: mermaid diagram, trust boundaries, data stored and never stored, identity adapter, idempotency, withdrawal/deletion/backup-restore semantics, and what TTL does not guarantee.
- [x] `docs/aws/COVERAGE.md`: a row per behaviour, with columns implemented locally / LocalStack (4.12.0 + digest) / real AWS (always "not verified") / designed only.
- [x] `docs/aws/COST.md`: us-east-1, pricing date 2026-11-17, workload of 1 company, 5 users, 1,000 registrations + 5,000 checks/month, stated retention.
  - Price API GW HTTP, Lambda arm64, DynamoDB on-demand + storage + optional PITR, CloudWatch Logs, Cognito Lite, egress and Budgets.
  - Price an error/retry scenario and an abuse scenario separately.
  - Take rates only from official aws.amazon.com pricing pages fetched with WebFetch and cite their URLs. Mark any rate you could not fetch as "not retrieved".
  - State that $5 is a target and that budget alarms do not cap spend.
- [x] `docs/aws/RUNBOOK_AWS.md`: deploy; `cdk destroy` plus checks that nothing remains (CLI list commands); rollback; LocalStack steps; the restore procedure.
- [x] `.github/workflows/ci.yml`, `AGENTS.md`, `THREAT_MODEL.md`, `DECISIONS.md`: as described in the Code Map.

**Acceptance Criteria:**
- Given no AWS credentials, when `cd infra && npm ci && npm test` runs, then synth and every assertion pass.
- Given the pinned image, when `e2e.py` runs, then the evidence JSON reports each scenario as really executed against the API URL with pass/fail, or records the exact blocker verbatim with version and digest.
- Given a receipt from the real C++ sealer, when it is registered, then the signature check accepts it, and rejects it after any single-bit change.
- Given the changed repo, when the full Python suite runs, then it passes with the new tests counted, and AGENTS.md states the real counts.

## Implementation Notes

- Python counts: the default local `python3` (3.11, no pyulog) cannot collect `tests/test_tools.py`, so the root
  baseline was re-measured in a Python 3.12 venv with the CI packages: 49 passed / 29 skipped before, 104 passed /
  29 skipped after (55 new registry tests). `registry/tests` also passes on 3.11 (55 passed).
- No `registry/tests/conftest.py`: `tests/test_tools.py` imports `conftest` by name, so helpers live in
  `registry/tests/registry_helpers.py`.
- A mutation pass (epoch check, stale-IDEM arm, quota limit, share expiry, challenge sub binding, transaction
  rollback, S >= L, token count, restore withdrawal) was killed by the tests every time.
- LocalStack run (2026-11-17, arm64 host): 19 pass, 2 fail, 2 blocked. Every API scenario passed through the REST
  v1 stand-in, including paging, epoch invalidation and a restore drill (gate + apply_tombstones across two tables,
  with the backup emulated by copying items and undoing the withdrawal and deletion). Persistence: DynamoDB items survived both `docker restart` and `docker rm` + re-create on the volume;
  the Lambda function and REST API survived neither. apigatewayv2 and cognito-idp blocked with the verbatim
  licence message. The script exits 1 because of the two persistence failures.
- IAM: the AWS developer guide states transactions are authorised by PutItem/UpdateItem/DeleteItem/GetItem and
  ConditionCheckItem; there is no TransactWriteItems action, so the grant lists those item actions plus Query.

## Plan Change Log

- Added `ORG#o / ACTIVE_KEY`, a conditional pointer, so "at most one active key" holds under concurrent enrollments.
- `Table` protocol also has `scan(pk_prefix)`; `apply_tombstones` needs to enumerate TOMB items.
- The challenge delete condition also requires `expires_at > now` (explicit expiry on every read).
- Identical retry after deletion: 200 with the original ack and `disposition: "deleted"` (matrix row "identical
  retry ... plus current disposition"); a new idempotency key gets 410. The IDEM record keeps `received_at` until
  `DEDUPE_SECONDS` passes; documented in ARCHITECTURE_AWS.md.
- An invalid envelope with a receipt that already committed in this org returns the original ack (or 410) even
  with a new idempotency key, extending "a retry of an already-committed registration still returns its ack".
- COST.md rates come from the official AWS Price List JSON files (pricing.us-east-1.amazonaws.com); the
  aws.amazon.com HTML pages load their tables with JavaScript and showed only free-tier text and examples. The
  512 KB metering rule is marked "not retrieved".
- LocalStack Lambda timeout is 30 s (cold start of the runtime image); the CDK stack keeps 5 s.
- boto3 pinned to 1.43.123 (released 2026-10-30): the latest, 1.44.5, was released the same day as this run.
- TypeScript 7.0.2 builds the CDK app; no 5.x fallback was needed. Tests use `node --test` on compiled output (no
  jest).
- CDK context `restoredTableName` + `restoredFrom` re-points the function (env and IAM grant) at a restored
  table, so the runbook restore procedure works with the synthesised stack.
- `deploy_cdklocal.sh` enables ADMIN_USER_PASSWORD_AUTH on the LocalStack client only, so the script can mint ID
  tokens; it uses `localstack/localstack-pro:4.12.0` without a digest (not run, tag unverified).

## Review Triage Log

### 2026-11-17 — Review pass
- verdicts: 10 findings — high 2, medium 4, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `patch` Bad base64 body escapes handle() as a Lambda error. Fixed: `b64decode(validate=True)`, and a decode error now returns 400 `bad_request`. Test added.
  - `[medium]` `patch` A deeply nested dev-token header raises RecursionError and returns 5xx instead of 401. Fixed: `_dev` catches RecursionError. Tests at the adapter and through the route.
  - `[high]` `patch` A restore resurrected compromised keys and the old epoch, because only withdrawals and deletions wrote TOMB items. Fixed:
    - `compromise` and `epoch` write TOMB items in their transactions.
    - `apply_tombstones` re-applies them: key compromised, ACTIVE_KEY dropped, epoch set to the maximum.
    - Restore test added.
  - `[high]` `patch` Small-order public keys verified any message (A = identity, R = identity, S = 0), so an enrolled forge-for-all key was possible. Confirmed by reading `_decode`, which accepts y=1, x=0. Fixed: verify returns False when [8]A is the identity. Tests cover verify and enroll.
  - `[low]` `patch` The unconditioned share update in delete_registration upserted permanent orphan items. Fixed: the update sets `ttl` (now + 1 day). Test added.
  - `[low]` `patch` MemoryTable.query cursor semantics differed from DynamoDB's LastEvaluatedKey. Fixed: it returns a cursor whenever a page is full, and the test was adjusted.
  - `[medium]` `patch` In --api-url mode, e2e.py labelled the run as the REST stand-in and wrote no evidence. Fixed: the note follows the mode, and the run writes `localstack-4.12.0-cdklocal-http-api.json`.
  - `[medium]` `patch` The "every route" claim for the restore gate overclaimed, since only GET share was probed. Fixed: the drill also probes POST /v1/envelopes and GET /v1/registrations. Evidence regenerated by a real run: all 5 probes returned 503.
  - `[low]` `patch` The deploy_cdklocal.sh trap left `${NAME}-lambda` containers behind. Fixed: the trap removes them too. Checked with `bash -n` only.
  - `[low]` `reject` COST.md rates come from AWS Price List files, not the JS-rendered aws.amazon.com pages. Every page rate is marked "not retrieved", the Price List source is official AWS, and the deviation is recorded in the Change Log and reported to the caller.

### 2026-11-17 — Review pass (independent security review, relayed by the coordinator)
- verdicts: 5 findings — high 0, medium 2, low 1, false 0, maybe-false 0, plus 1 info and 1 documentation correction (both treated as real, low)
- findings:
  - `[medium]` `patch` A restore reactivated a rotated key, because enroll wrote no tombstone for the rotation. Repro on the old code: register signed by the rotated key A returned 201.
    - Fix: every key-state change (enroll → active, rotation → rotated, compromise) writes `TOMB#org#KEY#fp` with its latest state.
    - `apply_tombstones` replays the state and recomputes ACTIVE_KEY from the replayed keys.
    - Test `test_restore_keeps_a_rotated_key_rotated`: A rotated gets 403 `key_not_active`; B active gets 201.
  - `[medium]` `patch` The restore marker was bound only to its source name, so a marker copied into a gen2 backup opened the gate. Repro on the old code: 200.
    - Fix: the marker names its source, target and a per-restore ID. The app also requires `TABLE_NAME` and `RESTORE_ID` to match, and stays closed when RESTORE_ID is empty.
    - `apply_tombstones` refuses a source that is not the served table, and refuses a target equal to it.
    - CDK gets a `restoreId` context, required together with the other two.
    - The runbook now describes chained restores.
    - Tests: `test_a_marker_copied_into_a_later_backup_does_not_open_the_gate` and `test_restore_gate_stays_closed_without_a_restore_id`, plus an infra assertion.
  - `[low]` `patch` A demoted admin keeps the admin role until their ID token expires. Fix:
    - ID and access token validity set to 15 minutes, asserted in synth.
    - RUNBOOK_AWS.md and COVERAGE.md say to pair demotion with AdminUserGlobalSignOut, and that tokens already issued stay valid until they expire.
  - `[low]` `patch` (info) register disclosed an existing registration for a forged receipt when the envelope had expired.
    - Fix: parse and signature verification now run before the envelope check and any existence lookup; the docstring order is updated.
    - Test `test_expired_envelope_with_a_forged_receipt_does_not_reveal_a_registration`: the old code returned 200; now 422 `bad_signature`. A genuine lost-ack retry still gets 200.
  - `[low]` `patch` The doc claimed "same cofactorless check OpenSSL uses". Corrected in ed25519.py, DECISIONS.md and this plan: the equation is cofactorless, but the registry is stricter than OpenSSL because it rejects small-order and non-canonical keys.
- **Verification:**
  - `registry/tests`: 64 passed.
  - Root suite on py3.12 with the CI packages: 124 passed, 30 skipped.
  - `npm --prefix infra test`: 11/11.
  - LocalStack e2e re-run on the pinned image: 19 pass, 2 fail (the same persistence checks), 2 blocked; the restore drill now runs with target and restore ID.

## Auto Run Result

- **Summary:** receipt-only registry Lambda (stdlib + boto3, pure-Python RFC 8032 verify matching `src/fseal.cpp` signed_message), CDK TypeScript stack (synth-only), LocalStack 4.12.0 community run through a REST v1 stand-in, AWS docs, CI and AGENTS gates, THREAT_MODEL and DECISIONS appends.
- **Files:**
  - `registry/` (app, ed25519, receipt, identity, store, restore, handler, tests, localstack scripts)
  - `infra/` (stack, assertions test, lockfile)
  - `docs/aws/` (ARCHITECTURE_AWS, COVERAGE, COST, RUNBOOK_AWS, evidence JSON)
  - `.github/workflows/ci.yml`, `AGENTS.md`, `THREAT_MODEL.md`, `DECISIONS.md`
- **Review:**
  - 9 patches applied (high 2, medium 4, low 3), 0 deferred.
  - 1 rejected: the COST source deviation, documented as a deviation.
- **Follow-up review recommended:** true. Two high entries were patched (small-order key rejection, and key/epoch tombstones on restore), and those fixes have had no independent second review.
- **Verification** (after the patches):
  - `python3 -m pytest -q registry/tests`: 60 passed.
  - Root suite on py3.12 with the CI packages: 109 passed, 29 skipped.
  - `npm --prefix infra test`: 10/10.
  - `ctest`: 5/5.
  - e2e.py on the pinned LocalStack image: 19 pass, 2 fail (persistence of Lambda/API across restart and re-create), 2 blocked (apigatewayv2, cognito-idp).
- **Residual risks:**
  - Nothing has been verified on real AWS: no HTTP API, Cognito, IAM enforcement or throttling.
  - Lambda durations in COST.md are estimates.
  - `deploy_cdklocal.sh` has never run.

## Design Notes

Single table, `PK`/`SK` strings, numeric `ttl` (epoch seconds) used for background cleanup only:
- `ORG#o / KEY#<fp>`: state (active|rotated|compromised), enrolled_at, enrolled_by, changed_at. At most one key per org is active.
- `ORG#o / CHAL#<nonce>`: sub, expires_at (5 min). Consumed by a conditional delete with `attribute_exists(PK) AND sub = :sub`. Signed bytes: `b"hashwing-key-enroll v1\n" + org_id + b"\n" + nonce_hex`.
- `ORG#o / EPOCH`: epoch int. `ORG#o / ENV#<id>`: sub, epoch, expires_at (default 7 days, env `ENVELOPE_SECONDS`).
- `ORG#o / QUOTA#YYYYMM`: n. The update condition `attribute_not_exists(n) OR n < :limit` runs inside the registration transaction.
- `ORG#o / REG#<rid>`: `rid = sha256(f"{org}|{fp}|{head}|{count}")[:32]`. Holds fp, head, count, received_at, state (active|deleted), share_hashes (≤ 10). Deletion removes received_at and sets state=deleted, deleted_at. This tombstone has no ttl.
- `ORG#o / IDEM#<key>`: payload_hash, rid, received_at, expires_at (`DEDUPE_SECONDS`, default 7 days), ttl.
- `SHARE#<sha256(token)> / SHARE`: org, rid, state (active|withdrawn), expires_at (default 30 days, max 365). The token is `secrets.token_urlsafe(32)` and is never stored.
- `TOMB#<org>#<rid-or-sharehash> / TOMB`: kind and time, never TTL'd. The restore apply copies these.
- New registration = one TransactWrite: Put REG (`attribute_not_exists`), Put IDEM (`attribute_not_exists`), Update QUOTA.
  - On cancellation, re-read consistently: an IDEM hit gives the same ack or 409; a REG hit gives the original ack or 410; a QUOTA failure gives 429.
- Request order: size → auth → schema → idempotency lookup → envelope → receipt/signature → key state → transaction.
- `payload_hash = sha256` of the canonical JSON of `{receipt, envelope_id}`. The body allowlist is exactly `receipt`, `idempotency_key` (`[A-Za-z0-9_-]{16,128}`) and `envelope_id`.

## Verification

**Commands:**
- `cmake -S . -B build && cmake --build build -j && ctest --test-dir build` -- expected: 4 suites pass
- `python3 -m pytest -q registry/tests` -- expected: all pass, none skipped when `build/fseal` exists
- `python3 -m pytest -q` -- expected: previous 49 passed / 29 skipped plus the new registry tests, 0 failures
- `cd infra && npm ci && npm test` -- expected: synth and assertions pass with no credentials
- `uv run --no-project --with boto3 python registry/localstack/e2e.py` -- expected: evidence JSON written; every attempted step recorded truthfully
- `git status --short` -- expected: `_bmad/` untracked and not staged

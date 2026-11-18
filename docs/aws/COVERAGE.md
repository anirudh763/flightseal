# Registry coverage: what was checked where

Columns:

- **Local:** pytest over the in-memory table with an injected clock (`python3 -m pytest -q registry/tests`). These
  are unit tests, not integration tests. Rows that say so were also run in Playwright Chromium against the dev ONLY
  `registry/devserver/server.py` on a loopback port (`node --test newweb/tests/outbox-browser.mjs`).
- **LocalStack:** `registry/localstack/e2e.py` against `localstack/localstack:4.12.0@sha256:0df3a97da57de03a588c05d9b8f390f15c7033fc7c4512f94619d344bc3cd317`
  (community edition), through a **REST API v1 `{proxy+}` stand-in** with the dev-hs256 adapter, a real Lambda
  (python3.12, arm64) and DynamoDB. Evidence: [evidence/localstack-4.12.0.json](evidence/localstack-4.12.0.json).
  This is not the HTTP API and not Cognito; the community image refuses both (verbatim errors are in the evidence).
- **Real AWS:** never deployed. Always "not verified".
- **Designed only:** written down and, where noted, synthesised, but never executed.

| Behaviour | Local | LocalStack 4.12.0 | Real AWS | Designed only |
|---|---|---|---|---|
| Ed25519 verify: RFC 8032 vectors 1–3, sample receipts, every single-bit flip, small-order keys rejected | yes | — | not verified | |
| A fresh receipt from the C++ sealer (`build/fseal`) registers; a bit flip is rejected | yes | — | not verified | |
| Strict receipt parsing (extra tokens, uppercase hex, count 0 and ≥ 2^64) | yes | — | not verified | |
| Authorized register (201) | yes | pass | not verified | |
| No / bad / expired token → identical 401 | yes | pass (no token) | not verified | |
| Wrong org → 403 `key_not_enrolled`, nothing written | yes | pass | not verified | |
| Body with `org_id` or any unknown field → 400 | yes | — | not verified | |
| Bad signature → 422 | yes | — | not verified | |
| Rotated / compromised key → 403 `key_not_active` | yes | — | not verified | |
| Identical retry → original ack, quota charged once | yes | pass | not verified | |
| Lost ack (commit, discard response, retry) → same registration, one item | yes | pass (one item read back from DynamoDB) | not verified | |
| Conflicting retry → 409 | yes | — | not verified | |
| Same receipt with a new key → original ack; after deletion → 410 | yes | pass (410) | not verified | |
| Replay after the dedupe window → original ack | yes | pass (`DEDUPE_SECONDS=8`) | not verified | |
| Expired / wrong-sub / stale-epoch envelope → 422 `envelope_expired` / `sub_mismatch` / `epoch_mismatch`; committed retry still acked | yes | — | not verified | |
| Monthly quota → 429 with no partial write | yes | — | not verified | |
| Body over 4096 bytes → 413; invalid base64 body → 400; deeply nested JSON or token header → 400 / 401 | yes | — | not verified | |
| Share lifecycle; unknown / withdrawn / expired / deleted → identical 404 | yes | pass (create, view, withdraw, 404) | not verified | |
| Malformed share paths (bad characters, wrong length, extra segments) → the same 404 status, headers and body as an unknown token, from any origin, in the Lambda. On the HTTP API, empty or multi-segment paths get API Gateway's own 404 instead | yes | — | not verified | |
| Withdrawn share stays 404 after an identical register retry | yes | pass | not verified | |
| Deletion withdraws the registration's shares and tombstones it | yes | pass (state read back from DynamoDB) | not verified | |
| Store read errors fail closed (503) | yes (injected failures) | — | not verified | |
| Restore gate: 503 `restore_pending` until tombstones are applied | yes | pass (function re-pointed at a second table with `RESTORED_FROM`; public share GETs, `POST /v1/envelopes` and `GET /v1/registrations` all 503) | not verified | CDK restore context synthesised and asserted |
| Restore marker bound to the target table and a per-restore ID; a marker copied into a later backup keeps the gate closed; a source other than the served table is refused | yes | partial: the drill re-points the function with `RESTORE_ID` and opens only after the marker naming that target and ID is written; the copied-marker case is unit-tested only | not verified | CDK `restoreId` context synthesised and asserted |
| Demoted admin keeps `custom:role` until the ID token expires (15 min); demotion is paired with `AdminUserGlobalSignOut` | — | — (Cognito blocked) | not verified | designed: token validity asserted in synth, procedure in RUNBOOK_AWS.md |
| `apply_tombstones` re-applies withdrawals, deletions, key rotations and compromises (then recomputes the active key) and the org epoch; refuses on unreadable source | yes | pass for re-apply, against two DynamoDB tables; the backup was **emulated** (items copied, withdrawal and deletion undone) because community LocalStack has no PITR restore. Refusal not tested there | not verified | |
| Key enrollment: admin only, single-use 5-minute challenge, `confirm_replace` | yes | pass (enroll) | not verified | |
| List registrations with a cursor; list keys | yes | pass | not verified | |
| Epoch bump invalidates an outstanding envelope | yes | pass | not verified | |
| boto3 adapter: Get, Put, Update (SET/REMOVE/ADD), conditional Delete, Query with cursor, Scan, TransactWriteItems with cancellation reasons | — | exercised by the LocalStack rows marked pass | not verified | |
| DynamoDB data after `docker restart` with `PERSISTENCE=1` and a volume | — | survived (item read back directly) | not verified | |
| Lambda and REST API after `docker restart` | — | **did not survive** (function and API gone) | not verified | |
| DynamoDB data after `docker rm` and re-create on the same volume | — | survived | not verified | |
| Lambda and REST API after re-create | — | **did not survive** | not verified | |
| HTTP API, JWT authorizer, `$default` stage throttling (2 rps, burst 5) | — | blocked: not in the community plan | not verified | synthesised; asserted in `infra/test/stack.test.ts` |
| Browser outbox under that throttle: 30 queued proofs, gateway-style 429s (no `quota_exceeded`) at 2 rps, burst 5, all end Registered and none Needs attention | measured once locally, not a CI gate: `REGISTRY_THROTTLE=1 node newweb/tests/registry-wiring.mjs` (Chromium, dev server, a wall-clock token bucket in `page.route`), 2026-11-17: 30 Registered in 13.4 s, 54 requests answered 429 | — | not verified | the real stage throttle is not exercised |
| Public share route throttle (2 rps, burst 5) on top of the stage default | — | blocked: HTTP API not in the community plan | not verified | synthesised; asserted (`RouteSettings` and the stage's dependency on the route) |
| CORS on the HTTP API: exact allowlisted origins, no `*`, no credentials, `authorization` / `content-type` / `idempotency-key` | — | blocked: HTTP API not in the community plan | not verified | synthesised; asserted (bad origins rejected at synth) |
| CORS in the Lambda (`CORS_ORIGINS`): preflight 204/403, origin echoed only when allowlisted, public share view `*` without credentials | yes | not run (the REST v1 stand-in run sets no `CORS_ORIGINS`) | not verified | |
| CORS from a real browser: a cross-origin page registers through a preflight; an origin off the allowlist is blocked | yes (Playwright Chromium against the dev server, `newweb/tests/outbox-browser.mjs`) | — | not verified | |
| Share idempotency: client-made token, hash + idempotency key; a lost-response retry returns the same share; key bound to registration and token hash; a withdrawn share is never reopened | yes, and in Chromium (the dev server commits, then drops the connection) | pass for create/view/withdraw with the new body; the lost-response retry is not run there | not verified | |
| `GET /v1/epoch`; 422 `envelope_expired` / `sub_mismatch` / `epoch_mismatch` | yes | pass (`epoch_mismatch` after an epoch bump) | not verified | |
| Cognito Lite pool, read-only custom attributes, ID-token claims | — | blocked: not in the community plan | not verified | synthesised; asserted |
| IAM scoped to the table ARN with item actions only | — | not enforced by LocalStack community | not verified | synthesised; asserted |
| Log group with 7-day retention | — | — | not verified | synthesised; asserted |
| Optional budget (only with `BudgetEmail`) | — | — | not verified | synthesised; asserted |
| Lambda asset holds only `handler.py` and `registry/*.py` (no dev server, tests, LocalStack scripts or `__pycache__`) | — | — | not verified | synthesised; asserted (built asset directory listed) |
| `cdklocal deploy` of the real stack + e2e against the HTTP API | — | not run (needs LocalStack Pro; `deploy_cdklocal.sh` exits 2 without a token) | not verified | yes |
| `cdk destroy` leaves nothing behind | — | — | not verified | runbook only |
| Cost figures | — | — | not verified | estimate in [COST.md](COST.md) |
| Accepted low-severity disclosure: `POST /v1/shares` with a token hash that was ever used (even withdrawn or expired) → 409 `conflict`, an unused one → 201 (which creates a real share, counted toward the 10-share limit). Visible only to a caller who holds the token or its hash and has an active registration; it names no org | yes (409 asserted for a withdrawn, expired share) | — | not verified | accepted, see [ARCHITECTURE_AWS.md](ARCHITECTURE_AWS.md) Shares |
| Known gap: a backup restore drops registrations and shares created after the backup, while the browser outbox may still show "Registered" | no (not fixed) | — | not verified | see [ARCHITECTURE_AWS.md](ARCHITECTURE_AWS.md) Backup restore |

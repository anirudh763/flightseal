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

## Release requirement ledger (baseline 2026-11-17, main b2cec46)

Source: the owner's UI/backend release brief (Phases A–E) and the owner decisions of 2026-11-17. This is the one requirement ledger for that release. Plans and PRs cite these IDs. Status was read from the code on `main` at b2cec46, not from older docs. No suite was re-run for this baseline. Statuses:

- `implemented`: in the code, with a test or a recorded measurement that shows it.
- `failing`: built or measured, but the code or the measurement does not meet the requirement.
- `proposed`: not built yet.
- `externally blocked`: needs something an agent session cannot supply (an owner permission, a deployment authorization, a paid service).
- `in progress (fix/lost-work)`: being built on branch `origin/fix/lost-work` (no PR open at baseline). Other packets do not touch it.

Nothing here is deployed. No real-AWS check has run, no customer has used HashWing, and no row certifies compliance.

### Phase A: experience and design

| ID | Requirement | Status | Evidence at baseline | Check that will prove it |
|---|---|---|---|---|
| R12 | Primary nav is Seal & send, Verify, Jobs, Trust. More tools holds Records, Receipts, Samples, Video, Benchmarks, System. Old routes, Back/Forward and focus keep working | proposed | `newweb/src/main.jsx:41-42` (primary nav still has Records and Receipts, no Jobs); `newweb/tests/console.mjs:771` asserts five links | AC-04 rewritten: the `console.mjs` nav check asserts four links, and `#/records` and `#/receipts` still load and focus their heading |
| R13 | Front door: HashWing identity, one factual value statement, Seal files, Verify files, secondary Try a sample on the real engine. No login wall, carousel, decorative numbering or forced animation | failing | `newweb/src/main.jsx:1707-1728`: rotating product-preview slides with a pause control, a kicker and lede, a numbered "From download to review" list, a Mavframe promotion | AC-51: on the landing route a browser check finds the three actions, no timer-driven DOM change over 10 s, no numbered step decoration |
| R14 | Guest sealing and verification work without an account | implemented | AD-1; `newweb/tests/registry-wiring.mjs:177` (flag off: no registry request); `tests/web/e2e.mjs` | The same checks stay green after the layout change |
| R15 | Seal & send shows one task and one primary action at a time. Every checker moves to Verify | failing | AC-06 `partial` in `ux-hashwing/EXPERIENCE.md`: two primaries after sealing, two on Verify | AC-06: a browser count finds at most one `.button.primary` per step |
| R16 | Small-file sealing and large-file fingerprinting are explicitly different choices | implemented | `docs/MANIFEST_MODE.md:3`; `newweb/tests/manifest-mode.mjs` | Unchanged |
| R17 | Seal & send shows selected files and byte totals, mode, optional job reference, signing identity, progress with Cancel. Technical options collapsed | proposed | Progress and Cancel exist in manifest mode (`docs/MANIFEST_MODE.md`). No job reference, no signing-identity line | AC-52: totals in tabular mono, optional job reference, signing fingerprint shown before Seal, Cancel keeps the selection |
| R18 | After sealing: what to download and send comes first. Sealed file vs manifest-only package is explicit, originals that travel separately are listed, a share link carries a registry record and not files, copying is not proof of receipt | proposed | Handoff today is the receipt-message block in `main.jsx` | AC-53: structure and copy check in both modes |
| R19 | Verify opens on "I have a link" / "I have files". A prefilled link never marks files verified | proposed | AC-09 open (EXPERIENCE, "Open") | AC-09 and AC-54: opening a share link leaves every file row unchecked until files are checked |
| R20 | Verify keeps manifest signature, file contents, key trust, receipt coverage, registry observation and time basis as separate facts | implemented | `newweb/src/recipient-trust.mjs:90` (trust apart from signature); `newweb/tests/recipient-trust.test.mjs:51` (five separate time fields) | Unchanged |
| R21 | File comparison at full usable width, with counts of matches, differences, missing and extra originals. A valid signature with missing originals reads incomplete | proposed | Per-file statuses exist (`recipient-trust.mjs:101`: Matches, Bytes differ, Missing, Not in manifest). No counts row; the comparison shares a column | AC-55: counts equal the per-file rows; at 1440 px the comparison spans the main column; a missing original gives an incomplete verdict |
| R22 | Jobs page: bounded, paginated local list with search, status, timestamps, job reference, resume and export | proposed | No `jobs` route in `main.jsx` | AC-56 to AC-58 |
| R23 | Local job and pending-work metadata is scoped to guest, profile or company. Visible state clears on logout or switch without deleting owner-scoped saved work. Never described as server tenant isolation | in progress (fix/lost-work) | Owner-scoped persistence on `origin/fix/lost-work` (4e363ce, 9985a0b). Jobs scoping follows in the Jobs packet | Tests on that branch, then AC-57 |
| R24 | Trust has four distinct sections (trusted companies, local signing key, company sign-in, authorized company-key actions) and no Verify toolbar | failing | EXPERIENCE "Open": Trust shows the Verify workbench strip; "Your company's keys" is not built | AC-59: four section headings, no "Source and report actions" on Trust |
| R25 | Registry absent from the public Pages build until a dedicated origin and production authentication exist | implemented | AD-16; `newweb/tests/registry-wiring.mjs:26,144` | Kept when that scan is split (release plan, "Tests that change on purpose") |
| R26 | Compact "Sealed on this device" list below the sealing result, in every build | proposed | Flag-on only (`registry-ui.jsx` `SealedOnDevice`). The flag-off scan forbids the string (`registry-wiring.mjs:26`) | Scan split; AC-60: the Pages build shows the local list and makes no registry request |
| R27 | 320, 390, 768 and 1440 px, 200% zoom, reduced motion and forced colours reviewed, with before/after screenshots from the same fixtures | proposed | axe and screenshots exist at 320/768/1440 (`registry-wiring.mjs`). 390 px and 200% zoom are not tested | Screenshots per width and zoom; overflow and 44 px checks per width |

### Phase B: company and recipient workflows

| ID | Requirement | Status | Evidence at baseline | Check that will prove it |
|---|---|---|---|---|
| R28 | First-admin provisioning and invitation or approved membership. Self-service never grants admin or lets a user pick a company | proposed | The base holds: `infra/lib/stack.ts:96` `selfSignUpEnabled: false`, `:111` the app client writes email only, `org_id` is immutable | Synth assertions and a runbook step. The real Cognito run is in R55 |
| R29 | Tokens validated for issuer, audience, expiry and token type (ID token). Org and role come from admin-controlled claims | proposed | AD-3. The `token_use == "id"` check is in the spine's Deferred list | Unit test: an access token carrying `custom:org_id` gets 401 |
| R30 | Development tokens loopback-only; production builds contain none | implemented | AD-16; `registry-wiring.mjs:26` forbids `dev-hs256` and the test secret; the infra synth test forbids `DEV_` | Unchanged |
| R31 | Identity service unavailable: an honest unavailable state, guest tools keep working | proposed | The non-loopback "sign-in isn't available in this build" branch has no test (spine Deferred) | A flag-on non-loopback build test |
| R32 | Browser-only profiles are labelled local profiles. Company sign-in is never simulated by a browser password screen | proposed | The `signup` and `login` screens (`main.jsx:84`) do not say they are local | AC-61: copy check on both screens |
| R33 | Company-key controls: challenge, enroll, list, replace, compromise, with server-enforced roles and company isolation | proposed | Server routes exist (`registry/registry/app.py:37-40`). No UI (AC-38 to AC-40 open) | AC-38 to AC-40 in `registry-wiring.mjs`; the role and wrong-org cases in `registry/tests` stay green |
| R34 | Pinning a trusted company needs an explicit attestation that the fingerprint was confirmed independently | failing | `trusted-keys.mjs:141` requires a source for fingerprint pins, but `pinTrustedKey` (`:125-128`) accepts `not-recorded` | Unit test: both pin paths refuse without a source and an attestation |
| R35 | A compromised mark persists through delete and re-add, reload and restore | implemented | `newweb/tests/manifest-mode.mjs:230-233` (delete and re-add refused) | Add a backup-import case |
| R36 | Share links are listed (active, expired, withdrawn) with expiry and Withdraw, after reload and from another admin session, in bounded pages, without storing raw tokens | proposed | No list route (`app.py:33-45`); withdraw needs the raw token in the path (`app.py:550`) | New routes PROPOSED in `docs/aws/ARCHITECTURE_AWS.md`; registry tests for paging, wrong org and withdraw by share id |
| R37 | Malformed, unknown, expired, withdrawn and deleted links give the same response | implemented | AD-6; `registry/tests/test_registry_app.py:184` `test_share_lifecycle_and_identical_404s` | Unchanged |
| R38 | A recipient sees a permitted shared proof without an account and cannot list records | implemented | AD-9: `GET /v1/shares/<token>` is the only public route (`app.py:44`) | Unchanged |
| R39 | A saved ack reads "Last confirmed by this device" with its observation time and a Refresh action. A current statement appears only after an authorized lookup | proposed | `newweb/src/registry-ui.jsx:200,335` show "Registered at" from the saved row | Changed strings in `registry-wiring.mjs` and `registry-session.test.mjs`, plus a refresh test against the dev server |
| R40 | Never show "Not registered" in place of "Signature invalid" or "Registry not checked" | failing | Spine Deferred: in a flag-on build, the report of a manifest check that did not verify can read "Not registered" | Report test for a failed manifest check in a flag-on build |

### Phase C: lost work and security regressions

| ID | Requirement | Status | Evidence at baseline | Check that will prove it |
|---|---|---|---|---|
| R41 | Proofs are bound to a deliberate owner before dispatch. Proofs made while signed out stay unassigned until explicit assignment, or are exported | in progress (fix/lost-work) | Spine Deferred row "Owner of an unsent in-memory proof"; branch commit 4e363ce | Tests on that branch |
| R42 | Sign-out clears credentials and stops dispatch without deleting saved proofs or other profiles' work. Cross-tab messages are scoped to the owner | in progress (fix/lost-work) | AD-17 "Current behaviour, open"; branch commits | Tests on that branch: delayed messages, account switch, demo entry, session expiry |
| R43 | A refresh while queued keeps the metadata. A selected File that cannot survive a refresh is shown as needing reselection | in progress (fix/lost-work) | Branch commit 4e363ce | Tests on that branch |
| R44 | No private signing key or auth secret is stored as ordinary workspace data | implemented | AD-15 outbox row fields; AD-16: the test token lives in tab memory and `sessionStorage`, loopback only | Unchanged |
| R45 | Cancellation, worker crash, full storage, denied permission, IndexedDB/OPFS failure, clipboard or download failure and stale results each leave one working next action | proposed | Handled case by case; no failure matrix | New rows in `newweb/tests/edge-matrix.mjs` |
| R46 | No registry success before a durable ack. Idempotent retries. Bounded attempts, payloads, queue and concurrency | implemented | AD-5, AD-11, AD-15; `newweb/tests/outbox.test.mjs` | Unchanged |
| R47 | Secrets scanning over all history. Narrow fixture exceptions with a negative control | implemented | `.github/workflows/ci.yml:108-109` (gitleaks `--log-opts=--all`, then `tools/check_receipt_allowlist.py` with its negative fixture) | Unchanged |

### Phase D: backup, recovery, retention and cost

| ID | Requirement | Status | Evidence at baseline | Check that will prove it |
|---|---|---|---|---|
| R48 | The registry exposes a recovery version; clients revalidate saved acks before showing them as current | proposed | `docs/aws/ARCHITECTURE_AWS.md` "Known gap (not fixed)"; AD-19 (decided, not built) | Registry test: a restore raises the version. Client test: an ack saved under an older version reads "Last confirmed" until refreshed |
| R49 | A restore keeps creations made after the backup and works when the source table is gone; repeated restores and tombstone order are safe | failing | A restore drops registrations and shares created after the backup, and needs the source table readable (`ARCHITECTURE_AWS.md`, "Backup restore") | Registry tests: chained restores, absent source, creation journal replay |
| R50 | The restore gate stays closed until security state is re-applied | implemented | AD-7; `registry/tests/test_registry_app.py:318` `test_restore_pending_closes_every_route` | Unchanged |
| R51 | Production: PITR with a 35-day window, deletion protection, retained table and user pool, behind an explicit environment switch. Local stays disposable | proposed | `infra/lib/stack.ts:61` `pitr ?? false`; `:62,102` `RemovalPolicy.DESTROY`; AD-12 amended (decided, not built) | Synth assertions for both environments in `infra/test/stack.test.ts` |
| R52 | Operational actor IDs kept 90 days, then scrubbed from mutable KEY records, tombstones and restored records. Minimal security history kept. Backup and identity-provider retention documented separately | proposed | `enrolled_by` on KEY items and in tombstones never expires (AD-2 amended: decided, not built) | Registry test at day 89, 90 and 91, plus an idempotent rerun |
| R53 | Share expiry is checked on every read, not left to TTL | implemented | AD-6; `registry/tests/test_registry_contract_fixes.py:196` | Unchanged |
| R54 | Share links default to 30 days, 7 days offered, server maximum 30 | failing | `app.py:500-501` accepts 1 to 365; `registry-ui.jsx:405` offers 7, 30, 90 and 365 | Registry test: 31 days is 400. UI test: only 7 and 30 offered |
| R55 | Real-AWS checks (Cognito, JWT authorizer, IAM, PITR restore, throttling, billing) and the RPO 15 min / RTO 4 h drill | externally blocked | Nothing deployed; deployment not authorized (AD-12, AD-13) | Scripted checks prepared and marked blocked in `docs/aws/COVERAGE.md` |
| R56 | The budget response is a reversible traffic pause that keeps data and identities | proposed | `docs/aws/RUNBOOK_AWS.md:38-55`: delete the stage (untested) or destroy; AD-18 (decided, not built) | Synth assertion for the pause switch. The real run is in R55 |
| R57 | Pricing recalculated with backups, PITR, auth, logs, transfer, restore charges and abuse; write counts audited against the real transactions | proposed | `docs/aws/COST.md`: one estimate (about $0.05 a month); PITR costed only as the optional flag | COST.md update citing current official pages, dated |
| R58 | 30 queued proofs under 2 rps, burst 5, finish within 60 s, none lost or duplicated (local simulation) | implemented | `docs/aws/COVERAGE.md:52`: 30 Registered in 13.4 s, one local run | Unchanged. The real API Gateway run is in R55 |
| R59 | Exact-origin CORS, body caps, quotas, bounded pages, redacted logs, 7-day log retention | implemented | AD-11, AD-12; `infra/lib/stack.ts:76` | Unchanged |
| R60 | A dedicated origin before any public registry release | externally blocked | Needs an owner hosting or domain decision (AD-12 counts custom domains as fixed-fee) | Owner decision recorded |

### Phase E: proof of completion

| ID | Requirement | Status | Evidence at baseline | Check that will prove it |
|---|---|---|---|---|
| R61 | Files over 2 GB on the sealing path add at most 128 MiB of memory | failing | `docs/MANIFEST_MODE.md:169-178`: browser RSS rose 140.3 and 159.5 MiB in two runs | `FSEAL_LARGE_HASH=1 node --test tests/wasm/hash-browser.test.mjs` under 128 MiB, or the unmet gate reported |
| R62 | Files over 2 GB on the recipient path: memory, responsiveness, cancellation and throughput on named hardware | proposed | Only the hashing path was measured | The same harness on the Verify path |
| R63 | 800, 2,422 and 64,542-record fixtures with byte flip, deletion, truncation, timestamp reversal, and wrong, malformed and weak keys | implemented | `tests/web/make_cases.py`, `tests/web/verifier.test.mjs`, `tests/wasm/enterprise-edge.test.mjs` | Unchanged |
| R64 | File edge cases: zero bytes, many files, duplicate names, Unicode, renamed, missing and extra, one-byte change, input changed during hashing, worker killed | proposed | Partly in `newweb/tests/manifest-mode.mjs`; no single matrix | One edge-matrix row per case |
| R65 | LocalStack scenarios, with exact limits | failing | `docs/aws/evidence/localstack-4.12.0.json`: 19 pass, 2 fail (Lambda and API lost after a container restart and after a re-create), 2 blocked (apigatewayv2 and cognito-idp are not in community) | Rerun after a redeploy script. The two blocked probes stay blocked |
| R66 | VoiceOver navigation through the pilot, recipient and admin flows | externally blocked | VoiceOver automation is not enabled on this Mac (`SCREnableAppleScript` unset). The owner has to enable it | Recorded actions and observations from a human-observed run |
| R67 | Every visible control, link, dialog and Cancel checked for keyboard, focus, names, live regions, 44 px and contrast | proposed | axe 0 violations at 320/768/1440 in the existing suites. No full control inventory | A control inventory per screen in the release plan |
| R68 | Two independent advisors (UX/accessibility, security/reliability) at design review and final review | proposed | Not run yet for this release | Review notes linked from the release PR |

Task packets, their order and the tests that change on purpose are in [plan-ui-backend-release.md](plan-ui-backend-release.md).

---
type: plan
title: UI and backend release, task packets
parent: initiative-hashwing-aws.md
status: proposed
updated: 2026-11-17
---

# UI and backend release: task packets

Requirement IDs (R12 to R76) and their baseline status are in the [initiative ledger](initiative-hashwing-aws.md#release-requirement-ledger-baseline-2026-11-17-main-b2cec46). The design these packets build is locked in [ux-hashwing/EXPERIENCE.md](ux-hashwing/EXPERIENCE.md) ("Release layout, locked") and [ux-hashwing/DESIGN.md](ux-hashwing/DESIGN.md). Binding decisions are AD-2, AD-4 (provisional pilot signing), AD-9, AD-12, AD-15, AD-16, AD-18, AD-19 and AD-20 in the [architecture spine](architecture-hashwing-aws/architecture-hashwing-aws.md).

## Writer rules

- `newweb/src/main.jsx` has one writer at a time. New screens (Jobs, the front door, the Verify chooser, Trust sections) live in their own files under `newweb/src/` and are imported by `main.jsx`. A packet that only adds a screen file and one import line asks the `main.jsx` writer to land the import.
- `registry/registry/app.py` and `newweb/src/registry-client.mjs` have one writer at a time.
- An API change is agreed in `docs/aws/ARCHITECTURE_AWS.md` first, marked PROPOSED, before either side is coded. The share-list, withdraw-by-id, single-registration lookup and recovery-version routes are recorded there now.
- The owner merges. Every packet ends with green current-head CI and an advisor review before merge.

## Packets, in order

| # | Packet | Goal (ledger IDs) | Files | Acceptance checks | Protected behaviour | Owner |
|---|---|---|---|---|---|---|
| 1 | Lost work (in progress, branch `fix/lost-work`, PR #37) | R23, R41, R42, R43 | `newweb/src/registry-ui.jsx`, `newweb/src/main.jsx`, `newweb/src/outbox.mjs`, `docs/OUTBOX.md`, spine AD-17 | The branch's own tests; `registry-session.test.mjs`, `registry-wiring.mjs`, `outbox.test.mjs` green | AD-15 row contents, AD-17 "no token on the channel", flag-off bundle scan | Builder of `fix/lost-work`; owner merges |
| 2 | Seal & send / Verify split, front door and page shell | R12, R13, R15, R17, R18, R19, R20, R21, R24, R32, R76 | `main.jsx` (single writer), new `newweb/src/front-door.jsx`, `newweb/src/verify-start.jsx`, `newweb/src/compare-table.jsx`, `newweb/src/style.css` | AC-04 (rewritten), AC-06, AC-09, AC-13, AC-51 to AC-55, AC-59, AC-61, AC-65 to AC-67; axe 0 at 320/390/768/1440; `console.mjs`, `manifest-mode.mjs`, `edge-matrix.mjs`, `tests/web/e2e.mjs`, `tests/web/routes.mjs` | Format `FLTSEAL1`, receipt v1, `docs/verifier.js` verdicts, existing routes and deep links, sample privacy, confirm-before-replace | UI builder; `main.jsx` writer for this packet |
| 3 | Company onboarding | R28, R29, R71 | new `registry/tools/onboard.py` (operator script), `registry/registry/identity.py`, `docs/aws/RUNBOOK_AWS.md`, `infra/lib/stack.ts` (`TemporaryPasswordValidityDays`), `infra/test/stack.test.ts` | Script refuses an org not on the allow-list and defaults the role to `pilot`; synth asserts the password validity; identity test: an access token carrying `custom:org_id` is 401 (`token_use == "id"`); Trust copy states the provisional signing arrangement (Option A) | AD-3 (org and role only from verified claims), self sign-up stays off, `org_id` stays immutable | Registry builder; the owner answers Option A or B before packet 4 starts |
| 4 | Key enrollment UI and share list | R33, R34, R36, R54 | `app.py` and `registry-client.mjs` (single writer), new `newweb/src/company-keys.jsx`, `registry-ui.jsx`, `trusted-keys.mjs`, `docs/aws/ARCHITECTURE_AWS.md` | AC-38 to AC-40, AC-48, AC-62; registry tests: 31-day share is 400, the four-item share transaction with its index item, list paging, wrong org, withdraw by share id with every transaction condition, stub rows; pin refused without source and attestation | AD-4 challenge rules, AD-9 identical 404 and hashed tokens, AD-6 tombstones, existing `DELETE /v1/shares/{token}` | Registry builder (server and client) |
| 5 | Recovery: saved vs refreshed status, recovery version, security journal | R39, R40, R48, R49, R50, R73, R75 | `app.py`, `restore.py`, `infra/lib/stack.ts` (journal table), `registry-client.mjs`, `registry-ui.jsx`, `ARCHITECTURE_AWS.md`, `RUNBOOK_AWS.md`, `THREAT_MODEL.md` | AC-25, AC-63, AC-64; registry tests: the recovery version is the opaque `RESTORE_ID` and clients compare for equality; journal item in the same transaction as each tombstone and creation; restore with the served table absent; chained restores; ordering by `at`; a lost share keeps its original `expires_at` (repro case A) and a re-sent registration its original `received_at` (case B); restored-table checks keep the gate closed on failure | AD-7 restore gate, AD-14 ack meaning, PR #38's deleted stub and replay guard | Registry builder; after PR #38 merges |
| 6 | Jobs | R22, R23 (Jobs part), R26 | new `newweb/src/jobs.jsx`, new `newweb/src/jobs-store.mjs`, one import in `main.jsx` | AC-56 to AC-58, AC-60; flag-off scan split (below) | AD-1 (no file bytes stored), AD-2 (no job labels to the registry), AD-16 (no registry code on Pages) | UI builder |
| 7 | Infra, retention and cost | R51, R52, R56, R57, R59, R74 | `infra/lib/stack.ts`, `infra/test/stack.test.ts`, `registry/registry/app.py` (scrub job and 503 `paused`, single writer), `newweb/src/outbox.mjs` (`paused` and `Retry-After`), `docs/aws/COST.md`, `docs/aws/RUNBOOK_AWS.md`, `docs/aws/COVERAGE.md` | Synth: production has PITR 35 days, deletion protection, RETAIN on table and user pool; local stays DESTROY and PITR off. Registry test at day 89, 90, 91 for the `enrolled_by` scrub anchored on `enrolled_at`, over KEY items, key tombstones, the journal and restored records, with an idempotent rerun; EventBridge schedule and `dynamodb:Scan` asserted at synth. Pause switch asserted at synth | AD-12 pay-per-use envelope, AD-13 coverage columns, no `cdk deploy` from an agent | Infra builder; owner alone deploys |

Externally blocked rows (R55 real AWS, R60 dedicated origin) get scripts or steps prepared inside packets 5 and 7 and are reported as blocked, not skipped. R66 (VoiceOver) is unconfirmed until its first recorded run.

## Tests that change on purpose

These assertions encode the old layout or the old wording. Each packet changes them in the same PR and names the change in the PR body.

| Test | Today | Change | Packet |
|---|---|---|---|
| `newweb/tests/registry-wiring.mjs:26` `FORBIDDEN` and the flag-off check at `:177-200` | One list forbids both registry strings and "Sealed on this device" in the Pages bundle | Split into two lists: "registry never ships" (`Company registry`, `Test sign-in`, `hashwing-outbox`, `/v1/`, `dev-hs256`, the test secret) stays forbidden; "local history may ship" (`Sealed on this device`, Jobs strings) is allowed and checked to make no registry request | 6 |
| `newweb/tests/console.mjs:771` "only the five primary links show", and AC-04 | Five primary links: Seal & send, Verify, Records, Receipts, Trust | Four: Seal & send, Verify, Jobs, Trust. Records and Receipts move to More tools; their routes and headings stay (`console.mjs:754,793`) | 2 |
| "Registered at" strings: `registry-ui.jsx:200,335`; `registry-wiring.mjs:284,290-326`; `registry-session.test.mjs:108`; `recipient-trust.test.mjs:62`; `docs/OUTBOX.md` (from PR #32) | "Registered at {received_at}" from the saved row | "Last confirmed by this device {observed_at}" with a Refresh action. "Registered at" appears only after a successful authorized lookup in this session | 5 |
| `registry-ui.jsx:405` share length options (tested through AC-48) | 7, 30, 90, 365 days | 7 and 30, default 30 | 4 |
| `recipient-trust.mjs:101` and the tests that assert "Not in manifest" (`manifest-mode.mjs`, `recipient-trust.test.mjs`) | "Not in manifest" for extra files | "Not in the list", the one name in rows and counts | 2 |
| `main.jsx:1462` session strip and the tests that expect it on Trust | Hidden only on Seal & send | Shown only on Verify and More tools (AC-66) | 2 |

## Skill-use record (baseline PR)

Only skills actually read or run for this baseline:

| Skill | Read by | Used for |
|---|---|---|
| Frontend Taste 2.5.1 (`~/.claude/plugins/cache/taste-skill/taste-skill/2.5.1/skills/taste-skill/SKILL.md`) | coordinating session | System rules only (one button pair, one panel style, equal edges, no filler, hover and press feedback, no carousels or timed tabs, reduced motion). Its marketing-page photography and effects rules were not applied to the console |
| UI/UX Pro Max: one design-system search and two UX-domain searches | coordinating session | "Minimalism & Swiss Style" fit; 44px targets, visible labels, errors next to fields, progress for multi-step, full-width tables on desktop and per-file summaries on mobile. Its navy / Plus Jakarta palette and marketing hero were rejected |
| bmad-architecture: `lint_spine.py` | this PR's author | Spine lint, 0 findings after the update |
| BMAD `memlog.py append` | this PR's author | Decision entries in both `.memlog.md` files |

The bmad-ux skill was not loaded; its existing DESIGN.md / EXPERIENCE.md split was kept.

## Control inventory (R67)

Each packet adds its screen's controls here as it lands, with keyboard, focus, accessible name, 44 px and contrast checked in a real browser. Empty at baseline.

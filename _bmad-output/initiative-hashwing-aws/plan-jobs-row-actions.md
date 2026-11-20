---
title: 'Jobs row actions: share links, delete, {company} label, company switch, Last confirmed + Refresh'
type: feature
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '09c3af10bafdb3c1faabd00051d36ed1bdcf3c34'
route: full
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: ['/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-jobs/AGENTS.md', '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-jobs/_bmad-output/initiative-hashwing-aws/plan-jobs-registry-status.md']
warnings: ['multiple-goals', 'oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** In registry-on builds the Jobs row detail (#59) shows status only; share links and "Delete hosted record" live only in Seal & send's registry list, rows carry no "{company}" label, a company switch is untested, and a saved ack reads "Registered at" although the owner decided (R39, AD-15) it must read "Last confirmed by this device {time}" with a Refresh lookup.

**Approach:** Reuse `ShareLinks`/`DeleteRecord` from `registry-ui.jsx` inside the Jobs detail through a generic slot in `jobs.jsx`; derive the company label from the current sign-in's snapshot; keep made links and refreshed records in the session store (memory only, cleared on owner change); add the PROPOSED `GET /v1/registrations/<rid>` route for Refresh.

## Boundaries & Constraints

**Always:** flag-off bundle and behaviour unchanged (no new string in `docs/console`); all new copy in `registry-ui.jsx`; Refresh requests only on press; share lifetime 7/30 days, default 30; 44px targets, keyboard, focus never lands on body after delete/withdraw; no duplicate DOM ids between the hidden Seal & send list and Jobs; nothing from company A shown under company B.

**Never:** touch Verify (`registryTimeField`, Verify screens, `recipient-trust.mjs`, `docs/verifier.js`) or Trust; change `outbox.mjs` labels or chip text (chip stays "Registered"); hand-edit `docs/console`; deploy.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error handling |
|---|---|---|---|
| Saved ack | registered, active, not refreshed | line "Last confirmed by this device {acked_at, else updated_at}. This is the registry's statement, not proof of the files." + Refresh | — |
| Refresh ok | GET 200 active | "Registered at {received_at UTC}. …" for the session; Refresh hidden | — |
| Refresh deleted | GET 200 disposition deleted | outbox.markDeleted → "Registered, later deleted" | save failure message |
| Refresh fails | 404 / 401 / network / other | saved line kept + why | plain-words message, role=alert |
| Company switch | A rows, sign in as B | no A label, status, share link, refresh or delete; back to A restores status | late answers dropped |
| Member | pilot role | share links, no Delete | — |

</intent-contract>

## Code Map

- `registry/registry/app.py:36-38,376-393` -- add `("GET", r"/v1/registrations/([0-9a-f]{32})", "get_registration", ANY)`; handler returns the list row shape for one rid (org-scoped PK), 404 `not_found()` otherwise. Dev server (`registry/devserver/server.py`) uses this app, no change.
- `infra/lib/stack.ts:89-91` -- add `[GET, '/v1/registrations/{id}']`; `infra/test/*.ts:155` route count 16 → 17.
- `registry/tests/test_registry_app.py` -- tests: own record, other org 404, unknown 404, deleted stub.
- `newweb/src/registry-client.mjs:76` -- `getRegistration(id, opts)`.
- `newweb/src/registry-ui.jsx` -- state `links` {rid→link} and `confirmed` {rid→received_at}, reset in `closeOutbox`; `refreshRecord(row)` (token/owner captured once, result dropped if owner changed); `jobLine`/RegistryRow registered sentence → "Last confirmed…" unless confirmed; `jobsStatusMap` adds `company` (= `s.claims.org`) for current-owner rows/pending, and the `row`; `ShareLinks`/`DeleteRecord` take an id prefix and read/write `links` from store; new `RecordActions` (Refresh + ShareLinks + admin DeleteRecord) used by RegistryRow and exported `JobRecordActions`; `useJobsRegistry` returns `detailActions(job)`.
- `newweb/src/jobs.jsx` -- generic: Status shows `s.company`; JobDetail renders `detailActions?.(job, s)` slot; Details button gets id for focus return. No new string literals.
- `newweb/src/main.jsx:1916` -- pass `detailActions`.
- `newweb/src/style.css` -- `.jobs-company` small label.
- Tests: `newweb/tests/registry-session.test.mjs` (jobsStatusMap line/company/confirmed), `newweb/tests/registry-client.test.mjs` (getRegistration path), `newweb/tests/registry-wiring.mjs` (update :376/:384/:1334 expectations; new flag-on Jobs checks; flag-off scan strings), `newweb/tests/jobs.mjs` (flag off: no company/actions).

## Tasks & Acceptance

**Execution:**
- [ ] server route + infra + pytest
- [ ] client `getRegistration` + unit test
- [ ] registry-ui store/state, RecordActions, lines, company
- [ ] jobs.jsx slot + main.jsx wiring + css
- [ ] tests: registry-session, registry-wiring (5 new checks: share in Jobs, delete in Jobs as admin, Last confirmed + Refresh, company switch A→B→A, axe/320/768/1440 + screenshots), flag-off string scan
- [ ] console rebuild rule, docs (AGENTS.md counts, ledger R22/R26/R39, EXPERIENCE AC-56/57/60/63)

**Acceptance Criteria:**
- Given flag on and a Registered job, when its Jobs Details opens, then "Make a share link" makes a link whose lifetime menu offers 7 and 30 days (30 default), and Copy/Withdraw work; the same link shows on Seal & send.
- Given an admin, when "Delete hosted record" is confirmed in Jobs, then the row reads "Registered, later deleted" and focus is on that row's Details button.
- Given a company switch A→B, Jobs shows no "orgA" label and no Registered status; switching back shows them.
- Given the flag-off build, its bundle contains none of the new strings and makes no registry request.

## Implementation Notes

- The first implementation subagent stopped (host went to sleep) while it was updating docs; the parent checked its diff, re-ran the console rebuild rule and every gate, and wrote the ledger, EXPERIENCE and AGENTS changes.
- One `RecordActions` component (Refresh, `ShareLinks`, admin `DeleteRecord`) serves Seal & send's list and the Jobs detail; made links and refreshed records sit in the session store and end with the sign-in.
- After review: the device's observation time is shown in local time, the same as the Sealed column ("19 Nov, 23:26", as in EXPERIENCE.md's examples); UTC is kept for the registry's received_at. A 404 reads "no record" only when its code is `not_found`, so a gateway 404 from an undeployed route gets the generic message. Admin screenshots at 320 and 1440 show the un-refreshed state. At 320, Delete hosted record is full width. Full pytest: 365 passed, 30 skipped.
- Chip text stays "Registered" (deferred, see Design Notes). The flag-off bundle carries no new copy; only the class name `jobs-company` and the prop name `detailActions` appear as code.

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 5 findings — high 0, medium 2, low 3, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` A successful Refresh unmounts the focused button and focus drops to the body, with no announcement. Fixed: the actions box (`tabIndex=-1`) takes focus, a role=status line says "The registry confirmed this record.", and the wiring check asserts both.
  - `[medium]` `[patch]` `docs/aws/ARCHITECTURE_AWS.md` still listed `GET /v1/registrations/{rid}` as not built, with a different response. Fixed: the row now says it is built but not deployed, gives the shape it really returns, and notes that `recovery_version` (AC-64) is still missing.
  - `[low]` `[patch]` DeleteRecord moved focus to the Details button or row summary before the save on this device had finished, so after a failed save the focus was away from the error. Fixed: `deletedRef` removed; the dialog returns focus to the trigger, and `afterDelete` runs only after the save succeeds.
  - `[low]` `[patch]` The AC-25 check pressed Refresh only if the button was there. Fixed: the press is unconditional.
  - `[low]` `[reject]` `registeredLine` prints an empty or 1970 time if `acked_at` and `updated_at` are both missing or null. `outbox.mjs:282-284` always writes `acked_at` and `updated_at` on an ack, so this needs damaged saved data; fixing it means adding a guard branch.

## Auto Run Result

- Summary: in flag-on builds the Jobs row detail now carries Refresh, share links (7/30 days, default 30) and an admin "Delete hosted record", using the same `RecordActions` as Seal & send. Rows show the "{company}" label of the current sign-in. A company switch leaves nothing of the other company on screen. A saved ack reads "Last confirmed by this device {time}" until a signed-in Refresh in this session shows "Registered at {received_at}". The registry gains `GET /v1/registrations/<rid>` (built, not deployed).
- Files: `registry/registry/app.py` (route + `_reg_row`), `registry/tests/test_registry_app.py`, `infra/lib/stack.ts` and `infra/test/stack.test.ts` (17 routes), `newweb/src/registry-client.mjs` (`getRegistration`), `newweb/src/registry-ui.jsx` (store links/confirmed, `refreshRecord`, `registeredLine`, `RecordActions`, company), `newweb/src/jobs.jsx` (generic company label + detail slot), `newweb/src/main.jsx` (wiring), `newweb/src/style.css`, tests (`registry-wiring.mjs` +5 checks, `registry-session.test.mjs` +1, `registry-client.test.mjs` +1, `jobs.mjs` flag-off assertion), `docs/console` (rebuilt), `docs/aws/ARCHITECTURE_AWS.md`, AGENTS.md, ledger, EXPERIENCE.md.
- Review: 4 patches (2 medium, 2 low), 0 deferred, 1 rejected (low, damaged-data time fallback; reason above).
- Follow-up review recommended: true. Two medium patches were applied, and the Refresh focus fix is checked only by the wiring check's activeElement assertion. The open risk is the focus and announcement behaviour, which has not been checked with a screen reader.
- Verification: see AGENTS.md "Measured for the Jobs row actions PR"; after the patches, the console was rebuilt and wiring passed 52/52, followed by the remaining gates.
- Residual risks: the new route is not deployed, so Refresh against the deployed registry gets a 404 until a deploy (the message reads "no record with this ID"). AC-25 (Verify) and AC-64 are still open. The chip text is unchanged. R26 compact list is not adopted.

## Design Notes

Key details: key `RecordActions` by `owner + row.id` so an open dialog or a made link never survives a company switch; id prefixes `seal`/`jobs` so the always-mounted (hidden) Seal & send list never duplicates ids with Jobs; after a delete in Jobs focus goes to that job's Details button (give it `id="job-details-{id}"`), after Withdraw to "Make a share link". Made links live in store state (`links`, memory only), so collapsing Details or leaving Jobs keeps Withdraw reachable and both lists show the same link. The Seal & send registered sentence changes too (one wording on both screens); existing wiring checks that parse "Registered at" from `.registry-detail` (:376, :384) must get `received_at` another way (e.g. `/__dev/registrations?org=orgA`, or press Refresh first) — do not change Verify expectations. Status cell: `{company}` as a small text label after the chip, only when the status entry has `company`. Refresh response must have `registration_id` equal to the row's; otherwise treat as failure.

R26 one compact list: not done if the registry list still owns Assign, Try now/Try again, Export/Import pending proofs, held proofs and imported proofs with no job row — record that in the ledger. Chip text "Last confirmed by this device" is deferred: it changes outbox labels used across Seal & send and filters (~10 checks).

Environment: project root is the git worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-jobs` (branch feat/jobs-row-actions). Edit only there; never edit `/Users/anirudhyadav/flightseal`. Keep test logs and artifacts inside the worktree. A dev registry for browser checks: `python3 registry/devserver/server.py --port 8798` from the worktree (check the port is free first; stop it after); never use ports 8787/4180/8794-8797/8799. Run `npm --prefix newweb ci` once; build with `npm --prefix newweb run build` per AGENTS.md's console rebuild rule. `tests/.data` can be copied from `/Users/anirudhyadav/flightseal/tests/.data`. Do not commit; the parent commits. Do not edit Verify/Trust code (another builder owns it).

## Verification

**Commands:**
- `python3 -m pytest -q registry/tests` -- expected: all pass
- `cd infra && npm ci && npm test` -- expected: all pass
- `node --test newweb/tests/*.test.mjs` -- all pass
- `npm --prefix newweb run test:browser` -- 0 failed
- `REGISTRY_DEV_URL=http://127.0.0.1:8798 node newweb/tests/registry-wiring.mjs` -- 47 + new, 0 failed
- `REGISTRY_DEV_URL=http://127.0.0.1:8798 node --test newweb/tests/outbox-browser.mjs` -- 8/8
- `node newweb/tests/profiles.mjs` -- 8/8
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- 147/147

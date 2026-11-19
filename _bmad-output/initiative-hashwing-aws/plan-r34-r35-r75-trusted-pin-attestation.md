---
title: 'R34/R35/R75: trusted pins need an independent-confirmation attestation; compromised marks persist; no "before compromise" inference'
type: feature
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '0e3855aa422b1b85449cf1187421b8196797a84b'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-pins/AGENTS.md'
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-pins/_bmad-output/initiative-hashwing-aws/design-key-enrollment-option-b.md'
warnings: [multiple-goals]
deferred:
  - summary: >-
      No browser check shows Verify reading "Signed by a key marked compromised" after a page reload or a profile restore.
    evidence: |-
      Verify reads trust only through trustForKey, which the unit tests run on re-read storage and after commitBackupRestore; a Verify reload clears the chosen files, so a browser check needs a reseeded run.
    location: >-
      newweb/tests/manifest-mode.mjs:283
    severity: low
---

<intent-contract>

## Intent

**Problem:** A trusted-company pin can be saved without the user stating they confirmed the fingerprint independently (`pinTrustedKey` accepts source `not-recorded`; neither path asks for an attestation), yet such a pin turns Verify green. R35 (compromised mark survives reload and backup restore) and R75 (no "signature predates compromise" inference) have no tests at the surfaces the ledger names.

**Approach:** Both pin paths require a real source plus an explicit unticked-by-default checkbox ("I confirmed this fingerprint myself, through the channel above, not from the message that came with the file"); the pin stores `confirmedAt`. `trustForKey` returns a new status `unconfirmed` for an active pin without `confirmedAt` (legacy pins), which `verdict()` (unchanged) turns into "Files match · signer not confirmed". Add tests for R35 reload/restore and R75 wording. This is the client part of design PR 2 only; AC-37 ("Matches the registry's record") is NOT built.

## Boundaries & Constraints

**Always:** Work only in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-pins` (branch `feat/trusted-pins-attestation`); never edit `/Users/anirudhyadav/flightseal`. Keep `verdict()` and `VERIFIED_NEEDS_TRUSTED_KEY` strict and unchanged; compromised is checked first and always wins. Plain words, calm UI, 44px targets, keyboard reachable, labels tied to inputs, layout works at 320 and 1440. Checkbox ids are derived from `idPrefix` (the pin controls render twice). A bad/missing `confirmedAt` makes an entry unconfirmed, never dropped (dropping could lose a compromised record). Any dev registry you start uses port 8796 and is stopped after.

**Never:** Don't touch `newweb/src/jobs.jsx`, Jobs parts of `newweb/src/registry-ui.jsx`, or `registry/` (other builders). Don't build AC-37 / `applyRegistryRecord`. Don't extend the profile-backup format. Don't change `docs/verifier.js`, the C++ core, or file/receipt formats. Don't hand-edit `docs/console`; don't commit `_bmad/` or `.venv-agent`. Don't use ports 8787/4180/8797/8798/8799. No commits, pushes or PRs (the orchestrator does those).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Add company, attested | name, fingerprint, source `phone`, `confirmed: true` | entry saved active with `source`, `confirmedAt` (ISO now) | none |
| Add company, no attestation | `confirmed` missing/false | refused, store unchanged | "Tick the box to confirm you checked this fingerprint yourself." (or similar plain sentence) |
| Pin key (check form), no source or `not-recorded` | `source` default | refused, store unchanged | "Choose where you got this key." |
| Pin key, no attestation | source ok, `confirmed` false | refused, store unchanged | same attestation sentence |
| Legacy pin (no `confirmedAt`, any source) | stored entry | `trustForKey` → `{status:'unconfirmed', entry}`; Verify headline "Files match · signer not confirmed"; trust line names the company and says how it was confirmed isn't recorded | none |
| Re-add legacy pin with same name+fingerprint, attested | existing unconfirmed entry | entry upgraded in place: `source` and `confirmedAt` set; now `trusted` | none |
| Attested pin, files complete | confirmed active pin | Verified | none |
| Compromised + confirmed pin of same key | any | `compromised`, headline "Signed by a key marked compromised" | none |
| Compromised mark, then remove + re-add, reload | stored | still compromised; re-add refused | existing message |
| Profile backup create → restore (and failed-commit rollback) | compromised mark present | pin store byte-identical after; key still compromised; re-add still refused | none |
| R75: sealedAt earlier than compromisedAt | manifestReport with compromised trust | Result "Signed by a key marked compromised"; text/markdown/json/pdfLines contain no `before`/`after`/`predate` within a few words of `compromis` | none |

</intent-contract>

## Code Map

- `newweb/src/trusted-keys.mjs` -- `clean()` (add `confirmedAt`, else stripped on every read), `read()` (accept optional `confirmedAt`: keep only a valid ISO string, otherwise omit it — never drop the entry for it), `upsert()` (early return on same name+fingerprint: also set `source` and `confirmedAt` when the existing entry lacks `confirmedAt` and the call is attested), `pinTrustedKey` (default `source` must no longer be accepted: require a key of `SOURCES` other than `not-recorded`, and `confirmed === true`), `addTrustedCompany` (require `confirmed === true`), `trustForKey` (order: compromised → active with `confirmedAt` → `trusted`; active without → `unconfirmed`; replaced → `replaced`). `listTrustedKeys`/`matchingTrustedKey` unchanged. `SOURCES['not-recorded']` stays for legacy display.
- `newweb/src/recipient-trust.mjs` -- `trustLine()` add `case 'unconfirmed'` (e.g. "Signed by a key saved for {name}, but how you confirmed it isn't recorded. Confirm its fingerprint on Trust."); `TRUST_KIND.unconfirmed = 'warn'`. `verdict()` untouched (status !== 'trusted' already gives signer-not-confirmed). `manifestReport` `keyTrust` may add `confirmedAt`.
- `newweb/src/main.jsx` -- `TrustedKeyPinControls` (~2067): add checkbox `${idPrefix}-confirmed`, button disabled until ticked, pass `confirmed` on save and on the replace-confirm path; reset after success. `TrustedCompanies` (~2096): checkbox `tc-confirmed` after the source fieldset, pass `confirmed` through `add(confirmReplace)`, reset after success; active list line: "Added from {source} on {date} · confirmed by you" or, when no `confirmedAt`, a warn hint "Not confirmed yet. Add it again below and tick the box." plus a text button "Confirm" that prefills `tc-name`/`tc-fingerprint` and focuses the source choice. History line adds the same confirmed/not-confirmed word. Also line ~1623 and ~1511 report `keyTrust` objects: add `confirmedAt` alongside `addedAt`. `readCompanies`/`readActivePins` unchanged. Do not touch Jobs/registry blocks.
- `newweb/src/style.css` -- only if the checkbox needs a 44px row; reuse existing `.check-row`.
- `newweb/tests/trusted-keys.test.mjs` -- existing tests call `pinTrustedKey` without source and `addTrustedCompany` without `confirmed`; update them to pass `source`/`confirmed: true`, and `deepEqual` shapes to include `confirmedAt`. Legacy-read test: legacy pin now reads `unconfirmed`. Add R34 tests (both paths × no source / not-recorded / no attestation, store unchanged; legacy upgrade in place).
- `newweb/tests/profile-backup.test.mjs` -- add R35 test: mark compromised in the same MemoryStorage, run `createEncryptedProfileBackup` → `inspectEncryptedProfileBackup` → `commitBackupRestore` (and a restore whose storage `setItem` throws to hit rollback); pin store string unchanged, `trustForKey` still `compromised`, re-add refused. Look at existing helpers in that file first.
- `newweb/tests/recipient-trust.test.mjs` -- `unconfirmed` → signer-not-confirmed, trustLine/TRUST_KIND; R75 test on `manifestReport` (sealedAt `2026-01-01…`, compromisedAt `2026-06-01…`), regex over text, markdown, json, pdfLines.join: `/\b(before|after|predat\w*|prior to)\b\W+(?:\w+\W+){0,3}compromis|compromis\w*\W+(?:\w+\W+){0,3}(before|after|predat\w*|prior to)\b/i` must not match.
- `newweb/tests/manifest-mode.mjs` -- `addCompany` helper (~228) and the Late Co (~504) flow and the pin-control check (~345) must tick the new checkbox; add asserts: add without ticking shows the attestation error; list shows "confirmed by you"; a page `reload()` after Old Co is marked compromised still shows it in history and re-add refused (R35 browser); in the compromised-while-hashing check (~500) assert no before/after-compromise wording on screen and in reports (R75). Line ~384 writes `localStorage` directly — read it and keep its intent (add `confirmedAt` if the test expects trusted).
- `newweb/tests/console.mjs` -- ~1088 Pilot Co / Other Co adds must tick the checkbox.
- `THREAT_MODEL.md:50-56` -- add: the confirmation is the user's own statement stored in the same `localStorage`; a sibling site can write a "confirmed" pin too (same caveat). 
- `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md` -- rows R34 (73), R35 (74), R75 (129): status and exact evidence (file:line, test names, counts). R35 stays partly open for the sibling-origin case (R60). Backup carrying marks to another browser: note not in scope.
- `_bmad-output/initiative-hashwing-aws/ux-hashwing/EXPERIENCE.md` -- Verified row (~465): "pinned in your trusted list, confirmed by you, and not compromised"; note the attestation checkbox in the Trust/Add company copy.
- `AGENTS.md` -- update counts that change (test:browser checks are not counted there; update any count you change, e.g. none if only node --test files change — run and check).
- `docs/console` -- rebuilt via `npm --prefix newweb run build` at the end (orchestrator re-runs after merging fresh main).

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/src/trusted-keys.mjs` -- attestation fields, `unconfirmed` status, in-place upgrade -- R34
- [ ] `newweb/src/recipient-trust.mjs` -- `unconfirmed` trust line + kind -- R34
- [ ] `newweb/src/main.jsx` -- checkboxes in both pin forms, confirmed display, report `confirmedAt` -- R34 UI
- [ ] `newweb/tests/trusted-keys.test.mjs`, `recipient-trust.test.mjs`, `profile-backup.test.mjs` -- matrix unit tests (R34, R35, R75)
- [ ] `newweb/tests/manifest-mode.mjs`, `newweb/tests/console.mjs` -- tick checkbox; R34 refusal, R35 reload, R75 wording browser asserts
- [ ] `THREAT_MODEL.md`, ledger rows, `EXPERIENCE.md`, `AGENTS.md` -- docs with exact evidence
- [ ] `npm --prefix newweb run build` -- rebuild `docs/console`

**Acceptance Criteria:**
- Given Trust → Add company with the box unticked, when the user presses Add company, then nothing is saved and an alert names the box.
- Given a pin saved with the box ticked, when the Trusted companies list shows it, then it reads "confirmed by you" with its source and date.
- Given a pin saved before this change, when a matching proof is checked, then the headline is "Files match · signer not confirmed" and the trust line says how it was confirmed isn't recorded; after re-adding it with the box ticked, the headline is "Verified".
- Given a key marked compromised, when the page is reloaded (and separately after a profile backup restore), then Trust still lists it as marked compromised and Verify reads "Signed by a key marked compromised".

## Implementation Notes

- Implemented by the step-03 subagent as planned. Beyond the plan: the tick clears when the key or fingerprint changes (and, after review, when the source changes); the legacy hint and Confirm button hide for a key already marked compromised; console.mjs drives the legacy pin -> signer not confirmed -> Confirm -> Verified flow with axe.
- R35 and R75 needed no product code; their tests also pass on the baseline.
- Merged origin/main 467cd91 (PRs #59, #60); ledger R35 conflict resolved by keeping the server evidence from #60 and adding the client evidence.

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 8 findings — high 0, medium 0, low 6, false 1, maybe-false 0 (1 low rejected)
- findings:
  - `[low]` `[patch]` Legacy hint says "Add it again below" but the form is above — changed to "above" in main.jsx, console.mjs, EXPERIENCE.md.
  - `[low]` `[patch]` Upgraded legacy pin shows "confirmed by you" with no date (addedAt is '') — the row now reads "confirmed by you on {confirmedAt date}"; console.mjs asserts the date on the upgraded Pilot Co row.
  - `[low]` `[patch]` Check-form checkbox says "key" while the error says "fingerprint" — label now says "fingerprint".
  - `[low]` `[patch]` Tick survives a change of source, so the statement can refer to another channel — both forms clear the tick on source change; manifest-mode.mjs asserts it.
  - `[low]` `[defer]` AC 4 on-screen Verify after reload/restore is unit-level only — deferred (see frontmatter); the Verify path is trustForKey, covered on re-read storage and after restore.
  - `[low]` `[patch]` EXPERIENCE.md bullet after the verdict table omits the new unconfirmed trust line — added.
  - `[low]` `[patch]` Ledger cites manifest-mode.mjs:252 for the disabled pin button — line refs corrected after the final edits (254, 268, 368, 283, 553).
  - `[false]` `[reject]` docs/console rebuild missing from the diff — the diff file excluded docs/console on purpose; the rebuilt bundle is committed (index-B4WZqbg7.js contains the new strings).

## Design Notes

Legacy pins (including ones that had a source) stop reading Verified until re-confirmed. That follows from "no silent pin" and strict Verified; the PR must say so. `unconfirmed` is a separate status (not `untrusted`) because the default untrusted line ("isn't in your trusted list") would be false for a saved company.

## Verification

**Commands:** (run from the worktree root)
- `node --test newweb/tests/*.test.mjs` -- all pass
- `python3 tools/fetch_sample.py tests/.data && npm --prefix newweb run build && npm --prefix newweb run test:browser` -- all pass (copy `/Users/anirudhyadav/flightseal/tests/.data` if fetch is offline; build `build/fseal` via cmake if missing)
- `node newweb/tests/profiles.mjs` -- all pass
- `python3 registry/devserver/server.py --port 8796 &` then `REGISTRY_DEV_URL=http://127.0.0.1:8796 node newweb/tests/registry-wiring.mjs` -- all pass; stop the server
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- all pass

## Auto Run Result

Status: built. Trusted pins on both paths need a real source and an unticked-by-default "I confirmed this fingerprint myself" box; pins store confirmedAt; legacy pins read `unconfirmed` (Files match · signer not confirmed) until re-added; compromised still wins. R35/R75 tests added (no product change needed). AC-37 not built.
Files: trusted-keys.mjs, recipient-trust.mjs, main.jsx (Trust and check-form pin UI), five test files, THREAT_MODEL.md, EXPERIENCE.md, ledger rows R34/R35/R75, docs/console rebuild.
Review: 6 low patched, 1 low deferred, 1 false rejected. followup_review_recommended: false (no high, no medium patched).
Verification at the merged head: node --test newweb/tests/*.test.mjs 147/147; tests/web/*.test.mjs 146/146; test:browser exit 0 (console 35, manifest-mode 16, jobs 13); profiles 8/8; registry-wiring 34/34 against the dev registry on 8796 (stopped).
Residual risk: existing users' pins stop reading Verified until re-confirmed; the tick is a self-statement in shared-origin localStorage (THREAT_MODEL).

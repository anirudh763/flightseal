---
title: 'AC-37: Verify compares a share link with the registry record (downgrade only)'
type: feature
ticket: ''
created: '2026-11-19'
status: in-progress
baseline_revision: 'f2583efddeab71a84ba0be1f5f85b9c1b75d58fd'
route: full
route_source: auto
risk: medium
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-hashwing-aws/design-key-enrollment-option-b.md'
  - '{project-root}/AGENTS.md'
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** On a registry-on build, Verify opened from a share link shows the registry's record, but never compares it with the checked receipt (AC-37 open; design §7.1, spine AD-22). Separately, Verify's "Registry acceptance" row (`registryTimeField`) matches any receipt line of the message, not only the line the registry got.

**Approach:** A pure step `applyRegistryRecord(result, record, receipt)` in `recipient-trust.mjs` runs after `verdict()` only in flag-guarded code: all equal → line "Matches the registry's record", headline unchanged; any differ → warn line "Doesn't match the registry's record for this link", and only `verified` becomes warn "Files match · doesn't match the link"; record unavailable → info line "This link was withdrawn or couldn't be checked", result unchanged. One share fetch feeds both the record panel and the verdict; the verdict waits until it settles. `registryTimeField` uses `registryLine`. Docs corrected; Trust primary button contrast measured; screenshots taken.

## Boundaries & Constraints

**Always:** `verdict()` stays registry-free and unchanged. The step never raises any result. Applied only behind `__REGISTRY_URL__`; flag-off bundle has none of the new strings. Report Result line equals the screen headline on both Verify paths (small file and manifest) in every format. Head and count come from `registryLine(receipts)`; key fingerprint from that line's `key=`.

**Never:** No change to `registry/` (share view has no key state; registry-side compromise signal is deferred per design §11 default 2). Don't touch `outbox.mjs`, session/logout, manifest Cancel. No `docs/verifier.js`, C++ or format changes. Don't hand-edit `docs/console`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Match | record head/count/fp equal the receipt line | line "Matches the registry's record"; headline unchanged | — |
| Mismatch, verified | any field differs, result `verified` | key `link-mismatch`, warn, "Files match · doesn't match the link" | — |
| Mismatch, other result | any differs, e.g. compromised / differ / signer-not-confirmed | warn line added, result unchanged | — |
| Unavailable | 404/withdrawn/expired/network/malformed | info line; result unchanged | — |
| No link | no share token | step not applied; no line | — |
| Multi-line message | two receipt lines | time row and comparison use the last receipt line only | — |

</intent-contract>

## Code Map

- `newweb/src/recipient-trust.mjs` -- `verdict` (unchanged), `manifestReport` (gets optional `applyRecord` hook so reports apply the same step without shipping its strings flag-off); add `applyRegistryRecord`.
- `newweb/src/registry-ui.jsx` -- `ShareRecordPanel` fetch moves to `useShareRecord(token)`; add `useRegistryRecordCheck(view, receipts)` (async key fingerprint via `fingerprintHex`); `registryTimeField` → `registryLine`.
- `newweb/src/main.jsx` -- `shareToken` (l.185); small path `smallReady`/`smallVerdict`/`smallLines`/`smallResultLines`/downloads (l.1509-1560); panels l.1929-1931; `ManifestCheck` (l.2589+) result and `reportFor`.
- `newweb/src/company-keys.jsx:135` -- dialog copy (source of truth for docs).
- Workspace: `{project-root}` is the git worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-verify` (branch `feat/verify-registry-record`). Never edit `/Users/anirudhyadav/flightseal`. Dev registry for wiring runs: `python3 registry/devserver/server.py --port 8797` (own data; stop it after); never use ports 8787/4180/8795/8796/8798/8799. Don't commit; the parent commits.
- `newweb/src/registry-ui.jsx:298` `registryLine` -- the shared picker; reuse it. `newweb/src/company-keys.mjs` `stateLabel` -- reuse if any key state is rendered (none is in §7.1).
- `VerdictBlock` (`newweb/src/compare-table.jsx:23`) keys `lines` by label: use the unique label "Registry record" (the outbox time line stays "Registry"). The `.registry-record` panel must still never say "matches" (wiring asserts it).
- Tests: `newweb/tests/recipient-trust.test.mjs`, `newweb/tests/registry-session.test.mjs`, `newweb/tests/registry-wiring.mjs` (share link check l.408; company keys axe l.1333; `FORBIDDEN` l.27).

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/src/recipient-trust.mjs` -- add `applyRegistryRecord`; `manifestReport` accepts `applyRecord` and writes a "Registry record:" line.
- [ ] `newweb/src/registry-ui.jsx` -- lift fetch, add record-check hook, fix `registryTimeField`.
- [ ] `newweb/src/main.jsx` -- wire both paths, hold the verdict until the record settles.
- [ ] tests -- unit (never raises: every verdict key × every record outcome; mismatch per field; report Result = headline), session (multi-line time row), wiring (match, mismatch lowers Verified, 404 info line, compromised pin + match stays compromised, report Result = headline, axe 320, keyboard, screenshots; Trust primary button contrast at rest/hover/focus/disabled ≥ 4.5).
- [ ] docs -- design §4.1 bad_challenge + §6 dialog copy; EXPERIENCE dialog copy, bad_challenge, AC-37 built, verdict row, l.223 button name; ledger R24/R33 contrast numbers + AC-37 evidence; AGENTS.md counts; rebuild `docs/console`.

**Acceptance Criteria:**
- Given a registry-on build and a share link whose record matches the checked receipt, when the files are checked, then the verdict lines show "Registry record: Matches the registry's record" and the headline is what it would be without the link.
- Given a pinned confirmed key and a record that differs, when checked, then the headline is "Files match · doesn't match the link" on screen and on the report's Result line.
- Given the flag-off build, when `docs/console` is scanned, then none of the new strings appear.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

`manifestReport(..., applyRecord)` takes a closure built in flag-guarded code: `(r) => applyRegistryRecord(r, record, receipt)`. Flag-off nothing references `applyRegistryRecord`, so Rollup drops it and its strings. Add the new strings to `FORBIDDEN` in `registry-wiring.mjs`; that check scans `git show HEAD:docs/console`, so the parent rebuilds `docs/console` (AGENTS.md rule) and commits before the final wiring run.

Small path: hold `smallReady` while a share token is set and the record or the receipt fingerprint is still loading, so the headline never shows Verified and then drops. Same for `ManifestCheck` (pass the check result in as a prop). Small-path reports: `smallResultLines` (text, Markdown, JSON `verdict`) use the lowered result and add the "Registry record: …" line.

Browser tests (in the existing share-link check, reviewer context; don't compromise SEED_A at the registry, later checks need it): match line with the real record; pin flight-a's key by seeding `localStorage['flightseal_trusted_keys_v1']` with `[{name, publicKey:'', fingerprint, source:'phone', addedAt, status:'active', confirmedAt}]` → Verified + match line; `page.route` a well-formed record with another head → "Files match · doesn't match the link" on screen and on the text report's first line; `page.route` 404 → info line, Verified kept; a compromised pin (`status:'compromised', compromisedAt`) + real record → still "Signed by a key marked compromised". axe at 320 and 1440 with the line shown, Tab reaches the verdict's next control, screenshots `verify-record-{320,1440}.png`.

Contrast (Trust "Your company's keys" primary button, flag-on, 320px): read computed `color`/`background-color` (composite any alpha over the real backdrop) at rest, real mouse hover, keyboard-Tab focus, and disabled; assert ≥ 4.5:1 each, print the four ratios; check whether `.button` has a colour transition (wait for it to finish before sampling). Fix CSS tokens in `newweb/src/style.css` if any is below 4.5. Screenshots `company-keys-{320,1440}.png` of `#company-keys`.

Docs: design §4.1 line "400 `bad_challenge`…" → the client shows "That request expired. Press the button again."; the next press gets a fresh challenge; nothing is fetched automatically. Design §6 and EXPERIENCE dialog copy → verbatim `company-keys.jsx:135`. EXPERIENCE: add the bad_challenge sentence near the keys section, AC-37 → `built` with test cites, a "Files match · doesn't match the link" row (flag on) in Verify verdicts, l.223 "Enroll your signing key" → "Enroll this key". Ledger `initiative-hashwing-aws.md` R24/R33: contrast numbers; AC-37 evidence with file:line and test names; deferred: registry-side compromise/removal signal on the share view (design §11 default 2). Status wording: "built in this PR", never "on branch / not merged".

## Verification

**Commands:**
- `node --test newweb/tests/*.test.mjs` -- all pass
- `REGISTRY_DEV_URL=http://127.0.0.1:8797 node newweb/tests/registry-wiring.mjs` -- all pass
- `npm --prefix newweb run test:browser`; `node newweb/tests/profiles.mjs`; `node --test tests/web/*.test.mjs` -- all pass
- `grep -rl "registry's record for this link\|doesn't match the link" docs/console` -- nothing

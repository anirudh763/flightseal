---
title: 'Verify registry line follows this device''s outbox (AC-25, AC-26)'
type: bugfix
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: '0d7d01abeda1ddeee59f5b17641bce0a9d7d83ce'
route: oneshot
route_source: pinned
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/docs/OUTBOX.md']
warnings: ['multiple-goals']
deferred:
  - summary: >-
      Cross-tab app logout (type logout over BroadcastChannel) has no automated test.
    evidence: |-
      registry-session.test.mjs removes BroadcastChannel and the browser check covers only registry sign-out; app logout needs the local account flow in two tabs.
    location: >-
      newweb/src/registry-ui.jsx createRegistry channel listener
    severity: medium
  - summary: >-
      RegistryBoundary has no test that makes a registry panel throw.
    evidence: |-
      The malformed-share check passes through shareRecord validation before rendering, so it would pass without the boundary; no seam exists to force a render error.
    location: >-
      newweb/src/registry-ui.jsx RegistryBoundary
    severity: low
  - summary: >-
      "Not available yet" (owner set, list not read) has no automated test.
    evidence: |-
      Patched after review; reaching it needs openOutbox to fail or a check during the first refresh window.
    location: >-
      newweb/src/registry-ui.jsx useRegistryTimeField
    severity: low
---

<intent-contract>

## Intent

**Problem:** With `VITE_REGISTRY_URL` set, the "Registry acceptance" time row on a check result (small-file
"Check a sealed log" and the large-file manifest check) and in every report built from it (text, Markdown, JSON, PDF)
always reads "Not registered" / "no registry was used", even when this device's outbox holds a Registered row for the
same receipt. That is a false line on the main demo path and breaks AC-25 and AC-26.

**Approach:** `timeFields()` and `manifestReport()` in `newweb/src/recipient-trust.mjs` take an optional
`registry: { value, basis }` that replaces the row; the default (flag off) stays byte-identical. A flag-guarded hook
in `newweb/src/registry-ui.jsx` maps the checked receipt lines to that row by matching `row.receipt` (every outbox
row has it; `count`/`head` exist only after an ack) against the outbox rows and the signed-out in-memory list. No new
stored fields; only `label`/`value`/`basis` strings reach the reports, never a row.

| Outbox state for the checked receipt | Value | Basis |
|---|---|---|
| registered, active | `Registered at {received_at}` | the registry's clock; the registry's statement, not proof of the files |
| registered, deleted | Registered, later deleted | the registry's statement, not proof of the files; its hosted record was deleted |
| sealed_local / registering / waiting_for_connection / signed-out pending | Not yet registered | this device's list: `{label}` |
| needs_attention | Needs attention | the row's plain message (never the raw code) |
| no row, signed in | No registry record on this device | this device has no registry record for this receipt |
| no row, signed out | Not signed in | sign in to the company registry to see this device's record |
| flag off | Not registered (unchanged) | no registry was used (unchanged) |

</intent-contract>

## Implementation Notes

Oneshot: one optional parameter in a pure helper, one hook in the flag-guarded registry module and two guarded call
sites in `main.jsx`. All four small-file exports derive from `resultTimes`; all four manifest exports derive from
`manifestReport` fields, and the manifest report is recomputed when the registry line changes.

Failing-first: a new check in `newweb/tests/registry-wiring.mjs` (flag on: seal with the enrolled key, Registered,
check the same receipt; the Registered line on screen and in the text, Markdown, JSON and PDF exports, no "Not
registered", no token) and a unit test of the override in `newweb/tests/recipient-trust.test.mjs`. The existing
flag-off check keeps "Not registered" / "no registry was used".

Implemented as planned: `timeFields`/`manifestReport` take `registry`; `useRegistryTimeField` in `registry-ui.jsx`
matches `row.receipt` against the checked lines (rows and the signed-out pending list); `main.jsx` feeds it into
`resultTimes` and recomputes the manifest report with `useMemo`. Before: registry-wiring 18/20, recipient-trust
override test failing. After: 20/20. Surprise: the PDF wraps lines at 92 characters, so the test compares with
whitespace normalized; the shared decoder is `newweb/tests/pdf-text.mjs`.

Extra scope from the coordinator (independent review of 0d7d01a), same branch, each failing first:
1. Share view validates every field (`shareRecord`); malformed, 429 and 503 show the unavailable message;
   `RegistryBoundary` wraps the three registry panels. 2. Sign-out and logout broadcast on
   `BroadcastChannel('hashwing-registry')` (owner only, no token). 3. Announce resets on owner change; display names
   are pruned when a different owner signs in (not on a same-owner sign-in, which keeps its names). 4. A `user`
   counter bumped by logout stops a mid-await sign-in flush or seal save from restoring proofs. 5. 429 handled in 1.
6. manifest-mode reads the compromised line from the PDF. 7. ARCHITECTURE_AWS.md note on tokens in the GET/DELETE
   path. Before: registry-wiring 18/22, registry-session 0/3. After: 22/22 and 3/3.

## Verification

**Commands:**
- `npm --prefix newweb run build` -- expected: docs/console rebuilt, flag off
- `node newweb/tests/registry-wiring.mjs` -- expected: all checks pass (19 + new)
- `node --test newweb/tests/recipient-trust.test.mjs newweb/tests/trusted-keys.test.mjs` -- expected: pass
- `npm --prefix newweb run test:browser`, `node newweb/tests/edge-matrix.mjs`, `node tests/web/e2e.mjs`, `node tests/web/routes.mjs`, the AGENTS.md JavaScript gate -- expected: pass
- `gitleaks git --log-opts=origin/main..HEAD` -- expected: no leaks

## Review Triage Log

### 2026-11-17 — Review pass
- verdicts: 8 findings — high 0, medium 2, low 4, false 0, maybe-false 0 (2 rejected as out of the reviewer's frame)
- findings:
  - `[medium]` `[patch]` Signed in but outbox not open (opening or failed) showed "Not signed in" — now `!s.owner` gives "Not signed in" and an open-pending or unread list gives "Not available yet"; OUTBOX.md updated.
  - `[low]` `[patch]` Between opening the outbox and the first refresh the line fell through to "No registry record" — added `listed`, set by refresh and cleared on close; the line reads "Not available yet" until then.
  - `[low]` `[reject]` Raw `received_at` in the line — AC-25 asks for `{received_at}` verbatim; it is the registry's own ack value, checked as a string by the outbox.
  - `[low]` `[patch]` OUTBOX.md said logout carries the owner — reworded: sign-out names the owner, logout signs every tab out.
  - `[medium]` `[defer]` Cross-tab app logout untested — recorded in `deferred`.
  - `[low]` `[defer]` RegistryBoundary untested — recorded in `deferred`.
  - `[low]` `[reject]` Plan carries extra scope — the extra items were added by the coordinator mid-run; recorded in Implementation Notes and `warnings: multiple-goals`.
  - `[low]` `[patch]` Manifest browser check covered only the text report — it now checks text, Markdown, PDF and JSON.

## Auto Run Result

- Summary: Verify registry line (AC-25/AC-26) on small-file and manifest checks plus the seven coordinator-added review fixes; see Implementation Notes.
- Files: `newweb/src/recipient-trust.mjs` (registry override), `newweb/src/registry-ui.jsx` (time-row hook, share validation, boundary, broadcast, session races, announce/names), `newweb/src/main.jsx` (wiring, boundaries), `newweb/tests/registry-wiring.mjs` (+2 checks, extended checks), `newweb/tests/registry-session.test.mjs` (new, 3), `newweb/tests/pdf-text.mjs` (new helper), `newweb/tests/recipient-trust.test.mjs` (+1), `newweb/tests/manifest-mode.mjs` (PDF line), docs (OUTBOX, ARCHITECTURE_AWS, AGENTS counts), CI, rebuilt `docs/console`.
- Review: 4 patches (1 medium, 3 low), 3 deferred, 2 rejected (reasons above). All three deferred items were then covered by unit tests in `newweb/tests/registry-session.test.mjs` (fake BroadcastChannel for sign-out and logout messages, `registryTimeField` for every row state, `RegistryBoundary` render), 7/7 at head and 0/7 against main's registry-ui.jsx. The manifest check now matches receipt lines through `parseHandover`, so quoted or wrapped messages find their row.
- Follow-up review recommended: false (one medium patched).
- Verification: registry-wiring 22/22; registry-session 7/7; recipient-trust 11/11; trusted-keys+recipient-trust+report-pdf 29/29; outbox+client+session 56/56; outbox-browser 8/8; test:browser console 33 + manifest-mode 16 checks; edge-matrix 9; e2e 5; routes 6; JS gate 142/142; gitleaks clean.
- Residual risks: the deferred items; cross-tab sign-out misses frozen or discarded tabs (documented).

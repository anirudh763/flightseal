---
title: 'Verify registry line follows this device''s outbox (AC-25, AC-26)'
type: bugfix
ticket: ''
created: '2026-11-17'
status: in-progress
baseline_revision: '0d7d01abeda1ddeee59f5b17641bce0a9d7d83ce'
route: oneshot
route_source: pinned
risk: medium
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md', '{project-root}/docs/OUTBOX.md']
warnings: []
deferred: []
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

## Verification

**Commands:**
- `npm --prefix newweb run build` -- expected: docs/console rebuilt, flag off
- `node newweb/tests/registry-wiring.mjs` -- expected: all checks pass (19 + new)
- `node --test newweb/tests/recipient-trust.test.mjs newweb/tests/trusted-keys.test.mjs` -- expected: pass
- `npm --prefix newweb run test:browser`, `node newweb/tests/edge-matrix.mjs`, `node tests/web/e2e.mjs`, `node tests/web/routes.mjs`, the AGENTS.md JavaScript gate -- expected: pass
- `gitleaks git --log-opts=origin/main..HEAD` -- expected: no leaks

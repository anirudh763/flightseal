---
title: 'Walkthrough rough spots: one Files differ note, bar link fits at 320px, calm client registry line, profile removal race'
type: bugfix
ticket: ''
created: '2026-11-19'
status: in-review
baseline_revision: '56fc2192098eefae77ce2e578cd43c32e237ccbd'
route: oneshot
route_source: auto
risk: medium
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md']
warnings: ['multiple-goals']
deferred: []
---

<intent-contract>

## Intent

**Problem:** A demo walkthrough on main found three rough spots and the #54 review found one race: (1) Verify shows the "Files differ" explanation twice (under the verdict and again in the file's row or comparison box); (2) at 320px the flag-on command bar cuts "Company registry" off with an ellipsis; (3) a client who opened a share link with no account reads "Registry: Not signed in", which sounds like an error; (4) a small or large seal that finishes while its profile is being removed can call `addJob` with the removed scope and recreate that profile's jobs database.

**Approach:** (1) Show the per-row/compare explanation only when the verdict is not `differ` (the verdict already says it); status chips and report text stay. (2) Let the bar link wrap to two lines inside its 44px target instead of truncating; visible text and accessible name unchanged. (3) `registryTimeField` takes `{ fromLink }`; signed out with a share link open it reads "No account needed" with a plain basis. The registry stays its own line; `verdict()` gets nothing registry-related. (4) A removed-scope guard inside `addJob` (the one function both seal paths call), set synchronously before the jobs store is closed and deleted.

</intent-contract>

## Implementation Notes

Oneshot: about 100 lines across a few small source edits plus tests. Tests were written first and run on the baseline to capture "before" screenshots and failures.

Files: `newweb/src/main.jsx` (items 1, 3, 4), `newweb/src/registry-ui.jsx` (item 3), `newweb/src/style.css` (item 2), tests `newweb/tests/{manifest-mode,console,jobs,registry-wiring}.mjs`, `newweb/tests/registry-session.test.mjs`; `docs/console` rebuilt.

Results: before the fix, the new checks failed on the baseline: manifest-mode (2 checks: explanation shown twice), jobs (race check: the removed profile's jobs database came back), registry-wiring share-link check ("Not signed in") and bar-link check (cut 0.297px at 320px; scrollWidth rounds this away, so the check measures sub-pixel line widths with the ellipsis off). After: all pass.

Surprise: the 320px truncation was a 0.3px overflow (label 112.3px in a 112px box), so wrapping fixes it at any font metric rather than nudging the max-width.

Docs: docs/OUTBOX.md and ux-hashwing/EXPERIENCE.md name the new "No account needed" line; the initiative open-items list marks four of five items fixed ("Sealed locally" in Jobs stays open).

## Verification

**Commands:**
- `npm --prefix newweb run build` then `npm --prefix newweb run test:browser` -- expected: all checks pass
- `node newweb/tests/registry-wiring.mjs` -- expected: all checks pass
- `node newweb/tests/profiles.mjs` -- expected: all checks pass
- `node --test newweb/tests/registry-session.test.mjs` -- expected: all pass
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- expected: all pass

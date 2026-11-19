---
title: 'Walkthrough rough spots: one Files differ note, bar link fits at 320px, calm client registry line, profile removal race'
type: bugfix
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '56fc2192098eefae77ce2e578cd43c32e237ccbd'
route: oneshot
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
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

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 6 findings — high 0, medium 0, low 5, false 0, maybe-false 1
- findings:
  - `[maybe-false]` `[reject]` Cross-tab: a second tab on the same profile could recreate the jobs DB after removal — that tab's logoutFromAnotherTab runs keepUnsavedThenClear → clearSensitiveWorkspace, which bumps runRef/protectRunRef and aborts the controller (small seal stops at its next op check) and remounts ManifestSeal (unmount aborts it). Only a write already past those checks could slip through; settling it needs a two-tab timing test. If real it is low, so rejected with this note.
  - `[low]` `[patch]` registry-wiring client-result screenshots taken before the registry line settled — moved the screenshots after the "No account needed" assertions.
  - `[low]` `[patch]` bar-link fit not checked at 768px — loop now covers 320/768/1440.
  - `[low]` `[patch]` new basis text narrated the interface (owner copy rule) — shortened to "opened from a share link; not used in this check".
  - `[low]` `[patch]` docs/OUTBOX.md option list read wrongly — reworded as three parallel options.
  - `[low]` `[patch]` small-file restored/copy box could show the explanation before the verdict appeared, then hide it — now shown only once a non-differ verdict exists.

## Auto Run Result

- Summary: Verify shows the Files differ explanation once; the flag-on bar link wraps at 320px instead of truncating; a signed-out client with a share link reads "Registry: No account needed"; removing a profile marks its jobs scope removed before closing the store so late seals cannot recreate its jobs DB.
- Files: newweb/src/main.jsx (items 1, 3, 4), newweb/src/registry-ui.jsx (item 3 wording), newweb/src/style.css (item 2), newweb/tests/{console,manifest-mode,jobs,registry-wiring}.mjs and registry-session.test.mjs (tests), docs/OUTBOX.md and ux-hashwing/EXPERIENCE.md (wording), initiative open items, docs/console rebuilt.
- Review: 5 low patches applied, 0 deferred, 1 rejected (cross-tab, maybe-false, reason above). followup_review_recommended: false (no high, fewer than two medium patched).
- Verification: test:browser 64 ok (console+manifest-mode 51, jobs 13/13); one earlier run timed out once in the console "one task at a time" check waiting for #handover-text and passed on rerun (it doesn't touch the changed lines); registry-wiring 29/29; profiles 8/8; newweb unit tests 65/65; tests/web 146/146. New checks failed on the baseline before the fix.
- Residual risk: the cross-tab removal case is untested.

## Verification

**Commands:**
- `npm --prefix newweb run build` then `npm --prefix newweb run test:browser` -- expected: all checks pass
- `node newweb/tests/registry-wiring.mjs` -- expected: all checks pass
- `node newweb/tests/profiles.mjs` -- expected: all checks pass
- `node --test newweb/tests/registry-session.test.mjs` -- expected: all pass
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- expected: all pass

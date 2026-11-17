---
title: 'Simpler console navigation'
type: feature
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: 'c375509469b9e16eb51eb7ef746678a55326ab3b'
route: oneshot
route_source: auto
risk: low
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The console rail shows nine equal links (Seal & send, Samples, Verify, Records, Benchmarks, System, Receipts, Video, Trust), so the main job (seal a file, hand it over, check it) competes with demo and diagnostic pages. The Seal & send screen also shows the workbench's session strip and "Source and report actions" bar, which belong to the Verify workbench, and signed-in users still see "Log in / Create account".

**Approach:** Keep Seal & send, Verify, Records, Receipts and Trust in the primary rail; move Samples, Video, Benchmarks and System into a "More tools" disclosure inside the same nav (opens automatically when one of them is the current page, Escape closes it). Hide the session strip and source actions on Seal & send, and hide the topbar auth links for a signed-in account. Deep links, route names, product-mode (CANONICAL_NAV) and screen contents stay unchanged.

</frozen-after-approval>

## Tasks & Acceptance

- `newweb/src/main.jsx` -- split NAV into primary/secondary; render secondary in `<details className="nav-more">`; hide strip/source actions on `protect`; hide auth links when `activeSession?.kind === 'account'`.
- `newweb/src/style.css` -- style the disclosure to match rail links, including the 320px mobile menu.
- `newweb/tests/console.mjs` -- open "More tools" before clicking secondary links; assert the disclosure and the hidden Seal & send chrome.

**Acceptance Criteria:**
- Given any hash route, when the rail renders, then only the 5 primary links are visible and Samples/Video/Benchmarks/System appear after opening "More tools".
- Given the current page is a secondary tool, when the rail renders, then "More tools" is open and that link has aria-current="page".
- Given the Seal & send screen, then no session strip or "Source and report actions" bar is shown.
- Given a signed-in account, then the topbar shows no "Log in"/"Create account" links.

## Implementation Notes

Oneshot: about 40 changed lines across three files, all inside the existing nav rendering.

## Verification

**Commands:**
- `cd newweb && npm run build` -- expected: build succeeds
- `cd newweb && node tests/console.mjs` -- expected: all checks pass
- `node tests/web/routes.mjs` and `node tests/web/e2e.mjs` -- expected: pass

**Manual checks:**
- Screenshots at 320/768/1440px of the rail with "More tools" closed and open; no console errors.

## Review Triage Log

Pass 1 (quick lens): 5 real (2 medium, 3 low), 1 rejected.
- medium, patched: Escape on a closed "More tools" was swallowed by `closeDisclosure`, so the 768px mobile menu could not be closed by keyboard. Fixed in the shared function (only acts when the disclosure is open); a 320px test now covers it.
- medium, patched: auto-open on a secondary page was untested (the helper clicked the summary itself). Test now loads `#/video` directly and checks the disclosure is open with aria-current.
- low, patched: AC4 had no test. The signup check now asserts the account links are hidden.
- low, patched: AC1 only checked Benchmarks. Now checks all four secondary links are hidden and exactly five links are visible.
- low, patched: summary colours did not match the later `.nav a` overrides. Now uses the same colours.
- low, rejected: duplicate `useState` initializer plus effect. The initializer avoids one closed-then-open render on a deep link; harmless.

Verification (macOS, this branch): console browser 33/33, JS 131/131, edge-matrix ok, e2e 5/5 (the file has 5 checks; AGENTS.md says 6, pre-existing), routes 6/6, private-lifecycle 19/19, action-offline 3/3, product-routes no unexpected HTTP failures. Screenshots at 320/768/1440 px: no console errors, no horizontal scroll. newweb/tests/profiles.mjs fails 3/7 identically on unchanged main (not in CI); deferred.
- medium, patched (CI pass 2): More tools sometimes stayed closed on a secondary page. A <details> toggle event fires late, so the mirrored React state was still true after Escape and the reopen was a no-op. Now the route sets the DOM open state directly in a layout effect; repro script went from 13/15 failures to 0/15, console suite 33/33 six runs in a row.

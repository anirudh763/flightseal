---
title: 'Lost-work fixes: unsaved work on logout, reload and expiry; narrow the registry logout message; owner-tagged unsent proofs'
type: bugfix
ticket: ''
created: '2026-11-17'
status: in-progress
baseline_revision: 'a3f6fe52a4f5e5282ff9b7a551341d9cfbf8a0fd'
route: full
route_source: auto
risk: medium
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/OUTBOX.md'
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Sealed results, receipt messages and unsent registry proofs can vanish without warning: another tab's logout wipes this tab, a reload drops them silently, the registry's every-tab `{type:'logout'}` (also sent on sign-in, account switch and demo start) wipes unsent proofs in tabs of other profiles, and an unsent in-memory proof has no owner, so the next registry sign-in in the tab queues it under anyone. The `key_not_enrolled` copy points at an enroll control that does not exist, and `profiles.mjs` fails 3 of 7.

**Approach:** Warn before losing (reload prompt; block local logout, switch and demo while work is unsaved, with one "Download unsaved work" action); when the loss is forced (another tab logged this profile out, or the server workspace signed out), keep the unsaved work in this tab's memory and offer it as one download on the landing page. Make the registry logout local only (the local-auth logout message already names the profile), keep the owner-scoped `signout` message, and tag each in-memory proof with the registry owner it was sealed under.

## Boundaries & Constraints

**Always:** AD-17 binding rules: no token on any channel; a registry sign-out stops every tab of that owner. AD-15: owner match before every send; outbox rows never hold names, media or keys. Plain, calm copy; one primary action per step. Failing-first tests; measured counts only.

**Never:** restructure the Seal & send or Verify layout; build key enrollment; persist proofs or names to `sessionStorage`/`localStorage` (no new storage surface); send a proof tagged with one registry owner under another; show a held proof's file name to another owner.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Other tab logs out this profile | Tab A has a Seal & send result not yet saved and an unsent proof; tab B (same profile) logs out | Tab A goes to the landing page and shows "You were logged out in another tab..." with "Download unsaved work" (one zip) and "Discard"; registry token gone | Zip failure shows a plain message; work stays |
| Other profile's tab logs out | Tab A profile P1 (unsent proof), tab B profile P2 logs out | Tab A unchanged: proof and registry sign-in kept | none |
| Sign-in / switch / demo in tab B | Tab A has unsent proof | Tab A unchanged | none |
| Local logout with unsaved work | Seal & send result or unsent proof in this tab | Logout blocked with message and "Download unsaved work"; after the download logout works | none |
| Reload | Seal & send result, large-file result or unsent proof not saved | `beforeunload` is prevented | none |
| Registry token ends (401) | Waiting rows | Rows stay, list asks to sign in again (nothing lost today; kept) | none |
| Proof sealed under owner X, then owner Y signs in | pending tagged X | Not sent; row says it was sealed under another registry sign-in, with Export; name hidden | none |
| Proof sealed signed out, then sign-in | pending with no owner | Sent under the first sign-in (unchanged) | none |
| key_not_enrolled | row needs attention | Copy asks the company's registry admin to enroll the key with this fingerprint; the fingerprint is shown | none |

</intent-contract>

## Code Map

- `newweb/src/registry-ui.jsx` -- session store `createRegistry`: `sealed()` (capture owner before await), `signIn()` flush (only `!p.owner || p.owner === owner`), names pruning on owner change, `logout()`/`logoutHere()` (drop `{type:'logout'}` post and receiver), `exportPending()` marks receipts exported; new `useRegistryUnsent()` / `registryUnsentExport()`; `SealedOnDevice` held-row body; `REASONS.key_not_enrolled` copy; `RegistryRow` fingerprint line (`fingerprintHex` of the receipt's `key=`; matches `registry/registry/receipt.py fingerprint`).
- `newweb/src/main.jsx` -- `beforeunload` effect (~260), `clearSensitiveWorkspace` (~1074, also clear Seal & send state), `logout`, `beginDemo`, `finishAuthentication`, `removeActiveProfile`, `logoutFromAnotherTab` (~1106), `WorkspaceStore.register({onLogout})` (~1380), Seal & send download/copy buttons (~1520, set saved flags), `ManifestSeal` (report unsaved output up), profile menu (`hasUnacknowledgedOutput`), landing render (rescue notice). Reuse `createStoreZip` and `download`.
- `newweb/src/style.css` -- small rescue-notice style if needed.
- Do not change `outbox.mjs` (ROW_FIELDS), `registry-client.mjs`, the C++ core or `docs/verifier.js`.

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/tests/registry-session.test.mjs` -- failing-first: owner tag held/sent, no `{type:'logout'}` post, received logout ignored, key_not_enrolled copy; update the old "logout tells them all" / "logout clears everything" expectations deliberately.
- [ ] `newweb/tests/registry-wiring.mjs` -- failing-first browser checks: other tab (same profile) logout keeps work for download; other profile's logout and sign-in leave this tab's unsent proof; reload warns with a Seal & send result and with an unsent proof; held proof under another owner is not sent.
- [ ] `newweb/tests/profiles.mjs` -- repair stale selectors (cause: simpler-nav PR moved "Create account"/"Log in" to `.landing-persistent-actions`, renamed "Try Live Demo"; record list starts on page 1).
- [ ] `newweb/src/registry-ui.jsx`, `newweb/src/main.jsx` -- implement per Code Map.
- [ ] `docs/OUTBOX.md`, spine AD-17 + Deferred, `.memlog.md`, `deferred-work.md`, `AGENTS.md` counts, `docs/console` rebuild.

**Acceptance Criteria:**
- Given the matrix rows, when the console is driven in Chromium (flag on), then each behaves as stated.
- Given the flag-off build, when `registry-wiring.mjs` scans `docs/console`, then no registry strings ship.

## Implementation Notes

- Implemented in the main session, not by a context-free implementing subagent: in this host, subagents launch only in the background, which the workflow forbids for the implementer; the investigation (failing-first tests) was already in this session. Review uses a context-free subagent.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `node --test newweb/tests/registry-session.test.mjs` -- all pass
- `npm --prefix newweb run build && node newweb/tests/registry-wiring.mjs` -- all checks pass
- `node newweb/tests/profiles.mjs` -- 8/8
- `npm --prefix newweb run test:browser`, `node newweb/tests/edge-matrix.mjs`, `node newweb/tests/private-lifecycle.mjs`, `node --test newweb/tests/outbox.test.mjs newweb/tests/registry-client.test.mjs`, `node --test newweb/tests/outbox-browser.mjs`, `node tests/web/e2e.mjs`, `node tests/web/routes.mjs`, JS gate, pytest -- all pass

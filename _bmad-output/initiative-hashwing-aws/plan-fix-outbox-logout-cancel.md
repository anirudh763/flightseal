---
title: 'Outbox Retry-After, logout reaches restored tabs, two lost-work tests, large-file Cancel keeps hashed files'
type: bugfix
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '2ead46684154445f6056e61ed2780a196bd9a955'
route: full
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Ledger rows R74, R78, R79 and the follow-up "large-file Cancel restarts hashing" (`initiative-hashwing-aws.md`): the outbox ignores `Retry-After`; an app logout does not reach a tab the browser discarded and later restored (it comes back logged in and signed in to the registry from its saved sessionStorage); two lost-work paths have no test; Cancel during a large-file seal throws away files already hashed, against EXPERIENCE.md line 217/387 ("Cancelling keeps the files already hashed").

**Approach:** Smallest change per item, each with a test that fails before and passes after (R79 adds tests only; if they pass on the baseline, say so and prove they have teeth by breaking the code once).

## Boundaries & Constraints

**Always:** plain words; existing copy unchanged ("Sealing cancelled. Your files are still chosen." stays exact); 44 px targets and keyboard unchanged; measured counts only. Work only in this git worktree (the directory holding this plan); never edit `/Users/anirudhyadav/flightseal`. A dev registry only on port 8798 (stop it after); never touch ports 8787/4180/8795/8796/8797/8799. Do not commit; the parent commits.

**Never:** touch Trust (`TrustedCompanies` in main.jsx, `company-keys.jsx`); hand-edit `docs/console`; change the file format, C++ core or verifier; change infra or the registry server (the Retry-After CORS gap is documented, not fixed); post an app logout on the registry channel or reuse `hashwing-registry-signouts` (registry-session.test.mjs asserts an app logout stays off that channel; that key is FORBIDDEN in the flag-off bundle).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| R74 seconds | register gets 429 (no `quota_exceeded`) with `retry-after: 30` | row `waiting_for_connection`, `next_attempt_at - now >= 30000` | attempts +1 as today |
| R74 HTTP date | 503 with `retry-after: <now+120 s as HTTP date>` | waits 120 s (by the outbox's injected clock) | |
| R74 cap | 429 with `retry-after: 86400` | waits 15 min (`BACKOFF_CAP`) | |
| R74 bad/zero/past | `retry-after: soon`, `0`, a past date | existing backoff (`backoffDelay`) | |
| R74 queue-wide | after a Retry-After wait starts, a new enqueue | nothing is sent before the wait ends; `retryNow()` with no id still sends at once | |
| R74 quota | 429 `quota_exceeded` with Retry-After | unchanged: needs_attention, no automatic retry | |
| R78 restored | profile P logged out in tab A after tab B's sign-in; B restored with its old sessionStorage | B is logged out and has no registry token; no registry sign-in | |
| R78 control | P logs in again later, signs in to the registry, reloads | stays logged in and signed in | |
| R78 frozen/woken | tab of P is shown again after P logged out elsewhere | it logs out as for another tab's logout | |
| Cancel | two files, Cancel while hashing the second, Seal the list again | the first is not hashed again; sealed list has 2 files, first digest correct | a kept file now unreadable: the existing "Could not read {name}…" error |

</intent-contract>

## Code Map

- `newweb/src/registry-client.mjs` `request()` -- on a non-ok HTTP answer add `retryAfter: res.headers.get('retry-after')` (string or null). Nothing else.
- `newweb/src/outbox.mjs` -- `backoffDelay` (l.38), `handleResult` retry branch (l.293-305), `drain()` (l.368). Add exported `retryAfterDelay(value, nowMs)` → ms or null (digits = seconds; else `Date.parse`; null when unparseable, ≤ 0; capped at `BACKOFF_CAP`). Use it only when `res.status === 429 && res.code !== 'quota_exceeded'` or `res.status === 503`; else `backoffDelay`. Keep an in-memory `notBefore` set from it; an unforced `drain` before `notBefore` schedules for `notBefore` and returns; `retryNow()`/forced ignores it.
- `newweb/tests/outbox.test.mjs` -- harness replies may be `Response` objects (l.37); existing throttle test l.575. Add the R74 matrix rows; import `retryAfterDelay`.
- `docs/OUTBOX.md` l.117 table and failure list -- say Retry-After is honoured (cap 15 min), and that a cross-origin console can read it only if the registry sends `Access-Control-Expose-Headers: retry-after`; today neither `registry/registry/app.py` nor the API Gateway CORS config (`infra/lib/stack.ts:205`) exposes or sends it.
- `newweb/src/local-auth.mjs` -- `setLocalSession` (l.221) stores `at: Date.now()`; `getLocalSession` (l.235) returns the same shape as today (no `at`; local-auth.test.mjs deepEquals it) and returns null when revoked; `announceLocalLogout` (l.319) records `{[userId]: Date.now()}` under a new localStorage key `flightseal_logouts_v1` (bounded to 50 newest, try/catch). New export `dropRevokedLocalSession()` → true when the stored account session is older than its profile's logout mark, after clearing it (`clearLocalSession`).
- `newweb/src/main.jsx` -- before `createRoot(...)` (l.2691): `if (dropRevokedLocalSession() && __REGISTRY_URL__) registryLogout();` (`registryLogout` with no registry yet just clears the saved token: registry-ui.jsx l.326). Also one effect with `pageshow`/`visibilitychange`(visible)/`focus`/`resume` listeners: when `activeSession?.kind === 'account'` and `dropRevokedLocalSession()` is true, call `logoutFromAnotherTab({ type: 'logout', userId: activeSession.userId })` (l.1386). Do not touch Trust code.
- `newweb/src/main.jsx` `hashAll` (l.2392) -- optional 4th arg `kept` (a `WeakMap<File,{name,bytes,sha256}>`); for a kept file: report full progress, read `file.slice(0, 1).arrayBuffer()` and on failure throw the same "Could not read {name}…" error and drop the entry; otherwise reuse. Store each finished digest. The check panel caller (l.2635) passes nothing.
- `newweb/src/main.jsx` manifest panel (l.2448 `controllerRef`, `seal` l.2481) -- `const keptRef = useRef(new WeakMap())`; pass it to `hashAll`. New selections are new File objects, so no clearing is needed.
- `newweb/tests/manifest-mode.mjs` l.202 "Cancel stops hashing" -- add a check after it (same patterns: sparse files with `ftruncateSync`, `#manifest-seal-progress-N`).
- `newweb/tests/registry-wiring.mjs` -- `profileIn` l.773, `appLogout`, `reloadWarns`, the "zip fails" init script l.923, the large-file `#/login` check l.954, the frozen/restored check l.978. Flag-on, dev registry.
- `newweb/tests/registry-session.test.mjs` -- `globalThis.fetch` is bound at client creation (l.18), so make it delegate to a swappable handler; queue-full test pattern at l.110.

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/src/registry-client.mjs`, `newweb/src/outbox.mjs`, `newweb/tests/outbox.test.mjs`, `docs/OUTBOX.md` -- R74 as mapped -- the throttle wait comes from the server.
- [ ] `newweb/src/local-auth.mjs`, `newweb/src/main.jsx`, `newweb/tests/local-auth.test.mjs` (unit: mark, revoke, later login survives, other profile unaffected) -- R78.
- [ ] `newweb/tests/registry-wiring.mjs` -- R78 browser check "a restored tab of a logged-out profile stays logged out and signed out of the registry (simulated discard)": A and B logged in as P, B signed in to the registry; snapshot B's whole sessionStorage, close B; log P out in A; new page D with an init script that restores the snapshot once (guard with a flag key); goto; D shows the front door (no active profile), `hashwing-registry-token` is null, no "Signed in to the company registry". Control: log P in again in D, sign in to the registry, reload: still both.
- [ ] `newweb/tests/registry-wiring.mjs` -- R79 "zip fails on #/login": with the zip-blocking init script, a large-file result unsaved, go to `#/login`; "Download unsaved work" in `#auth-main` shows the "Couldn't make one download" message and per-file buttons; downloading each file then "I saved these"/"I saved it" unlocks Log in. Use the copy the app actually shows.
- [ ] `newweb/tests/registry-session.test.mjs` -- R79 "a proof held because the queue was full is sent when the queue gains room": fill 200, seal one more (held), swap fetch to a fake registry that answers epoch, envelopes and registrations with an ack, `outbox.retryNow()`, wait until `pending` is empty and the held receipt is in the outbox list.
- [ ] `newweb/src/main.jsx`, `newweb/tests/manifest-mode.mjs` -- large-file Cancel as mapped. Test: file 1 (256 MiB sparse) and file 2 (1 GiB sparse); Cancel while `#manifest-seal-progress-1` > 0; install a MutationObserver recording the seal-progress label text, then Seal the list again; no label ever reads "Sealing 1 of 2"; the result reads 2 files; the sealed list's first item digest equals sha256 of 256 MiB of zeros (read it from the result or by checking the list against the files, whichever the existing test helpers make simplest).

**Acceptance Criteria:**
- Given each new test, when run against the baseline source, then it fails (R74, R78, Cancel) or the report states it passed on the baseline and failed with the guarded code disabled once (R79).
- Given the full suites below, when run on the final head, then all pass with counts recorded in AGENTS.md.

## Implementation Notes

- Implemented by the step-03 subagent. Deviations: `retryAfter` is omitted (not null) when absent, because `registry-client.test.mjs` compares error shapes exactly; a kept file reports progress as the next file starting, so the label never names it.
- Baseline evidence: R74 5 tests fail on baseline (4 fallback/quota tests pass by design); R78 browser check fails at "no active profile"; Cancel check fails ("Sealing 1 of 2 …"); R79 both pass on baseline and each failed with the guarded code disabled once (`flushOwned` in `refresh()`, `markSaved` in the unsaved confirm).
- Merged origin/main f2583ef (#61, #62); AGENTS.md conflict resolved to main's text, counts then re-measured; `docs/console` rebuilt per the rule (`grep -l transfer` finds `hash-worker-CNksEhMA.js`; `grep -rl hashwing-pending docs/console` finds nothing).

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 6 findings — high 0, medium 2, low 2, false 0, maybe-false 0 (2 not code defects)
- findings:
  - `[medium]` `patch` `dropRevokedLocalSession()` at module level throws when site storage is blocked (default-parameter storage getters sit outside the try), so the app never renders — fixed: the whole body, defaults included, is in try/catch and returns false.
  - `[medium]` `patch` kept digests were reused by every later Seal, not only after a Cancel — fixed: `keptRef` is replaced after a full hash, so only a Cancel or failure keeps them.
  - `[low]` `patch` `docs/OUTBOX.md` command counts for registry-session and registry-wiring were stale — fixed (now 15 and 45, the counts measured after merging main).
  - `[low]` `reject` AC-1 evidence for R79 not recorded — recorded in Implementation Notes and the ledger; not a code defect.
  - `[low]` `reject` the woken-tab part writes the mark directly and sends only `focus` — the writer is covered by `local-auth.test.mjs:132` and the restored-tab part uses the real logout; testing each wake event adds little.
  - `[low]` `reject` a removed profile's random 32-hex id stays in `flightseal_logouts_v1` (newest 50) — no personal data, bounded; a fix adds a branch in `removeLocalProfile` for a negligible case.

## Verification

**Commands:**
- `node --test newweb/tests/*.test.mjs` -- all pass
- `npm --prefix newweb ci && npm --prefix newweb run build` (docs/console rebuilt as AGENTS.md says), then `grep -l transfer docs/console/assets/hash-worker-*.js` finds a file and `grep -rl hashwing-pending docs/console` finds nothing
- `npm --prefix newweb run test:browser` -- 0 failed
- dev registry on 127.0.0.1:8798, then `REGISTRY_DEV_URL=http://127.0.0.1:8798 node newweb/tests/registry-wiring.mjs` -- all pass; stop the server
- `node newweb/tests/profiles.mjs` -- all pass
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- all pass

## Auto Run Result

- Summary: R74 Retry-After honoured client side (queue-wide wait, cap 15 min); R78 per-profile logout mark drops a restored or woken tab's older session and its registry token; R79 two tests added (no code change needed); large-file Cancel keeps finished digests.
- Files: `newweb/src/{outbox,registry-client,local-auth}.mjs`, `newweb/src/main.jsx`, tests in `newweb/tests/{outbox,local-auth,registry-session}.test.mjs`, `registry-wiring.mjs`, `manifest-mode.mjs`; `docs/OUTBOX.md`, `AGENTS.md`, ledger; `docs/console` rebuilt.
- Review: 3 patches (2 medium, 1 low), 0 deferred, 3 rejected (reasons above). followup_review_recommended: true — two mediums patched; unverified risk: the storage-blocked path has no test.
- Verification (after merging main, final tree): node unit 168/168; outbox+client 58/58; registry-session 15/15; test:browser 65/0 failed; registry-wiring 45/45 (dev registry 8798, stopped); outbox-browser 8/8; profiles 8/8; tests/web 147/147.
- Residual risks: R74 is inert cross-origin until the registry sends and exposes Retry-After; the discard is simulated in Playwright; the Cancel check hashes ~1.3 GiB of sparse files.

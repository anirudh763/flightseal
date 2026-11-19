---
title: 'Trust: Your company''s keys (design PR 1 browser half, Option A)'
type: feature
ticket: ''
created: '2026-11-19'
status: in-progress
baseline_revision: '467cd919cab54beefc4f3828b01b3d80b799779b'
route: full
route_source: auto
risk: high
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-trust-keys/AGENTS.md'
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-trust-keys/.agents/skills/enterprise-ui-polish/SKILL.md'
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-trust-keys/_bmad-output/initiative-hashwing-aws/design-key-enrollment-option-b.md'
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The registry key routes are built (PR #60), but Trust has no "Your company's keys" section. Admins can't enroll, replace or mark a key compromised from the computer that holds it, and members can't see the key list. AC-38 to AC-40 and AC-59 are open (R24, R33, the R71 Trust copy).

**Approach:** Add a flag-on-only section, "Your company's keys", as its own component after Company registry on Trust. It lists keys, and for admins it enrolls, replaces and marks compromised. Signing happens in the browser with the key loaded under Your signing key. The challenge bytes are built locally and nothing is signed on a mismatch. Add unit, cross-format and browser checks.

## Boundaries & Constraints

**Always:**
- Work only in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-trust-keys` (branch `feat/trust-company-keys`). Never edit `/Users/anirudhyadav/flightseal`.
- Dev registry for manual runs: port 8797 only, started from the worktree (`python3 registry/devserver/server.py --port 8797`) and stopped by its PID. Never touch 8787, 4180, 8796, 8798 or 8799.
- Flag-off build (`VITE_REGISTRY_URL` empty, the Pages build): its behaviour and text stay unchanged. The new code renders and is reachable only behind `__REGISTRY_URL__`, has no top-level side effects, and none of its strings ship flag off.
- Challenge bytes: `"hashwing-key-enroll v1\n" + org + "\n" + nonce`. `org` comes from the session claims (`claims.org`, which registry-ui `claimsOf` reads from `custom:org_id ?? org_id`). `nonce` must fullmatch `/^[0-9a-f]{32}$/`. If the server's `message` is not exactly equal to that string, sign nothing and show "The registry sent an unexpected challenge. Nothing was signed."
- Private keys never leave the device. The enroll POST body is exactly `{public_key, nonce, signature}` plus `confirm_replace` on replace. The signing import is `importKey('pkcs8', …, {name:'Ed25519'}, false, ['sign'])`, which is non-extractable.
- Strict Verified: no change to `recipient-trust.mjs`, `verdict()`, `trusted-keys.mjs` or `docs/verifier.js`. The registry never raises a verdict.
- Copy is plain and calm, following the owner UI copy rule in AGENTS.md. Keys show as "Active", "Replaced on {YYYY-MM-DD}", "Marked compromised on {YYYY-MM-DD}" or "Removed on {YYYY-MM-DD}" (for `retired`). Any other state reads "Not in use". The string "rotated" never reaches the DOM. Rows read "Enrolled {YYYY-MM-DD}", plus " by you" when `enrolled_by_me` is true. A missing date is omitted, never invented.
- There is one primary button in the section (Enroll this key / Replace with this key). Every other button is secondary. Targets are at least 44px. Dialogs are native `<dialog>` with the safe choice focused, and Escape cancels, as `DeleteRecord` does in registry-ui.jsx.

**Never:**
- Don't edit `TrustedCompanies`, `recipient-trust.mjs` or `trusted-keys.mjs`; another builder owns trusted-company pins (R34/R35/R75). In `main.jsx`, make a single insertion after `<RegistryPanel />` on the Trust screen (around line 1980), plus the import.
- Don't add the flag-off "Company sign-in isn't part of this copy of HashWing." sentence: it changes flag-off behaviour. Defer it.
- No `registry/` changes unless the lost-response test can't be done in Playwright (see Code Map). No AWS deploy, no force-push, and don't commit `_bmad/`, `.venv-agent` or `build/`.
- Never sign the server's `message` string. Never auto-retry after `bad_challenge`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Enroll, no active key | admin, key loaded, list empty | challenge → sign the local bytes → POST → 201, then the list is reloaded and shows "Active", "by you" | — |
| Hostile challenge | `message` = `fseal-receipt v1…`, another org, a trailing newline, or `hashwing-pilot-authorization v1…` | the signer is never called and nothing is POSTed | "The registry sent an unexpected challenge. Nothing was signed." |
| Bad nonce | nonce not 32 lowercase hex (even when message matches it) | not signed | same message |
| Replace | another key active | "Replace with this key" → confirm dialog ("Keep the current key" focused) → POST with `confirm_replace:true` → old row "Replaced on …" | 409 `confirm_required` without confirm opens the dialog |
| Lost response | POST answered 409 `key_exists` | list all pages; success only if the loaded key's fp === `active_key` | otherwise "This key was enrolled before and can't be enrolled again." |
| Expired challenge | 400 `bad_challenge` | exactly 1 GET challenge + 1 POST for that press; "That request expired. Press the button again." | no automatic retry |
| Loaded key already retired/compromised | its fp in the list, not active | no enroll button; the same "enrolled before" line | — |
| No key loaded | admin | the primary button is disabled, with "Load your company's signing key under Your signing key first." | — |
| Mark compromised | admin, a non-compromised row | dialog: "New receipts signed with it will be refused. Older proofs from it will show a warning." with "Keep it" focused → POST `{}` → row "Marked compromised on …" | 404 → "This key isn't in your company's list any more." plus reload |
| Member | role not admin | read-only list, with no enroll/replace/compromise control | — |
| Offline | `navigator.onLine` false | actions disabled, "You're offline. Key changes need a connection." | — |
| Registry down | list GET network/timeout/5xx | "Couldn't reach the company registry. Try again in a few minutes." with a secondary "Try again" | — |
| Errors | 401, 403, 409 `conflict`, 422 `bad_signature`, 503 | plain line each (sign in again / only an admin / the list changed: reloaded / the registry couldn't check this key's signature / registry busy). Raw code only under "More options" | — |
| Paging | more than 50 keys, or an exactly-full page | follow `next_cursor` until null, at most 20 pages | stop at the cap |
| Signed out | flag on, no registry sign-in | heading shown, "Sign in under Company registry to see your company's keys." | — |

</intent-contract>

## Code Map

- `newweb/src/registry-client.mjs` -- add `keyChallenge(opts)` GET `/v1/keys/challenge`, `enrollKey(body, opts)` POST `/v1/keys`, `listKeys({cursor}, opts)` GET `/v1/keys[?cursor=]`, `compromiseKey(fp, opts)` POST `/v1/keys/<fp>/compromised` with `{}`. Every call takes `opts.token`; capture the token once per press.
- `newweb/src/company-keys.mjs` (new, pure, no JSX, no side effects) -- `challengeBytes(org, challenge)` returns a Uint8Array or null. `enroll({client, org, token, sign, publicKeyHex, confirmReplace})` takes an injected `sign(bytes)` and returns `{ok}` or `{ok:false, reason, code}`, with reasons `unexpected_challenge`, `confirm_required`, `enrolled_before`, `bad_challenge` and `http`. `listAllKeys(client, opts)` follows the cursor. `stateLabel(row)`, `publicKeyHexFromPem(pem)` and `signerFromPem(pem)`.
- Public key for an imported PEM: `main.jsx:1141` sets `publicKeyHex: ''`, and `docs/wasm/client.mjs` has no derivation. Use a throwaway extractable `importKey('pkcs8')` and `exportKey('jwk')`, read only `x` (base64url → hex), and drop the key object. The signing key is a separate non-extractable import. The PEM is already in JS memory (main.jsx `signingKey`), so this adds no exposure. Use the same path for generated keys.
- `newweb/src/company-keys.jsx` (new) -- `CompanyKeysPanel({ signingKey })`: `<section className="panel" id="company-keys" aria-labelledby="company-keys-title">`, heading `h2` "Your company's keys". Read the session through `useRegistry`, which you export from registry-ui.jsx: it is a non-exported const at about line 288. Use `s.claims` (org, role, sub), `s.online`, `s.owner` and `r.client`. Clear the list when `s.owner` changes. Fingerprints use `fingerprintHex`/`formatFingerprint` from trusted-keys.mjs (SHA-256 of the raw public key, groups of four), with a Copy button. The Option A note sits under the list: "Only the company computer holds this key. Pilots on other devices seal with a one-time key, which reads 'signer not confirmed'." Reuse the classes `panel-head`, `panel-body`, `actions-row`, `button primary|secondary`, `registry-bad`, `registry-dialog`, `field-hint`, `registry-notice`, `report-details`, `status-label ok|warn|neutral|bad`, `wrap fingerprint`. Add CSS to `style.css` only if needed.
- `newweb/src/main.jsx` -- import `CompanyKeysPanel`. On the Trust line (`screen === 'help'`), after `{__REGISTRY_URL__ && <RegistryBoundary><RegistryPanel /></RegistryBoundary>}`, insert `{__REGISTRY_URL__ && <RegistryBoundary><CompanyKeysPanel signingKey={signingKey} /></RegistryBoundary>}`.
- `newweb/tests/company-keys.test.mjs` (new, `node --test`) -- every matrix row that doesn't need a browser: hostile messages (each one asserts the sign spy has 0 calls and no POST), bad nonce, key_exists success and failure, bad_challenge call counts, confirm_required, paging, labels (no "rotated"), and the JWK public key matching a known seed (SEED_A: pkcs8 prefix `302e020100300506032b657004220420` + bytes 0..31).
- `tests/web/verifier.test.mjs` -- cross-format: a WebCrypto Ed25519 key signs the challenge bytes. A receipt `{count, head, key, sig: challengeSig}` through `checkReceipts` gives `bad-signature` with `sigChecked: true`, while the same receipt with a genuine `fseal-receipt v1`+count LE8+head signature gives `ok`. Use count 0 / zero head with `scan = {status:'ok', records:0, links:new Map()}`, or a real scanned log.
- `newweb/tests/registry-wiring.mjs` -- add `'Your company\'s keys'`, `'/v1/keys'` and `'hashwing-key-enroll'` to `FORBIDDEN`. Add checks in a fresh context for org `orgK` (the devserver token takes `org=`; `tokenFor`/`signIn` hard-code orgA, so add an org parameter). `__dev/reset` enrolls SEED_A in orgA and later checks need it, so don't touch orgA keys.
  - AC-59: the four headings in order, then Trust and limits. Flag off: neither registry section (extend the existing flag-off check).
  - Admin with a generated key: seal a small file → Needs attention (key_not_enrolled). Then Enroll this key → Active "by you". The enroll POST body keys are exactly `public_key,nonce,signature`. Back on Seal & send → Try again → Registered.
  - Replace with a second generated key: the dialog focuses the safe choice and Escape cancels. Confirm → old row "Replaced on", and "rotated" is not in `document.body.innerText` or the HTML.
  - Lost response: Playwright `page.route` on POST `/v1/keys` does `route.fetch()` then `route.abort()`. Press again → success shown (409 key_exists path). If this can't work, add `enroll` to the devserver drop routes in `registry/devserver/server.py` and run the registry pytest.
  - Mark compromised: the dialog focuses "Keep it" and Escape cancels; confirm → "Marked compromised on".
  - Member (role pilot, orgK): the list shows and there are 0 buttons in `#company-keys` except Copy.
  - Offline (`ctx.setOffline(true)`; set the existing `offline` flag): actions disabled and the reason shown.
  - Registry down (route the list GET to abort): the down message.
  - axe 0 violations at 320/768/1440 with the list shown, no horizontal scroll, every button in `#company-keys` at least 44px high, the keyboard reaching the enroll button by Tab, and screenshots in `.test-artifacts/registry-wiring/`.
  - The `key_not_enrolled` assertion near line 291 ("no enroll control exists") is now stale. Keep the REASONS copy and reword the assertion's message.
- Docs:
  - `AGENTS.md`: the registry-wiring count in the gate text and the Measured line, plus the new unit test file.
  - `_bmad-output/initiative-hashwing-aws/ux-hashwing/EXPERIENCE.md`: AC-38, AC-39, AC-40 and AC-59 to `built` with test cites. AC-50 notes that the second half is now real. Resolve the "Enroll it on the Trust page" Open bullet.
  - Ledger `initiative-hashwing-aws.md`: rows R24, R33 and R71, evidence with exact file:line and test names.
  - Spine AD-21: "mechanism PROPOSED … not built" becomes built.
  - `docs/aws/RUNBOOK_AWS.md` "How pilots sign": mention the Trust button, if it names a manual step.
- The docs/console rebuild rule (from `plan-jobs-registry-status.md:39`): `git rm -r -q --cached docs/console; rm -rf docs/console; npm --prefix newweb run build; git add -A docs/console`. Then `grep -l transfer docs/console/assets/hash-worker-*.js` finds a file, and `grep -rl hashwing-pending docs/console` finds nothing. Commit the rebuild before running registry-wiring, because its first check reads `HEAD:docs/console`.

## Tasks & Acceptance

**Execution:**
- [x] `newweb/src/registry-client.mjs` -- four key methods -- the client key methods named in the design
- [x] `newweb/src/company-keys.mjs` + `newweb/tests/company-keys.test.mjs` -- pure flow plus unit tests for the matrix -- the B1 rule, proved without a browser
- [x] `newweb/src/company-keys.jsx`, `newweb/src/registry-ui.jsx` (export `useRegistry` only), `newweb/src/main.jsx` (one insertion and the import), `newweb/src/style.css` (only if needed) -- the section
- [x] `tests/web/verifier.test.mjs` -- cross-format test
- [x] `newweb/tests/registry-wiring.mjs` -- the checks above
- [x] docs/console rebuild and commit; docs, ledger and AGENTS.md counts last, from measured runs

**Acceptance Criteria:**
- Given a flag-on build and an admin signed in on the computer holding the key, when they press Enroll this key, then the row reads Active and "by you", and a proof that needed attention for `key_not_enrolled` registers after Try again.
- Given a replaced key, when Trust renders, then its row reads "Replaced on {date}" and "rotated" appears nowhere in the page.
- Given a member, offline, or a down registry, when Trust renders, then no key action can be pressed and the plain reason is shown.
- Given the flag-off build, when Trust renders, then the page is unchanged and the bundle has none of the new strings.

## Implementation Notes

- The panel uses `panel trust-wide` so it spans both Trust columns like the registry panel; no new CSS.
- `enroll()` has one extra reason, `sign_failed` (the browser couldn't import or sign with the loaded PEM; nothing is sent).
- When the loaded key is the active one, the section shows the factual line "The key loaded here is your company's active key." instead of a button.
- The public key always comes from the PEM (`publicKeyHexFromPem`), for generated and imported keys alike.
- Lost response is tested with Playwright `route.fetch()` + `route.abort()`; no `registry/` change was needed.
- Tailwind scans `newweb/` for class names, so a test comment containing a utility name (e.g. "transition") changes the flag-off CSS; keep such words out of `newweb/` comments.

## Plan Change Log

## Review Triage Log

## Design Notes

The browser builder is a second, independent copy of the challenge format, never the server's `message`. Without it, a hostile registry could get the company key to sign a receipt. The enroll flow takes an injected `sign` function so a test can prove zero signatures on a mismatch.

## Verification

**Commands (from the worktree root):**
- `node --test newweb/tests/*.test.mjs` -- expected: all pass (baseline 140 plus the new tests)
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- expected: all pass (baseline 146 plus the cross-format tests)
- `npm --prefix newweb run build` then the two docs/console greps -- expected: one hash-worker file, no hashwing-pending hits
- `npm --prefix newweb run test:browser` -- expected: 0 failed
- `node newweb/tests/profiles.mjs` -- expected: 8/8
- `REGISTRY_DEV_URL=http://127.0.0.1:8797 node newweb/tests/registry-wiring.mjs` (dev server started from the worktree on 8797, then stopped) -- expected: all checks pass

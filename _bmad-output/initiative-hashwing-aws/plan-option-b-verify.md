---
title: 'Option B browser half, part 1: authorization checker, Verify delegated path (switch off), CLI/verifier note line'
type: feature
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '9cbb10005f366d387ab70ed64f541a01f8fc54b6'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-optb/_bmad-output/initiative-hashwing-aws/design-key-enrollment-option-b.md'
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-optb/AGENTS.md'
warnings: [oversized]
deferred:
  - summary: >-
      With the switch on, Verify never reaches trustForProof when the recipient chose a company or typed the company key, so a valid pilot proof reads Not verified there.
    evidence: |-
      main.jsx runProtectCheck compares the anchor (pilot key) fingerprint with the chosen company's and goes to setCompanyMismatch; a typed company key makes the receipts wrong-key; the manifest path returns mismatch before trust is read. Fails closed; switch off everywhere. How a chosen company accepts its pilots is a part 2 decision.
    location: >-
      newweb/src/main.jsx:1278, newweb/src/main.jsx:2668
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Option B (design-key-enrollment-option-b.md §4.2, §7.2, §8, §10; spine AD-21..AD-24; ledger R71) has its server half (`registry/registry/pilot_authorization.py`, shared vectors `tests/fixtures/pilot-authorization.json`) but no browser checker, no Verify delegated path, and the CLI and `docs/verifier.js` do not say when a receipts file carries a pilot authorization line.

**Approach:** Add a JS checker that matches the Python on every shared vector; add `trustForProof` behind the build constant `PILOT_AUTHORIZATION_ACCEPTED = false`, which the bundler must fold away so the flag-off console gains no strings; make the CLI and `docs/verifier.js` skip an authorization line in a receipts file and print "Pilot authorization not checked by this verifier", with the verdict computed exactly as before. The Trust pilot screens are part 2, not this work.

## Boundaries & Constraints

**Always:**
- Work only in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-optb` (branch `feat/option-b-verify`). Never edit `/Users/anirudhyadav/flightseal`; read-only use of its `build/`, `.venv-agent/` and `tests/.data` is fine. Keep every test log and artifact inside the worktree (`newweb/.test-artifacts/` is gitignored).
- Strict Verified: the registry never raises a verdict; `verdict()` is unchanged; the authorization is checked against the verifier's own clock (injectable `now`), never the seal time or any sender time (R75).
- Shipped builds (Pages and every `npm run build`) keep the switch false. Tests flip it only through a test-only transform (Vite `ssrLoadModule` with a plugin that rewrites `export const PILOT_AUTHORIZATION_ACCEPTED = false` to `true`, the same pattern as `newweb/tests/registry-session.test.mjs`). No option or runtime value turns it on.
- The flag-off `docs/console` has none of the new strings (`Authorized by company key`, `hashwing-pilot-authorization`, `pilot key`, `authorization ended`, `Pilot authorization not checked`). Baseline copy of origin/main's console: `newweb/.test-artifacts/baseline-console`.
- Console rebuild rule from AGENTS.md (never hand-edit or hand-merge `docs/console`), then its two greps.

**Never:** Trust page UI for pilot keys, the 500-entry compromised-fingerprint list, any `pilotKeys` setter or UI (part 2); editing `tests/fixtures/pilot-authorization.json` or its generator (PR #66 changes them); changing `parseReceipts`, `weakPublicKey`, `fseal.cpp`/`parse_line` or the wasm bridge; changing any RESULT or exit status; committing `_bmad/` or `.venv-agent`; deploys; merging.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Vectors | every case in `tests/fixtures/pilot-authorization.json` | JS `reason` equals the case's `reason`; `found` equals the case's `found` (true when the field is absent) | n/a |
| Leading space | message line `" Authorized by company key: …"` | `found: false`, reason `no_line`, nothing authorized | inline test (fixture gets this case in #66) |
| Switch off | pilot-signed proof with a valid authorization and a qualifying pin | same trust as `trustForKey` (untrusted → "Files match · signer not confirmed") | n/a |
| Switch on, all checks pass | one canonical line; `pilot_key` = receipt key; `company_key` matches an active, confirmed pin with `pilotKeys: true` (by fingerprint, and byte-equal when the pin stores a key); signature valid; `now < not_after <= now + 30d`; neither fingerprint compromised | `{status:'trusted', via:'pilot', entry, notAfter}`; verdict Verified; line "Signed by a pilot key {company} authorized until {date}" | n/a |
| Switch on, ended | everything passes except `not_after <= now` | `{status:'untrusted', reason:'authorization-ended', notAfter, entry}`; "The company's authorization for this pilot key ended on {date}. Ask the company." | only when the pin checks also pass; otherwise plain untrusted |
| Switch on, one check fails | other receipt key, other company key, pin without `pilotKeys`, unconfirmed pin, `not_after` > 30 days ahead, two lines, non-canonical | untrusted (signer not confirmed) | n/a |
| Switch on, compromised | pilot fingerprint or the statement's company fingerprint marked compromised | `compromised` | lowers only |
| Switch on, replaced | statement's company key matches only a replaced pin | `replaced` | n/a |
| Seal time | seal time before `not_after`, verifier clock after it | not Verified | seal time never read |
| CLI / verifier.js | receipts file with one or more lines starting at column 0 with `Authorized by company key:` | lines skipped; `  note         Pilot authorization not checked by this verifier` printed just before `RESULT:`; RESULT and exit status the same as the file without those lines (pilot key vs company `--pubkey` → UNVERIFIED, exit 3) | a file with only authorization lines → existing "contains no receipts" error (exit 2); JS error line numbers refer to the original file |
| Cross-format | company-key signature over an authorization or an enroll challenge; receipt signature | fails as a receipt in `docs/verifier.js` `checkReceipts`; a receipt signature fails as an authorization | n/a |

</intent-contract>

## Code Map

- `registry/registry/pilot_authorization.py` -- the reference. Mirror `parse` (regex `[A-Za-z0-9_-]+`, decode, exactly 4 lines, prefix, field order, 64/64 lowercase hex, `YYYY-MM-DDTHH:MM:SSZ`, then re-encode the rebuilt statement and compare characters: this catches second 60, padding, loose bits), `check` (reason order: malformed, weak_pilot_key, same_key, not_pilot_key, bad_signature, ended, too_long, not_company_key; sig must be 128 lowercase hex) and `parse_line` (split on `\n` only; a line counts if it starts at column 0 with `Authorized by company key:`; more than one, missing trailing space, or not exactly one `.` → malformed; none → no line).
- `registry/registry/ed25519.py` `_recover_x`/`weak_key` -- weak = non-canonical y, off-curve (x² not a square, or x = 0 with sign bit), or small order. `docs/verifier.js` `weakPublicKey` misses off-curve keys (the fixture's `OFF_CURVE`); add a BigInt curve-point check in the new module, don't touch `weakPublicKey`.
- `docs/verifier.js` -- reuse `ed25519Verify`, `weakPublicKey`, `parseHex`, `hex`. `parseReceipts` (l.320) stays unchanged: it is in the console bundle. Add an exported wrapper (for example `parseReceiptFile(text)`) that drops column-0 authorization lines, calls `parseReceipts`, maps error line numbers back, and returns `pilotAuthorization: bool`; `cliReport(path, scan, receiptCheck, { pilotAuthorization } = {})` prints the note line before `RESULT:`. Neither is imported by the console.
- `docs/app.js` l.395 -- use the wrapper and pass the flag to `cliReport` (l.670).
- `src/main.cpp` `verify` l.166-179 -- skip `line.rfind("Authorized by company key:", 0) == 0` lines, remember it, print the same note line before each `RESULT:` line. Keep the change in `main.cpp`.
- `tests/web/verifier.test.mjs` -- JS-vs-CLI byte-for-byte cross-check harness (`js()` l.48): add a case with an authorization line. Needs `build/fseal` (`cmake -S . -B build && cmake --build build -j`) and `tests/.data` (copy from `/Users/anirudhyadav/flightseal/tests/.data`).
- `newweb/src/recipient-trust.mjs` -- import-free. Add `export const PILOT_AUTHORIZATION_ACCEPTED = false;` next to `VERIFIED_NEEDS_TRUSTED_KEY`; in `trustLine` add the two pilot cases, each guarded by `PILOT_AUTHORIZATION_ACCEPTED &&` so they fold away.
- `newweb/src/pilot-authorization.mjs` (new) -- `parseLine(message)`, `parse(b64)`, `check(b64, sig, pilotKeyBytes, companyKeyBytesOrNull, nowSeconds)` → `{ reason, auth }`, async because WebCrypto verify is async; constants from the Python.
- `newweb/src/trusted-keys.mjs` -- `trustForKey` l.171, `read`/`clean` l.69-95. Add `trustForProof(publicKey, message, { storage, cryptoObject, now })`: `if (!PILOT_AUTHORIZATION_ACCEPTED) return trustForKey(...)`; else start from `trustForKey`, return it unless `untrusted`, then apply the matrix. `clean()` keeps `pilotKeys: true` only when it is exactly true, so stored pins without it stay byte-identical.
- `newweb/src/main.jsx` -- trust is read at l.1515 (log/protect path: `result.key`; the message is `checkText` from `runProtectCheck` l.1268, passed through `runVerify` l.610) and l.2651/2668/2677 (manifest path: `text`). Call `PILOT_AUTHORIZATION_ACCEPTED ? trustForProof(key, message) : trustForKey(key)` so the off build is unchanged. Pass the raw message, never `parseHandover`/`unquote` output.
- `newweb/tests/recipient-trust.test.mjs`, `newweb/tests/trusted-keys.test.mjs` -- existing unit tests and their style.

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/src/pilot-authorization.mjs` -- the checker -- one owner for the format in the browser.
- [ ] `newweb/tests/pilot-authorization.test.mjs` -- iterate every fixture case (`reason`, `found` defaulting to true); inline leading-space `no_line`; cross-format cases against `docs/verifier.js` `checkReceipts` (sign test bytes with `crypto.subtle` Ed25519 keys generated in the test) -- parity with Python.
- [ ] `newweb/src/recipient-trust.mjs`, `newweb/src/trusted-keys.mjs`, `newweb/src/main.jsx` -- switch, `trustForProof`, `trustLine` cases, call sites, `pilotKeys` kept -- the Verify delegated path.
- [ ] `newweb/tests/pilot-verify.test.mjs` (new) -- switch off through a plain import; switch on through Vite `ssrLoadModule` with the rewrite plugin; one test per matrix row, plus `verdict()` reading Verified for a pilot `trusted` result and "Files match · signer not confirmed" otherwise.
- [ ] `src/main.cpp`, `docs/verifier.js`, `docs/app.js`, `tests/web/verifier.test.mjs` -- the note line and its cross-check.
- [ ] `docs/console` -- rebuild per AGENTS.md; prove no new strings against the baseline (grep both trees for each new phrase); record whether the bundle is byte-identical.
- [ ] Docs: `THREAT_MODEL.md` (CLI tolerates the authorization line, fails closed), `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md` R71 row (honest status: "built in this PR, switch off"), `EXPERIENCE.md` only if it lists Verify trust lines, `AGENTS.md` measured counts line for this PR.

**Acceptance Criteria:**
- Given the shipped build, when a recipient verifies a pilot-signed proof with a valid authorization, then it reads "Files match · signer not confirmed", exactly as on origin/main.
- Given the switch flipped in a test, when every §7.2 B-on row is exercised, then each reads as the design table says.
- Given `fseal verify` and the static verifier on the same receipts file with an authorization line, then both print the same report, including the note line, with an unchanged RESULT and exit status.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 5 findings — high 0, medium 2, low 2, false 1, maybe-false 0
- findings:
  - `[medium]` `[patch]` parseReceiptFile accepted "<receipt>\n\n<auth line without newline>" that fseal verify refuses at line 2 — fixed in 9728bf8: getline's EOF rule applied to the original lines first; new cross-check case "blank-then-final-auth-no-newline".
  - `[medium]` `[defer]` switch-on Verify with a chosen or typed company key never reaches trustForProof — fails closed, switch off; part 2 decision (deferred list).
  - `[low]` `[patch]` AGENTS.md measured line had pre-merge counts — re-measured on the merged head and rewritten (task brief asks for measured counts).
  - `[low]` `[patch]` AGENTS.md JS gate still said 147 tests — now 153.
  - `[false]` `[reject]` docs/app.js drops the note when `check` is null — check is null only when the pubkey is missing or invalid, where `fseal verify` exits 2 before printing a report, so there is no CLI report to diverge from.

## Auto Run Result

- Summary: JS pilot authorization checker (agrees with the Python on all 27 shared vectors), `trustForProof` and two pilot trust lines behind `PILOT_AUTHORIZATION_ACCEPTED = false` (folded out of the console: no new strings), CLI and `docs/verifier.js` skip a column-0 `Authorized by company key:` line in a receipts file and print "Pilot authorization not checked by this verifier" with RESULT and exit status unchanged.
- Files: `newweb/src/pilot-authorization.mjs` (checker), `newweb/src/trusted-keys.mjs` (`trustForProof`, `pilotKeys` kept when true), `newweb/src/recipient-trust.mjs` (switch, trust lines), `newweb/src/main.jsx` (folded call sites), `docs/verifier.js` + `docs/app.js` + `src/main.cpp` (note line), tests `newweb/tests/pilot-authorization.test.mjs`, `newweb/tests/pilot-verify.test.mjs`, `tests/web/verifier.test.mjs`, CI list, THREAT_MODEL, R71, EXPERIENCE, AGENTS.md.
- Review: 3 patches (1 medium, 2 low), 1 deferred (medium), 1 rejected (false, see triage log).
- Follow-up review recommended: false (patched: 0 high, 1 medium).
- Verification on the merged head: newweb unit 219/219; tests/web 153/153; ctest 5/5; pytest 364 passed, 30 skipped; test:browser 66 ok, 0 failed; edge-matrix 9 ok; profiles 8/8; registry-wiring 47/47 (dev registry on 8797); e2e 5 ok; console rebuild clean, both AGENTS.md greps as required, no pilot strings.
- Residual risks: switch-on main.jsx wiring has no browser test; the chosen-company path (deferred); `docs/app.js` is loaded by no page, so the note line there is covered only through `cliReport` unit tests.

## Design Notes

Security decisions: the receipts-file tolerance is a deliberate CLI behaviour change (exit 2 "not a receipt" → checked, note line printed); it can't raise a result because the pilot key is not the `--pubkey` key. Compromise of either fingerprint lowers only. `authorization-ended` is returned only once the pin checks pass, since `check()` tests `ended` before `not_company_key`.

## Verification

**Commands:**
- `node --test newweb/tests/*.test.mjs` -- all pass, including the new files
- `npm --prefix newweb run build && grep -l transfer docs/console/assets/hash-worker-*.js && ! grep -rl hashwing-pending docs/console` -- both greps as AGENTS.md says
- `grep -rlE "Authorized by company key|hashwing-pilot-authorization|Pilot authorization not checked|authorized until" docs/console` -- finds nothing
- `cmake -S . -B build && cmake --build build -j && ctest --test-dir build` -- 5 suites pass
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- all pass
- `npm --prefix newweb run test:browser`; `node newweb/tests/profiles.mjs`; `REGISTRY_DEV_URL=http://127.0.0.1:8797 node newweb/tests/registry-wiring.mjs` (47 on main) -- all pass
- `/Users/anirudhyadav/flightseal/.venv-agent/bin/python -m pytest -q` -- passes (C++ touched)

---
title: 'Reject weak Ed25519 public keys in every receipt verifier'
type: bugfix
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: '96e7e7430638a8c2f453dd4e0944fbf4a997ef58'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/AGENTS.md']
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** OpenSSL's Ed25519 verify (CLI 3.5.9 and the fseal build linked to OpenSSL 4) and Chromium WebCrypto accept small-order and non-canonical public keys. With such a key, a receipt `R = small-order point, S = 0` verifies for any message. So an attacker who hands over a log, receipts and a weak "trusted" key gets a signature that passes. Measured on baseline `96e7e74`: unpatched `build/fseal` gives the head-mismatch verdict, not bad-signature, for key `0100…00` and sig `key||00*32`. Headless Chromium 153 accepts all 14 small-order forgeries in `tests/fixtures/ed25519-weak-keys.json`. Node 24 (bundled OpenSSL 3.5.9) rejects them.

**Approach:** Use one predicate per language. A key is weak if its encoding is non-canonical (y ≥ p after masking bit 255) or its y, sign bit ignored, is one of the 5 small-order y values (libsodium's has_small_order list). Enforce it in two places: at the trusted-key input (a clear error) and in the low-level verify primitive (returns false, as defence in depth). Use one shared fixture.

## Boundaries & Constraints

**Always:** The error text is exactly `This public key is weak and can't prove anything`. Every weak trusted key is refused before any receipt is checked: CLI exit 2, Wasm `{error}`, JS throws. A weak key inside a receipt that differs from the trusted key stays `wrong-key` everywhere, because main.jsx compares native and JS verdicts. RFC 8032 TEST 1–3 and the real sample receipts (`docs/samples/flight.receipts` + `pubkey.txt`) still verify. Name the fixture source (libsodium `ed25519_ref10.c` has_small_order). Use failing-first tests and report real counts.

**Never:** Do not edit `newweb/src/main.jsx`, `newweb/src/style.css`, `registry/` or `infra/`. Do not change the file or receipt format. Do not change the CLI report text for non-weak keys. Do not put the check in trusted-keys `read()`, because a stored weak pin would make the list unreadable. Do not add a Python Ed25519 verifier: `tools/*.py` only shell out to the CLI, so pytest drives the CLI. Do not edit `docs/app.js`: no page loads it. Do not hand-edit `docs/console` or `docs/wasm` output. Never `git add` `_bmad/` or the node_modules symlinks.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Weak trusted key, CLI | `fseal verify LOG --receipts R --pubkey <any fixture weak key>` | exit 2, stderr `verify: This public key is weak and can't prove anything`, no stdout report | refused before scanning |
| Weak trusted key, Wasm | `fseal_verify(path, receipts, weakKey)` | `{"error":"This public key is weak and can't prove anything"}` | invalid_argument |
| Weak trusted key, JS | `checkReceipts(receipts, weakKeyBytes, scan)` | rejects with Error(WEAK_KEY_MESSAGE) | before WebCrypto |
| Forged receipt, primitive | each fixture weak entry with `sig` | `signature_ok` / `ed25519Verify` → false | n/a |
| Pin weak key | `pinTrustedKey(name, weakHex)` | rejects with WEAK_KEY_MESSAGE, storage unchanged | n/a |
| Control key | `not_weak` (y = p−2) | `weak…` → false | n/a |
| RFC 8032 1–3 | fixture `rfc8032` | verify → true (C++, JS) | n/a |
| Real sample | intact.fseal + flight.receipts + pubkey.txt | INTACT in CLI, Wasm, JS, console | n/a |
| Non-matching strong key | key `11`×32 | unverified / wrong-key, as before | n/a |

</intent-contract>

## Code Map

- `tests/fixtures/make_ed25519_weak_keys.py` (done) generates `tests/fixtures/ed25519-weak-keys.json`, one entry per line: `error`, `weak[]` of {key, small_order, count, head, sig|null} with 48 keys (14 forged), `not_weak[]`, `rfc8032[]` of {key, msg, sig}. `forge(key, count, head)` is importable. Signed message: `"fseal-receipt v1" || u64le(count) || head`.
- `src/fseal.h:85-111`: `PublicKey`/`Signature` arrays, `signature_ok`. Add `extern const char kWeakKeyMessage[]`, `bool weak_public_key(const PublicKey&)` and `bool ed25519_verify(const PublicKey&, const uint8_t* m, size_t n, const Signature&)`.
- `src/fseal.cpp:338-348`: the body of `signature_ok` becomes `ed25519_verify`, which returns false for weak keys before calling OpenSSL; `signature_ok` calls it. Keep CryptoError semantics.
- `src/main.cpp:145-157`: `verify()` parses `--pubkey`; add the weak check, `verify: <msg>`, exit 2.
- `wasm/bridge.cpp:99-100`: after `parse_hex`, `throw std::invalid_argument(fseal::kWeakKeyMessage)`.
- `docs/verifier.js:345-420`: export `WEAK_KEY_MESSAGE`, `weakPublicKey(bytes)` (pure byte comparison) and `ed25519Verify(key, sig, msg, cache = new Map())` (weak → false, otherwise WebCrypto importKey/verify with the hex-keyed import cache). `checkReceipts` throws for a weak `trustedKey` right after the first `stop()`, before `ed25519Supported`, and verifies through `ed25519Verify(rc.key, rc.sig, signedMessage(..), keys)`.
- `newweb/src/trusted-keys.mjs:16-21`: `pinTrustedKey` imports from `../../docs/verifier.js` and throws WEAK_KEY_MESSAGE after the hex check.
- `CMakeLists.txt:69-71`: `target_compile_definitions(fseal-tests PRIVATE FSEAL_SOURCE_DIR="${CMAKE_SOURCE_DIR}")`. CMakeLists is in the Wasm provenance hash set.
- Tests: `tests/test_fseal.cpp` (CHECK/TEST macros, no JSON lib: extract `"key": "…"` and the other fields with std::string find on each line); `tests/test_weak_keys.py` (fixtures `fseal_bin` and `ROOT` in `tests/conftest.py`); `tests/web/verifier.test.mjs`; `tests/wasm/bridge.test.mjs:40` uses weak `'00'.repeat(32)` as a "wrong key", so change it to `'11'.repeat(32)`; `newweb/tests/trusted-keys.test.mjs`; `newweb/tests/console.mjs:541` fills `'0'.repeat(64)`, so change it to `'1'.repeat(64)` and add a weak-key check.
- `scripts/build_wasm.sh` (Docker, emsdk 4.0.23) rewrites `docs/wasm/flightseal.{mjs,wasm}` and `provenance.json`; check with `python3 tools/verify_wasm_provenance.py`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/fseal.h`, `src/fseal.cpp` -- predicate, message constant, `ed25519_verify`, `signature_ok` routed through it -- core guard
- [ ] `src/main.cpp` -- refuse a weak `--pubkey` with exit 2 -- CLI trust boundary
- [ ] `wasm/bridge.cpp` -- throw for a weak trusted key -- Wasm trust boundary
- [ ] `docs/verifier.js` -- exports and the `checkReceipts` guard -- JS verifier (Chromium accepts forgeries)
- [ ] `newweb/src/trusted-keys.mjs` -- refuse weak pins -- UI shared module
- [ ] `CMakeLists.txt`, `tests/test_fseal.cpp` -- fixture-driven unit test: 48 weak, 14 forged rejected, control not weak, RFC 1–3 verify, real sample receipt verifies -- C++ coverage
- [ ] `tests/test_weak_keys.py` -- CLI: every weak key gives exit 2 and the message. Using `forge()`, a key-`0100…00` receipt for intact.fseal's real count and head is refused, where it was INTACT before the change. The real sample stays INTACT -- end-to-end CLI
- [ ] `tests/web/verifier.test.mjs`, `tests/wasm/bridge.test.mjs`, `newweb/tests/trusted-keys.test.mjs` -- matrix rows for JS, Wasm and pins
- [ ] `newweb/tests/console.mjs` -- switch the wrong key to `'1'.repeat(64)`; add a check that a weak key in `#trusted-key` shows the message and no verdict. If main.jsx hides it, record that as a note for the main.jsx owner rather than editing main.jsx
- [ ] `THREAT_MODEL.md`, `DECISIONS.md`, `CHANGELOG.md`, `AGENTS.md` -- threat note (with the measured OpenSSL, Chromium and Node behaviour), decision note with the source, changelog line, updated test counts
- [ ] Rebuild: `scripts/build_wasm.sh` after the last change to src/, wasm/ or CMakeLists, then `npm --prefix newweb run build`

**Acceptance Criteria:**
- Given the unpatched baseline, when the new tests run, then they fail. Given this change, they pass.
- Given the console at /app/verify with the intact sample loaded, when a fixture weak key is entered and the check runs, then the page shows `This public key is weak and can't prove anything` and no Intact verdict.
- Given the shipped `docs/wasm`, when `tools/verify_wasm_provenance.py` runs, then it passes with hashes that match the new sources.

## Implementation Notes

Implemented in the main session rather than by a fresh subagent. The investigation (live repros, browser probe, fixture generation) is already in this context, and the advisor recommended doing it here and using subagents only for review.

- Failing-first, run on baseline code with the new tests: `pytest tests/test_weak_keys.py` gave 2 failed. The forged identity-key receipt for `docs/samples/rewritten.fseal` printed `RESULT: INTACT`, and weak key `00…00` gave exit 1 (TAMPERED, so the signature was accepted). `verifier.test.mjs` gave 2 failed (missing exports, and `checkReceipts` did not reject). `trusted-keys.test.mjs` gave 1 failed. `bridge.test.mjs` gave 1 failed (the old module returned verdicts). `test_fseal.cpp` did not compile (missing symbols).
- The CLI test forges against `rewritten.fseal`, not `intact.fseal`, because a rewritten log printing INTACT is the actual attack. The baseline output above shows it.
- The JS primitive guard is tested with a stand-in WebCrypto that accepts every signature, because Node 24 already rejects the forgeries. A mutation that removes the guard makes that test fail (checked).
- Probes: the OpenSSL 3.5.9 CLI accepted the exact repro. Unpatched `fseal` (OpenSSL 4) accepted it too, reporting head-mismatch rather than bad-signature. Headless Chromium 153 accepted all 14 forged fixture receipts and verified RFC 1–3. Node 24.22.3 (OpenSSL 3.5.9) rejected all 14.
- `docs/app.js` was left unchanged: no file under docs/ references it.
- Python: no Python receipt verifier exists. `tools/*.py` call the CLI, so pytest covers the CLI.

## Plan Change Log

## Review Triage Log

### 2026-11-17 — Review pass
- verdicts: 7 findings — high 0, medium 4, low 3, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` docs/wasm not rebuilt and provenance stale — the planned last step had not run yet. Ran `scripts/build_wasm.sh`; `verify_wasm_provenance.py` verified 11 hashes.
  - `[medium]` `[patch]` bridge weak-key test ran against the stale module — passes after the rebuild (Wasm node tests 30/30).
  - `[medium]` `[patch]` docs/console not rebuilt — ran `npm --prefix newweb run build`; the bundle `index-Cm2TuuMu.js` now contains the message.
  - `[low]` `[patch]` docs claimed Wasm protection that was not yet shipped — true once the rebuild is committed in the same PR.
  - `[medium]` `[patch]` the JS `ed25519Verify` guard was not exercised under Node — added a stand-in WebCrypto that accepts everything; the mutation check fails without the guard.
  - `[low]` `[reject]` CLI test uses rewritten.fseal instead of intact.fseal — the stronger, intended attack; recorded in Implementation Notes with the baseline INTACT output.
  - `[low]` `[patch]` no recorded failing-first evidence or counts — recorded in Implementation Notes and Auto Run Result.

## Design Notes

Small-order y values (LE hex, bit 255 masked): `00…00`, `01 00…00`, `ecff…ff7f` (p−1), `26e8958f…6d53fc05`, `c7176a70…92ac037a`. Non-canonical: masked byte31 = 0x7f, bytes 1–30 = 0xff, byte0 ≥ 0xed. These two rules reject all 14 libsodium encodings plus every y ≥ p.

## Verification

**Commands:**
- `cmake -S . -B build && cmake --build build -j && ctest --test-dir build` -- expected: 5/5
- `python3 -m pytest -q` -- expected: 60 + new passed, 30 skipped
- `node --test tests/web/verifier.test.mjs tests/web/copy.test.mjs tests/web/workbench.test.mjs tests/web/redirect.test.mjs tests/web/rawfile.test.mjs tests/web/sw-cache-index.test.mjs tests/web/manifest.test.mjs` -- expected: 139 + new, 0 fail
- `node --test tests/wasm/bridge.test.mjs tests/wasm/enterprise-edge.test.mjs tests/wasm/hash.test.mjs` and `node --test tests/wasm/browser.test.mjs tests/wasm/hash-browser.test.mjs` -- expected: 0 fail
- `node --test newweb/tests/*.test.mjs` -- expected: 45 + new, 0 fail
- `python3 tools/verify_wasm_provenance.py` -- expected: ok
- `npm --prefix newweb run build && npm --prefix newweb run test:browser && node newweb/tests/edge-matrix.mjs` -- expected: 0 failures
- `node tests/web/e2e.mjs` and `node tests/web/routes.mjs` -- expected: 5 and 6 checks pass

## Auto Run Result

Status: built. A weak Ed25519 trusted key (48 encodings: the 8 small-order points incl. non-canonical forms, every y ≥ p) is refused with "This public key is weak and can't prove anything". This applies to the CLI (exit 2), the Wasm bridge (`{error}`), `docs/verifier.js` `checkReceipts` (throws) and `pinTrustedKey`. `ed25519_verify` and `ed25519Verify` return false for such keys.

Files: `src/fseal.{h,cpp}` (predicate, message, `ed25519_verify`), `src/main.cpp` (CLI refusal), `wasm/bridge.cpp` (Wasm refusal), `docs/verifier.js` (exports and guard), `newweb/src/trusted-keys.mjs` (pin refusal), `CMakeLists.txt` (test source dir), `tests/fixtures/*` (generator and vectors), tests (C++, pytest, node, Wasm, console), `THREAT_MODEL.md`, `DECISIONS.md` #22, `CHANGELOG.md`, `AGENTS.md` counts, rebuilt `docs/wasm` and `docs/console`.

Review: 6 patched, 1 rejected (reason above), 0 deferred. Follow-up review recommended: true (4 medium patched). The named risk is that the rebuilt `docs/wasm` and `docs/console` artifacts were not re-reviewed after patching; provenance and browser checks pass

Verification (all run after the rebuild): ctest 5/5. pytest 63 passed, 30 skipped. JS 141/141. Wasm node 30/30. Wasm browser 8 passed, 3 skipped (opt-in large-file). newweb unit 46/46. provenance verified 11 hashes. Console `test:browser` 42 ok, exit 0. edge-matrix 9 ok. e2e 5 ok. routes 6 ok.

Residual risk: the CLI and Wasm verdict for a weak key that appears only inside a receipt (not the trusted key) stays `wrong-key`, as before. Small-order `R` is not rejected separately (not needed once the key is checked).

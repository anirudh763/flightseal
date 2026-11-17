---
title: 'Packet A: Manifest-only mode for large files'
type: feature
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: '57bbc28e1ab4e34d2d98de9580f616b38a35d7a8'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '/Users/anirudhyadav/flightseal/.claude/worktrees/agent-aa113fd09db24fd7b/AGENTS.md'
  - '/Users/anirudhyadav/flightseal/.claude/worktrees/agent-aa113fd09db24fd7b/DESIGN.md'
  - '/Users/anirudhyadav/flightseal/.claude/worktrees/agent-aa113fd09db24fd7b/.agents/skills/enterprise-ui-polish/SKILL.md'
  - '/Users/anirudhyadav/flightseal/.claude/worktrees/agent-aa113fd09db24fd7b/.agents/skills/wasm-edge-case-qa/SKILL.md'
warnings: [oversized, multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Seal & send embeds the whole file (base64, 45 MiB cap, `docs/rawfile.js`), so operators cannot seal multi-GiB flight videos/logs or several files at once. There is no streaming whole-file SHA-256 in the browser or CLI.

**Approach:** Keep Embedded file mode unchanged. Add a **Manifest only** mode: originals stay on the operator's storage; a Web Worker streams each file's SHA-256 through OpenSSL in Wasm (begin/update/final, 4 MiB `File.slice()` reads, one read in flight); a deterministic `hashwing-manifest v1` payload is sealed as exactly ONE FLTSEAL1 record with the existing sealer; a recipient verifies that sealed manifest against an independently trusted key, then streams local files and gets per-item Matches / Bytes differ / Missing / Not in manifest. A matching streaming CLI (`tools/manifest.py`) produces byte-identical manifests.

## Boundaries & Constraints

**Always:**
- One incremental SHA-256 context per file over the original bytes in order. Never hash chunk hashes, never `file.arrayBuffer()` on the whole file, never concatenate chunks, never base64 media.
- Prefer Wasm OpenSSL glue in `wasm/bridge.cpp` rebuilt by `scripts/build_wasm.sh` (updates `docs/wasm/provenance.json`). Only if the Docker/emscripten build genuinely fails: a small self-contained JS incremental SHA-256 with parity tests vs `openssl dgst -sha256`, with the failure reason recorded in Implementation Notes and `docs/MANIFEST_MODE.md`.
- Manifest verdict requires: chain intact, exactly 1 record, no trailing bytes after it, exactly 1 receipt line, receipt `count=1`, head equal to the scanned head, signature valid for a key the recipient entered or chose from a local pin in a separate "Trusted public key" field. The key inside the receipt message is never used as the trust anchor.
- The check shows only fields parsed from the signed manifest payload. Text in the handover message (names, sizes, digests, times) is ignored as unsigned.
- "Bytes differ" copy names possible causes (editing, truncation, corruption, metadata change, recompression) and never claims tampering or picks a cause. UI states: "A manifest is not a backup."
- No network request body may contain source-file bytes during manifest seal/check. Manifest state stays out of `runVerify`/the shared `result` (so "Save current run" can never upload it).
- Keep keyboard/focus/live-region semantics and 320/768/1440 layouts; obey AGENTS.md owner UI copy rule (short labels, no tutorial prose).
- Honesty: every number in docs/PR is measured; record method. Run the >2 GiB browser and CLI test locally and record real throughput and memory.
- Stage files by explicit path only. Never `git add -A`/`git add .`; never add `_bmad/`, `newweb/node_modules`, `tests/web/node_modules` (symlinks/untracked).

**Never:** change FLTSEAL1, receipt v1, `src/` C++ core, `docs/verifier.js` verdicts, `docs/rawfile.js` behaviour or the 45 MiB limit; add npm/pip deps; send manifest/salt/digests anywhere; derive "Bytes differ" via perceptual similarity.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Digest sizes | files of 0, 1, 4 MiB, 4 MiB-1, 4 MiB+1, 46 MiB bytes | browser worker hex == CLI hex == `openssl dgst -sha256` | No error |
| >2 GiB | sparse file of 2^31 + 5 MiB + 7 bytes with non-zero markers at 2^31-1, 2^31 and last byte | same parity; throughput + memory recorded | Gated by env `FSEAL_LARGE_HASH=1`; run locally |
| Cancel | abort after first progress event | promise rejects `AbortError`, worker terminated, no further progress | UI returns to idle, message "Cancelled" |
| Read failure | file modified/removed on disk after selection | rejects with a readable error (assert what Chrome actually reports) | UI shows error, no manifest produced |
| Limits | 0 items, 101 items, payload > 65536 bytes, name > 255 UTF-8 bytes, note > 1000 UTF-8 bytes, lone surrogate | encoder/parser throws RangeError/TypeError | UI shows the limit |
| Payload mutation | one byte of record 0 payload changed (CRC/link fixed or not) | check rejected (head/receipt mismatch or bad chain) | "Manifest not verified" |
| Extra record | valid second record appended, receipt count=1 kept | rejected ("must contain exactly one record") | — |
| Trailing bytes / torn tail | garbage after record 0 | rejected | — |
| count≠1 / 2 receipts | receipt count=2, or two receipt lines | rejected | — |
| Wrong/missing trusted key | key field empty, or key ≠ receipt key | rejected; no "verified" state | prompt for trusted key |
| Pairing | locals vs items | Matches / Bytes differ / Missing / Not in manifest per rule in Design Notes | — |

</intent-contract>

## Code Map

- `wasm/bridge.cpp:26-44` -- existing `sha256_file` uses `EVP_DigestInit_ex/Update/Final_ex`; add `extern "C"` `fseal_sha256_begin()` (int, frees+reallocs one global `EVP_MD_CTX`), `fseal_sha256_update(const unsigned char*, size_t)` (int 1/0), `fseal_sha256_final()` (const char* 64-hex, "" on error; frees ctx).
- `wasm/CMakeLists.txt` -- add `_fseal_sha256_begin/_update/_final`, `_malloc`, `_free` to EXPORTED_FUNCTIONS and `HEAPU8` to EXPORTED_RUNTIME_METHODS. Re-read `module.HEAPU8` after every malloc/update (memory growth detaches views).
- `scripts/build_wasm.sh` -- run as `FSEAL_WASM_BUILD_DIR=/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wasm-build scripts/build_wasm.sh` (OpenSSL already cached there). It rewrites `docs/wasm/flightseal.{mjs,wasm}` and `provenance.json`; then `python3 tools/verify_wasm_provenance.py`.
- `docs/wasm/client.mjs` -- existing `run()` caps 64 MiB and has a 5-minute deadline: do NOT reuse it. Add `hashFile(file, { signal, onProgress })` + `HASH_CHUNK = 4 MiB`: one new Worker per file, terminate on abort/finish, no size cap, no deadline.
- `docs/wasm/hash-worker.mjs` (new) -- loads `./flightseal.mjs`, mallocs one 4 MiB buffer, loops `await file.slice(o, o+4MiB).arrayBuffer()`, checks returned length, copies into heap, update, posts `{progress: bytesDone}`; posts `{sha256, bytes, wasmHeapBytes}` or `{error}`; frees buffer.
- `docs/sw.js:21` -- add `'manifest.mjs'`, `'wasm/hash-worker.mjs'` to the cached asset list (check `tests/web/sw-cache-index.test.mjs` still passes).
- `docs/manifest.mjs` (new, pure ES module, works in node and browser) -- `MANIFEST_LIMITS`, `encodeManifest({salt, items}) -> Uint8Array`, `parseManifest(bytes)` strict, `newSalt()` (crypto.getRandomValues 32 bytes), `manifestRecordsBlob(bytes)` (`0\t<payload>\n`), `verifySealedManifest(blob, receiptsText, trustedKeyHex)` built on `docs/verifier.js` `blobSource/scanLog/parseReceipts/checkReceipts/readRecord`, `compareFiles(manifest, locals)`, `manifestHandoverText({items, receipts, publicKey, sealedAt})` (receipt + key + item count only; no names/digests).
- `docs/verifier.js` -- read-only; reuse exports listed above. `docs/rawfile.js` -- read-only (reuse `parseHandover` to pull receipt lines only).
- `tools/fseal_py.py` -- independent reader: `link(prev, seq, ts, payload)`; head of a one-record log = `link(b"\0"*32, 0, 0, payload)` (key-independent, `src/fseal.cpp:80`). Use it for fixture heads and CLI `check` record reading.
- `tools/raw_file.py` -- pattern to mirror (quote safe set, CLI shape, pipe into `build/fseal append ... --every 1`).
- `tools/manifest.py` (new) -- `digest FILE`, `create [--salt HEX] [--include-names] [--note N=TEXT]... FILE...` (writes the sealer line to stdout), `check SEALED.fseal FILE...` (prints per-item status, exit 1 unless all Match). `hashlib.sha256()` updated with 4 MiB `readinto` reads.
- `newweb/src/main.jsx:951-980,1429-1475` -- `runProtectSeal` and the protect screen. Reuse `sealFile(..., { every: 1, privateKeyPem: signingKey?.privateKeyPem || '' })`, `download`, `copyHandover` pattern, `TrustedKeyPinControls` (line ~1748), `fmtBytes`. Help Limits `<dl>` (~line 1509): add Manifest items 100, Manifest payload 64 KiB.
- `newweb/src/style.css` -- styles for mode radio group, file list, `<progress>`, status table (reuse `status-label ok|bad|warn`).
- `newweb/tests/console.mjs` -- server/browser launch pattern to copy for the new browser test; `newweb/package.json` `test:browser` script.
- `tests/wasm/browser.test.mjs:1-45` -- `withPage` pattern (serves `docs/`, Chrome channel on macOS) to copy for the worker test.
- `.github/workflows/ci.yml`, `AGENTS.md` test gates -- register new test files and update real counts.
- Python env: `export PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH`; `python3 tools/fetch_sample.py tests/.data` before console tests; C++ CLI via `cmake -S . -B build && cmake --build build -j`.

## Tasks & Acceptance

**Execution:**
- [ ] `wasm/bridge.cpp`, `wasm/CMakeLists.txt` -- add SHA-256 begin/update/final glue and exports; rebuild with `scripts/build_wasm.sh` (Docker) -- native OpenSSL reuse.
- [ ] `docs/wasm/hash-worker.mjs`, `docs/wasm/client.mjs`, `docs/sw.js` -- streaming hash worker + `hashFile` client -- bounded memory, cancel, progress.
- [ ] `docs/manifest.mjs` -- format, limits, verification, pairing, handover -- shared by console and node tests.
- [ ] `tools/manifest.py` -- streaming CLI with identical bytes -- CLI fallback.
- [ ] `tests/fixtures/manifest/` -- `basic.json` (salt + items incl. a 0-byte item, a UTF-8 name, an operator note, an item without name), `basic.payload` (exact bytes), `basic.head` (hex via `fseal_py.link`); plus `minimal.*` (1 item, no name/note) -- published test vectors.
- [ ] `tests/wasm/hash.test.mjs` -- node: Wasm glue digests for the matrix sizes (except >2 GiB) == `openssl dgst -sha256`, 1-byte-at-a-time and 4 MiB update splits agree.
- [ ] `tests/wasm/hash-browser.test.mjs` -- Playwright worker: matrix sizes parity via `setInputFiles`, cancellation, read failure; `FSEAL_LARGE_HASH=1` large sparse case printing JSON `{bytes, seconds, MiBps, idleRssMiB, peakRssMiB, deltaRssMiB, wasmHeapBytes, jsHeapUsedMiB}` (RSS = sum over the launched browser's process tree sampled with `ps` every 250 ms; JS heap via CDP `Performance.getMetrics`).
- [ ] `tests/web/manifest.test.mjs` -- node: fixtures encode/parse exactly; strict parse rejects non-canonical forms; limits; `verifySealedManifest` positive case (sealed with `build/fseal` or the Wasm sealer) and every rejection row; `compareFiles` rule; JS bytes == `python3 tools/manifest.py create --salt ...` bytes.
- [ ] `tests/test_manifest.py` -- pytest: CLI digest parity vs openssl for matrix sizes, fixtures, `check` statuses, round trip through `build/fseal append/verify` when the binary exists (skip otherwise), large sparse case under `FSEAL_LARGE_HASH=1` reporting seconds and `ru_maxrss` of the child.
- [ ] `newweb/src/main.jsx`, `newweb/src/style.css` -- Seal & send: radio group "Embedded file (up to 45 MiB)" / "Manifest only (large or multiple files)"; manifest mode: multi-file input (≤100), "Include file names" checkbox (default off), optional per-file "Operator note" input, progress + Cancel, "A manifest is not a backup" notice, outputs (download `*.manifest.fseal`, copy/download receipt message, public key). New panel "Check files against a manifest": sealed manifest file, receipt message, trusted public key (+ `TrustedKeyPinControls`), local files, results table. Help Limits rows.
- [ ] `newweb/tests/manifest-mode.mjs` + `newweb/package.json` (`test:browser` runs it after `console.mjs`) -- real UI flow: seal 3 files (one containing a random 64-byte marker), check with one modified, one missing, one extra file → expected statuses; no trusted key → not verified; record all context-level requests and assert no `postDataBuffer()` contains the marker or any file bytes; axe 0 violations and no horizontal scroll at 320/768/1440.
- [ ] `docs/MANIFEST_MODE.md` -- format spec, ordering/encoding rules, limits, pairing rule, verification rule, measured numbers + method, limitations (digest = bytes read, not producer history; not a backup; no-name items cannot report Bytes differ).
- [ ] `AGENTS.md`, `.github/workflows/ci.yml` -- add new test commands (large test manual only) and real pytest counts.
- [ ] `docs/console/` -- regenerate via `npm --prefix newweb run build`; commit output.

**Acceptance Criteria:**
- Given Seal & send in Manifest only mode, when the operator selects files and seals, then a `.manifest.fseal` with exactly one record and a count=1 receipt message are offered, a "not a backup" notice is visible, and Embedded file mode behaves exactly as before.
- Given a sealed manifest, receipt message and the correct key entered in the trusted-key field, when the recipient selects local files, then each item shows Matches / Bytes differ / Missing and extra files show Not in manifest.
- Given the receipt message alone (trusted-key field empty or different), when checking, then no verified result or item statuses are shown.
- Given hashing is in progress, when Cancel is pressed, then the worker stops, progress stops, and the UI is usable again.
- Given any manifest seal/check run, then no network request body contains source-file bytes.

## Implementation Notes

- Planning: a Docker prebuild of OpenSSL into the scratchpad `wasm-build` dir (named in Code Map) was started from unchanged sources (log: `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wasm-build.log`). Before running `scripts/build_wasm.sh`, wait until no `emscripten/emsdk` container shows in `docker ps`; then the script reuses `wasm-build/openssl/lib/libcrypto.a`. Any `docs/wasm` change from the prebuild is superseded by your rebuild.
- Build: the Docker/emscripten rebuild succeeded, so the JS SHA-256 fallback was not needed. `verify_wasm_provenance.py` verified 11 hashes.
- Owner UI direction arrived mid-task through an agent message and overrides the plan's UI copy:
  - Mode labels are "Large files (fingerprint only)" and "Small file (seal the whole file, up to 45 MiB)".
  - Manifest and salt are explained in a "What is this?" disclosure, which keeps "A manifest is not a backup". The visible notice reads "This keeps a fingerprint, not a copy. Keep your original files."
  - A step list (Choose files, Seal, Send) uses `aria-current="step"`.
  - Each file has a progress bar with percent, MB/s and Cancel.
  - Chips: Matches is green, Bytes differ is amber with the "isn't proof of tampering" line, Missing is grey and Not in manifest is neutral.
  - Errors are friendly and say the next step.
  - Names, notes and key/interval info sit under "More options".
- The manifest panels stay mounted (hidden) while Small file mode is shown, so switching modes never drops a running hash or an unsaved sealed list. Limits are dry-run before hashing.
- Measured large runs are recorded in docs/MANIFEST_MODE.md (browser 169.3 MiB/s with +140.3 MiB process-tree RSS; CLI 1,205.2 MiB/s with 21.5 MiB child RSS; sparse file, page cache).
- Review fixes:
  - The "Bytes differ" note now names metadata changes and recompression.
  - Name-length errors advise renaming the file or turning off Include file names.
  - Only file-read failures get the "moved, changed or deleted" text; engine and worker errors show their message plus "Reload the page and try again".
  - A running manifest check marks the tab active for service-worker updates.
  - The manifest panels stay mounted (hidden) across route changes.
  - The second TrustedKeyPinControls takes an `idPrefix` so its ids stay unique.
  - tools/manifest.py uses one `base_name` helper for create and check.

## Plan Change Log

## Review Triage Log

### 2026-11-17 — Review pass
- verdicts: 8 findings — high 0, medium 4, low 2, false 2, maybe-false 0
- findings:
  - `[medium]` `[patch]` "Bytes differ" note missed metadata change/recompression — reworded in main.jsx; manifest-mode.mjs asserts new text.
  - `[low]` `[patch]` name-length error pointed to a non-existent field — advice now says rename the file or turn off Include file names.
  - `[medium]` `[patch]` hashAll reported engine/worker failures as file problems — only NotReadable/short-read keep that text; others show real message + reload step.
  - `[medium]` `[patch]` running manifest check did not block SW update — ManifestCheck now reports activity via the same flag mechanism.
  - `[low]` `[reject]` identical duplicate receipt lines accepted — parseHandover dedups identical lines by design (email quoting/forwarding); identical lines carry the same signed claim, no harm; two different lines are rejected and tested.
  - `[low]` `[patch]` tools/manifest.py create/check split names differently — one base_name helper; pytest added.
  - `[false]` `[reject]` AGENTS.md count changes unexplained — baseline e2e.mjs (unchanged) prints 5 ok and ctest reports 5 tests; counts were stale corrections.
  - `[medium]` `[patch]` leaving Seal & send lost unsaved sealed list — panels stay mounted hidden across routes; route-change test added.

## Design Notes

**Canonical payload** (single line, ASCII, no CR/LF — the sealer splits on `getline`):
```
hashwing-manifest v1 salt=<64 lowercase hex> items=<n>[ item=<i>,<bytes>,<sha256>,<name>,<note>]×n
```
- `i` = 1..n contiguous ascending (order = operator's selection order); `bytes` decimal, no leading zeros, ≤15 digits; `sha256` 64 lowercase hex; `name`/`note` = `encodeURIComponent` of the exact UTF-8 string (Python `quote(s.encode(), safe="-_.!~*'()")`), empty when absent. `note` is operator-entered text, labelled so in UI and docs. Parser re-encodes decoded fields and requires byte equality (rejects non-canonical escapes). Limits: 1 ≤ n ≤ 100; payload ≤ 65536 bytes; name ≤ 255 and note ≤ 1000 UTF-8 bytes. Sealed as `0\t<payload>\n`, `every=1` → record seq 0, ts 0.

**Pairing rule** (`compareFiles`, deterministic): (1) each local file, in selection order, matches the lowest-id unmatched item with equal size and digest → Matches; (2) each remaining local file whose name equals the included name of the lowest-id remaining item with that name → Bytes differ; (3) remaining items → Missing; remaining local files → Not in manifest. Duplicate digests are allowed; each local file and item pairs at most once.

## Verification

**Commands:**
- `python3 tools/verify_wasm_provenance.py` -- expected: all hashes verified after rebuild
- `node --test tests/web/verifier.test.mjs tests/web/copy.test.mjs tests/web/workbench.test.mjs tests/web/redirect.test.mjs tests/web/rawfile.test.mjs tests/web/sw-cache-index.test.mjs tests/web/manifest.test.mjs` -- expected: all pass
- `node --test tests/wasm/bridge.test.mjs tests/wasm/enterprise-edge.test.mjs tests/wasm/hash.test.mjs` and `node --test tests/wasm/browser.test.mjs tests/wasm/hash-browser.test.mjs` -- expected: all pass
- `FSEAL_LARGE_HASH=1 node --test tests/wasm/hash-browser.test.mjs` and `FSEAL_LARGE_HASH=1 python3 -m pytest -q tests/test_manifest.py` -- expected: pass; numbers recorded in docs/MANIFEST_MODE.md
- `python3 -m pytest -q` -- expected: pass (record counts)
- `python3 tools/fetch_sample.py tests/.data && npm --prefix newweb run build && npm --prefix newweb run test:browser && node newweb/tests/edge-matrix.mjs` -- expected: pass
- `node tests/web/e2e.mjs && node tests/web/routes.mjs` -- expected: 5 + 6 checks pass (baseline e2e has 5)

## Auto Run Result

Status: built

- Summary: Manifest-only ("Large files (fingerprint only)") mode: Wasm OpenSSL streaming SHA-256 worker (4 MiB slices, one read in flight, cancel), `hashwing-manifest v1` canonical single-record payload sealed with the existing sealer (count=1 receipt), strict recipient verification against an independently entered/pinned key, per-file Matches/Bytes differ/Missing/Not in manifest, streaming CLI `tools/manifest.py` with byte-identical output, fixtures, docs.
- Files: wasm/bridge.cpp + wasm/CMakeLists.txt (begin/update/final glue), docs/wasm/* (rebuilt + provenance), docs/wasm/hash-worker.mjs + client.mjs hashFile, docs/manifest.mjs, docs/sw.js, tools/manifest.py, tests/fixtures/manifest/*, tests/wasm/hash.test.mjs, tests/wasm/hash-browser.test.mjs, tests/web/manifest.test.mjs, tests/test_manifest.py, newweb/src/main.jsx + style.css, newweb/tests/manifest-mode.mjs, newweb/package.json, docs/console/* (build), docs/MANIFEST_MODE.md, AGENTS.md, .github/workflows/ci.yml.
- Review: 6 patched (4 medium, 2 low), 0 deferred, 2 rejected (reasons in triage log).
- Follow-up review recommended: true — two or more medium entries patched; specific unverified risk: fixes 2-4 (name advice, engine-error text, SW hold during check) have no dedicated tests.
- Verification on final head: provenance 11 hashes; JS 139/139; Wasm 29/29; browser+hash-browser 8 pass/3 skip; pytest 60 passed/30 skipped; ctest 5/5; test:browser 42 ok (78 requests, 0 bodies); edge-matrix 9 ok; e2e 5 ok; routes 6 ok. Large (2,152,726,535 B sparse, page cache): browser 169.4 MiB/s, RSS +159.5 MiB (prior run +140.3); CLI 1,279.5 MiB/s, 22.1 MiB peak.
- Residual risks: 128 MiB extra-memory target not demonstrated by the process-tree RSS method; needs browser Ed25519; large tests manual; no screen-reader test.

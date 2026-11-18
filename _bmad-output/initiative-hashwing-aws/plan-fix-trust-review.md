---
title: 'Trust review fixes: compromised keys stay compromised, pin integrity, manifest name and key parity'
type: bugfix
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: '3a22d5c8543124d4100c516c60e21dddea07982a'
route: oneshot
route_source: pinned
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals]
deferred:
  - summary: >-
      main.jsx Remove copy says "and its key history" and a compromised-only company keeps a no-op Remove button.
    evidence: |-
      removeTrustedKey now keeps compromised records; main.jsx:1894/1920/1923 are owned by the wiring builder.
    location: >-
      newweb/src/main.jsx:1894
    severity: medium
  - summary: >-
      A corrupted compromised entry is dropped by read(), clearing the compromised mark.
    evidence: |-
      read() drops malformed entries as the intent requires; documented in THREAT_MODEL.md.
    location: >-
      newweb/src/trusted-keys.mjs
    severity: medium
  - summary: >-
      An active pin of a fingerprint that another entry marks compromised still lists as active.
    evidence: |-
      Pre-existing; trustForKey still returns compromised for that key.
    location: >-
      newweb/src/trusted-keys.mjs listTrustedKeys
    severity: medium
---

<intent-contract>

## Intent

**Problem:** An independent review of main 3a22d5c found five trust and parity bugs. (1) Removing a company in
`newweb/src/trusted-keys.mjs` deletes its compromised history, so a key the user marked compromised can later read as
`trusted` through another company's pin (probe.mjs section 4 reproduces this); `markCompromised` also matches names
case-sensitively. (2) `read()` accepts an entry whose fingerprint is not SHA-256 of its public key, and one malformed
entry makes the whole list unreadable. (3) `tools/manifest.py base_name` splits on `\`, unlike the browser's
`File.name`. (4) `verifySealedManifest` rejects an uppercase trusted key. (5) It throws, instead of returning
`{verified:false, reason}`, for a weak trusted key.

**Approach:**
1. `removeTrustedKey` keeps the removed name's `compromised` entries. `upsert`, shared by `pinTrustedKey` and
   `addTrustedCompany`, refuses a fingerprint that any entry marks compromised, with a plain message.
   `markCompromised` uses `sameName`.
2. `read()` drops each malformed entry, and each entry with a non-empty `publicKey` whose fingerprint does not equal
   its SHA-256. This needs a small synchronous SHA-256, because `read()` and its callers in main.jsx are synchronous.
   It still throws for unparseable JSON, a non-array, or more than 64 entries. THREAT_MODEL.md gets a note on the
   shared origin.
3. `base_name` uses `os.path.basename`. On POSIX it splits only on `/`, which matches the browser.
4. Lowercase the trusted key before `parseHex`.
5. Return `reject(WEAK_KEY_MESSAGE)` before `checkReceipts`.

Each fix gets a test that fails before it. Do not edit main.jsx or style.css; report the copy strings it needs.

</intent-contract>

## Implementation Notes

Oneshot route: five small, localised fixes in three source files plus tests, all specified by the review.
Deliberate test change: `trusted-keys.test.mjs` "history entries need their dates" asserted that the whole store
throws `unsupported format`. The requirement now says per-entry problems are dropped, so it asserts the entry is
dropped. The old `test_base_name_matches_browser_file_name` expectations (`a\b.mp4` -> `b.mp4`) encoded the bug
and are flipped.

Files touched: `newweb/src/trusted-keys.mjs`, `docs/manifest.mjs`, `tools/manifest.py`; the tests in
`newweb/tests/trusted-keys.test.mjs`, `newweb/tests/manifest-mode.mjs`, `tests/web/manifest.test.mjs` and
`tests/test_manifest.py`; `THREAT_MODEL.md`, `docs/MANIFEST_MODE.md`, `AGENTS.md` (141 -> 142 tests); and the
rebuilt `docs/console/`.

Coordinator corrections applied: `base_name` uses the platform basename (`os.path.basename`), documented in
MANIFEST_MODE.md. A compromised record survives remove, then reload, then the integrity filter.

Surprise: the browser check "Pin controls on the check form" pinned a key that the previous check had marked
compromised. It now asserts the refusal, then pins a fresh key. The rebuilt CSS gains one `.fixed` rule; it comes
from Tailwind's source scan, not from any source edit here.

## Review Triage Log

### 2026-11-17 — Review pass
- verdicts: 6 findings — high 0, medium 3, low 3, false 0, maybe-false 0
- findings:
  - `[medium]` `[defer]` main.jsx Remove copy ("and its key history") is now untrue, and on a company with only a compromised record left, Remove does nothing but still says "Removed". This is real, but main.jsx belongs to the wiring builder. The new strings are reported for that builder (see Auto Run Result).
  - `[low]` `[patch]` Compromised records count toward the 64-entry cap for good. Added a `ponytail:` comment that names the ceiling and how to raise it.
  - `[medium]` `[defer]` A corrupted compromised entry is dropped by read(), which clears the compromised mark. The intent asks for malformed entries to be dropped. THREAT_MODEL.md now says so (patched docs); keeping such entries is deferred.
  - `[medium]` `[defer]` Another company's active pin of a fingerprint marked compromised still appears as active in Settings and in the pin dropdown. This predates the change (trustForKey still gives the right verdict, `compromised`), so it is deferred.
  - `[low]` `[reject]` The `.catch` at main.jsx:2328 is now dead code. It does no harm, and it is reported to the wiring builder.
  - `[low]` `[patch]` An unrelated line-ending change to the tslib licence came from the rebuild. Restored it with `git checkout`. The generated docs/console assets were left out of the reviewed diff on purpose.

## Auto Run Result

Status: built. The five fixes from the intent are implemented, with tests written to fail first. Patched after review: the cap
comment, a THREAT_MODEL sentence, and the restored licence file. Deferred: the 3 items above. Follow-up review: false (no high
patched; 0 medium patched). Verification: JS gate 142/142, newweb unit 112/112, pytest 144 passed / 30 skipped,
test:browser 48 ok, edge-matrix ok. Residual risk: main.jsx copy for Remove (wiring builder).

## Verification

**Commands:**
- `node --test newweb/tests/*.test.mjs` -- expected: all pass
- JS gate from AGENTS.md (`node --test tests/web/...`) -- expected: all pass
- `uv run --no-project -p 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q` -- expected: pass, with Linux-only skips
- `npm --prefix newweb run build && npm --prefix newweb run test:browser` -- expected: all checks pass
- `gitleaks git --log-opts=origin/main..HEAD` -- expected: no leaks

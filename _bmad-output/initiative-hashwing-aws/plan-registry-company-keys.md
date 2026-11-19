---
title: 'Registry company keys, server half (design PR 1, Option A)'
type: feature
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '56fc2192098eefae77ce2e578cd43c32e237ccbd'
route: full
route_source: auto
risk: medium
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The registry key routes don't yet do what design PR #57 (`design-key-enrollment-option-b.md` §4.1, §10 "PR 1, registry pytest" and the cross-format rule) and spine AD-21 ask for. Marking a key compromised a second time moves its compromise date. `GET /v1/keys` doesn't say which key is active or who enrolled it, and it silently stops at 50 rows. Python clients sign whatever `message` the server sends.

**Approach:** Make these small server fixes in `registry/registry/app.py`. Add one Python client builder that makes the enrollment challenge bytes locally and refuses a mismatched server `message`, and route every Python signer through it. Add tests, including cross-format tests: a company-key signature over a challenge must fail as a receipt in `receipt.py` and in the `fseal` CLI. Make the docs truthful.

## Boundaries & Constraints

**Always:**
- Work only in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-keys` (branch `feat/registry-company-keys`). Never edit `/Users/anirudhyadav/flightseal`.
- Touch only `registry/`, `tools/` (only if needed), `docs/aws/ARCHITECTURE_AWS.md`, `docs/aws/RUNBOOK_AWS.md`, `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md` (rows R33 and R35 only), `AGENTS.md` (test counts only) and this plan.
- If a dev registry is needed, use port 8799 with its own temp data. Never use 8787, 4180, 8797 or 8798.
- Keep the challenge format byte-exact: `hashwing-key-enroll v1\n<org>\n<nonce>`, with a 32-lowercase-hex nonce. The challenge and enroll routes keep today's request and response fields.
- Never return a `sub` or `enrolled_by` to a client.

**Never:**
- No `newweb/` or `docs/console/` changes.
- No spine or design-note edits: PR #57 is open and owns them.
- No AD-24 or restore changes: the kind, `company_fp` and `not_after` fields are PR 3 (design §5).
- No new routes, no infra ROUTES change, and no AWS deploy.
- Don't run `registry/localstack/e2e.py` (it needs Docker), and don't touch the `docs/aws/evidence/` JSON.
- Don't commit `_bmad/`, `.venv-agent` or `build/`. No force-push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First compromise | admin, active key | 200 `{key_fingerprint, state:"compromised", changed_at}`. KEY and TOMB updated, ACTIVE_KEY removed | — |
| Repeat compromise | key already compromised, clock later | 200 with the stored `changed_at`. The KEY and TOMB items are unchanged (deep-equal) | — |
| Racing compromise | state changes between read and write | The update is conditioned on the state read. On cancel, re-read: if compromised, return 200 with the stored `changed_at`, otherwise 409 `conflict` | — |
| Compromise, unknown or other org | fp not in caller's org | 404, the same body as today | — |
| Compromise as member | role pilot | 403 `forbidden` | — |
| List keys | member, keys enrolled by admin-1 | Rows have `key_fingerprint`, `state`, `enrolled_at`, `changed_at`, `enrolled_by_me` (true only when `enrolled_by == caller sub`). Top level has `active_key` (fp or null) and `next_cursor`. The body contains no `enrolled_by` key and no sub string | — |
| List keys, more than 50 | 51+ KEY items | Page 1 has 50 rows and a `next_cursor`. `?cursor=<fp>` returns the rest. The last page's `next_cursor` is null, except that an exactly-full page may return a cursor, as with registrations | — |
| Bad cursor | `cursor` not 64 lowercase hex | 400 `bad_request` | — |
| Restored stub key | KEY item with `enrolled_by` "restore" | `enrolled_by_me` false | — |
| Challenge bytes | admin GET challenge | `nonce` matches `[0-9a-f]{32}`, `message` == `"hashwing-key-enroll v1\n" + org + "\n" + nonce` | — |
| Client builder | server message ≠ local bytes (e.g. `fseal-receipt v1…`, other org, trailing newline), or nonce not 32 lowercase hex | refuses: returns None / raises, signs nothing | caller stops |
| Cross-format, Python | company-key sig over a challenge put into a Receipt | `receipt.signature_ok` False; registering that line → 422 `bad_signature` | — |
| Cross-format, enroll | a receipt signature posted as the enroll `signature` | 422 `bad_signature` | — |
| Cross-format, CLI | real `fseal` receipt line with sig replaced by the same key's challenge sig | `fseal verify LOG --receipts F --pubkey HEX` exits 3, `RESULT: UNVERIFIED` | test skips only if `build/fseal` is missing |

</intent-contract>

## Code Map

- `registry/registry/app.py` -- `list_keys` (about line 459) uses `self.t.query(pk, "KEY#", PAGE)` and ignores the cursor. Copy the cursor pattern from `list_registrations` (about line 327): `query` dict, `last[4:]`, but the cursor is HEX64 because fingerprints are 64 hex. `compromise` (about line 464) always writes. Store conditions available: `("eq", f, v)`, `("or", c1, c2)`, `("exists",)` (see `store.py` lines 1-60, 160-175). `_transact` returns the failed-reason list (falsy on success). `_iso` formats times. `challenge_message` (about line 403) is the server builder: keep it, and don't make the client reuse it (the client must build independently).
- `registry/registry/receipt.py` -- `signed_message(count, head)` = `b"fseal-receipt v1" + count LE8 + head`, and `signature_ok`. Read-only: the format must not change.
- `registry/registry/restore.py` -- read-only. It replays a key tombstone's `state` and `at` into `changed_at`, so an idempotent compromise keeps the first date across a restore. Stub KEY items use `enrolled_by` "restore".
- `registry/tests/registry_helpers.py` -- `enroll()` signs `ch["message"]` (server text). `registry/devserver/server.py:77` enrolls through it. Switch it to the client builder. `fseal_bin()` and `fseal_receipts(tmp_path)` give a real C++ receipt and its seed.
- `registry/tests/test_registry_cognito.py:107-111` -- signs `ch["message"]`. Switch it to the builder, with org from that test's token (`orgA`).
- `registry/localstack/e2e.py:244-247` -- signs `ch["message"]`. Switch it to the builder, with org `"orgA"` from its own `tok(...)` call. It isn't runnable here.
- `registry/tests/test_registry_app.py:274-330` -- `test_key_enrollment_rules`. These direct server tests intentionally sign the server message. Leave them.
- `tools/registry_onboard.py`, `tools/fseal_py.py` -- checked: neither signs challenges nor verifies receipts. No change.
- `docs/aws/ARCHITECTURE_AWS.md` -- the routes table and the Data table (line 75 KEY item). Document the `GET /v1/keys` fields, the cursor, and compromise idempotency.
- `docs/aws/RUNBOOK_AWS.md:86-101` -- "How pilots sign (provisional)". Make it final: Option A is the owner's decision (2026-11-18, design PR #57, spine AD-4). Option B is built later and stays off by default. Line 100: the client builds the challenge bytes itself and signs only if the server's `message` is byte-equal.
- `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md:72` (R33) and `:74` (R35) -- update only the evidence column with exact test names and lines. Status stays as is: the UI and browser halves are open.
- `AGENTS.md` -- the Python count (baseline measured 175 passed, 30 skipped; the doc says 174) and the registry count (baseline 112).

## Tasks & Acceptance

**Execution:**
- [x] `registry/registry/app.py` -- `compromise`: return early if the key is already compromised. Otherwise condition the KEY update on `("eq","state",<read state>)`. On cancel, re-read and return the stored value or 409. Add `changed_at` (ISO) to both responses. `list_keys`: handle the cursor (HEX64, else 400), add `enrolled_by_me`, `active_key` and `next_cursor`. Use `.get` so a stub without `enrolled_at` doesn't crash.
- [x] `registry/registry/enroll_challenge.py` (new, client side) -- `bytes_to_sign(org_id, challenge)` builds `b"hashwing-key-enroll v1\n"+org+b"\n"+nonce` itself, requires `challenge["nonce"]` to fullmatch `[0-9a-f]{32}` and `challenge["message"]` to equal the built bytes decoded, and raises `ValueError` otherwise. Its docstring states the B1 rule.
- [x] `registry/tests/registry_helpers.py`, `registry/tests/test_registry_cognito.py`, `registry/localstack/e2e.py` -- sign `bytes_to_sign(org, ch)` instead of `ch["message"]`.
- [x] `registry/tests/test_registry_company_keys.py` (new) -- one test per matrix row above, plus a design §10 check: after a lost enroll response, the retry is 409 `key_exists` and the list shows that fingerprint as `active_key`. Add a restore test: compromise twice, run `restore.apply_tombstones`, and `changed_at` is the first date. Follow `test_registry_restore.py` for setup.
- [x] Docs, ledger and AGENTS.md as in the Code Map.

**Acceptance Criteria:**
- Given an already compromised key, when an admin marks it compromised again later, then the response `changed_at` equals the first one and the table is unchanged.
- Given a backup restore after two compromise calls, when the restore runs, then the KEY item's `changed_at` is the first compromise time.
- Given any Python tool or test helper in `registry/` or `tools/` that enrolls a key, when the server's `message` differs from the locally built bytes, then nothing is signed.
- Given the docs, when a reader opens RUNBOOK "How pilots sign", then it isn't labelled provisional, and every new response field is in ARCHITECTURE_AWS.md.

## Implementation Notes

- Review pass: the R36 ledger cite `app.py:550` was changed to `app.py:575`, because this change shifted `withdraw_share`. That is the only ledger row edited outside R33 and R35.

- `list_keys` omits `enrolled_at`/`changed_at` on a row that lacks them (`_iso(None)` would print the current time).
- `compromise` responses add `changed_at`; the early return and the post-cancel re-read share `_compromised`.
- `bytes_to_sign` also raises `ValueError` for a missing or non-string `nonce`/`message` or an empty org.
- The verification grep for `enrolled_by` also hits the `enrolled_by_me` comparison in `list_keys` (a read, not a response field).
- Measured: `registry/tests` 136 passed, 0 skipped; repo `pytest -q` 199 passed, 30 skipped; infra 19 passing.
- Out of scope, left as is: ledger R71 and spine AD-4 still say "PROVISIONAL" (spine is owned by PR #57; R71 is not R33/R35).

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 3 findings — high 0, medium 1, low 2, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` R36's ledger cite was edited although the plan names only R33 and R35 — this change shifted `withdraw_share` from 552 to 575, so leaving `app.py:550` would make the ledger untrue. Kept the corrected cite and recorded it in Implementation Notes.
  - `[medium]` `[patch]` ARCHITECTURE_AWS.md said a restored key always gets `enrolled_by` `restore` — `restore.py:53-55` copies the tombstone's `enrolled_by`, and `_key_tomb` can store `unknown`. Rewrote the KEY row and the `enrolled_by_me` bullet to describe this.
  - `[low]` `[reject]` A caller whose sub is literally `restore` or `unknown` would see `enrolled_by_me` true — only dev tokens can carry such a sub (Cognito subs are UUIDs), the field is display-only, and the fix adds a guard.

## Design Notes

The client builder is deliberately a second, independent copy of the three-line format, not a call to `App.challenge_message`. If the client reused the server's builder, a server-side change would silently change what clients sign. The browser client (newweb, a later PR) gets its own copy for the same reason.

## Verification

**Commands:**
- `uv run --no-project --python 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q registry/tests` (from the worktree root) -- expected: all pass, 0 skipped (`build/fseal` exists)
- `uv run --no-project --python 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q` (repo root) -- expected: all pass. Skips stay at 30
- `cd infra && npm ci && npm test` -- expected: 19 passing
- `grep -rn "enrolled_by" registry/registry/app.py` -- expected: only writes, never in a response dict

## Auto Run Result

- **Summary:**
  - `POST /v1/keys/<fp>/compromised` is idempotent and race-safe, and returns `changed_at`.
  - `GET /v1/keys` pages with a cursor and returns `enrolled_by_me` and `active_key`, never a sub.
  - Python clients build the enrollment challenge bytes themselves (`enroll_challenge.bytes_to_sign`).
  - Cross-format tests cover Python, register and the `fseal` CLI.
  - The docs and the R33 and R35 evidence are updated.
- **Files changed:**
  - `registry/registry/app.py`: list_keys, compromise
  - `registry/registry/enroll_challenge.py` (new): the client builder
  - `registry/tests/test_registry_company_keys.py` (new): 24 tests
  - `registry/tests/registry_helpers.py`, `registry/tests/test_registry_cognito.py`, `registry/localstack/e2e.py`: switched to the builder
  - `docs/aws/ARCHITECTURE_AWS.md`, `docs/aws/RUNBOOK_AWS.md`
  - the ledger (R33, R35, and the R36 cite)
  - `AGENTS.md`: counts
- **Review:** 2 patched (1 medium, 1 low), 1 rejected (low: a dev-only sub collision with the placeholders), 0 deferred.
- **Follow-up review recommended:** false. 0 high and 1 medium were patched.
- **Verification:**
  - `registry/tests`: 136 passed, 0 skipped
  - repo pytest: 199 passed, 30 skipped
  - infra `npm test`: 19 passed
- **Residual risks:**
  - `e2e.py` was compiled, not run (needs Docker).
  - The newweb devserver browser suites were not run. The devserver now enrolls through the builder, and a devserver started on port 8799 enrolled orgA and orgB (201, 201). Playwright suites not run: newweb has no node_modules here.

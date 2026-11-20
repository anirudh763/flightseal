---
title: 'Option B server follow-ups: usable-key pilot slots, retire never blocked, LocalStack pilot steps, legacy restore, Retry-After, leading-space vector'
type: bugfix
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: 'ce751bad4671c8839c5cc6374411e7e4b4e5ea48'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-hashwing-aws/design-key-enrollment-option-b.md'
warnings: [multiple-goals, oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Follow-ups to merged PR #63 (Option B server half). (1) A pilot key whose authorization ended, or whose company key was replaced/compromised, stays `active` and keeps one of the 50 slots, so renewal (a new key each time) fills the cap in ~10 weeks for 10 pilots; and retire answers `pilot_keys_off` while the org is switched off, blocking revocation. (2) No LocalStack e2e covers the pilot routes. (3) No test proves pre-#60 key items/tombstones (no `kind`/`key_kind`) restore as company keys. (4) The registry never sends `Retry-After` on 429/503 nor exposes it via CORS (client half is open PR #64). (5) The shared vector file has no leading-space line case.

**Approach:** Implement the slot rule already settled in the design note §4.2 "Pilot slots" (commit ce751ba): lazy reclaim by retiring unusable active pilot keys when an enroll hits the cap, then retry once. Ungate retire. Add e2e pilot steps, legacy restore tests, Retry-After + expose headers in app and stack, and one vector case; update docs, ledger and AGENTS.md counts.

## Boundaries & Constraints

**Always:**
- Work ONLY in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt` (branch `fix/option-b-server-followups`). Never edit `/Users/anirudhyadav/flightseal`. Absolute paths. Test logs go in `<worktree>/.test-logs/` (never committed).
- Cap stays one conditional increment of `PILOT_COUNT` (`n < 50`) inside the enroll transaction. Invariant after every operation: `PILOT_COUNT.n == number of pilot KEY items with state active`.
- Reclaim = the existing retire transaction (`KEY state==active` → `retired`, `changed_at` now, tombstone via `_tomb_for`, `PILOT_COUNT` add −1), one transaction per key; a failed one is ignored. Only keys that are `active` AND (`not_after <= now` OR parent company KEY state != `active`) are reclaimed. Never touch retired/rotated/compromised keys; never change `not_after`.
- Reclaim runs only when the enroll transaction failed on the counter op; then retry the enroll transaction once (the canceled transaction did not consume the challenge). A switched-off org frees nothing (it is reversible).
- Compromise must never be refused because a reclaim/retire raced it: on transaction failure, re-read; if already compromised report it; otherwise retry once with the fresh state.
- `retire` works whatever `PILOT_KEYS_ORGS` says (remove it from `PILOT_ROUTES`); challenge and enroll stay gated.
- `Retry-After` integer seconds on every 429 and 503 the app returns: 429 `quota_exceeded` = seconds until the next UTC month starts; 503 = 30. `access-control-expose-headers: retry-after` on every response that carries `access-control-allow-origin` (allow-listed origin and the public share view). Stack `corsPreflight.exposeHeaders: ['retry-after']`. Docs must say API Gateway's own throttling 429 does not carry it (client falls back to backoff).
- Vector rule: only a line that starts exactly (column 0, no trimming) with `Authorized by company key:` counts; a leading-space line is not an authorization line → no authorization (fails closed: signer not confirmed). Keep `parse_line` unchanged.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't commit `_bmad/`, `.venv-agent`, `.test-logs/`. Don't push/merge (the parent does).

**Never:**
- No `newweb/` or `docs/console/` changes. No AWS deploy, no `cdk deploy`. `PILOT_KEYS_ORGS` set only in tests, the dev server flag and the LocalStack e2e Lambda env; the stack never sets it.
- Dev servers only on port 8799 (stop after); never 8787/4180/8794-8798. Never print any token.
- Never hand-edit `docs/aws/evidence/localstack-4.12.0.json` or `tests/fixtures/pilot-authorization.json` (scripts write them).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Renewal cycles | 10 pilots, each re-enrolls a new key every 14 days for 8 cycles (clock past old `not_after`) | every enroll 201; `n` == active count ≤ 50; old keys `retired` with tombstones | — |
| Cap of usable keys | 50 usable active pilot keys | 409 `pilot_key_limit`; nothing retired | — |
| Expired key frees slot | 50 active, one with `not_after <= now` | enroll 201; the expired one `retired`; `n == 50` | — |
| Parent replaced frees slots | 50 under company A, company rotated to C | enroll under C 201; keys under A that were reclaimed are `retired` | — |
| Reclaimed key | reclaimed fingerprint | enroll 409 `key_exists`; register 403 `key_not_active` | — |
| Racing enrolls at cap | 49 usable + 1 expired, two enrolls interleave | exactly one 201, one 409 `pilot_key_limit`; `n == 50 ==` active count | — |
| Reclaim races retire/compromise | admin retire or compromise commits between reclaim read and transaction (and the reverse for compromise) | one decrement only; compromise answers 200 compromised; `n` == active count | compromise retries once |
| Switch off | org not in list, active pilot key at cap | retire 200 and decrements; challenge/enroll still 403 `pilot_keys_off`; nothing reclaimed by switching off | — |
| Legacy restore | pre-#60 KEY item `{state, enrolled_at, enrolled_by, changed_at}` and tombstone `{kind:"key", org, ref, state, at[, enrolled_at, enrolled_by]}` (no `kind`/`key_kind`), key in backup and key absent from backup, plus a tombstone with no `state` | restore succeeds, marker written, keys `kind: company`, ACTIVE_KEY recomputed, restored app registers with the company key | — |
| Retry-After | 429 `quota_exceeded`; 503 `unavailable`; 503 `restore_pending` (incl. share view) | header present, digits; expose header with allowed origin / on share view; absent on other statuses | — |
| Leading-space vector | `line` = " " + valid line | `parse_line` → None; case marked `found: false` | — |

</intent-contract>

## Code Map

All paths relative to the worktree.

- `registry/registry/app.py` -- `PILOT_ROUTES` L52 (drop `retire`); `handle` L149-200 (add headers after status known; `out_headers` built L195-199); `register` L284 (quota 429 at L360); `pilot_enroll` L498 (transaction L520, failure map L530-537: `failed[3]` = counter); `_tomb_for` L555, `_decrement_pilots` L583, `compromise` L589, `retire` L614. Add a `_reclaim_pilot_slots(pk, now)` helper reusing the retire op list; page with `self.t.query(pk, "KEY#", PAGE, cursor)` like `restore._recompute_active_key`. Mark the full-org scan with a `ponytail:` comment (O(keys in org), only at cap). Read each distinct parent's KEY state once.
- `registry/registry/restore.py` -- expected unchanged (`_is_pilot` defaults to company; recount counts active pilots). Fix only if the legacy test fails.
- `registry/tests/test_registry_pilot_keys.py` -- helpers `_world`, `_count`, `_retire`, `_seed`, `_fp`, `_restore`; race pattern = swap `table.transact` once (see `test_racing_enrolls_never_pass_the_cap` L271, `test_retire_racing_a_compromise_reports_the_winner` L441). Update `test_switch_off_answers_pilot_keys_off...` L60 (retire no longer in the loop; add a separate off-switch retire test) and `test_identity_and_role_come_before_the_switch` if affected. `pilot_enroll` helper in `registry_helpers.py` takes `not_after`? check its signature; authorizations default 14 days from `clock.t`.
- `registry/tests/test_registry_restore.py` -- add legacy-shape tests (or in pilot keys file).
- `registry/tests/test_registry_app.py` / `test_registry_contract_fixes.py` -- existing header/CORS tests; add Retry-After tests next to the CORS ones (grep `access-control-allow-origin`). `make_app(REG_QUOTA_PER_MONTH="1")` for 429; `MemoryTable(fail=...)` for 503; `RESTORED_FROM` env for restore_pending.
- `registry/localstack/e2e.py` -- `lambda_env` (add `PILOT_KEYS_ORGS: "orgA"`), `scenarios(url, tok, table, dedupe)` (add pilot steps after the "list keys" check: pilot challenge with pilot token, enroll with authorization from `pilot_authorization.statement/encode` + `ed25519.sign(company seed)`, `not_after = int(time.time()) + 14*86400`; register with a receipt signed by the pilot seed → 201; admin retire → 200 `retired`; register again → 403 `key_not_active`; `GET /v1/keys` shows the pilot row `retired`). In `--api-url` mode record those steps `skipped` ("the stack never sets PILOT_KEYS_ORGS"). Needs an envelope minted after the epoch bump if placed after it.
- `tests/fixtures/make_pilot_authorization.py` -- add case `leading space before the line` with `line=" " + valid line`, `found: False` field (add `found` to every case: True default), reason None; extend `HOW` text: no trimming; a line with any leading character is not an authorization line. `registry/tests/test_pilot_authorization.py` -- `evaluate` returns a sentinel for not found and the test asserts `case["found"] is False` there; exclude `found: False` cases from `test_vector_through_the_registry`; keep reason-set assertion valid.
- `infra/lib/stack.ts` L210-215 `corsPreflight` (+`exposeHeaders`), `infra/test/stack.test.ts` L207-220 (assert `ExposeHeaders == ['retry-after']`).
- Docs: `docs/aws/ARCHITECTURE_AWS.md` (L77 PILOT_COUNT, L102, L164, L181-191 pilot section; add Retry-After/expose), `docs/aws/RUNBOOK_AWS.md` L122-133 (retire while off now works; expired keys no longer hold slots), `THREAT_MODEL.md` L105 area, `docs/OUTBOX.md` (server half of Retry-After; keep text true on main; PR #64 edits the same paragraph/row), spine `_bmad-output/initiative-hashwing-aws/architecture-hashwing-aws/architecture-hashwing-aws.md` AD-23 (L203: slot rule, retire ungated), ledger `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md` R71 (L125) and R74 (L128) evidence, `AGENTS.md` L29-34 measured counts.

## Tasks & Acceptance

**Execution:**
- [x] `registry/registry/app.py` -- slot reclaim + retry in `pilot_enroll`; ungate retire; compromise retry-once; Retry-After + expose headers -- matrix rows 1-8, 10.
- [x] `registry/tests/test_registry_pilot_keys.py` (+ helpers if needed) -- one test per matrix row 1-8 plus an invariant helper asserting `n == active pilot count` after each.
- [x] `registry/tests/` (restore or pilot file) -- legacy restore tests (matrix row 9), built from the real pre-#60 shapes.
- [x] `registry/tests/` (app or contract file) -- Retry-After tests (row 10).
- [x] `tests/fixtures/make_pilot_authorization.py`, regenerate `tests/fixtures/pilot-authorization.json`, `registry/tests/test_pilot_authorization.py` -- row 11.
- [x] `registry/localstack/e2e.py` -- pilot steps; then run it (Docker) and let it rewrite `docs/aws/evidence/localstack-4.12.0.json`; expected: new pilot steps pass, the two known persistence-after-restart failures remain (community-edition gap).
- [x] `infra/lib/stack.ts`, `infra/test/stack.test.ts` -- expose header.
- [x] Docs, spine, ledger, AGENTS.md -- as in the Code Map, with measured counts.

**Acceptance Criteria:**
- Given `PILOT_KEYS_ORGS` unset, when the registry suite runs, then all company-key tests pass unchanged.
- Given the LocalStack run, when it finishes, then the evidence JSON lists pilot enroll, pilot register, retire, and register-after-retire steps as pass and records the run honestly (no hand edits).
- Given the synthesised stack, when infra tests run, then the HTTP API CORS config exposes exactly `retry-after` and still allows no `*` and no credentials.

## Implementation Notes

- Reclaim and retry live in `pilot_enroll`: reclaim only when the counter condition is the failure left after the challenge, key and ACTIVE_KEY checks; the same ops are re-sent once with the same `now`. `_retire_ops` is shared by admin retire and reclaim. A pilot item with no string `company_fp` or no int `not_after` counts as unusable (as on register).
- Compromise is a two-pass loop that rebuilds every op from a fresh read; the second pass runs only for a pilot key, so company-key compromise behaves exactly as before (company-key tests unchanged). `test_compromise_of_a_pilot_key_gives_up_with_409_when_every_attempt_races` covers the remaining 409.
- Retry-After and the expose header are set once in `handle` from the final status; the 204 preflight also carries the expose header.
- Measured: registry 301 passed (0 skipped with `build/fseal`), full suite 364 passed / 30 skipped, infra 19, ctest 5/5, LocalStack 24 pass / 2 fail (the known persistence steps) / 2 blocked.

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 5 findings — high 0, medium 1, low 4, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` `infra/lib/stack.ts` pilot-route comment still said every pilot route answers `pilot_keys_off` — rewritten: challenge/enroll gated, retire never.
  - `[low]` `[patch]` `pilot_enroll` docstring omitted the cap reclaim and retry — one sentence added.
  - `[medium]` `[patch]` leading-space vector had `reason: null`, the same as valid cases, so a JS consumer reading only `reason` would fail open — reason is now `no_line` (registry_error null), `how_to_evaluate` says never treat it as valid, test asserts `no_line` iff `found` is false; JSON regenerated.
  - `[low]` `[patch]` OUTBOX said "every 503 (30)" without naming `identity_unavailable` — wording now names it (a configuration error the wait won't fix).
  - `[low]` `[reject]` e2e `pilot_steps` doesn't check the challenge status — not silent: `main` wraps the run in `except Exception` and records a `run` `blocked` step, and the committed evidence shows all five pilot steps passing.

## Design Notes

Reclaim sketch (shape only):

```python
def _reclaim_pilot_slots(self, pk, now):  # ponytail: pages every KEY# item of the org, only when the cap is hit
    parents, freed = {}, 0
    for key in all KEY# items:
        if not _is_pilot(key) or key["state"] != "active": continue
        p = key.get("company_fp")
        if p not in parents: parents[p] = (self.t.get(pk, "KEY#" + p) or {}).get("state")
        if key.get("not_after", 0) > now and parents[p] == "active": continue
        if self._transact(<retire ops for key>) is None: freed += 1
    return freed
```

## Verification

**Commands:**
- `cd <wt> && cmake -S . -B build && cmake --build build -j && ctest --test-dir build` -- expected: 5/5
- `cd <wt> && uv run --no-project --python 3.12 --with pytest python -m pytest -q registry/tests` -- expected: all pass, 0 skipped (baseline 280)
- `cd <wt> && uv run --no-project --python 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q` -- expected: 0 failed (baseline 343 passed, 30 skipped)
- `cd <wt>/infra && npm ci && npm test` -- expected: all pass (baseline 19)
- `cd <wt> && python3 tests/fixtures/make_pilot_authorization.py && git diff --exit-code tests/fixtures/pilot-authorization.json` (after committing) -- expected: no diff
- `cd <wt> && python3 tools/check_receipt_allowlist.py` and `gitleaks detect --no-banner --config .gitleaks.toml` (if gitleaks installed) -- expected: clean
- `cd <wt> && uv run --no-project --with boto3==1.43.123 python registry/localstack/e2e.py > .test-logs/e2e.log 2>&1` -- expected: pilot steps pass; only the two persistence steps fail

## Auto Run Result

- Summary: pilot slots held only by usable keys (lazy reclaim = retire, only when an enroll hits the cap, then one retry); retire works whatever `PILOT_KEYS_ORGS` says; pilot compromise retries once if a retire/reclaim races it; `Retry-After` on 429/503 plus `access-control-expose-headers: retry-after` in the app and API Gateway CORS; legacy (pre-#60) restore tests; leading-space vector (`no_line`); LocalStack pilot steps.
- Files: `registry/registry/app.py` (reclaim, ungated retire, compromise retry, Retry-After/expose), `registry/tests/test_registry_pilot_keys.py` (slots, races, switch off, legacy restore), `registry/tests/test_registry_contract_fixes.py` (Retry-After), `registry/tests/test_pilot_authorization.py` + `tests/fixtures/make_pilot_authorization.py` + `pilot-authorization.json` (27 cases), `registry/localstack/e2e.py` + evidence JSON, `infra/lib/stack.ts` + test, docs (ARCHITECTURE_AWS, RUNBOOK_AWS, THREAT_MODEL, OUTBOX, design note, spine AD-23, ledger R65/R71/R74, AGENTS.md).
- Review: 4 patches (1 medium, 3 low), 0 deferred, 1 rejected (e2e robustness: failures already recorded as `run` blocked). Follow-up review recommended: false (one medium patched, no high).
- Verification: ctest 5/5; `registry/tests` 301 passed, 0 skipped; root pytest 364 passed, 30 skipped; infra 19/19; vectors regenerate byte-equal; `check_receipt_allowlist.py` with gitleaks 0; gitleaks on 126858d..HEAD clean; LocalStack e2e 24 pass / 2 fail (known persistence-after-restart community gap) / 2 blocked (apigatewayv2, cognito-idp), all five pilot steps pass.
- Residual risks: reclaim and compromise retry only exercised on MemoryTable (LocalStack never reaches the cap); reclaim scans all KEY# items of the org (bounded by keys ever enrolled); PR #64 edits the same R74 row and OUTBOX paragraph (merge conflict expected).

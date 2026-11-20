---
title: 'R52 actor-ID scrub, R56 reversible traffic pause, R36 share list and withdraw by id'
type: feature
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '09c3af10bafdb3c1faabd00051d36ed1bdcf3c34'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - AGENTS.md
warnings: [multiple-goals, oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three ledger rows are proposed only: `enrolled_by` (a Cognito `sub`) is kept forever on KEY items and key tombstones (R52); the only budget response is deleting the stage or destroying the stack (R56); share links cannot be listed or withdrawn without the raw token, so after a reload or from another admin session they are unmanageable (R36).

**Approach:** R52: a pure `scrub(table, now)` run daily by a small scheduled Lambda and by `registry.restore` before it writes the marker. R56: a CloudFormation parameter `TrafficPaused` that sets both stage throttles (default route and the public share route) to 0 and back, synth-tested only. R36: admin-only `GET /v1/shares` over a new write-once org index item, newest first, bounded pages, plus admin-only `DELETE /v1/registrations/{rid}/shares/{share_id}`.

## Boundaries & Constraints

**Always:**
- Work only in this worktree. Scope: `registry/`, `infra/`, `docs/aws/`, `THREAT_MODEL.md`, `AGENTS.md`, the ledger and spine under `_bmad-output/initiative-hashwing-aws/`.
- The request Lambda keeps item-level actions only (no Scan). Every new route is in `app.py` ROUTES and `infra/lib/stack.ts` ROUTES with the JWT authorizer.
- No raw share token is ever stored or returned. `share_id` is the stored `sha256(token)`; it cannot open a link because the public route hashes what it is given.
- Scrub never changes a tombstone's or KEY item's `state`, `at`, `changed_at`, `kind`, fingerprint or pilot fields; only `enrolled_by` (KEY and key tombstones) and expired CHAL/ENV items. Every scrub write is conditional so it never creates an item.
- Docs never call the budget or pause a hard cap. $5 stays a target (R9). Real-AWS behaviour stays "not verified".
- Run pytest with `PYTHONDONTWRITEBYTECODE=1` and `-p no:cacheprovider` from the repo root; never leave `__pycache__`/`.pytest_cache` under `registry/`.

**Never:** no `newweb/` or `docs/console` changes; no `cdk deploy` or real AWS; no new stored actor ID (no creator on shares); no 503 `paused` Lambda setting or outbox change (AD-18's client half stays not built); no fixed-fee services; do not fix the #66 enroll items (record them only).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| scrub day 89 | KEY enrolled 89 d ago with a sub, its tombstone too | `enrolled_by` kept on both; count 0 | none |
| scrub day 90 / 91 | same at exactly 90 d and at 91 d | both become `scrubbed`; state, `at`, `changed_at` unchanged; count 2 | none |
| scrub rerun | right after a scrub | count 0, items byte-identical | none |
| scrub placeholders | `enrolled_by` `restore`/`unknown`/`scrubbed` | untouched | none |
| scrub CHAL/ENV | expired CHAL and ENV; an unexpired ENV | expired ones deleted (conditional on still expired); live ENV kept | none |
| scrub race | item removed between scan and write | no item created, not counted | ConditionFailed swallowed |
| restore of an old backup | backup KEY with a sub enrolled > 90 d ago | after `apply_tombstones`, target KEY and tombstone say `scrubbed`; marker written after scrub | scrub raises → no marker |
| list shares | admin, 3 shares (active, expired, withdrawn) | 200 `{shares:[{share_id, registration_id, state, created_at, expires_at}], next_cursor}` newest first | none |
| list paging | `limit=1` then `cursor` | one row per page, no repeats, last page null cursor (an exactly full page may return a cursor to an empty page) | bad limit/cursor → 400 `bad_request` |
| list access | pilot role; other org; no token | 403 `forbidden`; other org sees none of orgA's; 401 | none |
| list CORS | `GET /v1/shares` | no `access-control-allow-origin: *` | none |
| list stub | share created after a backup, withdrawn, restored | listed `withdrawn`, `created_at` null | none |
| withdraw by id | admin, own org, matching rid | 200 `{withdrawn: true}`; link then identical 404; tombstone written; repeat 200 | wrong org / wrong rid / unknown id → identical 404; malformed → 404 |
| pause synth | `TrafficPaused` default `false` | both throttles `Fn::If` [IsPaused, 0, 2] / [.., 0, 5]; parameter AllowedValues `false`,`true` | none |

</intent-contract>

## Code Map

- `registry/registry/app.py` -- ROUTES (:34-51), `create_share` (:706, 3-op transaction at :728), `withdraw_share` (:764, the withdraw ops to reuse), `list_registrations` (:376, limit/cursor validation to mirror), `list_keys` (:582, `enrolled_by_me` at :593), `_share_view` (:698, expired-on-read rule), `SHARE_VIEW` (:57: only GET under `/v1/shares/` gets CORS `*`; `GET /v1/shares` with no trailing segment must not match it).
- `registry/registry/store.py` -- `Table.query(pk, prefix, limit, start)` for MemoryTable (:109) and DynamoTable (:271): add `reverse=False` (DynamoDB `ScanIndexForward=False`; memory: sort descending, `sk < start`). `scan(pk_prefix)` exists on both.
- `registry/registry/restore.py` -- `apply_tombstones` share-stub branch (:48-52) also writes the index item keyed by `withdrawn_at`; call `scrub.scrub(target, now)` just before the SYSTEM/RESTORE put (:78).
- `registry/registry/scrub.py` (new) -- `PLACEHOLDERS = {"scrubbed","restore","unknown"}`, `RETAIN = 90*86400`, `scrub(table, now) -> int`, Lambda `handler(event, ctx)` reading `TABLE_NAME`, printing only `{"scrubbed": n}`. Handler string `registry.scrub.handler` (the asset test allows only `handler.py` and `registry/*.py`).
- `registry/tests/` -- add `test_registry_scrub.py` and `test_registry_shares_list.py` (import from `registry_helpers`: `make_app`, `call`, `token`, `enroll`, `register`, `share`, `line`, `SEED_A`, `Clock`, `T0`). Existing restore test `test_restore_reapplies_tombstones_then_opens` asserts `== 4` tombstones; keep it true.
- `infra/lib/stack.ts` -- ROUTES (:87-105), `HttpStage` throttle (:221-226) and the public RouteSettings override (:238-242), log group pattern (:148), `served.grant` (:164). Add `aws_events`, `aws_events_targets`.
- `infra/test/stack.test.ts` -- will break: Lambda count 1 (:28), first-function destructure (:37), single IAM policy (:111-112), throttle `deepEqual`s (:145-151, :195-205), route count 16 (:155). Select functions by `Handler`; assert IAM per role.
- `registry/localstack/e2e.py` -- `scenarios()` (:229); `make_share` (:93). Add list + withdraw-by-id checks (exercises `ScanIndexForward` on real DynamoDB API).
- Docs: `docs/aws/ARCHITECTURE_AWS.md` (Shape diagram :14-36, IAM row :45, Stored table :73-87, Shares :202, PROPOSED table :287-300), `docs/aws/RUNBOOK_AWS.md` "When the budget alert fires" (:141-161), `docs/aws/COST.md` (:6-8, "12 signed-in routes" :145, :154-155), `docs/aws/COVERAGE.md` (:62), `THREAT_MODEL.md:113`, spine AD-2 (:71 "decided, not built"), AD-9 (:113 share management), AD-18 (:167), ledger rows R36, R50, R52, R56 and a new open-items block after line 184.

## Tasks & Acceptance

**Execution:**
- [ ] `registry/registry/store.py` -- add `reverse` to `query` in protocol and both adapters -- newest-first list.
- [ ] `registry/registry/scrub.py` -- new: KEY items (`ORG#` scan, SK `KEY#`) and key tombstones (`TOMB#` scan, `kind == "key"`) whose `enrolled_by` is not a placeholder and `now - enrolled_at >= RETAIN` (missing `enrolled_at` counts as 0) get `enrolled_by = "scrubbed"` with cond `[("exists",), ("eq","enrolled_by",old)]`; CHAL#/ENV# items with `expires_at <= now` are deleted with cond `[("lt","expires_at",now+1)]`; ConditionFailed is skipped; return the count. Lambda handler as in Code Map.
- [ ] `registry/registry/restore.py` -- scrub target before marker; stub branch writes `ORG#<org> / SHARE#<withdrawn_at:012d>#<hash>` with `rid` when the tombstone has one.
- [ ] `registry/registry/app.py` -- `list_keys`: `enrolled_by_me` false for placeholders. `create_share` transaction gains a 4th op: put `ORG#<org> / SHARE#<now:012d>#<h>` `{rid}` cond not_exists (keep failed-index handling for ops 0 and 2 correct). New `list_shares` (ADMIN, `GET /v1/shares`, `limit` 1..50 default 50 same regex as registrations, `cursor` = 12 digits + 64 hex → SK `SHARE#<12>#<64>`, else 400): query with `reverse=True`, read each row's `SHARE#<h>` item (state via the `_share_view` rule; missing item or other org → skip), `created_at`/`expires_at` ISO or null; `next_cursor` from the last SK. New `withdraw_share_by_id` (ADMIN, `DELETE /v1/registrations/([0-9a-f]{32})/shares/([0-9a-f]{64})`): SHARE item must exist with `org == caller` and `rid == path rid` and `ORG#<org>/REG#<rid>` must exist, else identical 404; already withdrawn → 200; else one transaction: update SHARE (cond eq org, eq rid) + share tombstone (same shape as `withdraw_share`) + check REG exists; failure → 409 `conflict`. Return `{withdrawn: true}`. Comment the per-row GetItem (`ponytail:` up to 50 reads a page; BatchGetItem if it matters).
- [ ] `infra/lib/stack.ts` -- ROUTES add `GET /v1/shares` and `DELETE /v1/registrations/{id}/shares/{shareId}`. `CfnParameter TrafficPaused` (String, AllowedValues false/true, default false) + `CfnCondition IsPaused`; stage `DefaultRouteSettings` and the public RouteSettings use `Fn.conditionIf(IsPaused, 0, value)` for rate and burst. Scrub function: same asset, handler `registry.scrub.handler`, python3.12 arm64 128 MB 60 s, own 7-day log group, env `TABLE_NAME` only, `served.grant(scrub, 'dynamodb:Scan','dynamodb:UpdateItem','dynamodb:DeleteItem')`, `events.Rule` `Schedule.rate(Duration.days(1))`.
- [ ] `infra/test/stack.test.ts` -- fix the broken assertions; new: 2 Lambda functions (request + scrub), request role has no Scan, scrub role only Scan/UpdateItem/DeleteItem on the table ARN, daily rule targets scrub, route count 18 all JWT but the public one, `TrafficPaused` parameter and both throttles' `Fn::If` with 0.
- [ ] `registry/tests/test_registry_scrub.py`, `registry/tests/test_registry_shares_list.py` -- cover every matrix row.
- [ ] `registry/localstack/e2e.py` -- list shares newest first (2 shares, `limit=1` paging) and withdraw by id then the link 404.
- [ ] Docs and ledger -- as in Code Map; move the two built routes out of PROPOSED (amend: ADMIN not any member; index item write-once key+rid, state read from SHARE; withdraw conditions are SHARE.org/rid match + REG exists); AD-2 scrub built; AD-18 mechanism = parameter switch, operator step, unverified; ledger statuses honest; #66 open items; re-check every `app.py:` and `test_registry_app.py:` cite against final files; AGENTS.md counts.

**Acceptance Criteria:**
- Given an admin token, when `GET /v1/shares` then `DELETE /v1/registrations/{rid}/shares/{share_id}`, then the link is the identical 404 and a second list shows it withdrawn.
- Given `cd infra && npm test`, then every test passes with the new counts.
- Given the LocalStack run, then the new list and withdraw-by-id checks pass and the evidence file records them honestly.

## Implementation Notes

- The implementing subagent was cut off twice by host sleep; the main session finished the infra tests, e2e checks, docs, ledger and AGENTS.md itself.
- Restore tests now pass `clock=Clock()` to `apply_tombstones`, so the scrub inside a restore uses the test clock rather than wall time.
- Pause is a stack parameter (`TrafficPaused`), as the Design Notes say; no Lambda calls UpdateStage.
- Withdraw by id drops the design's "hash in `share_hashes` or index" condition: `SHARE.org`/`SHARE.rid` plus a REG check already bind it (spine AD-9 amended).

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 4 findings — high 0, medium 1, low 3, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` Ledger R36 row and the #66 block still held `@..@` cite placeholders — filled from the final files (app.py 51-52, 529, 549-563, 624-643, 751, 796-820, 822-840; store.py 223-234), with every other `app.py:`, `test_registry_app.py:`, `stack.ts:`, `stack.test.ts:` and `restore.py:` cite in the ledger re-checked (R33, R35, R37, R38, R50, R53, R72, R28, R30, R59; R51 left as its baseline evidence).
  - `[low]` `[patch]` R50 cited `test_registry_app.py:318` for `test_restore_pending_closes_every_route` (now 346) — fixed in the same pass.
  - `[medium]` `[patch]` LocalStack `share_steps` could flake: `share2` from earlier in `scenarios` could share a creation second with `older` and sort by hash — added a 1.1 s sleep before `older`; the e2e re-ran with the 3 new checks passing.
  - `[low]` `[patch]` A key-state change could copy a pre-scrub `enrolled_by` from a KEY item read before a racing scrub back into the tombstone — `_tomb_for` now writes `scrubbed` when `now - enrolled_at >= 90 days`; new test `test_a_state_change_on_an_old_key_never_writes_the_sub_back_into_its_tombstone` fails without the fix and passes with it; ARCHITECTURE_AWS "Actor IDs" says so.

## Design Notes

Pause as a stack parameter, not a Lambda calling UpdateStage: an out-of-band UpdateStage is drift a no-op deploy never undoes, while `cdk deploy --parameters TrafficPaused=true|false` is tracked and reversible, and later plain deploys keep the previous parameter value. The budget still only emails; the operator runs the pause. List and withdraw-by-id are ADMIN (owner brief), so the design table's "any member" is amended.

## Verification

**Commands:**
- `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider registry/tests` -- all pass, 0 skipped with `build/fseal` (build it with `cmake -S . -B build && cmake --build build -j` if missing).
- `PYTHONDONTWRITEBYTECODE=1 uv run --no-project --python 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q -p no:cacheprovider` -- all pass.
- `find registry -name __pycache__ -o -name .pytest_cache` -- prints nothing, then `cd infra && npm ci && npm test` -- all pass.
- `uv run --no-project --with boto3==1.43.123 python registry/localstack/e2e.py` -- all checks pass; never print a token.

## Auto Run Result

Status: built

- **Summary:** R52 scrub (`registry/registry/scrub.py`, daily `ScrubFunction`, run by `registry.restore` before the marker); R56 `TrafficPaused` parameter zeroing both stage throttles (synth only); R36 admin-only `GET /v1/shares` over a write-once org index and `DELETE /v1/registrations/{rid}/shares/{share_id}`; #66 open items recorded; ledger cites re-checked.
- **Files:** `registry/registry/{app,store,restore,scrub}.py`; `registry/tests/test_registry_{scrub,shares_list}.py` (new) and `clock=Clock()` in five restore-calling test files; `registry/localstack/e2e.py` (+3 checks) and its evidence JSON; `infra/lib/stack.ts`, `infra/test/stack.test.ts`; `docs/aws/{ARCHITECTURE_AWS,COST,COVERAGE,RUNBOOK_AWS}.md`, `THREAT_MODEL.md`; spine AD-2/AD-9/AD-18; ledger R36/R50/R52/R56 and open items; `AGENTS.md` counts.
- **Review:** 4 findings, 4 patched (1 medium, 3 low), 0 deferred, 0 rejected.
- **Follow-up review recommended:** false (no high, one medium patched).
- **Verification:** root pytest 397 passed, 30 skipped; `registry/tests` 334 passed; `infra` npm test 21/21; LocalStack e2e 27 pass / 2 fail / 2 blocked (the fails and blocks are the pre-existing persistence and HTTP API/Cognito rows; exit 1 as on main). No `__pycache__`/`.pytest_cache` under `registry/`.
- **Residual risks:** nothing is verified on AWS (HTTP API throttle 0 behaviour and billing, the scheduled scrub, `ScanIndexForward` on real DynamoDB is LocalStack only); the share list makes up to 50 GetItems a page; shares created before this change have no index item (no deployment exists, so only disposable test data).

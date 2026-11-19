---
title: 'Option B server half: pilot authorization format, /v1/pilot-keys, register checks, restore (design PR 3, both switches off)'
type: feature
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '2ead46684154445f6056e61ed2780a196bd9a955'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/initiative-hashwing-aws/design-key-enrollment-option-b.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Signing Option B (pilot keys authorized by the company key) is designed (design §3 PR 3, §4.2, §5, §8–§10; spine AD-23, AD-24) but has no server half. The browser half needs a stable authorization format with shared test vectors, the `/v1/pilot-keys` routes, register checks and restore support to build on.

**Approach:** Add a Python authorization module plus a shared JSON vector file, the three pilot-key routes and the pilot register checks in `registry/registry/app.py` behind the operator switch `PILOT_KEYS_ORGS` (unset/empty = off everywhere), key kinds in `restore.py`, the routes in `infra/lib/stack.ts`, and the matching docs. Nothing turns either switch on outside tests and the dev server.

## Boundaries & Constraints

**Always:**
- Work ONLY in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt` (branch `feat/option-b-server`). Never edit `/Users/anirudhyadav/flightseal`. Absolute paths in every command.
- Switch off = 403 `pilot_keys_off` on all three new routes, checked after identity and before schema (spine request order). Off also means a pilot KEY item answers 403 `key_not_active` on register. The company-key paths behave exactly as today.
- `PILOT_KEYS_ORGS`: exact comma list, each entry validated with `identity.ORG_ID`; unset, empty, whitespace, invalid entries and `*` mean off (no wildcard). Read from env at `App.__init__`. Not settable by any route; the stack never sets it.
- Pilot-ness of a KEY item or key tombstone: `kind == "pilot"` OR `company_fp` present OR `not_after` present. Missing `kind` = `company`.
- Key tombstones already use `kind: "key"` as the TOMB kind, so the key's kind is stored on tombstones as `key_kind` (plus `company_fp`, `not_after` for pilot keys). KEY and CHAL items use `kind`. Document this naming in ARCHITECTURE_AWS.md.
- Every transaction names each item at most once (DynamoDB rejects duplicates). Add a guard in `MemoryTable.transact` that raises on a duplicate key so tests catch it.
- Revocation is never blocked by the counter: `PILOT_COUNT` decrement (retire, compromise of an active pilot key) is `add {n: -1}` with no floor condition; the KEY update carries `("eq","state","active")`.
- Store `not_after` as epoch seconds (int). Compare with the registry clock only, never with a receipt or sender time.
- No public key is stored (AD-2). No new IAM actions (ConditionCheckItem is already granted).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not commit `_bmad/` or `.venv-agent`. Do not push, merge or open a PR (the parent does that).

**Never:**
- No `newweb/` or `docs/console/` changes (browser half is a later PR). No AWS deploy, no `cdk deploy`.
- No new share-view field and no server-side recipient compromised list: the "removed or marked compromised" recipient signal is a follow-up per the design's "Defaults taken 2026-11-19" #2 and AD-9 needs an amendment first; the 500-entry compromised list is the recipient's browser store. Record both caps as constants in the vector JSON and docs only.
- Don't use dev servers on ports 8787/4180/8795/8796/8797/8798; only 8799 if one is needed, and stop it after.
- Don't print any token.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Switch off | org not in `PILOT_KEYS_ORGS` (or var unset); any of the 3 pilot routes, even with a bad body | 403 `pilot_keys_off`, nothing written | before schema |
| Pilot challenge | member, org on | 200 `{nonce, expires_at, message}`, message `hashwing-pilot-key-enroll v1\n<org>\n<nonce>`, CHAL item `kind: pilot` | — |
| Pilot enroll happy | valid challenge sig by pilot key, authorization by org's ACTIVE_KEY, `not_after` in (now, now+30d] | 201 `{key_fingerprint, kind:"pilot", state:"active", company_fingerprint, not_after}`; KEY item with kind/company_fp/not_after; key tombstone with key_kind/company_fp/not_after; `PILOT_COUNT.n` +1 | — |
| Cross-kind challenge | company-kind nonce on pilot enroll (correct pilot prefix signed), or pilot-kind nonce on `POST /v1/keys` (correct company prefix signed) | 400 `bad_challenge`, nothing written | — |
| Bad challenge sig / weak pilot key | | 422 `bad_signature` | before authorization |
| Bad authorization | unparsable, non-canonical, `pilot_key` ≠ `public_key`, sig not by `company_key`, pilot_key weak, pilot_key == company_key | 422 `bad_authorization` | — |
| Authorization time | `not_after` ≤ now, or > now + 30 days | 422 `authorization_expired` | — |
| Company key not active | `company_key` is not this org's ACTIVE_KEY (rotated, compromised, other org's, none) or ACTIVE_KEY changes during the transaction | 422 `company_key_not_active` | condition check in transaction |
| Duplicate | fingerprint ever seen in org, any state (incl. retired, company) | 409 `key_exists` (only after both signatures pass) | — |
| Cap | 50 active pilot keys; concurrent enrolls | 409 `pilot_key_limit`; never above 50 | counter condition `n < 50` in transaction |
| Register pilot ok | org on, pilot active, not_after > now, parent company KEY active | 201 | — |
| Register pilot refused | org off, retired, compromised, not_after ≤ now, parent rotated/compromised, retire or parent change committed during the registration transaction | 403 `key_not_active`, no REG item | ConditionCheck on pilot KEY (state active, not_after > now) and parent KEY (state active) inside the registration transaction |
| Retire | admin, active pilot key | 200 `{key_fingerprint, state:"retired", changed_at}`; tombstone; count −1. Already retired/compromised: 200 stored state, no write. Unknown, other org, or company key: 404 `not_found`. Member: 403 `forbidden` | |
| Compromise pilot | admin, existing route | unchanged response; active pilot key also decrements count; tombstone carries pilot fields | |
| List keys | member | rows gain `kind`; pilot rows gain `company_fingerprint`, `not_after` (ISO); response gains `pilot_keys` (bool) | |
| Restore | backup + tombstones with several active pilot keys and a company rotation | ACTIVE_KEY from company keys only; pilot keys stay active with kind/company_fp/not_after; state = max rank of (tomb, target) with order active<rotated<retired<compromised; PILOT_COUNT recomputed from active pilot keys; tomb/KEY kind disagreement → raises, no marker | |
| Cross-format | same key signs a receipt, a company challenge, a pilot challenge, an authorization | each verifies only as itself: `receipt.signature_ok`, register route, `fseal verify` CLI, `POST /v1/keys`, `POST /v1/pilot-keys` (challenge sig and authorization sig) | |
| Vectors | `tests/fixtures/pilot-authorization.json` | every case gives its expected result in Python; file equals what the generator writes | |

</intent-contract>

## Code Map

All paths relative to the worktree.

- `registry/registry/app.py` -- ROUTES (L32), `register` (L264: key read L294, transaction L305, failure mapping after it), `challenge_message`/`challenge`/`enroll` (L406-451), `_key_tomb` (L454), `list_keys` (L462), `compromise` (L480). Follow the existing patterns: `_fields`, `_str`, `_transact` returns per-op reasons, `HttpError`, `_iso`. `MAX_BODY` 4096 is enough.
- `registry/registry/enroll_challenge.py` -- client-side builder; add the pilot prefix (e.g. `bytes_to_sign(org, challenge, kind="company")`), same B1 rules.
- `registry/registry/ed25519.py` -- factor the small-order/non-canonical check out of `verify` into a public helper (e.g. `weak_key(pub)`), `verify` keeps calling it.
- `registry/registry/receipt.py` -- unchanged; `fingerprint`, `signed_message`, `signature_ok` used by tests.
- `registry/registry/restore.py` -- key tombstone branch (L52-60) and `_recompute_active_key` (L71).
- `registry/registry/store.py` -- `MemoryTable.transact` (duplicate-key guard). DynamoDB adapter already supports `check`, `gt`, negative `add`.
- `registry/devserver/server.py` -- `reset()` L68 builds the app via `rh.make_app(CORS_ORIGINS=...)`; add an optional `--pilot-keys-orgs` arg (default off) passed as `PILOT_KEYS_ORGS`, for the later browser builder. DEV ONLY.
- `registry/tests/registry_helpers.py` -- `make_app(**env)`, `call`, `token`, `enroll`, `register`, `line`, `fseal_bin`, `fseal_receipts`; add pilot helpers (pilot challenge + enroll with authorization) here.
- `registry/tests/test_registry_company_keys.py` -- exact key-set assertions in `test_list_keys_says_which_is_active...` and `test_list_keys_exactly_full_page...` change (rows gain `kind`, response gains `pilot_keys`). Cross-format tests at the end are the model for the three-way test and the CLI test.
- `registry/tests/test_registry_app.py` L60 `test_no_route_accepts_private_key_material` -- extend to the pilot routes with the org switched on.
- `tests/fixtures/make_ed25519_weak_keys.py` + `ed25519-weak-keys.json` + `tests/test_weak_keys.py` -- pattern for a generator script plus JSON plus a test.
- `infra/lib/stack.ts` ROUTES (L87), `infra/test/stack.test.ts` (route count 13 at L152, env-var exact list at L38, IAM at L107).
- Docs: `docs/aws/ARCHITECTURE_AWS.md` (Stored table L73-84, Requests L92, Company keys L124, restore L240), `THREAT_MODEL.md`, `docs/aws/RUNBOOK_AWS.md` ("How pilots sign" L86), `AGENTS.md` test counts, ledger R71 row in `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md` L125, spine AD-2/AD-23/AD-24 "not built" wording in `_bmad-output/initiative-hashwing-aws/architecture-hashwing-aws/architecture-hashwing-aws.md`.

## Tasks & Acceptance

**Execution:**
- [ ] `registry/registry/ed25519.py` -- expose the weak-key check -- the authorization check must refuse a weak `pilot_key` that a valid company signature would otherwise pass.
- [ ] `registry/registry/pilot_authorization.py` (new) -- `PREFIX = "hashwing-pilot-authorization v1"`, `DEFAULT_DAYS = 14`, `MAX_DAYS = 30`; `statement(pilot_key, company_key, not_after) -> bytes` (four lines joined by `\n`, no trailing newline; `not_after` as `YYYY-MM-DDTHH:MM:SSZ`); `encode` (base64url, no padding); `check(authorization_b64, sig_hex, pilot_key, company_key, now) -> (reason or None, parsed)` where reasons are `malformed`, `weak_pilot_key`, `same_key`, `not_pilot_key`, `not_company_key`, `bad_signature`, `ended`, `too_long`; and `parse_line(message)` for the receipt-message form `Authorized by company key: <b64>.<128 hex>` (zero lines → none, more than one → malformed). Canonical check = decode, parse, rebuild, byte-compare (covers padding, uppercase hex, trailing newline, extra lines, second 60). Map to registry codes: malformed/weak/same/not_pilot_key/bad_signature → `bad_authorization`; ended/too_long → `authorization_expired`; not_company_key → `company_key_not_active`.
- [ ] `tests/fixtures/make_pilot_authorization.py` + `tests/fixtures/pilot-authorization.json` (new) -- deterministic vectors from fixed seeds, each with `name`, `authorization`, `authorization_sig`, `line`, `signed_text`, `pilot_key`, `company_key`, `now`, `reason`, `registry_error`. Cases: valid; valid at exactly 30 days; expired (not_after == now and < now); too long (> 30 days); wrong org (company_key ≠ expected); tampered (one changed byte in statement; changed sig); wrong prefix (receipt prefix, enroll prefix, v2); trailing newline; padding; uppercase hex; pilot_key mismatch; signed by another key; weak pilot key; pilot == company; two lines in one message. Top level also carries `prefix`, `default_days`, `max_days`, `pilot_key_cap: 50`, `recipient_compromised_cap: 500`.
- [ ] `registry/tests/test_pilot_authorization.py` (new) -- every vector gives its `reason`/`registry_error`; the JSON equals the generator's output; three-way cross-format matrix with ONE key (receipt / company challenge / pilot challenge / authorization: only the diagonal verifies) through `receipt.signature_ok`, the register route, `POST /v1/keys`, `POST /v1/pilot-keys` and `fseal verify` (skip if `build/fseal` missing, like the existing CLI test).
- [ ] `registry/registry/app.py` -- routes `GET /v1/pilot-keys/challenge` (ANY), `POST /v1/pilot-keys` (ANY), `POST /v1/pilot-keys/<fp>/retire` (ADMIN); `PILOT_CAP = 50`; challenge items gain `kind`; company enroll accepts `kind` missing or `company`; pilot enroll order: switch 403 → schema 400 (`{public_key, nonce, signature, authorization, authorization_sig}`) → challenge sig 422 → authorization 422 → company key active 422 → `key_exists` 409 → transaction [delete CHAL (exists, sub, expires_at > now, kind pilot); put KEY not_exists; put tombstone; update PILOT_COUNT add 1 with `("or",("missing","n"),("lt","n",50))`; check ACTIVE_KEY `fp == company_fp`] with each failed index mapped to its code; register adds pilot checks and two ConditionChecks and maps their failure to `key_not_active`; retire; compromise decrements for an active pilot key; `_key_tomb` takes the key's kind and pilot fields as required args at every call site; `list_keys` additions.
- [ ] `registry/registry/restore.py` -- per the matrix Restore row.
- [ ] `registry/registry/store.py` -- duplicate-key guard in `MemoryTable.transact`.
- [ ] `registry/registry/enroll_challenge.py`, `registry/devserver/server.py`, `registry/tests/registry_helpers.py` -- as in the Code Map.
- [ ] `registry/tests/test_registry_pilot_keys.py` (new) -- one test per matrix row (switch, routes, register, retire, compromise, list, restore, cap under racing transactions, a retire committed during a registration blocks it, org switched off with an active pilot key → `key_not_active`), plus edits in `test_registry_company_keys.py` and `test_registry_app.py`.
- [ ] `infra/lib/stack.ts`, `infra/test/stack.test.ts` -- 3 routes (JWT authorizer), count 16, assert `PILOT_KEYS_ORGS` absent from the template and IAM actions unchanged.
- [ ] Docs -- ARCHITECTURE_AWS.md (stored fields incl. `PILOT_COUNT`, `key_kind`, CHAL `kind`; a "Pilot keys (Option B, off by default)" section; request order; config `PILOT_KEYS_ORGS`; restore), THREAT_MODEL.md rows from design §8, RUNBOOK_AWS.md (switch on/off, renewal = new key, expired pilot keys stay `active` and count toward 50 until retired, restore), spine AD-2/AD-23/AD-24 status "server half built; browser half open", ledger R71 evidence (status stays honest: browser half open), AGENTS.md measured counts.

**Acceptance Criteria:**
- Given `PILOT_KEYS_ORGS` unset, when the full registry suite runs, then every pre-existing company-key test still passes unchanged except the deliberate list-shape additions.
- Given the vector JSON, when a later JS implementation loads it, then each case carries everything needed (inputs, clock, expected reason) without reading Python.
- Given the synthesised stack, when infra tests run, then 16 routes exist, all but the share view use the JWT authorizer, and no `PILOT_KEYS_ORGS` appears.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-11-19 — Review pass
- verdicts: 3 findings — high 0, medium 2, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` THREAT_MODEL row said a rogue admin can't mint a pilot signer at the registry; an admin can replace ACTIVE_KEY via `POST /v1/keys` + `confirm_replace` and then authorize pilots — row rewritten: refused at the recipient (pin), not at the registry; browser half not built.
  - `[medium]` `[patch]` "standard base64 alphabet" vector fell back to a trailing `+` (length change) — a canonical statement's base64url can never contain `-`/`_` (no `>`, `?`, `~` in it), so replaced by two same-length cases with `+` and `/`; JSON regenerated (26 cases).
  - `[low]` `[patch]` `test_no_route_accepts_private_key_material` ran only with the switch on — now runs with the switch unset and on (pilot routes only when on).

## Design Notes

Tests use the existing `Clock`/`make_app(**env)` helpers; `make_app(PILOT_KEYS_ORGS="orgA")` switches orgA on. Race tests follow `test_register_racing_a_compromise_is_refused_and_writes_nothing` (swap `table.transact` once). The cap race: pre-set `PILOT_COUNT.n = 49`, then run two enrolls whose transactions interleave via that hook; exactly one 201.

## Verification

**Commands:**
- `cd /private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt && cmake --build build -j && uv run --no-project --python 3.12 --with pytest python -m pytest -q registry/tests` -- expected: all pass, none skipped (baseline 137 passed)
- `cd /private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt && uv run --no-project --python 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q` -- expected: baseline 200 passed, 30 skipped, plus any new root tests, 0 failed
- `cd /private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt/infra && npm ci && npm test` -- expected: all pass
- `cd /private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt && python3 tests/fixtures/make_pilot_authorization.py && git diff --exit-code tests/fixtures/pilot-authorization.json` -- expected: no diff

## Auto Run Result

- Summary: Option B server half: `pilot_authorization.py` + shared vectors (26 cases), `/v1/pilot-keys` challenge/enroll/retire behind `PILOT_KEYS_ORGS` (off unless set; stack never sets it), pilot register checks inside the registration transaction, compromise/retire decrement `PILOT_COUNT`, restore keeps kinds, recounts `PILOT_COUNT`, rebuilds ACTIVE_KEY from company keys only, refuses kind disagreements; infra routes 16; docs and ledger.
- Review: 3 patches applied (2 medium, 1 low), 0 deferred, 0 rejected. Follow-up review recommended: true — two medium entries patched; the named unverified risk is the new transactions never having run against DynamoDB/LocalStack (only MemoryTable).
- Verification (after merging origin/main f2583ef): `registry/tests` 280 passed, 0 skipped; root pytest 343 passed, 30 skipped; `ctest` 5/5; `infra` npm test 19/19; vector generator reproduces the JSON byte for byte.
- Residual risks: real DynamoDB transactions not exercised; expired pilot keys stay `active` and count toward 50 until retired; recipient signal and the 500-entry recipient list are browser/follow-up work.


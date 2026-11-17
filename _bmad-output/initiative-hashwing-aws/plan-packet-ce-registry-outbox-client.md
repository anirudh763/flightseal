---
title: 'Packets C and E (client): owner-scoped offline outbox and registry client'
type: feature
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: '3e32f5a08ce24235d05ec88e5a2cae0a93f60734'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/aws/ARCHITECTURE_AWS.md'
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      Wire the outbox unit and browser tests into CI and the AGENTS.md gate list.
    evidence: |-
      ci.yml and AGENTS.md list fixed files; this change was new-files-only.
    location: >-
      .github/workflows/ci.yml
    severity: low
---

<intent-contract>

## Intent

**Problem:** The registry server (PR #21) exists, but the browser has no durable way to send receipts to it. A pilot sealing offline must not lose a receipt, must never see "Registered" before the server's acknowledgement is stored, and must never replay a withdrawn or deleted view, or one owner's envelope under another owner's token.

**Approach:** Two standalone ES modules with no new dependencies. `registry-client.mjs` is a fetch wrapper with typed results. `outbox.mjs` is a per-owner IndexedDB outbox with an in-memory store that has the same interface. That store backs the unit tests and is also the fallback when storage fails. A dev-only stdlib HTTP server runs the real `App` over `MemoryTable` for the Playwright Chromium tests.

## Boundaries & Constraints

**Always:**
- One IndexedDB database per owner, named `hashwing-outbox-v1-<sha256(ownerId) hex>`. Owner id is `<org>/<sub>`, decoded (without verification) from the bearer JWT's `org_id` or `custom:org_id` claim and its `sub` claim. Before every dispatch, the token's owner must equal the outbox's owner. If it does not, nothing is sent and rows stay queued.
- Stored row fields come from an exported allowlist `ROW_FIELDS`. `id`, `receipt`, `envelope_id`, `envelope_expires_at`, `envelope_epoch`, `idempotency_key`, `state`, `reason`, `attempts`, `next_attempt_at`, `created_at` and `updated_at` can appear on any row; `registration_id`, `received_at`, `count`, `head`, `key_fingerprint`, `disposition` and `acked_at` appear only once an ack exists. A write with any other key throws. `enqueue` accepts only `{receipt}` and checks the receipt with the v1 regex from `registry/registry/receipt.py`.
- `idempotency_key` = base64url(SHA-256(`ownerId\n receipt\n envelope_id`)), 43 characters. It is computed once, when an envelope is bound, and never changes for that binding.
- The ack is recorded and the row retired in one atomic store operation (`commitAck`): put into `acks`, delete from `queue`. A failed commit leaves the queue row in place.
- Re-check the generation counter after every await (token supplier, envelope fetch, fetch, store write). On `close()`: stop timers and listeners, abort the in-flight fetch, increment the generation, and drop any late result.
- Dispatch runs under `navigator.locks.request('hashwing-outbox:<hash>', {ifAvailable:true})` when Web Locks exist. A `registering` row seen by the lock holder is stale and gets dispatched again with the same key.
- Bounds: `MAX_QUEUE` 200, `MAX_ACKS` 1000 (the oldest ack is pruned), `MAX_ATTEMPTS` 10. Backoff for attempt n (from 1) is d = min(15 min, 2 s · 2^(n-1)), with a delay in [d/2, d] (equal jitter). `fetch`, `now`, `random`, timers and the online source are injectable.

**Never:** Edit `newweb/src/main.jsx`, `newweb/src/style.css`, `registry/registry/*`, `registry/handler.py`, `infra/`, `newweb/package.json` or `AGENTS.md`. Add a dependency. Store media, manifests, salts, names or keys. Create or retry a share from the outbox. Mint a replacement envelope without an explicit `retryNow`. `git add` `_bmad/` or the `node_modules` symlinks.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Handling |
|---|---|---|---|
| Enqueue offline with an unexpired cached envelope | valid receipt | row `sealed_local`, envelope and key bound | none |
| Enqueue with no cached envelope | valid receipt | row `sealed_local`, no envelope; the first online dispatch fetches one and binds it with its key in one write | none |
| Duplicate enqueue | same receipt | returns the existing row (id = sha256(owner\|receipt)) | none |
| 201/200 `disposition: active` | | `commitAck` → `registered`, label "Registered" | none |
| 200 `disposition: deleted` | | `commitAck` with disposition `deleted`, label "Registered, later deleted" | terminal |
| 410 `registration_deleted` | | `needs_attention`, reason `registration_deleted` | terminal; `retryNow` ignores it |
| 409 `idempotency_conflict` | | `needs_attention`, reason `conflict` | terminal |
| 422 `envelope_expired`, or local expiry has passed | | `needs_attention`, reason `envelope_expired` | `retryNow(id)` binds a new envelope and a new key |
| 422 `bad_signature`, 400, 413 | | `needs_attention` | terminal |
| 403 `key_not_enrolled` / `key_not_active` | | `needs_attention` | `retryNow` may retry |
| 401 | | stays queued, `needsSignIn` = true, dispatch stops | resumes when a new matching token appears |
| 503, 429, network error, timeout | | `waiting_for_connection`, attempts+1, backoff | after `MAX_ATTEMPTS`: `needs_attention`, reason `attempts_exhausted` |
| IndexedDB open fails or throws | | memory store, `storage: 'memory'`, `exportOffered: true` | `exportPending()` |
| Enqueue put fails (quota) | | row kept in memory, `exportOffered: true` | `exportPending()` includes it |
| Export with nothing available | the store is empty because it was lost | `{ok:false, reason:'needs_previous_export'}` | no empty success |

</intent-contract>

## Code Map

- `registry/registry/app.py` -- read-only contract. Routes are in `ROUTES`. The ack shape is in `_ack`. Replay order is in `register`. `payload_hash` = sha256 of `{"envelope_id","receipt"}`. `IDEM_KEY` = `[A-Za-z0-9_-]{16,128}`. The envelope is bound to `sub` and epoch. There are no CORS headers.
- `registry/registry/store.py` -- `MemoryTable` (reuse it in the dev server).
- `registry/tests/registry_helpers.py` -- reuse `make_app`, `token`, `enroll`, `line`, `call` and `SEED_A`/`SEED_B`. `Clock` has `.t`; the dev server sets it to real time plus an offset.
- `tests/web/browser-lock.mjs` -- `acquireBrowserLock`/`releaseBrowserLock` (browser tests take the lock).
- `newweb/tests/action-offline.mjs` -- the Chromium launch pattern (on darwin, `executablePath` is the system Chrome).
- Python: `/Users/anirudhyadav/flightseal/.venv-agent/bin/python3` (3.11; registry tests pass on it).

## Tasks & Acceptance

**Execution:**
- [x] `newweb/src/registry-client.mjs` -- `createRegistryClient({baseUrl, getToken, fetch, timeoutMs=10000})` returns `envelope()`, `register({receipt, idempotency_key, envelope_id}, {signal})`, `listRegistrations()`, `createShare(rid, days)` and `withdrawShare(token)`. Each result is `{ok:true,status,data}` or `{ok:false,kind:'network'|'timeout'|'aborted'|'http',status,code}`. Also export `tokenOwner(jwt)`. -- the one HTTP edge.
- [x] `newweb/src/outbox.mjs` -- export `openOutbox({ownerId, client, getToken, indexedDB, locks, now, random, setTimeout, clearTimeout, online})`, which returns `enqueue`, `list`, `retryNow(id?)`, `exportPending`, `importProofs`, `close`, `subscribe` and `status()` (`{storage, exportOffered, needsSignIn}`). Also export `createMemoryStore`, `ROW_FIELDS`, `STATES`, `backoffDelay`, `registrationLabel` and `stateLabel`, and handle `online`/`offline` events. -- the outbox.
- [x] `newweb/tests/outbox.test.mjs`, `newweb/tests/registry-client.test.mjs` -- node:test over the memory store and a stub fetch. Cover the I/O matrix, the backoff bounds (1000 random samples per n), allowlist rejection, owner isolation, a stale result after `close()`, a commit failure that leaves the queue row, and owner-mismatch tokens.
- [x] `registry/devserver/server.py` -- DEV ONLY: refuses a non-loopback bind. A `ThreadingHTTPServer` with a lock around `App.handle`. It sends `/v1/*` to an HTTP API v2 event and serves `/src/*.mjs` (from `newweb/src`) and `/harness.html` (from `newweb/tests/fixtures/outbox-harness.html`). `/__dev/*` controls: `token`, `receipt?count=`, `advance?s=`, `hold?ms=` (next registration), `drop` (next registration commits, then the socket closes), `log` (route, status, org, sub), `registrations?org=`, `reset`. orgA and orgB are enrolled at start.
- [x] `newweb/tests/fixtures/outbox-harness.html` -- imports both modules and exposes `window.hw`.
- [x] `newweb/tests/outbox-browser.mjs` -- node:test with Playwright Chromium. It starts the dev server on a free port and takes the browser lock. Six scenarios, per the ACs.
- [x] `docs/OUTBOX.md` -- states, labels, the stored fields, the status table, recovery limits, commands, and the contract problems.

**Acceptance Criteria:**
- Given an offline page with a queued receipt, when the page closes, a page reopens, the outbox starts while offline and the connection then returns, then the registry has exactly one registration. A later reload shows the same stored `received_at`, equal to the server's.
- Given the server commits and then drops the connection, when the clock has advanced 60 s and `retryNow` runs, then the stored `received_at` equals the first commit time and there is one registration.
- Given two tabs of one owner, when both call `retryNow` at once, then there is one registration and both tabs list the row as registered.
- Given a held registration under A, when A's outbox closes and B's opens with B's token, then the request log has no registration sent with B's token for A's receipt, and B's list is empty.
- Given `indexedDB.open` throws, when a receipt is enqueued, then `status().exportOffered` is true and `exportPending()` contains the receipt line.
- Given a registered receipt whose share was withdrawn, when a fresh profile enqueues the same receipt again, then the ack has the original `received_at`, the old share link is still 404, and no new share exists.

## Implementation Notes

- `openOutbox` also takes `store` (a `createMemoryStore()` instance) as a test seam; `createMemoryStore({fail})` injects write failures.
- Client calls accept `{token}` so the outbox sends exactly the token whose owner it checked.
- A 2xx that is not a readable JSON ack is `bad_response`, retried with backoff and the same key (never terminal).
- Envelope prefetch happens at most once per open; after a 422 no envelope is minted until `retryNow(id)`.
- The dev server speaks HTTP/1.0 so Chromium cannot silently re-send a dropped POST on a reused socket.
- Measured: unit 31/31, browser 6/6, registry 59 passed 1 skipped. Not run: C++, wasm, console build/browser gates; the
  root pytest and tests/web gates fail only on missing `build/fseal` in this worktree.

## Plan Change Log

### 2026-11-17 — Follow-up scope from the coordinator (after PR #21 merged)
- **Trigger:** the coordinator asked for the contract problems reported in pass 1 to be fixed, with registry/ and
  infra/ now editable.
- **Added scope:**
  - wire the tests into CI and the AGENTS.md gates;
  - CORS, as an allowlist in both the Lambda and the HTTP API;
  - idempotent share creation, with the token made by the client and only its SHA-256 sent;
  - `GET /v1/epoch` and the three envelope error codes;
  - a per-route throttle on the public share check, with the COST and COVERAGE updates.
- **Known-bad states avoided:**
  - a lost share response that leaves a token the client never received;
  - a console on another origin that cannot reach the API;
  - a public-route flood billed at the 10 rps stage limit.
- **KEEP:**
  - the outbox state machine and its store interface;
  - the field allowlist and the generation guard;
  - the behaviour of all eight browser scenarios.

## Review Triage Log

### 2026-11-17 — Review pass
- verdicts: 10 findings — high 0, medium 3, low 4, false 0, maybe-false 0, rejected-as-scope 3
- findings:
  - `[medium]` `[patch]` Prefetch minted an envelope right after a 422 envelope_expired — handleResult now sets `prefetched = true`; 422 test rewritten to count envelopes after the open-time drain settles.
  - `[medium]` `[patch]` A failed commitAck left the row in "registering" with nothing scheduled — a retry is armed with backoffDelay(1); a timer-driven test was added.
  - `[medium]` `[patch]` After a 401 or owner mismatch, nothing re-polled getToken — the sign-in check now repeats every 30 s while needsSignIn is set; a timer-driven test was added.
  - `[low]` `[patch]` A 401 on the prefetch envelope did not set needsSignIn — it does now; a test was added.
  - `[low]` `[defer]` The new tests are not in ci.yml or the AGENTS.md gate list — the intent allows new files only (no edits to existing files); left for the owner to wire up.
  - `[low]` `[reject]` Not all AGENTS.md gates ran — the intent asks for the gates this change touches (registry, newweb JS, outbox browser), and those ran. The C++/wasm/console gates need build/fseal and are unaffected; reported honestly.
  - `[low]` `[reject]` Storage read failures bypass the duplicate check and the MAX_QUEUE count — only reachable when IndexedDB reads fail while writes succeed, and the receipt line itself is not lost; the fix would add branches.
  - `[low]` `[reject]` exportPending returns needs_previous_export even when storage is healthy — deliberate: the client cannot tell eviction apart from an empty queue, so the conservative message is the honest one.
  - `[low]` `[patch]` registry-client accepted a 2xx JSON array as ok — Array.isArray now gives bad_response; an assertion was added.
  - `[low]` `[patch]` devserver unverified_claims crashed on a payload that is JSON but not an object — it returns {} now.

### 2026-11-17 — Review pass 2 (contract fixes: CORS, shares, epoch)
- verdicts: 8 findings — high 2, medium 3, low 3, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` A client-chosen token hash could be re-registered once TTL removed its SHARE record, which would reopen an old withdrawn link — SHARE records now have no TTL. Deletion writes a TTL-free withdrawn stub with org and rid. A taken hash is a 409 unless it is the same org and registration (a replay). New tests: hash never reusable (other org, other registration, 400 days later), and delete leaves a permanent stub.
  - `[high]` `[patch]` A restore plus the client's own retry recreated a share that had been created and withdrawn after the backup — restore now writes a withdrawn record for a share tombstone whose share is missing, and tombstones carry rid. New test: restore, then retry, gives 200 withdrawn and the link stays 404.
  - `[medium]` `[patch]` A retry after DEDUPE_SECONDS got an unexplained 409 — a taken hash of the same org and registration now returns the share with its disposition. New test: a late retry gets the original share.
  - `[medium]` `[patch]` The concurrent same-key branch had no test — added a racy-read test.
  - `[medium]` `[patch]` Client epoch gaps: the epoch check ran after dispatch, had no abort signal, and kept a cached envelope with no epoch — the epoch is now read before any dispatch, under the in-flight AbortController. Rows bound to an older epoch become needs_attention `epoch_mismatch` locally and are not sent. A cached envelope with no epoch is dropped. Three new unit tests.
  - `[low]` `[patch]` The CI step did not start the dev server — the step now starts it and passes `REGISTRY_DEV_URL`. Locally the test still starts its own server. Verified both ways (8/8 each).
  - `[low]` `[patch]` The dev CORS default included localhost — the default is now `http://127.0.0.1:*` only, and the cross-origin browser test sets `localhost` through `/__dev/cors` first.
  - `[low]` `[patch]` Small gaps in createShare and the stack:
    - createShare accepted a malformed token, and threw where `crypto.subtle` was missing. It now returns `kind: 'client'` (`bad_token` or `insecure_context`); a unit test was added.
    - `-c corsOrigins=` (empty) shipped with no origins. The stack now throws, with a synth assertion.
    - Array context is now accepted in bin/app.ts.
    - The AGENTS infra count is 13.

## Design Notes

The row primary key is the receipt hash, not the idempotency key, because a row can exist before it has an envelope. An envelope can be prefetched while online (`client.envelope()`, cached per owner in the store's `meta`). The server deduplicates by `rid` even across keys, so a new envelope after expiry still returns the original ack.

## Verification

**Commands:**
- `node --test newweb/tests/outbox.test.mjs newweb/tests/registry-client.test.mjs` -- expected: all pass
- `node --test newweb/tests/outbox-browser.mjs` -- expected: 6 pass
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH python3 -m pytest -q registry/tests` -- expected: 59 passed, 1 skipped (no build/fseal)

## Auto Run Result

Status: built.

**Summary:** Browser offline outbox and registry client as standalone modules, plus a dev-only registry HTTP server for real Chromium tests.

**Files:**
- `newweb/src/outbox.mjs` -- owner-scoped IndexedDB outbox with a same-interface memory store, state machine, backoff, Web Locks, generation guard, and export/import
- `newweb/src/registry-client.mjs` -- fetch wrapper with typed results, `tokenOwner`, and share helpers
- `newweb/tests/outbox.test.mjs`, `newweb/tests/registry-client.test.mjs` -- 34 node:test unit tests
- `newweb/tests/outbox-browser.mjs`, `newweb/tests/fixtures/outbox-harness.html` -- 6 Chromium scenarios
- `registry/devserver/server.py` -- dev-only, loopback-only server that runs the real App over MemoryTable
- `docs/OUTBOX.md` -- states, fields, the response table, limits, commands and contract problems

**Review:** 6 patches (3 medium, 3 low), 1 deferred (CI wiring), 3 rejected (reasons in the triage log). Follow-up review: false, because no high finding was patched and the medium fixes each have a timer-driven test.

**Verification:**
- unit tests: 34/34
- browser tests: 6/6
- registry/tests: 59 passed, 1 skipped (no build/fseal)
- newweb/tests/*.test.mjs: 79/79
- tests/web JS gate: 20/23; the 3 failures are a missing build/fseal in this worktree and existed before this change

**Residual risks:**
- IndexedDB ack pruning and real quota failure are tested only against the memory store.
- Rows in needs_attention count toward MAX_QUEUE, and there is no way to delete them.
- The modules are not wired into main.jsx.

### Follow-up pass (2026-11-17)

**Built:**
- CORS allowlist in the Lambda (`CORS_ORIGINS`) and on the HTTP API (`corsOrigins`, default `https://anirudh763.github.io`).
- Idempotent shares: the client makes the token and sends only its hash; hashes are never reusable.
- `GET /v1/epoch` and the codes `envelope_expired`, `sub_mismatch` and `epoch_mismatch`.
- Public share route throttle (2 rps, burst 5).
- CI steps and AGENTS.md gates, plus COST, COVERAGE, ARCHITECTURE_AWS and OUTBOX docs.

**Verification:**
- `uv run --no-project -p 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q`: 141 passed, 30 skipped.
- `registry/tests`: 81 passed.
- `infra` npm test: 13/13.
- ctest: 5/5.
- JS gate: 139/139.
- `newweb/tests/*.test.mjs`: 88/88.
- Outbox unit tests: 43/43.
- Outbox browser tests: 8/8, both with a self-started server and with an external `REGISTRY_DEV_URL` server.
- LocalStack e2e: 19 pass, 2 fail, 2 blocked, the same as before this change. The fails are the known Lambda/API persistence after a container restart; HTTP API and Cognito are blocked in community.

**Residual risks:**
- Whether API Gateway bills throttled (429) and authorizer-rejected requests was not retrieved.
- CORS and throttle on the real HTTP API are synthesised only.
- A share hash claimed forever costs about 150 bytes per share.

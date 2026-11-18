---
title: 'Registry security review lows (594fbb1)'
type: bugfix
ticket: ''
created: '2026-11-17'
status: built
baseline_revision: '594fbb1c7d0d385f2063d6def0b36814cb860011'
route: oneshot
route_source: pinned
risk: low
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md']
warnings: ['multiple-goals']
deferred: []
---

<intent-contract>

## Intent

**Problem:** An independent security review of main 594fbb1 found five low-severity issues. (1) The Lambda asset
ships `registry/devserver/server.py`. (2) A GET on a malformed `/v1/shares/<x>` path returns a 404 without the
`access-control-allow-origin: *` header that a well-formed unknown token gets, which breaks the "same body, same
headers" promise in ARCHITECTURE_AWS.md. (3) `POST /v1/shares` answers 409 `conflict` for a token hash that was ever
used and 201 for an unused one. (4) `tokenOwner` in `newweb/src/registry-client.mjs` prefers `org_id` over
`custom:org_id`, which is the opposite of the server's Cognito adapter. (5) Some wording in COVERAGE.md and COST.md
is out of date or incomplete.

**Approach:**
1. Add `'devserver'` to the asset `exclude` in `infra/lib/stack.ts`. Add a synth test that lists the built asset
   directory and asserts it holds exactly `handler.py` and `registry/*.py`.
2. In `registry/registry/app.py`, add the share-view CORS header to every GET under `/v1/shares/`, so malformed
   paths match unknown tokens. Add a pytest that compares status, headers and body.
3. Document the 409 disclosure as accepted and low severity, in ARCHITECTURE_AWS.md and COVERAGE.md. The only
   alternative found was answering 201 for a reused hash, which would report a share that does not exist. That is
   not a simple fix, so the code does not change.
4. Change `tokenOwner` to read `claims['custom:org_id'] ?? claims.org_id`. Add a node test with a token that
   carries both claims with different values.
5. Docs:
   - COVERAGE.md: the Local column also covers the dev-server tests in Playwright Chromium.
   - COST.md: put the billing caveat directly under the "about $8" total.
   - COST.md: note that the signed-in routes can be flooded with invalid tokens up to the stage default of 10 a
     second, burst 20. This is unverified on AWS.

Do not touch `newweb/src/main.jsx`, `newweb/src/style.css` or `newweb/src/outbox.mjs`. Every code change gets a
test that fails before the change and passes after it. Update the counts in AGENTS.md.

</intent-contract>

## Implementation Notes

The oneshot route was chosen because these are five small changes, each in its own place. Each one has a clear
check, and none changes the data model or the API contract.

- The three new tests were run before the fixes, and each failed for the expected reason:
  - pytest: the malformed-path 404 was missing `*`.
  - infra: `unexpected file in asset: devserver/server.py`.
  - node: the `tokenOwner` precedence assertion.
- `SHARE_VIEW` now matches every GET under `/v1/shares/`.
- The first `node --test newweb/tests/*.test.mjs` run failed in `report-pdf.test.mjs`, because `pdf-lib` was missing
  from a fresh worktree. After `npm --prefix newweb ci`, everything passes. This was an environment problem, not a
  code problem.
- The 409 disclosure is documented instead of fixed. Answering 201 for a reused hash would report a share that does
  not exist.

- Follow-up from the coordinator: COST.md had to cite AWS's own text.
  - AWS pages do not say whether HTTP API requests that fail the JWT authorizer, or that get a 429, are billed.
  - AWS pages do not say whether `DefaultRouteSettings` applies per route or is shared.
  - The pages read, and the sentences quoted, are listed in COST.md. Both questions stay open.
  - The stage default was therefore lowered from 10 a second, burst 20 to 2 a second, burst 5.
  - The synth assertions were changed first, and 2 of 14 failed. They pass after the change.
  - The worst case was recomputed to about $70 a month, assuming throttled requests are free.
  - RUNBOOK_AWS.md gained "When the budget alert fires": delete the `$default` stage, or run `cdk destroy`.

## Review Triage Log

### 2026-11-17 — Review pass
- verdicts: 5 findings — high 0, medium 0, low 4, false 1, maybe-false 0
- findings:
  - `low` `patch` ARCHITECTURE_AWS/COVERAGE describe "same 404 headers" as if the deployed system did it, but the
    HTTP API `{token}` route never sends empty or multi-segment paths to the Lambda. Fixed: both docs now scope the
    claim to the Lambda and the dev server, and say that API Gateway answers those paths with its own 404, which
    shows only the path's shape.
  - `low` `patch` COST.md flood bullet treated 10 rps as one shared limit. HTTP API `DefaultRouteSettings` applies
    to each of the 12 routes, and the bullet contradicted the throttled-billing caveat. Rewritten: about 120 rps, or
    about 311 M a month. The bullet now says the cost holds only if authorizer-rejected requests are billed, and
    that there is no ceiling if throttled requests are billed too. Marked unverified.
  - `low` `patch` The $8 caveat mixed in JWT-authorizer billing, which does not apply to the public route. Fixed:
    the caveat now covers only throttled 429s.
  - `low` `patch` The 409 docs said "holds the token" (holding the hash is enough) and did not mention that a 201
    probe creates a real share. Fixed: the docs now say "token or its hash", note the 10-share limit, and narrow the
    COVERAGE evidence to the case the test covers (withdrawn and expired).
  - `false` `reject` The `tokenOwner` change can disagree with the dev-hs256 adapter for a token that carries both
    claims. `make_dev_token` never emits `custom:org_id`, and the plan deliberately mirrors the Cognito adapter.

## Auto Run Result

- **Summary:** fixed five low-severity findings from the security review of main 594fbb1.
- **Files changed:**
  - `infra/lib/stack.ts`: excludes `devserver` from the asset.
  - `infra/test/stack.test.ts`: new test that lists the built asset directory.
  - `registry/registry/app.py`: `SHARE_VIEW` now covers every GET under `/v1/shares/`.
  - `registry/tests/test_registry_contract_fixes.py`: new test for identical 404s.
  - `newweb/src/registry-client.mjs`: `custom:org_id` now takes precedence.
  - `newweb/tests/registry-client.test.mjs`: new test with both claims.
  - `docs/aws/ARCHITECTURE_AWS.md`, `COVERAGE.md`, `COST.md`: the documentation changes listed in the intent.
  - `AGENTS.md`: updated test counts.
- **Review:** 4 low findings patched (all in the docs), 1 rejected as false, 0 deferred.
- **Follow-up review recommended:** `false` (no high or medium findings were patched).
- **Verification:**
  - `ctest`: 5/5 passed.
  - `registry/tests`: 82 passed.
  - Full pytest with CI packages: 145 passed, 30 skipped.
  - infra `npm test`: 14/14 passed.
  - `node --test newweb/tests/*.test.mjs`: 111/111 passed.
  - outbox and registry-client tests: 46/46 passed.
  - `outbox-browser.mjs` in Chromium: 8/8 passed.
- **Residual risks:** the HTTP API 404 shape, per-route throttling and billing of rejected or throttled requests
  are all unverified on AWS.

## Verification

**Commands:**
- `python3 -m pytest -q registry/tests` -- expected: all pass, with the new tests included
- `uv run --no-project -p 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q` (after cmake build) -- expected: all pass
- `cd infra && npm ci && npm test` -- expected: all pass, one more assertion than before
- `node --test newweb/tests/*.test.mjs` -- expected: all pass
- `gitleaks git --log-opts=origin/main..HEAD` -- expected: no leaks

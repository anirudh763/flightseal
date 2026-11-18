# Verification lens review — HashWing on AWS spine

Reviewed: `architecture-hashwing-aws.md` (AD-1..AD-17, Stack), `.memlog.md`, on worktree HEAD `e279032`, 2026-11-17.
Web access: available. Sources checked: npm registry (`registry.npmjs.org/<pkg>/latest`), Docker Hub tag API,
AWS Lambda runtimes page, AWS Cognito docs (search), LocalStack blog (search).

**Verdict: PASS WITH FIXES.** Every Stack pin and named technology checks out against live sources. AD-16 matches
the code. AD-17 and the extended AD-15 match the code in most details, but AD-17 says less than the code does in
one way that matters (what triggers the cross-tab wipe), and AD-15 has one wrong wording.

## Findings

### F1 — MEDIUM — AD-17: the cross-tab "logout" is sent by more than app logout
`main.jsx` `clearSensitiveWorkspace()` (line 1074) calls `registryLogout()`. That calls `registry.logout()`, which
posts `{type:'logout'}` on `hashwing-registry` (`registry-ui.jsx:166`). `clearSensitiveWorkspace` runs from
`logout` (1099) and `logoutFromAnotherTab` (1114/1117). It also runs from `beginDemo` when a session exists (1061)
and from `finishAuthentication` (1135), which is app sign-in or switching accounts. So when someone starts a demo
or signs in to the app in one tab, every open tab loses its registry sign-in and its unsent in-memory proofs.
AD-17 and docs/OUTBOX.md ("If anyone logs out of the app") only name logout.
**Fix:** decide which behaviour is wanted. Either change AD-17 (and OUTBOX.md Limits) to "app logout, app sign-in
or account switch, or demo start", or broadcast only from the logout paths (for sign-in and demo start, clear
only this tab).

### F2 — LOW/MEDIUM — AD-17 leaves out what happens to tabs that miss the message
AD-17 says frozen, discarded or `BroadcastChannel`-less tabs "miss the message". docs/OUTBOX.md (lines 119-121)
says what follows: those tabs **sign back in with the saved `sessionStorage` token when they wake**
(`createRegistry` resumes from `storage.get()`). The prevented failure "a duplicated tab still sending as a
signed-out user" can therefore still happen.
**Fix:** add "and sign back in with their saved token when they wake; sign out there too" to the AD-17 rule.

### F3 — LOW — AD-15: "other 4xx codes are terminal" is wrong for the two key codes
`outbox.mjs:25` `RETRYABLE` includes `key_not_enrolled` and `key_not_active` (and `attempts_exhausted`), so
`retryNow(id)` acts on them. The UI also offers 'retry' for `key_not_enrolled` (`registry-ui.jsx` REASONS).
AD-15 says that besides the envelope codes and quota, "other 4xx codes ... are terminal `needs_attention`".
**Fix:** "403 `key_not_enrolled` / `key_not_active` move to `needs_attention`, and only an explicit `retryNow(id)`
retries them; the remaining 4xx (including 410 `registration_deleted`, 409, 400, 413, 422 `bad_signature`) are terminal."

### F4 — LOW — AD-16: one branch untested, one wording loose
- The non-loopback branch ("Registry sign-in isn't available in this build yet.", `registry-ui.jsx` RegistryPanel)
  is not tested. `grep "available in this build"` finds it in no test. `registry-wiring.mjs` builds only
  flag-off and loopback flag-on. This branch is the one that keeps a paste-a-token form away from a real registry.
  **Fix:** add a wiring check that builds with a non-loopback `https://` `VITE_REGISTRY_URL` and asserts "Test
  sign-in" is absent and the not-available text is present (rendering needs no network).
- "a public origin": `vite.config.js` accepts a URL with a path and keeps `href` minus trailing slashes. Only the
  CSP uses `.origin`. **Fix:** say "a public URL (origin, optional path)".

### F5 — LOW — Version and runtime notes
- Memlog line 336 says "LocalStack 4.12.0 is the last community tag before auth-token-only single image". That is
  false. Docker Hub has `4.13.0` (2026-01-29), `4.13.1` (2026-02-02) and `4.14.0` (2026-02-26). The spine's own
  wording in AD-13 ("a tag from before LocalStack moved to one auth-token image (2026-03)") is correct. LocalStack's
  own post suggested pinning 4.12 for Community use, so the pin is defensible. **Fix:** correct the memlog line,
  and optionally note in COVERAGE.md why 4.12.0 was chosen over 4.14.0.
- Stack says "Node.js (CI, infra) 22". The registry-relevant jobs (`test`, `infra`, `browser`) use 22, but
  `wasm-console` (which builds the console and runs the registry wiring tests) uses Node **24**, and `http-runtime`
  uses Python 3.13. Node 22 reaches upstream end of life on 2027-04-30 (Lambda `nodejs22.x` deprecation
  2027-05-30). That is sooner than the Python 3.12 row that is already in Deferred.
  **Fix:** make the row "Node.js 22 (test, infra, browser jobs); 24 (wasm-console, which runs the registry console
  tests)" and add a Deferred row "Node 22 end of life 2027-04-30".
- boto3 "runtime-included, unpinned": the AWS runtimes page recommends bundling the SDK rather than relying on the
  runtime-included one. This is acceptable here, but it is a known drift risk. Note only.

## Confirmed (no action)

| Claim | Evidence |
| --- | --- |
| aws-cdk-lib 2.277.0 | npm latest 2.277.0 (published 2026-11-13); `infra/package.json` |
| constructs 10.8.1 | npm latest 10.8.1 |
| aws-cdk CLI 2.1148.1 | npm latest 2.1148.1 |
| aws-cdk-local 3.1.0 | npm latest 3.1.0 |
| TypeScript 7.0.2 | npm latest 7.0.2 |
| @types/node 22.20.5 (not in Stack) | latest 22.x on npm is 22.20.5 |
| python3.12 deprecation 2028-10-31 | AWS Lambda runtimes table: deprecation Oct 31 2028, block create Nov 30 2028, block update Jan 10 2029 |
| Lambda python3.12 arm64 | `stack.ts:81-82` `PYTHON_3_12`, `ARM_64` |
| LocalStack 4.12.0 digest | Docker Hub tag 4.12.0 digest `sha256:0df3a97d...cd317`, 2025-12-11, matches memlog/COVERAGE |
| Auth-token single image from 2026-03 | LocalStack blog: 2026.03.0 is the first release requiring an auth token; single image from 2026-03-23 |
| Cognito Lite: custom attrs in ID token, not access token | AWS docs: access token customization (pre-token V2) needs Essentials/Plus and cannot be configured on Lite; `stack.ts:95` `FeaturePlan.LITE`, `readAttributes ... withCustomAttributes('org_id','role')`; `identity.py:84` reads `custom:org_id` |
| HTTP API `corsPreflight` | `stack.ts:125-130` allowOrigins from validated `corsOrigins`, headers `authorization, content-type, idempotency-key`, `allowCredentials: false` |
| Vite `define` build-time constant | `vite.config.js` `define.__REGISTRY_URL__ = JSON.stringify(registryUrl)`; validation (https or loopback http, no credentials/query/fragment) matches AD-16 |
| "No registry code ships" when empty | `main.jsx:29` imports `registry-ui.jsx` statically, so this depends on tree-shaking (`registry-ui.jsx` declares no top-level side effects). CI enforces it: the `wasm-console` job runs a flag-off `npm run build`, then the `registry-wiring.mjs` FORBIDDEN-string scan of `docs/console` |
| Loopback hosts | `registry-ui.jsx:50` `isLoopback`: `localhost`, `127.0.0.1`, `[::1]`, same list as `vite.config.js` |
| Token in tab memory + `sessionStorage` key `hashwing-registry-token` | `registry-ui.jsx:9,51-52,73` |
| BroadcastChannel name and message shapes | `registry-ui.jsx:85-88,165-166`; owner is `<org>/<sub>` (`registry-client.mjs:29`); no token in messages; tested in `registry-session.test.mjs:77-87` |
| logoutHere drops pending + names, closes (not deletes) outbox | `registry-ui.jsx:155`; `closeOutbox` calls `state.outbox.close()` only |
| Every tab has a channel | `main.jsx:160` calls `getRegistry()` on mount when the flag is on |
| `registryTimeField` strings | `registry-ui.jsx:195-210` match AD-15 exactly |
| AD-15 outbox codes | `outbox.mjs:293-300` (non-quota 429, 408, 5xx back off to `attempts_exhausted`), `:23` envelope codes, `:547` `busy()`; `registry-client.mjs:75` `GET /v1/epoch` |
| IndexedDB + Web Locks exist and are used with fallbacks | `outbox.mjs:189-208` (memory fallback), `:406-407` `navigator.locks.request(..., {ifAvailable:true})` with no-lock fallback |

## Not verified
- API Gateway HTTP API behaviour (corsPreflight overriding integration headers, JWT authorizer accepting access
  tokens) was taken from docs and code only. The spine already marks it "Designed only" (AD-13, Deferred).
- Whether browsers queue BroadcastChannel messages for a frozen tab and deliver them on resume (as opposed to
  dropping them). The spine and OUTBOX.md take the cautious view ("miss"), which is the safe assumption.

Sources: [npm registry](https://registry.npmjs.org/), [Docker Hub localstack tags](https://hub.docker.com/r/localstack/localstack/tags),
[AWS Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html),
[Cognito access token customization](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-advanced-security-access-token.html),
[Cognito feature plan deactivation](https://docs.aws.amazon.com/cognito/latest/developerguide/feature-plans-deactivate.html),
[LocalStack 2026.03.0 release](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/),
[LocalStack single image](https://blog.localstack.cloud/localstack-single-image-next-steps/),
[The road ahead for LocalStack](https://blog.localstack.cloud/the-road-ahead-for-localstack/).

---
title: 'Option B browser half, part 2: Trust pilot screens, recipient pilotKeys and compromised list, chosen-company pilot path'
type: feature
ticket: ''
created: '2026-11-19'
status: built
baseline_revision: '32f0b743d91c0ced75b25809142d57bdaf3a5c20'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-optb2/_bmad-output/initiative-hashwing-aws/design-key-enrollment-option-b.md'
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-optb2/AGENTS.md'
  - '/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-optb2/.agents/skills/enterprise-ui-polish/SKILL.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Option B has its server half (`/v1/pilot-keys*`) and part 1 of the browser half (PR #67: `pilot-authorization.mjs`, `trustForProof`, `PILOT_AUTHORIZATION_ACCEPTED = false`), but no screen lets a pilot make and enroll a pilot key, no screen lets the company computer authorize one, the key list doesn't show pilot rows, recipients can't turn on "uses pilot keys" for a pin or mark a pilot fingerprint compromised, and Verify with a chosen company or a typed company key never runs the pilot check (part 1 deferred item).

**Approach:** Extend Trust "Your company's keys" with the pilot and company-computer steps (registry-on builds, shown only when `GET /v1/keys` says `pilot_keys: true`), add the recipient pieces to Trusted companies behind the build constant, make the chosen-company and typed-key Verify paths accept a valid pilot authorization for that company when the constant is on, and prove it with unit tests and registry-wiring browser checks against a dev registry with the pilot switch on for one test org.

## Boundaries & Constraints

**Always:**
- Work only in the worktree `/private/tmp/claude-501/-Users-anirudhyadav/d85e4c7d-ebdd-49d1-8c47-0eace70cc60c/scratchpad/wt-optb2` (branch `feat/option-b-trust`). Never edit `/Users/anirudhyadav/flightseal`. Every test log and artifact stays in the worktree (`newweb/.test-artifacts/` is gitignored).
- `PILOT_AUTHORIZATION_ACCEPTED` stays `false` in the source and in every `npm run build`. Only tests flip it, by a Vite plugin that rewrites the exact line `export const PILOT_AUTHORIZATION_ACCEPTED = false;` (as `newweb/tests/pilot-verify.test.mjs` does) and throws if the line is missing. No env var, option or runtime value turns it on.
- Gating. Sender screens (steps 1-4): inside `CompanyKeysPanel`, which already ships only behind `__REGISTRY_URL__`, rendered only when the list response has `pilot_keys === true`. Recipient pieces (step 5 setter and compromised list, step 6 Verify path, the new storage key) only behind `PILOT_AUTHORIZATION_ACCEPTED`, so they fold out of every shipped bundle. The flag-off `docs/console` gains none of the new strings; the flag-on, constant-off test build has none of the recipient strings.
- Rule B1: the browser signs only bytes it built itself. The pilot challenge is `hashwing-pilot-key-enroll v1\n<org>\n<nonce>` with `<org>` from its own sign-in and a 32-lowercase-hex nonce; any other `message` → sign nothing, "The registry sent an unexpected challenge. Nothing was signed." The authorization is built locally from the pasted pilot public key, the loaded company key and the chosen lifetime; nothing the server or the paste supplies is signed as given.
- Private keys never leave the device: no request body carries anything but the fields the routes take (`public_key`, `nonce`, `signature`, `authorization`, `authorization_sig` for enroll; `{}` for retire). Signing uses a non-extractable WebCrypto import (`signerFromPem`).
- Strict Verified: `verdict()` unchanged; the registry never raises a result; the authorization date is compared with the verifier's clock only, never the seal time.
- Plain words, one primary button per step, 44px targets, keyboard reachable, dialogs focus the safe choice and Escape cancels, focus returns to the trigger or the section heading, 320/768/1440 with no horizontal scroll, axe 0.
- Console rebuild rule from AGENTS.md (never hand-edit or hand-merge `docs/console`) and its two greps.
- Reuse `company-keys.mjs` / `company-keys.jsx` patterns (`challengeBytes`, `listAllKeys`, `errorLine`, `signerFromPem`, `publicKeyHexFromPem`, the dialog helpers) and `pilot-authorization.mjs` (`parse`, `check`, `parseLine`, `weakKey`, `iso`, `LINE_PREFIX`); do not copy the formats.

**Never:** Jobs code (`jobs.jsx`, the Jobs parts of `registry-ui.jsx`) — another builder owns it; any server, registry, C++, `docs/verifier.js` or fixture change; turning a switch on outside tests and the dev server; committing `_bmad/`, `.venv-agent`, `tests/.data` or `build/`; deploys; merging; force-push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pilot challenge, honest | `{nonce: 32 hex, message: "hashwing-pilot-key-enroll v1\n<org>\n<nonce>"}` | signs those bytes | n/a |
| Pilot challenge, hostile | message is a company challenge, an `fseal-receipt v1 …` line, a `hashwing-pilot-authorization v1 …` statement, other org, trailing newline, uppercase/short nonce | nothing signed, no POST | "The registry sent an unexpected challenge. Nothing was signed." |
| Authorize, honest | request text with a 64-hex public key; full fingerprint computed locally; read-back box ticked; 14 or 30 days | line `Authorized by company key: <b64>.<sig>`; `check()` of it under the loaded company key passes before it is shown | n/a |
| Authorize, refused | pasted key weak / off-curve, equals the loaded company key, malformed; read-back not ticked; loaded key is not the org's active company key | nothing signed | plain reason next to the field |
| Authorize, paste changes after tick | new text | tick cleared, must tick again | n/a |
| Enroll, honest | loaded pilot key + pasted line for it | 201; row "Pilot key" Active; the line is kept for this key and added to its receipt messages | n/a |
| Enroll, line for another key / ended / malformed | local `check()` fails | no request | plain reason |
| Enroll, lost response | 409 `key_exists` | success only if `GET /v1/keys` lists that fp `active`, `kind: pilot`, `company_fingerprint` = the line's company fp | else "This key was enrolled before and can't be enrolled again." |
| Enroll, server refusals | 403 `pilot_keys_off`, 422 `bad_authorization`, 422 `authorization_expired`, 422 `company_key_not_active`, 409 `pilot_key_limit`, 400 `bad_challenge` | each its own plain line, raw code under More options | never the "Only a company admin" line |
| Lifetime 30 days | authorize with 30, enroll against the dev registry | 201 (a skew margin keeps it under 30 days) | n/a |
| Pilot rows | list row `kind: pilot` | "Pilot key", company key (short fingerprint), "ends on {date}", state label | n/a |
| Remove / Mark compromised (admin) | dialog | safe choice ("Keep it") focused, Escape cancels; confirm → "Removed on {date}" / "Marked compromised on {date}" | errors via `errorLine` |
| pilotKeys setter | active, confirmed pin; tick "I confirmed this company signs through pilots" | `pilotKeys: true` stored; `PINS_CHANGED` fired | refused without the tick, on an unconfirmed, replaced or compromised pin |
| Compromised fingerprint list | add fp (+ optional note) | stored, survives reload, never dropped; `trustForProof` returns `compromised` when the pilot fp or the statement's company fp is on it (checked first) | 501st entry refused with a visible reason; a bad fingerprint refused |
| Chosen company, constant on | signer fp ≠ company fp, `trustForProof` says trusted via pilot with that company's pin | Verified, pilot trust line, report Result = headline | anything else: today's mismatch result |
| Typed company key, constant on | typed key ≠ message key, `trustForProof(messageKey)` trusted via pilot and the statement's company key = typed key | receipts checked under the message key; Verified | anything else: today's behavior (wrong key) |
| Constant off | any of the above | exactly today's behavior; no new strings in the bundle | n/a |

</intent-contract>

## Code Map

- `newweb/src/company-keys.mjs` -- `challengeBytes(org, challenge)` builds `hashwing-key-enroll v1`; give it a third `prefix` argument (default the company prefix) instead of a second copy, and add `pilotEnroll({client, org, token, sign, publicKeyHex, authorization, sig, companyFingerprint})` shaped like `enroll` (one challenge, one signature, one POST, never retries; the 409 `key_exists` recovery as in the matrix). Extend `errorLine` so pilot codes are mapped before the generic `status === 403` line. Add a pilot row label helper (kind, short company fp, "ends on {date}").
- `newweb/src/pilot-authorization.mjs` -- `statementText`/`encode` are private; export one builder, e.g. `authorize(pilotKeyBytes, companyKeyBytes, notAfter, sign)` → line, or export `statementBytes` + `line(b64, sig)`, so the company computer never re-implements the format. `check(b64, sig, pilotKey, companyKey, nowSec)` is the round-trip check.
- `newweb/src/registry-client.mjs` -- add `pilotKeyChallenge` (`GET /v1/pilot-keys/challenge`), `enrollPilotKey` (`POST /v1/pilot-keys`), `retirePilotKey(fp)` (`POST /v1/pilot-keys/<fp>/retire`, body `{}`), same style as the key methods.
- `newweb/src/company-keys.jsx` -- `CompanyKeysPanel({ signingKey })`. Keep the existing company flow and its tests unchanged. When `list.pilot_keys === true` (store it from `listAllKeys`; it currently drops it): (a) pilot device: "Make my pilot key" (calls a new prop that reuses main.jsx `generateSigningKey`), "Copy key request" (text: a first line `HashWing pilot key request`, `public_key=<64 hex>`, `fingerprint=<groups of four>`; public data only), a textarea to paste the authorization, "Enroll my pilot key"; (b) company computer (admin, loaded key = `list.active_key`): "Authorize a pilot key": paste textarea, the locally computed full fingerprint shown with "Read it back to the pilot. Don't authorize a key from the same message alone.", tick "I read this fingerprint back to the pilot", 14 (default) / 30 days radio, "Sign the authorization", read-only output + Copy; (c) rows: pilot rows get kind/company/ends-on, admins get "Remove" (new dialog "Remove this pilot key?", safe "Keep it") and the existing "Mark compromised". One `.button.primary` per step; existing orgK checks assert one primary button in a non-pilot org, so pilot UI must not render there.
- `newweb/src/main.jsx` -- trust is read at ~1516 (`trustForProof` vs `trustForKey`), `runProtectCheck` ~1268-1295 (chosen company `mismatch`, typed `checkKey` via `checkAnchorKey`), `ManifestCheck` ~2625-2690 (`companyFingerprint` mismatch branch, `anchor`). `generateSigningKey` ~1122 (reuse for "Make my pilot key"). Seal paths: small file `lines` ~1228-1236, manifest `manifestHandoverText` ~2544: append the stored authorization line (`signingKey.pilotAuthorization`, set via a callback from the panel only for the same signing-key object and only when `check()` says it authorizes that key) behind `__REGISTRY_URL__`. `TrustedCompanies` ~2128: add the pilotKeys control per active confirmed pin and the compromised-fingerprint form, behind `PILOT_AUTHORIZATION_ACCEPTED`. Trust page markup ~2000.
- `newweb/src/trusted-keys.mjs` -- `trustForProof` (end of file), `read`/`clean`/`write`, `PINS_CHANGED`. Add `setPilotKeys(name, fingerprint, on, { confirmed, storage })` and a separate store `hashwing_compromised_fingerprints_v1` (`markFingerprintCompromised(fp, { note, now, storage })`, `listCompromisedFingerprints({ storage })`, cap 500), read by `trustForProof` first, for both fingerprints. Return the statement's company key hex in the pilot result so the typed-key path can compare bytes.
- `newweb/src/recipient-trust.mjs` -- import-free; `trustLine` pilot cases; the copy change (step 7) lives here. A pure helper for step 6 (accept a pilot result for a chosen company fp or a typed key) may live here, guarded by the constant.
- Tests: `newweb/tests/company-keys.test.mjs` (style for hostile challenges), `newweb/tests/pilot-verify.test.mjs` (switch-on pattern), `newweb/tests/registry-wiring.mjs` (orgK block ~1396-1625 is the pattern for the panel; `FORBIDDEN` list l.28; flag-on build l.225; self-spawned dev server l.218 must pass `--pilot-keys-orgs orgP`), `.github/workflows/ci.yml` (l.136 unit list; l.143/154 dev servers need the same flag).
- Docs: `AGENTS.md` measured counts; `_bmad-output/initiative-hashwing-aws/initiative-hashwing-aws.md` R71 row; `_bmad-output/initiative-hashwing-aws/ux-hashwing/EXPERIENCE.md` l.471 and Trust ACs; design doc §7.2 copy row; AD-23 status line in the spine.

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/src/pilot-authorization.mjs`, `newweb/src/company-keys.mjs`, `newweb/src/registry-client.mjs` -- builder export, prefix-parameter challenge, `pilotEnroll`, error lines, pilot row labels, client routes -- the pure layer.
- [ ] `newweb/tests/pilot-keys.test.mjs` (new) -- hostile pilot challenges (company challenge, a receipt line, an authorization statement, other org, trailing newline, bad nonce) sign nothing and POST nothing; enroll body has exactly the five fields; each refusal code maps to its own line; the `key_exists` recovery (right fp/kind/company → success, else enrolled before); authorize refuses weak, off-curve, same-as-company and malformed keys; the built line passes `check()` and its `not_after` is under 30 days for the 30 choice.
- [ ] `newweb/src/trusted-keys.mjs`, `newweb/src/recipient-trust.mjs` -- setter, compromised list, step-6 helper, copy -- with tests added to `newweb/tests/pilot-verify.test.mjs` (switch on and off) and `newweb/tests/trusted-keys.test.mjs`.
- [ ] `newweb/src/company-keys.jsx`, `newweb/src/main.jsx` -- the screens, the seal-line append, the Verify paths.
- [ ] `newweb/tests/registry-wiring.mjs` -- `FORBIDDEN` gains the new strings; a constant-off flag-on scan for the recipient strings; a second flag-on build with the constant rewritten on (Vite JS API or a test-only config file under `newweb/tests/`, asserting the rewrite matched) used for a pilot org block: pilot makes key → copies request → admin (company key loaded and enrolled) authorizes (fingerprint read-back, 14 days; also once with 30) → pilot enrolls → a pilot seal registers → recipient pins the company, turns pilotKeys on with the tick → Verify with that company chosen and with the company key typed reads Verified with the pilot line, report Result = headline; pilotKeys off → "Files match · signer not confirmed"; fingerprint marked compromised → compromised; admin Remove and Mark compromised dialogs (safe focus, Escape); axe 0, no horizontal scroll, 44px at 320/768/1440; screenshots of the pilot screens at 320 and 1440 into `newweb/.test-artifacts/registry-wiring/`.
- [ ] `.github/workflows/ci.yml` -- new unit file in the list; both dev servers started with `--pilot-keys-orgs orgP`.
- [ ] `docs/console` -- rebuild per AGENTS.md; both greps; grep for the new strings finds nothing.
- [ ] Docs -- R71 row and EXPERIENCE with exact cites ("built in this PR"), AGENTS.md measured counts line, design §7.2 copy row.

**Acceptance Criteria:**
- Given a dev registry with the pilot switch on for one org, when a pilot makes a key, the company computer authorizes it and the pilot enrolls it, then the key list shows a "Pilot key" row ending on the authorization date, and a seal with that key registers.
- Given a recipient build with the constant on, a pinned company with "signs through pilots" on, when they verify that pilot's proof with the company chosen or its key typed, then the headline is Verified with the line "Signed by a pilot key that {company} authorized until {date}", and the report says the same.
- Given the shipped builds, when they are scanned, then the flag-off console has none of the new strings and the constant-off flag-on build has none of the recipient strings.

## Implementation Notes

- The authorization line for seals is kept in `App` state `pilotAuth = { key, line }` and used only while `pilotAuth.key === signingKey` (not a property on the signing-key object: changing that object would re-run the panel's key effect and clear its messages). It is set only after a successful pilot enroll whose line passed `check()` for the loaded key. Lost on reload, like the key itself.
- "Make my pilot key" reuses `generateSigningKey`: the pilot key lives in this tab's memory as the signing key (the sealer needs the PEM), never saved or sent; a backup exists only if the pilot presses Download. Every signature this PR adds (pilot challenge, authorization) goes through the non-extractable `signerFromPem` import.
- In an org with `pilot_keys: true` the Option A note ("Only the company computer holds this key. Pilots on other devices seal with a one-time key…") is hidden, since it would be false there. An admin with a pilot key loaded still sees the company flow's "Replace with this key" (the existing flow is unchanged); its confirm dialog still guards it.
- `.pilot-step` CSS (two rules) ships in every build, including the flag-off console; it is a class name, not copy.
- Requests from the coordinating session (2026-11-19), each with its test:
  1. Nothing pilot-related renders unless `GET /v1/keys` says `pilot_keys: true`: registry-wiring "non-pilot org (orgK, pilot_keys false): no pilot string or button on Trust, for an admin with a key loaded".
  2. Compromised list, cap 500, plain "This list is full…" refusal, marks never dropped or overwritten, re-add is a no-op success, a malformed list fails closed: pilot-verify "compromised list: survives a reload, re-adding is a no-op…", "compromised list cap 500: …", "a malformed compromised list never loses entries and fails closed (never trusted)".
  3. The key request is untrusted: exactly three lines (title, `public_key=<64 lowercase hex>`, `fingerprint=<16 groups of four>`, one optional trailing newline); weak/off-curve and the loaded company key refused; the shown fingerprint is computed from the key and a disagreeing fingerprint line is refused: pilot-keys "key request: only the exact three-line format; …" and registry-wiring "authorize: a tampered or company-key request is refused; …". Clock margin `not_after = floor(now) + days·86400 − 600`, with a local clock 0, 60 and 300 s ahead of the registry checked by the registry's own Python `pilot_authorization.check`: pilot-keys "lifetime margin: …"; and the dev registry accepts a 30-day authorization: registry-wiring "30 days: …".
  4. A pilot Verified left open is re-checked at `not_after` (`pilotRecheckDelay`, clamped to 2^31−1 ms, cleared on change/unmount, in both the small-file and list paths): pilot-verify "an open pilot Verified is re-checked when the authorization ends: …" and registry-wiring "a pilot Verified left open drops to … (fake clock)". Only the Trust tick sets `pilotKeys`: profile-backup.mjs carries only the profile and workspace keys, and no module but `trusted-keys.mjs` names the pin or compromised store: trusted-keys "only the Trust tick sets pilotKeys: adding, re-adding, rotating and pinning never carry it, and no other module writes pins".
     Other writers checked: `sync-provider.mjs` only sends requests it is given and never reads or writes localStorage; `server-workspace.js` has no localStorage use; nothing in `newweb/src` iterates storage keys (`grep -rn "localStorage.key(\|Object.keys(localStorage)\|localStorage.length" newweb/src` finds nothing); `profile-backup.mjs` reads and writes only the profile and workspace keys.
  5. `not_after` years below 1000 are malformed in the browser parser (`parse()` accepted `0999` before): pilot-keys "not_after years below 1000 are malformed in the browser parser". The Python parser is unchanged (server code is out of scope); it still accepts such a year, which then reads `ended` there, so both refuse it, with different reasons.

## Plan Change Log

## Review Triage Log

### 2026-11-20 — Review pass
- verdicts: 8 findings — high 0, medium 1, low 5, false 2, maybe-false 0
- findings:
  - `[false]` `[reject]` Pilot rows and the admin Remove button are not behind `pilot_keys` — by design §4.2/§9.5 retire works whatever the switch so an admin can always revoke; rows exist only in an org that enrolled pilots while switched on, so the demo and every deployment today show none (orgK check).
  - `[medium]` `[patch]` A compromised result from the fingerprint list lost its date in the report (`compromisedAt: null`) — `manifestReport` and main.jsx `keyTrust` now take `trust.compromisedAt` first; test in `pilot-verify.test.mjs` "trustForProof reads the compromised list first…" (fails without the fix).
  - `[low]` `[reject]` After `not_after` an open chosen-company result reads "Files match · signer not confirmed" while a fresh check reads "Not verified" — both fail closed and neither is Verified; aligning them needs re-running the mismatch branch from the timer, more than a direct correction.
  - `[low]` `[patch]` `CompromisedFingerprints` did not follow other tabs — now re-reads on `usePinsVersion` (storage event).
  - `[low]` `[patch]` `PilotKeysSetting` id from the fingerprint could repeat when one key is active under two names — now `useId()`.
  - `[low]` `[patch]` AGENTS.md gate text still said 52 wiring checks and did not list `pilot-keys.test.mjs` — updated with the measured counts.
  - `[low]` `[patch]` `outbox-browser.mjs` not run against a server started with `--pilot-keys-orgs orgP` — run on the merged head (count in AGENTS.md).
  - `[false]` `[reject]` An admin without a key loaded sees "Make my pilot key" — that is the pilot step and an admin may also fly; it is its own step with one primary button, and the company flow's button stays disabled until a key is loaded.

## Design Notes

- "Make my pilot key": the browser sealer (`sealFile`) signs with the PEM held in tab memory, as for the company key, so a key whose private half can't be read could never seal. So the pilot key is generated with `generateEd25519SigningKey` and loaded as this tab's signing key: never saved, never sent, backup only if the pilot presses Download; every signature this PR adds is made through the non-extractable `signerFromPem` import. Say this plainly in the PR.
- Lifetime: `not_after = floor(now) + days·86400 − 600`, so a client clock a few minutes ahead of the registry never makes the 30-day choice `authorization_expired` (too long).
- Step 6 decision: accept a pilot proof for a chosen company only when `trustForProof` returns `trusted`, `via: 'pilot'` and the pin's fingerprint equals the chosen company's; for a typed key only when the statement's company key byte-equals it, and then the receipts are checked under the message's key. Fail closed everywhere else.
- Copy (step 7): "Signed by a pilot key {company} authorized until {date}" reads as if the company is the key's name; becomes "Signed by a pilot key that {company} authorized until {date}".

## Verification

**Commands:**
- `node --test newweb/tests/*.test.mjs` -- all pass
- `npm --prefix newweb run build && grep -l transfer docs/console/assets/hash-worker-*.js && ! grep -rl hashwing-pending docs/console` -- both greps as AGENTS.md says
- `grep -rlE "Make my pilot key|Authorize a pilot key|Enroll my pilot key|signs through pilots|hashwing-pilot-key-enroll|/v1/pilot-keys|hashwing_compromised_fingerprints" docs/console` -- finds nothing
- `npm --prefix newweb run test:browser`; `node newweb/tests/profiles.mjs` -- all pass
- `REGISTRY_DEV_URL=http://127.0.0.1:8796 node newweb/tests/registry-wiring.mjs` (dev registry: `python3 registry/devserver/server.py --port 8796 --pilot-keys-orgs orgP`) -- all pass
- `PATH=/Users/anirudhyadav/flightseal/.venv-agent/bin:$PATH node --test tests/web/*.test.mjs` -- all pass

## Auto Run Result

- Summary: Trust pilot screens (Make my pilot key, Copy key request, Enroll my pilot key; Authorize a pilot key on the company computer with fingerprint read-back and 14/30 days), pilot rows with Remove and Mark compromised, the authorization line added to seals, the recipient pilotKeys tick and the 500-entry compromised-fingerprint list, and the chosen-company and typed-key Verify paths, all behind `pilot_keys` (server) and `PILOT_AUTHORIZATION_ACCEPTED = false` (recipient pieces). Merged with main edb014a (#67, #68, #69).
- Files: `newweb/src/pilot-authorization.mjs`, `company-keys.mjs`, `company-keys.jsx`, `registry-client.mjs`, `trusted-keys.mjs`, `recipient-trust.mjs`, `main.jsx`, `style.css`; tests `pilot-keys.test.mjs` (new), `pilot-verify.test.mjs`, `trusted-keys.test.mjs`, `registry-wiring.mjs`, `pilot-on.vite.config.mjs` (new, test-only); CI; docs (R71, EXPERIENCE, design §7.2, AD-23, AGENTS.md); `docs/console` rebuilt.
- Review: 5 patches (1 medium, 4 low), 0 deferred, 3 rejected (2 false, 1 low; reasons in the triage log).
- Follow-up review recommended: false (patched: 0 high, 1 medium).
- Verification on the merged head: newweb unit 240/240; tests/web 153/153; test:browser 66, 0 failed; profiles 8/8; edge-matrix 9 ok; registry-wiring 65/65 and outbox-browser 8/8 against the dev registry on 8796 with `--pilot-keys-orgs orgP`; registry pytest 335; ctest 5/5; console rebuild clean, both greps, no new strings in the flag-off console.
- Residual risks: the pilot key and its authorization live in tab memory (lost on reload; a re-imported key has no screen to paste the line back); an open chosen-company result after `not_after` reads "signer not confirmed" while a re-run reads "Not verified" (both fail closed); Python `pilot_authorization.parse` still accepts years below 1000 (the browser refuses; the registry refuses them as ended).


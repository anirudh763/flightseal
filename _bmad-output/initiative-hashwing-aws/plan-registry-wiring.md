---
title: 'Registry wiring PR 1 of 3: outbox, sign-in, shares and Trust page behind VITE_REGISTRY_URL'
type: feature
ticket: ''
created: '2026-11-17'
status: in-progress
baseline_revision: '594fbb1c7d0d385f2063d6def0b36814cb860011'
route: full
route_source: auto
risk: high
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/docs/OUTBOX.md'
  - '{project-root}/.agents/skills/enterprise-ui-polish/SKILL.md'
warnings: [oversized, multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** The registry outbox (`newweb/src/outbox.mjs`) and client (`newweb/src/registry-client.mjs`) are merged but not used by the console. The Trusted companies panel is reachable only from the product-mode Settings page. The signing-key controls are reachable only from Samples, and the seal hints say "under Settings".

**Approach:** Add a build-time flag `VITE_REGISTRY_URL`, empty by default and in the Pages build. When it is empty, none of the registry code ships and nothing registry-related renders or fetches. When it is set, a new module `newweb/src/registry-ui.jsx` provides:
- the sign-in panel on Trust;
- the "Sealed on this device" list on Seal & send;
- the recipient share view on Verify.

`main.jsx` gets thin hooks only. The UX spec for this work is `git show origin/docs/ux-spec:_bmad-output/initiative-hashwing-aws/ux-hashwing/EXPERIENCE.md` (and its `DESIGN.md`). Follow its strings, states and the ACs listed under Acceptance.

## Boundaries & Constraints

**Always:**
- **Flag.** `vite.config.js` reads `VITE_REGISTRY_URL` and validates it the way it validates the early-access endpoint:
  - it must be https, except for a loopback host;
  - it has no credentials, query or hash;
  - the trailing `/` is stripped.

  It exposes the value as `define: { __REGISTRY_URL__ }`. It adds the URL's origin to the CSP `connect-src` rewrite (the same plugin that already handles the early-access and Supabase origins).
- **Shipping.** Every registry render and call in `main.jsx` is guarded by `__REGISTRY_URL__` used directly in the expression (for example `{__REGISTRY_URL__ && <SealedOnDevice …/>}`), so the minifier drops it. `registry-ui.jsx` has no top-level side effects.
  - The flag-off production bundle (`docs/console/**`) must not contain:
    - `Company registry`
    - `Test sign-in`
    - `Sealed on this device`
    - `hashwing-outbox`
    - `/v1/envelopes`
    - `/v1/shares`
    - `registry-test-secret`
    - `dev-hs256`
  - A test enforces this. If tree-shaking leaves any of these behind, fix how the code is structured; never weaken the test.
- **Sign-in.** It is shown only when the registry host is loopback ("Test sign-in (local only)"): a password-type textarea or input where you paste a dev token.
  - The token is held in React state plus `sessionStorage` key `hashwing-registry-token`, and nowhere else (no localStorage, no IndexedDB, no URL).
  - For a non-loopback registry, the panel says "Registry sign-in isn't available in this build yet." and has no input.
  - Org, role and sub come from the token's claims, decoded without verification. Add an exported `tokenClaims(jwt)` to `registry-client.mjs`; `tokenOwner` must use it. Roles: `admin`, or `role` / `custom:role`.
  - Show "Signed in to the company registry as {sub} · {org} · {Admin|Member}" and a "Sign out" secondary button.
- **Outbox lifecycle.** While a token with a valid owner is present: one `openOutbox({ownerId, client, getToken})` per owner, where `getToken` reads the current in-memory token.
  - Close it on registry sign-out, on a token change to another owner, and on the app's existing `logout`, `logoutFromAnotherTab` and `clearSensitiveWorkspace` paths. Closing also clears the registry token.
  - An `openOutbox` promise that resolves after the owner changed is closed at once and never used.
  - Render from `outbox.list()` on every `subscribe` notification. `status().needsSignIn` shows "Your registry sign-in has ended. Sign in again to send this." with "Sign in" (go to Trust).
- **Enqueue.** After a successful small-file seal (`runProtectSeal`, after `setProtectSealed`) and a successful large-file seal (`ManifestSeal`, after its self-check passes), call a registry hook with the **last non-empty line** of `sealed.receipts`. Only `{receipt}` goes to `enqueue`.
  - The display name (file name, or "{n} files") is kept in a memory-only `Map` keyed by receipt, never persisted. The row falls back to "Sealed item".
  - When there is no outbox (signed out), the receipt goes to an in-memory pending list shown as chip "Sealed locally" with the single action "Sign in to register". On sign-in, every pending receipt is enqueued and the list is cleared.
  - A seal never waits on or fails because of the registry: catch `enqueue` errors and show them in the list (`RangeError` → "This device's saved list is full. Export pending proofs, then try again.").
- **Chip.** Every row shows one chip whose text is the outbox `label`: "Sealed locally", "Waiting for connection", "Registering", "Registered", "Needs attention". The chip uses the existing `.status-label` classes:
  - neutral: sealed_local, waiting and registering, with static dots for registering;
  - ok: registered;
  - warn: needs_attention;
  - neutral "Hosted record deleted": disposition deleted, reason `registration_deleted`, or deleted locally.

  The chip is not a button. Each row is a `<details>`, whose summary is the whole-row control (name, "sealed {local time}", chip). One `role="status"` region per list announces "{name}: {label}" once per change. Never use `aria-live` on the chips themselves.
- **Summary line.** "{a} registered · {b} not yet registered". Queued and pending rows are never counted as registered. The detail of every non-Registered row reads "Not yet registered" only through the per-state detail lines below; "Not registered" never appears in the list.
- **Detail lines** (spec, "Registry and offline states" and "Registry errors"):
  - sealed_local: "Sealed on this device. Not sent to the registry yet."
  - waiting_for_connection: "Saved on this device. It will register when you're back online. You can close this tab." If the reason is `unavailable` or `http_503`: "The registry is temporarily unavailable. It will try again automatically." Action: "Try now" (secondary) → `retryNow(id)`.
  - registering: "Sending the receipt to the registry…" and no action.
  - registered: "Registered at {received_at}. This is the registry's statement, not proof of the files." Then the Share section.
  - needs_attention: the message is `attentionMessage(row)` when it is defined (quota). Otherwise use the reason table:
    - `key_not_enrolled`: "This signing key isn't enrolled for your company. Ask your admin to enroll it in Trust."
    - `key_not_active`: "This signing key was marked compromised or replaced, so the registry won't accept new receipts from it."
    - `conflict`: "The registry already has a different request with this ID. Export this proof and contact your admin."
    - `registration_deleted`: "This receipt's hosted record was deleted, so it can't be registered again."
    - `envelope_expired`, `epoch_mismatch` and `sub_mismatch`: "This saved request has expired. Try again to send it with a fresh request."
    - `bad_signature`, `bad_request` and `body_too_large`: "The registry couldn't check this receipt's signature. Export this proof and contact your admin."
    - `attempts_exhausted`: "This couldn't be sent after several tries. It is still saved here."
    - anything else: "The registry refused this receipt. Export this proof and contact your admin."

    Retryable reasons (`key_*`, `envelope_expired`, `epoch_mismatch`, `sub_mismatch`, `attempts_exhausted`, `quota_exceeded`) get a "Try again" secondary button → `retryNow(id)`. A collapsed "More options" in the detail shows "Technical details: {reason}".
- **Offline notice.** At the top of the list while `navigator.onLine` is false: "You're offline. Sealing and checking still work. Registrations will send when you reconnect." Track it with online/offline events. No toast or banner.
- **Export.** "More options" under the list holds "Export pending proofs". It calls `outbox.exportPending()` and downloads `hashwing-pending-proofs.json`. With no outbox, it exports the in-memory pending list in the same `{format:'hashwing-outbox-export',version:1,receipts}` shape. `{ok:false}` shows "Nothing is waiting to be registered."
- **Share links** (Registered rows only). One primary-free row:
  - "Make a share link" (secondary) calls `client.createShare({registration_id, expires_days})`. The default is 30. A collapsed "More options" holds a `<select>` with 7, 30, 90 and 365 days.
  - The link is `${location.origin}${location.pathname}#/app/verify?share=${token}`. The token lives in the fragment only and in React state only; it is never stored.
  - Then: a read-only field, "Copy link" (polite status "Link copied"; fallback: select the field), and "Withdraw link" (`client.withdrawShare(token)`). After withdrawing, the inline text reads "Link withdrawn. It no longer opens. Copies of the receipt someone already has aren't affected." and the link is removed.
  - Field hint: "Anyone with this link can see that the registry received this receipt. They still need the files and the receipt message to check the files. Links stop working after {expires_at date}."
  - Errors use one friendly sentence plus the next step.
- **Delete hosted record** (admin role only; members see no button). A native `<dialog>`:
  - title "Delete the hosted record?";
  - body as in the spec;
  - buttons "Delete hosted record" (bad style) and "Keep it" (autofocus).

  Escape cancels and focus returns to the trigger. On confirm, call the new `client.deleteRegistration(id)`. On 200 or 404, call the new `outbox.markDeleted(id)`, which rewrites the ack with `disposition: 'deleted'` through `commitAck`. The chip then reads "Hosted record deleted" and the received time is no longer shown as current.
- **Recipient view.** `#/app/verify?share=<token>` is read from `route.params` and captured into state on first render, before any URL rewrite. It is never logged or stored.
  - Call the new `client.getShare(token)`, which is `GET /v1/shares/<token>` with `auth: false` and needs no sign-in. Render a panel at the top of Verify titled "The registry's record":
    - head, count, key fingerprint (formatted with the existing `formatFingerprint`, in a wrapping `<code>`) and received time (labelled "Received by the registry", basis "the registry's clock; the registry's statement, not proof of the files");
    - the provenance line "The registry checked that this key is enrolled for the company's account. It did not check who the company is. Compare the fingerprint with one you got from the company yourself.";
    - the instruction "This record is not a check of your files. To check them, use the sealed file and the receipt message you were sent, below."
  - It never says verified or matches.
  - 404 or a malformed token: "This link doesn't open. It may have been withdrawn or expired, or it was copied incompletely. Ask the sender for a new link." Offline or network: "You're offline. Opening a link needs a connection. You can still check files." 503: "The registry is temporarily unavailable. Try the link again in a few minutes."
  - There is no other registry UI on Verify, and no sign-in prompt.
- **Trust page** (`screen === 'help'`), above "Trust and limits":
  - a panel "Trusted companies" rendering `<TrustedCompanies/>`;
  - a panel "Your signing key" rendering the same signing-key controls JSX that Samples has (extract it to one `const signingKeyControls` and render it in both places; the two screens never mount at once, so the ids stay unique);
  - with the flag on, a panel "Company registry".

  Settings keeps its Trusted companies `<details>` unchanged. The three "under Settings" hints in `main.jsx` (lines ~1497, ~1519 and ~2263) say "under Trust".
- Calm, plain, premium UI. At most one `.button.primary` per step; registry actions are secondary. 44px targets. Wrap fingerprints and hashes. Tokens only from `style.css` (`--ok`, `--warn`, `--bad`, etc.). Add the minimal new CSS (`.registry-*` rules) to `newweb/src/style.css`.

**Never:**
- Change `registry/` or `infra/`.
- Restructure the Seal & send or Verify layouts (the side-by-side panels, the "Check what you were sent" redesign, AC-06 and AC-09).
- Do data-loss fixes.
- Build "Your company's keys", enrollment or compromise UI (AC-38–40, a later PR).
- Change Verify `timeFields()` output (AC-25, later).
- Store a share token or dev token anywhere but memory and sessionStorage, or bundle a token or secret.
- Write a flag-on build into `docs/console`.
- Add dependencies.
- `git add` `_bmad/` or the `node_modules` symlinks (stage explicit paths only).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Flag off | default build | no registry text, request, or `hashwing-outbox-*` IndexedDB; Verify still shows "Registry acceptance · Not registered" | none |
| Flag on, signed out, seal | small file | row "Sealed locally" + "Sign in to register" | none |
| Sign in, then seal with enrolled key (SEED_A PEM) | orgA pilot token | Registering → Registered; detail "Registered at …" | none |
| Seal large files with enrolled key | 2 files | row registers | none |
| Offline seal, then reconnect | `context.setOffline(true)` | "Waiting for connection" + offline notice; after `setOffline(false)` → Registered without action | backoff |
| Reload while queued | page reload | row still listed after sign-in (same tab sessionStorage) | none |
| Quota | registration answered 429 `{"error":"quota_exceeded"}` (Playwright `page.route`; the devserver has no quota control) | Needs attention + `attentionMessage` text + "Try again" | no auto retry |
| Key not enrolled | ephemeral key seal | Needs attention + key_not_enrolled sentence | Try again |
| Share | Registered row | create → link with `#/app/verify?share=`; a fresh context opens it → record panel (head/count/fingerprint/received) + instruction, no sign-in | — |
| Withdraw | share made | inline withdrawn text; fresh context → generic unavailable message | — |
| Malformed or unknown link | `?share=abc` | the same generic message | — |
| Delete (admin) | Registered row, admin token | dialog "Keep it" focused; Escape cancels; confirm → "Hosted record deleted" | 404 treated as deleted |
| Member | pilot token | no Delete button | — |
| Logout / sign-out / owner switch | outbox open | `close()` called; later seals go to pending; no registration requests from the old owner after sign-out (devserver `/__dev/log`) | late results dropped |

</intent-contract>

## Code Map

- `newweb/vite.config.js` -- `define` already holds `__EARLY_ACCESS_ENDPOINT__` and others. The `hashwing-early-access-csp` plugin rewrites `connect-src 'self';`. Extend both for `__REGISTRY_URL__`. `outDir` is `../docs/console` (tracked). Tests build the flag-on console with `node_modules/.bin/vite build --outDir <tmp> --emptyOutDir` and `VITE_REGISTRY_URL` set, run from `newweb/`.
- `newweb/src/main.jsx` -- only writer is this PR.
  - `App` starts at :109; `route.params` is a `URLSearchParams`.
  - `runProtectSeal` is at :963 (`sealed.receipts`, `packed.name`).
  - `clearSensitiveWorkspace` :1068, `logout` :1088 and `logoutFromAnotherTab` :1099 are the close hooks.
  - The Settings render is :1480. The protect section is :1486–1550; append the list after the manifest section (:1548), visible only when `screen==='protect'`.
  - Verify render: grep `screen === 'verify'`.
  - The help render is :1586 (`help-layout`).
  - The signing-key JSX is inside the Samples Seal panel at :1563 (`<section className="signing-key-controls">…</section>`).
  - `ManifestSeal` is at :2179 and seals at :2216; it already takes `signingKey` as a prop, so add `onSealed`.
  - `TrustedCompanies` :1867. `download()` :97. `closeDisclosure` :35 for Escape on `<details>`.
- `newweb/src/outbox.mjs` -- reuse `openOutbox`, `attentionMessage`, `stateLabel` and `registrationLabel`. Add `markDeleted(id)`: read the ack via `store.getAck`/spill and `commitAck({...ack, disposition:'deleted', updated_at: now()})`. Return `false` if there is no ack, then emit. Keep everything else unchanged.
- `newweb/src/registry-client.mjs` -- add `tokenClaims`, `getShare(token)` (`auth:false`) and `deleteRegistration(id)` (`DELETE /v1/registrations/<id>`). `tokenOwner` delegates to `tokenClaims`.
- `newweb/src/trusted-keys.mjs` -- `formatFingerprint` for display.
- `registry/devserver/server.py` -- DEV ONLY; read-only here.
  - `/__dev/token?org=&sub=&role=`, `/__dev/log`, `/__dev/reset`, `/__dev/registrations?org=`.
  - CORS allows `http://127.0.0.1:*`. orgA has SEED_A = bytes 0..31 enrolled.
  - Ed25519 PKCS#8 PEM for a seed = DER `302e020100300506032b657004220420` + 32 seed bytes. Import it through `#private-key-file` on Trust.
- `newweb/tests/outbox-browser.mjs` -- pattern to copy for spawning the devserver (or using `REGISTRY_DEV_URL`), the browser lock (`tests/web/browser-lock.mjs`) and the Chrome path.
- `tests/web/serve.mjs` -- serves `docs/` under `/flightseal`. The new test needs its own small static server: `/flightseal/console/*` from the flag-on build dir, and everything else from `docs/`. Use `serviceWorkers: 'block'` contexts so the cached default console is never served.
- `newweb/tests/console.mjs:962`, `manifest-mode.mjs:205` and `private-lifecycle.mjs:177` depend on Settings' `.trusted-companies-details` and the signing-key button names and ids; keep them working.
- `.github/workflows/ci.yml:138-157` -- the outbox steps and the devserver on port 39102. Add the new test steps next to them.

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/vite.config.js` -- the flag, its validation, `define` and the CSP origin -- feature flag.
- [ ] `newweb/src/registry-client.mjs` + `newweb/tests/registry-client.test.mjs` -- `tokenClaims`, `getShare` and `deleteRegistration`, with unit tests (`getShare` sends no authorization header).
- [ ] `newweb/src/outbox.mjs` + `newweb/tests/outbox.test.mjs` -- `markDeleted`, with a unit test (the label becomes "Registered, later deleted" and the disposition becomes `deleted`).
- [ ] `newweb/src/registry-ui.jsx` (new) -- the registry session store (token, outbox, rows, pending, online), `RegistryPanel`, `SealedOnDevice`, `ShareRecordPanel` and `registrySealed(receipt, name)`. No top-level side effects.
- [ ] `newweb/src/main.jsx` -- the Trust panels, the extracted signing-key controls, "under Trust" hints, the flag-guarded hooks (seal ×2, logout ×3, list, panel, share view).
- [ ] `newweb/src/style.css` -- minimal `.registry-*` styles (list, row summary, chip dots, share row stacking at 320px).
- [ ] `newweb/tests/registry-wiring.mjs` (new) -- builds the flag-on console into `newweb/.test-artifacts/registry-wiring/build`, then runs Playwright against the devserver for every matrix row. It also covers:
  - the flag-off bundle scan of `docs/console`;
  - flag off in the browser: no requests to any non-same-origin URL, no `hashwing-outbox` databases (`indexedDB.databases()`), no registry text on protect/verify/help, and "Not registered" still present after a sample check;
  - Trust reachable via the "Trust" primary nav link, with "Trusted companies" and "Your signing key";
  - axe (0 violations) on protect and help with the flag on;
  - screenshots at 320, 768 and 1440 of protect (list) and help (registry panel), saved to `newweb/.test-artifacts/registry-wiring/`;
  - fails on any console error or page error.
- [ ] `.github/workflows/ci.yml`, `AGENTS.md`, `docs/OUTBOX.md` -- add the new test command and the updated unit counts. OUTBOX.md: the console now wires the modules; add contract problems found (share tokens can only be withdrawn from the tab that made them, because there is no list-shares route; the devserver has no quota control).

**Acceptance Criteria:**
- Given the default build, when the bundle is scanned and the console used, then no registry string, request or outbox DB exists, and "Registry acceptance / Not registered / no registry was used" still shows (AC-01–03).
- Given hash mode, when the user clicks Trust in the primary nav, then "Trusted companies" and "Your signing key" are on that page, and the seal hint says "under Trust" (AC-08).
- Given the flag on, each matrix row behaves as stated (AC-19–24, 26–36, 41, 42), with axe 0 violations and no console errors at 320, 768 and 1440.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

The state lives in a module-level store inside `registry-ui.jsx`, created lazily by `getRegistry()` the first time a flag-guarded caller runs. Components read it with `useSyncExternalStore`. `main.jsx` then needs only one-line calls: `registrySealed(...)`, `registryLogout()`, `<SealedOnDevice onSignIn={() => navigate('help')} />`, `<RegistryPanel />` and `<ShareRecordPanel token={…} />`. No React context and no prop threading are needed.

## Verification

**Commands:**
- `node --test newweb/tests/outbox.test.mjs newweb/tests/registry-client.test.mjs` -- all pass (45 + new).
- `node --test newweb/tests/outbox-browser.mjs` -- 8 pass.
- `npm --prefix newweb run build && node newweb/tests/registry-wiring.mjs` -- all checks pass, 0 console errors.
- `npm --prefix newweb run test:browser` and `node newweb/tests/edge-matrix.mjs` -- pass.
- `node tests/web/e2e.mjs`, `node tests/web/routes.mjs`, and the JS gate line from AGENTS.md -- pass.
- `uv run --no-project -p 3.12 --with pyulog==1.3.0 --with pytest --with pyyaml==6.0.2 python -m pytest -q` -- pass.

# Rubric review — architecture-hashwing-aws (update: AD-15 ext, AD-16, AD-17, labels, Deferred row retired)

Reviewer: independent rubric walker. Base: origin/main e279032 plus the uncommitted spine/memlog/OUTBOX.md edits.

**Verdict: PASS with fixes.** The new and changed ADs ratify the merged code line for line. No High findings. Two
Medium (one stale diagram plus doc line, one undecided owner-change rule) and three Low.

## Checklist

| Check | Result |
| --- | --- |
| Fixes the real divergence points for the level below | Yes. The build flag, loopback-only test sign-in, the cross-tab message shape and the Verify-line source are the points where the console, the outbox and the reports could disagree. All four are now ADs. One gap: in-memory proofs on a registry owner change (M2). |
| Every Rule is enforceable and prevents its divergence | AD-16: yes, `newweb/tests/registry-wiring.mjs` scans `docs/console` for forbidden strings and runs in CI (`.github/workflows/ci.yml:161`). AD-17: message shapes can be checked (`registry-session.test.mjs`). AD-15 Verify line: `registryTimeField` is pure and unit-tested. |
| Nothing under Deferred lets two units diverge | Yes. Retiring "Offline outbox wiring into the console" is correct: `main.jsx:29,159-160,995,1075,1114,1222,1561-1601,2329` wire it. The rows that remain are environment or owner gated. |
| Named tech verified-current | Versions match `infra/package.json` and `ci.yml`. Not re-checked online in this pass because this update did not change them. The Node row is incomplete (L3). |
| Ratifies, does not contradict, the brownfield code | Checked each new claim against the code: see the table below. One echo behaviour is not stated (L1). |
| Covers every ticket requirement | R1-R11 all mapped. R2, R7 and R10 now also cite AD-16 and AD-17, which is correct. |
| Altitude dimensions (deployment/envs, infra, ops) decided, deferred or open | Yes. Deployment diagram needs a fix after AD-16 (M1). |

### Code cross-check of new/changed claims

| Spine claim | Code | OK |
| --- | --- | --- |
| `__REGISTRY_URL__` from `VITE_REGISTRY_URL`: https, or http only on loopback; no creds/query/fragment | `vite.config.js:23-35` | yes |
| Every registry render/call in `main.jsx` behind the constant | `main.jsx` lines above; enforced by the bundle scan | yes |
| Test sign-in only on `localhost`/`127.0.0.1`/`[::1]`, otherwise "not available in this build" | `registry-ui.jsx:50,221,234` | yes |
| Token in tab memory + `sessionStorage` only | `registry-ui.jsx:51-52,73` | yes |
| `BroadcastChannel('hashwing-registry')`, `{type:'signout',owner}` / `{type:'logout'}`, no token | `registry-ui.jsx:85-88,165-166` | yes |
| App logout discards in-memory proofs and names in every tab; saved rows closed, not deleted | `logoutHere` `registry-ui.jsx:162`; `closeOutbox` only closes | yes |
| Verify line only from this device's saved row, with the listed strings | `registryTimeField` `registry-ui.jsx:195-207` | yes, with one wording slip (L2) |
| Flag off: "Not registered" / "no registry was used" | `recipient-trust.mjs:63` | yes |

## Findings

### M1 — Stale: the deployment diagram and the AWS doc contradict AD-16 (Medium)

- Spine, Structural Seed, Deployment diagram: `Pages[GitHub Pages static console] -. optional calls .-> G`. AD-16 says
  the Pages build has an empty URL and ships no registry code, so Pages makes no calls.
- `docs/aws/ARCHITECTURE_AWS.md:228` "Not built: ... and a console screen". The console registry screens are now built
  (flag-on builds).
- `docs/aws/ARCHITECTURE_AWS.md:165` "The console runs on another origin (GitHub Pages)". This is true only for a
  future flag-on Pages build. The default CORS origin `https://anirudh763.github.io` (`infra/lib/stack.ts:28`) serves
  no registry client today.

Fix: change the diagram node to `Pages[GitHub Pages console, no registry code: VITE_REGISTRY_URL empty]` with no edge,
and add `Dev[Flag-on console build, loopback registry only today] -. calls .-> G`. In ARCHITECTURE_AWS.md "Not built",
replace "and a console screen" with "and real (Cognito) sign-in in the console; the console's registry screens ship
only in builds with VITE_REGISTRY_URL (docs/OUTBOX.md)". At line 165 add: "the Pages build ships no registry code
today; the allowlist default is for a future flag-on Pages build."

### M2 — Undecided: in-memory proofs follow a registry owner change within one app session (Medium)

The code `registry-ui.jsx` `signIn` (around lines 118-131) takes `state.pending` and enqueues it into the *new*
owner's outbox. `signOutHere` keeps `pending`; only `logoutHere` clears it. So: seal while signed in as A's org/sub,
lose the token or sign out, sign in as B, and those proofs register under B. AD-15's "Prevents: cross-owner dispatch"
and AD-17's "one user's unsent proofs sent ... under the next user" can be read either way. A later unit could
"fix" this in either direction.

Fix (ratify the code, add to AD-17): "In-memory unsent proofs belong to the app session, not to a registry owner. A
registry sign-out keeps them, and the next registry sign-in in this tab enqueues them under that owner. Only app
logout discards them. Saved outbox rows stay bound to their owner (AD-15)." If the owner does not want this, record it
as an open question and a code change instead.

### L1 — AD-17: received logout is broadcast again (Low)

`main.jsx` `logoutFromAnotherTab` calls `registryLogout()` (line 1114), and `clearSensitiveWorkspace` calls it again
(line 1075). Each call posts `{type:'logout'}` again from every tab that received the app's local-logout message.
This is idempotent and has no loop, because registry-channel receivers do not rebroadcast. But a late echo can sign
out a tab that has just signed in again. Fix (rule text): "A tab that acts on a received logout may re-announce it.
Receivers are idempotent, and a registry sign-in made within a moment of an app logout may be signed out again."
Alternatively, change the code so a received logout never rebroadcasts.

### L2 — AD-15 / Client labels wording (Low)

AD-15 says "Not yet registered" comes "from a row". It also comes from the in-memory pending list, which is not a
saved row (`registry-ui.jsx:203`). The Client labels row also leaves out "Registered, later deleted", "Not signed
in", "Not available yet" and "No registry record on this device". Fix: in AD-15, "...or 'Not yet registered' from a
row or this tab's unsent in-memory list". In Client labels, add "Verify-line values per AD-15".

### L3 — Stack: Node version incomplete (Low)

The `wasm-console` CI job, which runs `outbox.test`, `registry-session.test`, `outbox-browser` and
`registry-wiring`, uses Node 24 (`ci.yml:117`). The spine says "Node.js (CI, infra) 22". Fix: "Node.js 22 (infra and
most CI jobs); 24 (console job, which runs the registry client tests)".

## Not findings (checked)

- The Deferred removal is sound. Nothing else in the spine still says the console doesn't use the outbox. `docs/OUTBOX.md` is already
  current (intro lines 5-8, Limits entry for lost in-memory proofs).
- Real Cognito sign-in in the console is named in AD-16 as "needs its own change". Consider a Deferred row so it is
  tracked like the other real-AWS items. This is optional.

---
title: 'Design: company key enrollment on Trust, and pilot signing Option B'
status: draft
created: '2026-11-19'
binds: [AC-37, AC-38, AC-39, AC-40, AC-59, R24, R33, R34, R35, R71, R75]
spine: architecture-hashwing-aws/architecture-hashwing-aws.md (AD-4 amended, AD-21 to AD-24)
---

# Company key enrollment and pilot signing Option B

Design only. No product code. Registry stays off on public Pages (AD-16); no AWS deploy (AD-12, AD-13).
`[ASSUMPTION]` marks a choice the existing docs don't make; each is the conservative one.

## 1. Owner decisions this builds on (binding)

- **Option A for the supervised pilot.** One designated company computer holds the company signing key (backup under the
  signer's control). It is never copied to pilots' devices. Other pilots' one-time keys read "signer not confirmed" and
  the registry refuses them (`key_not_enrolled`).
- **Strict Verified.** Valid signature + every required file matches + complete coverage + an independently confirmed,
  trusted, uncompromised key. Registry state never gives Verified.
- **Private keys never leave the device that made them.** No route accepts private-key material.
- **Option B is built before independent company signing from several pilots is offered. Option A stays the default
  until B is switched on.**

## 2. What Option A and Option B are

| | Option A (today, default) | Option B (built later, off by default) |
| --- | --- | --- |
| Who signs company receipts | Only the designated company computer, with the company key | The company computer, **plus** pilots whose own key the company key has authorized |
| Keys in the registry per org | One active company key (`ACTIVE_KEY`) | One active company key, plus up to 50 active pilot keys `[ASSUMPTION]` |
| Who authorizes a pilot key | Nobody: not possible | The company key itself, by signing an **authorization** on the company computer. An admin role alone can't do it |
| What a recipient pins | The company key | The company key only. A pilot's proof carries its authorization, which Verify checks against that pin |
| Pilot private key | Not used (one-time keys only) | Made on the pilot's device, stays there; backup PEM under the pilot's control |

Option B is **company-key delegation**, not "admin approves many keys". Reason: a recipient only trusts what they can
check against their own pin, and a registry admin (or stolen admin sign-in) must not be able to mint signers.

## 3. PR split

| PR | Scope | Depends on |
| --- | --- | --- |
| **PR 1 — Company keys on Trust (Option A)** | Registry fixes (§4.1), client key methods, Trust "Your company's keys" (§6), four Trust headings, R71 Trust copy, RUNBOOK "How pilots sign" made final | none |
| **PR 2 — Verify and pins** | AC-37 "Matches the registry's record" as a downgrade-only step (§7.1), R34 pin attestation, R35 compromised-mark persistence, R75 test | PR 1 (shares the key-state labels) |
| **PR 3 — Option B behind two off switches** | Authorization format (Python + JS, shared vectors), pilot-key routes, register checks, restore changes, Trust pilot UI, Verify delegated path | PR 2 (R34 must land before any pin can anchor a delegated Verified) |

Each PR updates `docs/aws/ARCHITECTURE_AWS.md`, `THREAT_MODEL.md` and `infra/lib/stack.ts` ROUTES where it touches them
(AD-2: a stored field and its doc change land in the same PR).

## 4. API changes

### 4.1 PR 1 — existing routes, small fixes

| Route | Change | Why |
| --- | --- | --- |
| `POST /v1/keys/<fp>/compromised` (admin) | Already compromised: 200 with the stored `changed_at`, no write. Response gains `changed_at` | Today each call rewrites `changed_at` and a new tombstone `at`, so the compromise date moves |
| `GET /v1/keys` (member) | Each row gains `enrolled_by_me` (bool, `enrolled_by == caller sub`). `sub` is never returned. Response gains `next_cursor` (page 50, as today's `PAGE`) | "Enrolled {date} by you" (EXPERIENCE); bounded list |
| `GET /v1/keys/challenge`, `POST /v1/keys` | No change. Still admin-only, 5-minute, single-use, bound to the admin's `sub` | AD-4 |

**Enroll, from the browser.** The admin loads the company key under "Your signing key" on the designated computer.
"Enroll this key": `GET /v1/keys/challenge` → sign `message` in the browser (WebCrypto `importKey` pkcs8,
non-extractable, `sign`) → `POST /v1/keys {public_key, nonce, signature, confirm_replace?}`. Only the public key and
signature leave the device.

**Idempotency (no new idempotency key; the challenge is the guard):**
- Lost response, then retry: the server answers 409 `key_exists` (checked before the transaction). The client then
  calls `GET /v1/keys`; if that fingerprint is `active`, it shows success. Otherwise "This key was enrolled before and
  can't be enrolled again" (a retired fingerprint is never re-used).
- 400 `bad_challenge` (expired or used): the client gets one fresh challenge and asks the user to press again. No
  automatic loop.
- Compromise retry: 200 with the original `changed_at` (fix above).

**Errors the UI maps** (raw codes only under "More options", AC-29): 401, 403 `forbidden` (not an admin),
409 `confirm_required` (opens the replace confirmation), 409 `key_exists`, 409 `conflict` (a race: reload the list),
400 `bad_challenge`, 422 `bad_signature` (also covers weak keys, `test_small_order_key_is_rejected_and_cannot_be_enrolled`),
404 on compromise (unknown or another org's fingerprint, identical body), 503.

### 4.2 PR 3 — Option B routes (all new; 403 `pilot_keys_off` unless the org is switched on)

Authorization statement (signed by the company key on the company computer):

```
hashwing-pilot-authorization v1
pilot_key=<64 hex raw public key>
company_key=<64 hex raw public key>
not_after=<YYYY-MM-DDTHH:MM:SSZ>
```

Signed bytes are exactly those four lines joined by `\n`, no trailing newline. The prefix differs from
`fseal-receipt v1` (receipt) and `hashwing-key-enroll v1` (challenge), so no signature crosses formats. `not_after` is at
most 90 days after signing, default 30 `[ASSUMPTION]`. It carries no names, org id or pilot identity. It travels as one
line in the receipt message, `Authorized by company key: <base64url of the four lines>.<128 hex sig>`; receipt v1 itself is
unchanged (`receipt.parse` rejects extra tokens).

| Route | Who | Request | Response | Errors |
| --- | --- | --- | --- | --- |
| `GET /v1/pilot-keys/challenge` | any member | none | `{nonce, expires_at, message}`; `message` = `hashwing-pilot-key-enroll v1\n<org>\n<nonce>` | 403 `pilot_keys_off` |
| `POST /v1/pilot-keys` | any member (the pilot, on their own device) | `{public_key, nonce, signature, authorization, authorization_sig}` | 201 `{key_fingerprint, kind:"pilot", state:"active", company_fingerprint, not_after}` | 400 `bad_challenge` (missing, expired, other `sub`, or a company-kind challenge); 422 `bad_signature` (challenge not signed by `public_key`, or weak key); 422 `bad_authorization` (unparsable, `pilot_key` ≠ `public_key`, signature not by `company_key`); 422 `authorization_expired` (`not_after` ≤ registry clock, or > 90 days ahead); 422 `company_key_not_active` (`company_key` is not this org's `ACTIVE_KEY`); 409 `key_exists` (fingerprint ever seen in this org, any state); 409 `pilot_key_limit` |
| `POST /v1/pilot-keys/<fp>/retire` | admin | `{}` | 200 `{key_fingerprint, state:"retired", changed_at}`; already retired or compromised: 200 with stored state, no write | 404 unknown/other org/not a pilot key |
| `POST /v1/keys/<fp>/compromised` | admin | unchanged | unchanged; works for both kinds | unchanged |
| `GET /v1/keys` | member | unchanged | rows gain `kind` (`company`/`pilot`), and for pilot keys `company_fingerprint`, `not_after`. Response gains `pilot_keys` (bool, org switched on) | unchanged |

- Challenge items gain `kind` (`company` or `pilot`); each enroll route accepts only its own kind.
- Pilot keys never go through `POST /v1/keys`: that route rotates `ACTIVE_KEY`.
- **Renewal** = a new pilot key and a new authorization, not an extended one `[ASSUMPTION]`. It needs no fingerprint
  re-use rules and keeps authorizations immutable.
- **Register path** (`POST /v1/registrations`), after today's checks: a `pilot` KEY item is accepted only when the org
  is switched on, its state is `active`, its `not_after` > registry clock, and its parent company KEY item is `active`
  (read on each request, no fan-out). Otherwise 403 `key_not_active`, which the outbox already handles (AD-15). With
  the switch off the path behaves exactly as today.
- **Switch (server):** `PILOT_KEYS_ORGS`, an operator-set allow-list env var like the onboarding allow-list. Empty by
  default. Not settable through any route `[ASSUMPTION]`.

## 5. Data model

| Item | PR | Fields |
| --- | --- | --- |
| `ORG#o / KEY#<fp>` | 3 | add `kind` (missing = `company`), and for pilot keys `company_fp`, `not_after`. No public key stored (AD-2) |
| `ORG#o / CHAL#<nonce>` | 3 | add `kind` |
| `TOMB#<org>#KEY#<fp>` | 3 | add `kind`, `company_fp`, `not_after`, so a restore brings a pilot key back with them; new state `retired` |
| `ORG#o / ACTIVE_KEY` | — | unchanged; company keys only |

Key states: `active` < `rotated` < `retired` < `compromised` (most revoked wins, AD-20). `retired` is for pilot keys
only. Display: "Active", "Replaced on {date}", "Removed on {date}", "Marked compromised on {date}".

Restore (PR 3): `registry.restore` recomputes `ACTIVE_KEY` from **company** keys only. Today it demotes every other
active key to `rotated` (`restore.py:68-81`), which would wrongly rotate every pilot key.

## 6. Trust page (R24: four sections)

Order: **Trusted companies**, **Your signing key**, **Company registry** (sign-in, flag on), **Your company's keys**
(flag on). Flag off: the last two are absent and Trust and limits says "Company sign-in isn't part of this copy of
HashWing." (AC-50). One primary button per section.

**Your company's keys (PR 1):**
- Empty: "No company key enrolled yet." Admins on a computer with a loaded key also see **Enroll this key**. With no key
  loaded, the button is disabled with "Load your company's signing key under Your signing key first."
- List: fingerprint (groups of four, Copy), state label, "Enrolled {date}" plus "by you" when `enrolled_by_me`.
  `rotated` shows "Replaced on {date}"; the string "rotated" never appears (AC-38).
- Admins: **Enroll this key**, **Replace with this key** (shown when another key is active; confirm dialog, safe choice
  focused), **Mark compromised** (confirm: "New receipts signed with it will be refused. Older proofs from it will show a
  warning."). Members: read-only (AC-39). The server enforces roles regardless.
- Offline: actions disabled, "You're offline. Key changes need a connection." (AC-40).
- Option A note under the list (R71): "Only the company computer holds this key. Pilots on other devices seal with a
  one-time key, which reads 'signer not confirmed'."

**Option B additions (PR 3, shown only when `pilot_keys` is true):**
- Pilot's device: **Make my pilot key** (generated here, backup PEM download) → **Copy key request** (public key and
  fingerprint only) → paste the authorization the company computer gives back → **Enroll my pilot key**.
- Company computer (company key loaded): **Authorize a pilot key**: paste the request, confirm the full fingerprint with the
  pilot by phone or in person ("Read it back to the pilot. Don't authorize a key from the same message alone."), pick
  30 or 90 days, sign, copy the authorization back.
- List adds "Pilot key, authorized until {date}" rows; admins get **Remove** (retire) and **Mark compromised**.

## 7. Verify (strict Verified, never from the registry)

### 7.1 Registry record line (PR 2, AC-37)

Only when Verify was opened from a share link (`GET /v1/shares/<token>`). Separate from AD-15's "Registry acceptance"
line, which comes from this device's outbox.

- `verdict()` stays registry-free. A new pure step `applyRegistryRecord(result, record, receipt)` runs after it.
- Head, count and key fingerprint all equal: line "Matches the registry's record". The headline is unchanged.
- Any differ: warn line "Doesn't match the registry's record for this link". A `verified` result becomes `warn`,
  headline "Files match · doesn't match the link" `[ASSUMPTION copy]`; other results are unchanged.
- The step can only lower a result, never raise one (property test over every verdict key).

### 7.2 How each case reads

| Case | Headline | Key trust line |
| --- | --- | --- |
| Company key pinned, active, files complete | Verified | existing trusted line |
| One-time key (Option A pilot) | Files match · signer not confirmed | existing untrusted line |
| Registry says enrolled/registered, key not pinned | Files match · signer not confirmed | registry line is info only |
| Key marked compromised locally (any seal time) | Signed by a key marked compromised | "Marked compromised on {date}"; never "before compromise" (R75) |
| Share record mismatch | Files match · doesn't match the link | §7.1 |
| **B on:** pilot key, valid authorization by a pinned active company key, `not_after` after the verifier's clock, neither key marked compromised | Verified | "Signed by a pilot key {company} authorized until {date}" |
| **B on:** authorization ended (verifier's clock past `not_after`) | Files match · signer not confirmed | "The company's authorization for this pilot key ended on {date}. Ask the company." |
| **B on:** company key replaced in the pin list | Files match · signer not confirmed | existing replaced line |
| **B on:** company key or pilot key marked compromised locally | Signed by a key marked compromised | compromised line |
| **B on:** authorization missing, malformed, or signed by another key | Files match · signer not confirmed | untrusted line |
| **B off** (default, including Pages): any authorization line | ignored: Files match · signer not confirmed | untrusted line |

- `not_after` is compared with the verifier's clock (Verify) or the registry's clock (register), **never with the
  seal time** or any sender-supplied time (R75).
- Switch (client): `PILOT_AUTHORIZATION_ACCEPTED = false` in `recipient-trust.mjs`, next to
  `VERIFIED_NEEDS_TRUSTED_KEY`. It is a build constant, so it covers the Pages build too. Owner turns both switches on
  together.
- The CLI (`src/fseal.cpp`) and `docs/verifier.js` don't read authorizations: a pilot-key proof is UNVERIFIED against the
  company key (fails closed). Adding them is deferred.

## 8. Threat cases

| Threat | Result | How |
| --- | --- | --- |
| Rogue admin, or stolen admin sign-in, Option A | Can replace the company key in the registry, or mark it compromised (denial of service). Recipients are unaffected: their pin is the real key, so attacker receipts read "signer not confirmed" | AD-4; the change shows on the list as "Replaced on"; no notification `[open question 3]` |
| Rogue admin, Option B | Can't create a pilot signer: an authorization needs the company key. Can retire or compromise pilot keys (denial of service only) | §4.2 |
| Stolen pilot key | Registry: refused once an admin marks it compromised or retires it. Recipients: still reads Verified until `not_after` (≤ 90 days, default 30), or until the recipient marks that fingerprint compromised after the company tells them. **Recipients never see registry key state.** | Residual risk, bounded by `not_after` |
| Stolen company key | Everything signed by it, including new authorizations, is forgeable until marked compromised and recipients mark it too | Existing THREAT_MODEL row ("Steal the signing key") |
| Company key replaced (normal) | Registry: pilot keys under it stop registering (parent not active); pilots need a new key and authorization. Recipients: once they re-pin, the old company key reads "replaced", so its pilots' proofs read "signer not confirmed" | §4.2 parent check |
| Company key compromised | Registry: same as replaced, plus `key_not_active`. Recipients who mark it: every proof under it, pilot or company, reads "Signed by a key marked compromised" | No fan-out writes |
| Challenge replay | Refused | Single use, 5 minutes, bound to `sub` and `kind` |
| Authorization replay after retirement | Refused | A fingerprint once seen in an org is never enrolled again (409 `key_exists`); tombstones keep it after a restore |
| Authorization reused in another org | Refused unless that org's active company key is the same key | `company_key` must equal the org's `ACTIVE_KEY` |
| Cross-format signature reuse | Refused | Distinct prefixes for receipt, company challenge, pilot challenge and authorization |
| Substituted pilot public key in the request message | Caught by the company signer | Full fingerprint read back out of band before signing |
| Weak pilot key | Refused on the company computer and by the registry | DECISIONS 23 |
| Compromise timing | No screen or report says a signature "predates" a compromise. Registry `received_at` and the compromise `changed_at` are shown as registry-clock facts, without a verdict | R75, AD-14 |
| Private key leaves a device | Refused | `test_no_route_accepts_private_key_material` extended to the new routes |

## 9. Migration from Option A to Option B

1. Nothing changes until the owner switches an org on (`PILOT_KEYS_ORGS`) **and** ships the client constant.
2. The company key stays the one `ACTIVE_KEY`. No re-enrollment.
3. Existing one-time-key proofs stay "signer not confirmed". Nothing is retroactively authorized (one-time keys are
   discarded).
4. Recipients pin nothing new; they need a build with the constant on.
5. Switching an org off: pilot routes answer `pilot_keys_off`, pilot keys answer `key_not_active` on register, and the
   data is kept. Recipients' Verify still honours unexpired authorizations while the constant is on.

## 10. Test plan

**PR 1, registry pytest:** compromise twice → second is 200 with the same `changed_at` and no new write; `list_keys`
has `enrolled_by_me` and never a `sub`; member gets 403 on challenge, enroll and compromise; another org's fingerprint
is 404; retry after a lost enroll response → 409 `key_exists` and the list shows it `active`; private-key fields refused.
**PR 1, browser (`newweb/tests/registry-wiring.mjs`, loopback dev registry):** admin enrolls the loaded key → Active
"by you"; replace → old row "Replaced on", no "rotated" anywhere in the DOM; Mark compromised dialog focuses the safe
choice and Escape cancels; member sees no actions; offline disables actions with the reason; four Trust headings
(AC-59); a `key_not_enrolled` row reaches Registered after enroll and Try again; flag-off build has neither registry
section.

**PR 2, unit:** `applyRegistryRecord` never raises any verdict; match line; each field mismatch lowers Verified.
Both pin paths refuse without a source and an attestation (R34). A compromised mark survives reload and backup import
(R35). A compromised key with an earlier "Sealed at" reads "Marked compromised" and no report contains "before" next
to compromise (R75). **Browser:** share link with matching and mismatched receipts.

**PR 3, shared vectors** (`tests/fixtures/pilot-authorization.json`, checked by Python and JS): valid; wrong prefix;
trailing newline; `pilot_key` mismatch; signed by another key; weak pilot key; `not_after` > 90 days.
**Registry pytest:** org off → 403 `pilot_keys_off` and register unchanged; company challenge can't enroll a pilot
key and the reverse; authorization by a rotated or other key → 422 `company_key_not_active`; register with an active
pilot key → 201; with `not_after` past, retired, compromised, or parent rotated/compromised → 403 `key_not_active`;
re-enroll a retired fingerprint → 409; limit → 409; restore keeps pilot keys `active` and recomputes `ACTIVE_KEY` from
company keys only; merge order includes `retired`.
**Unit (`recipient-trust`):** every row of §7.2; constant off ignores the line; seal time is never read (seal time before
`not_after`, verifier clock after → not confirmed). **Browser:** pilot key request → authorization → enroll →
registered → Verify on a constant-on build.

## 11. Open questions (for the owner)

1. Authorization lifetime: 30 days default, 90 max `[ASSUMPTION]`. Honest old proofs lose Verified when it lapses
   (they read "signer not confirmed" with the end date). Longer lifetimes widen the stolen-pilot-key window.
2. Should recipients get a downgrade-only "this key was marked compromised" signal from the registry (for example on
   the share view)? Today they don't (AD-9 minimal disclosure), so revocation reaches them only through the company.
3. Should a company key replacement or compromise notify the org's other admins? Nothing does today.
4. Pilot key cap per org (50 `[ASSUMPTION]`).

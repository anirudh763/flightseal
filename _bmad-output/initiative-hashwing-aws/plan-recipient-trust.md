---
title: 'Recipient trust: trusted companies, time provenance, bytes differ and edited copies (browser)'
type: feature
ticket: ''
created: '2026-11-17'
status: in-progress
baseline_revision: '96e7e7430638a8c2f453dd4e0944fbf4a997ef58'
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
  - '{project-root}/DESIGN.md'
  - '{project-root}/.agents/skills/enterprise-ui-polish/SKILL.md'
  - '{project-root}/docs/MANIFEST_MODE.md'
warnings: [oversized, multiple-goals]
deferred: []
---

<intent-contract>

## Intent

**Problem:** A recipient checking a HashWing proof cannot tell "signed by a company I trust" from "signed by some key", cannot see where each time comes from, and a hash mismatch has no neutral explanation or way to seal an edited copy with a link to its original. Reports carry none of this.

**Approach:** Extend the existing local pin store (`trusted-keys.mjs`) into a trusted-companies list with provenance and history; add a pure `recipient-trust.mjs` for note tags, time fields, intervals, trust wording and the bytes-differ text; wire these into the Settings screen, both check paths, the Verify result and every report export, without changing any sealed format.

## Boundaries & Constraints

**Always:**
- Browser only. No server, no upload, no new dependency. Private signing keys are never stored or sent anywhere new.
- The format stays the same: `docs/manifest.mjs`, `docs/rawfile.js`, `docs/verifier.js` and the C++ core are untouched.
- Manifest mode puts the operator values inside each item's signed `note`, using a tag prefix: `[reported-landing=<ISO>]`, `[derived-from=<text>]`, then the free-text note. The tags count toward the 1,000-byte note limit.
- Embedded mode has no signed slot. Reported landing time goes in an extra handover line, `Reported landing time: <ISO> (operator-entered, not signed, not verified)`, and is labelled unsigned wherever it is shown.
- Seal time is taken from the handover `Sealed:` line in both modes and labelled "this computer's clock, not verified; from the receipt message, not signed".
- A key that travels inside the receipt message is never trusted just because it is there. It counts as trusted only when its SHA-256 fingerprint equals an active pin the user added.
- Copy is plain, calm and short. Advanced material goes behind "More options" or "What is this?". Controls have 44px targets, labels for every input, and in-page confirms (no `window.confirm`). Layouts are checked at 320, 768 and 1440 px with no horizontal scroll.
- Existing reports stay backward compatible: add lines and JSON keys, never rename or remove them.

**Never:**
- No verified-delay badge, no clamping of a negative interval to zero, no perceptual matching, and no statement that two different byte sequences are identical.
- No edits under `registry/` or `infra/`. Never stage `_bmad/` or the `node_modules` symlinks.
- Leave the chain-verdict labels (`Checksum mismatch`, `Hash link mismatch` and the rest) unchanged; they are verifier verdicts.
- Never clutter the main Seal & send path: new seal inputs go under More options.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Add company | name, fingerprint (spaces, colons or a `SHA-256:` prefix allowed), source | Saved as active, shown in 4-hex groups with its source | No source, bad hex, or a name over 80 chars gives a friendly error and saves nothing |
| Replace, not confirmed | same name, different fingerprint | Throws `code: 'replace-needs-confirm'` naming the old grouped fingerprint; store unchanged | UI shows an in-page "Replace key" / "Keep current key" choice |
| Replace, confirmed | `confirmReplace: true` | Old entry becomes `status: 'replaced'` with `replacedAt`; new entry is active; history keeps both | — |
| Mark compromised | name and fingerprint of an entry | That entry gets `status: 'compromised'` and `compromisedAt` | Unknown entry throws |
| Legacy pin | `{name, publicKey, fingerprint}` only | Read as active, `source: 'not-recorded'` | — |
| Trust lookup | public key hex | `trusted` (with entry) / `replaced` / `compromised` / `untrusted` | Invalid key gives `untrusted` |
| Interval | landing and sealed ISO strings | `{ms, text}`, with "reported" in the text; a negative value is kept negative and explained | Either value missing or invalid gives `Unknown` |
| Note tags | compose then parse | Round trip; plain notes parse to `{note}` only | `[` or `]` in derived-from is rejected with a friendly message |

</intent-contract>

## Code Map

- `newweb/src/trusted-keys.mjs` -- local pin store, key `flightseal_trusted_keys_v1`, used only by `main.jsx` (`listTrustedKeys`, `pinTrustedKey` at the `TrustedKeyPinControls` around main.jsx:1745). `listTrustedKeys` strips entries to three fields; extend it. Keep the existing exports and their test (`newweb/tests/trusted-keys.test.mjs`) passing. Raise `MAX_KEYS` to 64 (history counts). `removeTrustedKey` removes every entry with that name.
- `newweb/src/report-pdf.mjs` -- `fingerprintPublicKey` and `createIntegrityPdf({title, lines})`; lines that start with `## ` become headings. Reuse it for the manifest-check PDF.
- `docs/manifest.mjs` (read-only) -- `verifySealedManifest(blob, text, trustedKey)` rejects with "The receipt was not signed by the trusted public key." on the wrong key; `compareFiles` gives `bytes-differ` only when names are included and equal; `manifestHandoverText` writes `Sealed: <ISO> (...)`. `MANIFEST_LIMITS.maxNoteBytes` is 1000.
- `docs/rawfile.js` (read-only) -- `handoverText`, `parseHandover` (returns `publicKey` from the receipt or stated key), `recordsToFile` (returns `matches` and `actualSha256`), `sha256Hex`.
- `newweb/src/main.jsx`:
  - `runProtectSeal` (~955) and `runProtectCheck` (~987): the embedded flow. The check trusts the message key, which is PR #20 behaviour; keep it and add the trust status.
  - The restored panel (~1462): "Recovered file does not match" becomes Bytes differ.
  - `reportText`, `reportJson` and `reportMarkdown` (~1211–1243), and the PDF `lines` (~1255).
  - Settings screen (~1427): add a `<details className="report-details">` "Trusted companies" next to the profiles one.
  - `ResultPanel` (~1956): keep the heading text, because tests wait on "Intact".
  - `ManifestSeal` (~2014): `itemsFor` builds the notes; the precheck at the start of `seal` must use the same tag lengths.
  - `ManifestCheck` (~2110): result table and the bytes-differ note (~2161).
- `newweb/tests/manifest-mode.mjs` -- a real Chrome manifest flow with a `layout()` helper (axe, overflow, screenshots). It asserts the old bytes-differ sentence at line 146; update it to the new text.
- `newweb/tests/console.mjs` -- the Seal & send embedded test at ~891, with the `waitResult` and `auditAxe` helpers.

## Tasks & Acceptance

**Execution:**
- [ ] `newweb/src/trusted-keys.mjs` -- Entries are `{name, publicKey ('' when added by fingerprint), fingerprint, source, addedAt, status, replacedAt?, compromisedAt?}`, and `read()` accepts the legacy shape.
  - Export `SOURCES`: `{ website: 'company website you already knew', contract: 'contract or invoice', phone: 'phone call with a known contact', other: 'other', 'not-recorded': 'not recorded' }`.
  - Export `normalizeFingerprint`, `formatFingerprint` (16 groups of 4), and `addTrustedCompany(name, fingerprint, {source, confirmReplace, now, storage})`, which throws `{code: 'replace-needs-confirm'}`.
  - Export `markCompromised(name, fingerprint, opts)`, `listTrustedHistory()` (all entries), and `async trustForKey(publicKey, opts)`.
  - `pinTrustedKey` takes an optional `source`, keeps history on a confirmed rotation, and keeps its existing behaviour.
  - `listTrustedKeys` returns active entries only.
- [ ] `newweb/src/recipient-trust.mjs` (new, pure) -- Export these:
  - `composeNote` and `parseNote`.
  - `toIsoFromLocal(datetimeLocalValue)`, which returns an offset-free UTC ISO string or ''.
  - `reportedInterval(landingIso, sealedIso)`.
  - `timeFields({landing, landingSigned, sealedAt})`, which returns `[{label, value, basis}]` for: Reported landing time; Sealed on this computer at; Registry acceptance = `Not registered`; Trusted timestamp = `None`; Reported landing-to-seal interval.
  - `parseSealedLine(text)` and `parseLandingLine(text)`.
  - `trustLine(trust, sources)`, which gives exactly these strings:
    - "Signed by a key you trust: <company> (added from <source>)"
    - "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know."
    - "Signed by a key you marked as compromised: <company>. Don't rely on this proof without checking with the company."
    - "Signed by a key that was replaced for <company> on <date>. Ask the company whether proofs from that key are still valid."
    - Wrong-key and invalid-signature lines.
  - `BYTES_DIFFER`: the "Bytes differ" title plus the neutral explanation: editing, re-saving, metadata changes, recompression, truncation or corruption can cause it; it is not proof of tampering, and HashWing doesn't pick a cause. Ask for the original file, or an archive that keeps the original bytes.
  - `manifestReport({...})`, which returns `{text, markdown, json, pdfLines}`.
- [ ] `newweb/src/main.jsx`:
  - (a) `TrustedCompanies` panel in Settings: add form (name, mono fingerprint input, a required radio group "Where did you get this fingerprint?", one primary "Add company" button), in-page replace confirm, an active list with grouped fingerprint, source and date plus "Mark as compromised" (in-page confirm), a "Key history" disclosure, a "What is this?" disclosure, and a removal action.
  - (b) `TrustedKeyPinControls`: add a required source select, replace `window.confirm` with an in-page confirm, and list active pins that have a public key.
  - (c) Embedded seal: More options holds a `datetime-local` "Reported landing time"; when it is set, append the unsigned line to the handover. Show the sender's own key fingerprint (grouped) on the handover in both modes.
  - (d) Embedded check: show a trust status from `trustForKey(message key)` and the time fields parsed from the pasted message. Replace "Recovered file does not match" with Bytes differ. Add a "Compare with a copy you have" file input under More options, giving Matches or Bytes differ by SHA-256.
  - (e) Verify-screen result: show the trust status when receipts were checked against a key.
  - (f) Reports: text, Markdown, JSON (structured `keyTrust`, `timeProvenance`, `fileComparison`) and PDF get the trust line plus source, the time fields with their labels, and the bytes-differ wording.
  - (g) `ManifestSeal` More options: one "Reported landing time" for all items, and per file a checkbox "This is an edited copy" that shows "Derived from (the original's item number or SHA-256 fingerprint)". Both are encoded with `composeNote`.
  - (h) `ManifestCheck`:
    - If the key field is empty and the receipt's key fingerprint equals an active pin, use that key.
    - Show the trust line (trusted / not in your list / replaced / compromised; the wrong-key reject stays) and the time fields from the signed notes and the handover.
    - Show "Edited copy of: … (operator-entered, signed)".
    - Show the new bytes-differ text.
    - Add Download report buttons: text, Markdown, JSON and PDF.
- [ ] `newweb/src/style.css` -- Style the companies panel, the fingerprint groups (mono, wrapping), the time-fields `dl`, the trust-line status shapes and the confirm boxes, using the existing tokens. Keep 44px targets.
- [ ] `newweb/tests/trusted-keys.test.mjs`, `newweb/tests/recipient-trust.test.mjs` -- Unit-test every matrix row.
- [ ] `newweb/tests/manifest-mode.mjs`:
  - Check: trusted company (fingerprint pin, empty key field) vs untrusted (typed key) vs wrong key vs compromised.
  - Check: a negative reported interval is shown as negative, and there is no "verified" delay text.
  - Check: a re-encoded fixture (the same text with LF changed to CRLF plus a BOM, same file name, names included) shows Bytes differ with the new wording.
  - Check: the derivative flow (edited copy sealed with derived-from; the check shows the link and never says identical).
  - Check: the Settings Trusted companies panel goes through add, replace-confirm, history and compromised, then axe and screenshots at 320, 768 and 1440 px.
- [ ] `newweb/tests/console.mjs` -- In the embedded Seal & send test: the untrusted line before pinning, the trusted line after pinning the sender's fingerprint, the unsigned landing line and time fields, and "Bytes differ" from comparing a changed copy.
- [ ] `.github/workflows/ci.yml` -- Add `node --test tests/trusted-keys.test.mjs tests/recipient-trust.test.mjs` to the newweb step.
- [ ] `docs/MANIFEST_MODE.md` -- Document the note-tag convention and the fingerprint-pin rule. Rebuild `docs/console/` with `npm --prefix newweb run build` and commit the generated assets.

**Acceptance Criteria:**
- Given a company pinned by fingerprint with source "contract or invoice", when a manifest signed by that key is checked with the key field empty, then the page says "Signed by a key you trust: <company> (added from contract or invoice)".
- Given a typed key that is not pinned, when the check passes, then the page says "Valid signature, but this key isn't in your trusted list…".
- Given the wrong key, then "Manifest not verified" appears and no items are shown.
- Given a reported landing time later than the seal time, when the result shows, then the interval reads as negative with "reported" and no "verified" delay wording appears.
- Given any export from a check, then it contains the trust line, the source, every time field with its label, and the Bytes differ wording where it applies; the older keys and lines are still there.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Fingerprint-only pins are sound: the trust anchor is the pinned SHA-256 of the key, which the user obtained out of band. A receipt key whose fingerprint equals it is cryptographically that key. Without a matching pin, a message key is "not in your trusted list", never "trusted".

Example note: `[reported-landing=2026-11-17T09:58:00.000Z][derived-from=item 2, sha256 ab12…] Cropped for the client`

## Verification

**Commands:**
- `node --test newweb/tests/trusted-keys.test.mjs newweb/tests/recipient-trust.test.mjs newweb/tests/report-pdf.test.mjs` -- all pass
- `node --test tests/web/verifier.test.mjs tests/web/copy.test.mjs tests/web/workbench.test.mjs tests/web/redirect.test.mjs tests/web/rawfile.test.mjs tests/web/sw-cache-index.test.mjs tests/web/manifest.test.mjs` -- 139 pass
- `npm --prefix newweb run build && npm --prefix newweb run test:browser` -- every check ok
- `node newweb/tests/edge-matrix.mjs`, `node tests/web/e2e.mjs`, `node tests/web/routes.mjs` -- all pass
- Wasm `node --test tests/wasm/bridge.test.mjs tests/wasm/enterprise-edge.test.mjs tests/wasm/hash.test.mjs tests/wasm/browser.test.mjs tests/wasm/hash-browser.test.mjs`; `python3 -m pytest -q` -- unchanged pass counts

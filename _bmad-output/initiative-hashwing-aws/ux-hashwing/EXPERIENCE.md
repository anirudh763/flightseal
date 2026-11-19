---
name: HashWing
status: in-review
updated: 2026-11-17
# Release layout locked 2026-11-17 against main b2cec46 (owner brief Phase A); revised after the PR #35 reviews.
sources:
  - ../../../newweb/src/main.jsx
  - ../../../newweb/src/recipient-trust.mjs
  - ../../../newweb/src/trusted-keys.mjs
  - ../../../DESIGN.md
  - ../../../docs/MANIFEST_MODE.md
  - ../../../docs/aws/ARCHITECTURE_AWS.md
  - ../../../registry/registry/app.py
  - ../../../docs/OUTBOX.md
  - ../../../newweb/src/outbox.mjs
  - ../../../newweb/src/registry-client.mjs
  - ../../../newweb/src/registry-ui.jsx
companions:
  - DESIGN.md
---

# HashWing: how it works

This spine says how HashWing behaves. `DESIGN.md` beside it says how it looks; tokens are named like `{colors.ok}`. If a mock, a plan or code disagrees with this file, this file wins until it is updated.

Each surface, state and string is marked with one of three tags:

- **Existing**: in `main` at b2cec46. Keep it as it is.
- **Change**: in `main`, but it should change.
- **New (registry)**: to be built in the registry wiring PR. It appears only when the feature flag below is on.

`[ASSUMPTION]` marks a decision this headless run made without the owner. Each one is also logged in `.memlog.md`.

## Foundation

- **Form factor.** Responsive web app (the React console in `newweb/`), installable for offline use. It runs on a laptop in the office and on a phone or tablet in the field. Verified at 320, 768 and 1440 px.
- **UI system.** No component library. Native HTML controls (`<details>`, `<dialog>`, `<input type="file">`, `<input type="datetime-local">`) and Lucide icons with text labels. Native disclosures provide the keyboard behavior; no custom menu framework is added.
- **Where the work happens.** All hashing, sealing and checking runs in the browser. Files never leave the device. The optional receipt registry (AWS, `docs/aws/ARCHITECTURE_AWS.md`) only ever receives the receipt line (head, count and signature) for a company key that has been enrolled.
- **People.**
  - **Operations lead / company admin.** Owns the company signing key, enrolls it, manages links and hosted records.
  - **Pilot.** Seals files right after landing, often in a field with poor signal.
  - **Outside reviewer.** A client or insurer with no account. Receives a link or files and checks them.

## Information Architecture

Primary nav (Existing: `PRIMARY_NAV`). The order is fixed. **Change (owner decision 2026-11-17, locked in "Release layout, locked" below):** the primary nav becomes Seal & send, Verify, Jobs, Trust, and Records and Receipts move into More tools with their routes kept. This applies to the GitHub Pages console (hash routes, `productMode` false in `main.jsx:113`). The self-hosted product mode keeps its own Overview, Workbench, Reports and Settings paths from the root `DESIGN.md`; this release does not change them.

| Nav item | Route | Purpose | Who |
|---|---|---|---|
| Seal & send | `protect` | Seal a small file or a set of large files, then send the receipt message. With the flag on, it also lists items sealed on this device with their registry status. | Pilot, ops lead |
| Verify | `verify` | Check what you were sent: files plus a receipt message, or (flag on) a HashWing share link. | Reviewer |
| Jobs | `jobs` | **New.** Find and resume local evidence packages on this device. | Pilot, ops lead |
| Records | `records` | Browse the records inside a loaded `.fseal` log. **Change:** moves to More tools. | Anyone with a log loaded |
| Receipts | `receipts` | Receipt coverage and signature checks for a loaded log. **Change:** moves to More tools. | Anyone with a log loaded |
| Trust | `help` | Trusted companies (fingerprint pins), your signing key, your company's keys (flag on), and plain-language limits. | Reviewer, ops lead |

The "More tools" disclosure (Existing: `MORE_NAV`, a `<details>` in the nav) holds Samples (`sandbox`), Video, Benchmarks and System. It is closed by default and opens automatically when one of those pages is current. Escape closes it and returns focus to its summary.

Changes to the IA:

- **Change (decided, built): Trust is the home for key management and registry sign-in.** Trusted companies and the signing-key controls live on the Trust page (built; before, they rendered only under `settings`, which the hash-mode console nav cannot reach). Trust holds these sections, in order:
  1. "Trusted companies"
  2. "Your signing key"
  3. "Company registry" (New (registry), flag on; builder default awaiting owner confirmation): a small panel for registry sign-in and sign-out, showing who is signed in and for which company
  4. "Your company's keys" (New (registry), flag on)
  5. The existing "Trust and limits" text

  The seal hint reads "…under Trust" (built). The canonical product mode keeps Settings as well.
- **Change: Seal & send shows one step at a time.** Today the seal panel and the check panel sit side by side, each with a primary button. The check panel moves to Verify ("Check files"), and Seal & send keeps a text link: "Checking files someone sent you? Go to Verify". `[ASSUMPTION]`
- **Change: Verify opens on the reviewer's task.** With the flag on, the first panel asks "What were you sent?" with two choices, "I have a HashWing link" and "I have files". With the flag off it opens directly on the files form (see "Release layout, locked"). The sample demo panel moves behind a text link "Try a sample" that goes to Samples. The existing `.fseal` workbench inputs stay, under "More options".
- **New: "Sealed on this device" list**, compact (last five), directly below the sealing result, in every build, with "All jobs" leading to Jobs. With the flag on, each row also shows a registry chip and opens its registry detail (status, share links, delete). Owner decision 2026-11-17.
- **New (registry): share-link landing.** A reviewer opening a link lands on Verify with the "I have a HashWing link" choice already filled in and the link opened. The share token is generated by the client (`registry-client.mjs` `createShare`). Only its SHA-256 goes to the registry when the link is made. In the page URL the token is carried only in the fragment, after the `#` (the console already routes by fragment, so it rides as a parameter of the Verify hash route), never in the page path or a query, which keeps it out of Referer headers and the app host's logs. The page reads it, then calls `GET /v1/shares/{token}`, which does carry the raw token in the API request path (as does withdrawing, `DELETE`), so registry access logs must not record the path. It is never written to analytics, history state beyond the current entry, or storage.
- **New (registry): Trust → "Your company's keys"**, for signed-in registry members. Only admins see its actions.

Every stated need has a surface that serves it, and every surface is reached by at least one key flow:

| Need | Surface | Flow |
|---|---|---|
| Seal one small file | Seal & send | 1 |
| Seal large files (fingerprints only) | Seal & send | 1 |
| Send the receipt message | Seal & send | 1 |
| Register a receipt | Seal & send | 1 |
| Check a link | Verify | 2 |
| Check files | Verify | 2 |
| Pin a company | Trust | 2, 3 |
| Enroll a key | Trust | 3 |
| Find and resume a job | Jobs | 1 |
| Withdraw a link | Jobs row detail (or the recent list on Seal & send) | 1 |
| Delete a hosted record | Jobs row detail (or the recent list on Seal & send) | 1 |

## Feature flag: registry

- **Rule (built; the variable name and the empty Pages value are builder defaults awaiting owner confirmation).** All registry UI appears only when the build-time setting `VITE_REGISTRY_URL` is a non-empty URL. It is a public origin, not a secret. It is empty on the public GitHub Pages build, so the feature is off there. "Registry UI" means:
  - the registry chip on each "Sealed on this device" row (the list itself ships in every build, AC-60)
  - the "Company registry" sign-in panel
  - share links, withdraw and delete
  - "Your company's keys"
  - the outbox, including export and import
  - every message in "Registry errors" below
- **Flag off.** No element, network request, outbox database or service-worker route for the registry exists. The Verify time fields keep the existing row "Registry acceptance: Not registered", with basis "no registry was used" (Existing: `timeFields()`).
- **Flag on, but not signed in, or the sign-in has ended (401, `status().needsSignIn`).** Sealing still works fully offline, and rows stay queued in their current state. One inline notice above the list reads "Sign in to the company registry to send these." Its single action is "Sign in", which opens Trust → Company registry.
- **Flag on is never "required".** Sealing, sending and checking never wait on the registry.

## Registry and offline states

New (registry). This is the lifecycle of one sealed item's registration. It is held in the per-user IndexedDB outbox (`newweb/src/outbox.mjs`; contract in `docs/OUTBOX.md`). The outbox stores only the receipt line, envelope binding, idempotency key and retry state. It never stores media, manifests, salts, file names or keys.

Chip text comes from the outbox's own labels (`stateLabel()`, `registrationLabel()`). Use them verbatim.

| Outbox state | Chip text | Detail line | Single action |
|---|---|---|---|
| `sealed_local` | Sealed locally | Sealed while signed in: "Sealed on this device. Not sent to the registry yet." Sealed while signed out: "Sealed while signed out, so it isn't assigned to a company yet." | Signed out: none (sign in to assign it, or export it). Signed in: "Assign to <org>" for a proof sealed while signed out; it is never sent by itself. |
| `waiting_for_connection` | Waiting for connection | "Saved on this device. It will register when you're back online. You can close this tab." | "Try now" (secondary) |
| `registering` | Registering | "Sending the receipt to the registry…" | none |
| `registered`, disposition `active` | Last confirmed by this device | "Last confirmed by this device {observed_at}. This is the registry's statement, not proof of the files." After a signed-in Refresh in this session: "Registered at {received_at}." | "Make a share link" |
| `registered`, disposition `deleted` | Registered, later deleted | "The registry's record of this receipt was deleted. Links to it no longer open." | none |
| `needs_attention` | Needs attention | The message for the row's `reason`, from "Registry errors" | The action from the same table |

State rules:

1. **"Not yet registered"** is the summary label for every state except `registered` and `needs_attention` (the Verify line shows "Needs attention" with the row's message for those). It appears in the Verify time fields, in reports (text, Markdown, JSON and PDF) and in the share-dialog summary. It changes only after `commitAck` has written the acknowledgement to `acks`. A 200 response that has not been saved yet does not count.
2. **"Not registered" and "Not yet registered" mean different things.** "Not registered" means the flag is off or no registry was used. "Not yet registered" means queued or pending. Never show both for the same item.
3. **Queued work is never shown as witnessed.** Counts on Seal & send say, for example, "3 registered · 2 not yet registered". They never combine the two.
4. **A lost acknowledgement is not a failure.** A retry that returns the original acknowledgement goes to Registered and shows the original `received_at`. There is no duplicate row and no "registered again" message.
5. **Account switch or sign-out stops sending.** It stops dispatch and hides the other owner's rows. A result that arrives late for a previous owner is ignored. Signing back in as the same owner resumes sending; a different owner never sends those rows.
6. **Offline, with the flag on:** one calm inline notice at the top of the "Sealed on this device" list says "You're offline. Sealing and checking still work. Registrations will send when you reconnect." There is no toast or banner, and the notice goes away by itself when the device reconnects.
7. **Export and import pending proofs.** These sit under "More options" at the bottom of the "Sealed on this device" list.
   - "Export pending proofs" calls `exportPending()` and downloads `hashwing-pending-proofs.json`, which holds one receipt line per row that is not registered. Status line: "Exported {count} proofs. Keep this file until they show Registered."
   - If there is nothing to export (`needs_previous_export`), the status line reads "There's nothing waiting to export here. If this browser lost its saved data, only an export file you saved earlier can bring those proofs back." It is never an empty success.
   - "Import pending proofs" calls `importProofs()` and reports "Added {count} proofs to send." A proof that was already registered comes back with its original time.
   - Choosing a file that is not an export (`not_an_export`) reads "This file isn't a HashWing pending-proofs export."
8. **Storage that won't survive the tab** (`status().storage === 'memory'` or `exportOffered`): one inline notice reads "This browser can't keep these proofs after you close the tab. Export them now." Its single action is "Export pending proofs". It stays until an export succeeds.
9. **Queue full** (200 queued rows; `enqueue` throws `RangeError`): "This device is holding 200 proofs waiting to send. Sign in or reconnect so they can send, or export them, before sealing more."

### Share links and hosted records

New (registry).

- **Make a share link** (for Registered items; any member).
  - **What it shows.** The registry's record of this receipt: head, count, key fingerprint and received time. It does not show the files, names or the manifest.
  - **Expiry.** 30 days by default; the only other choice is 7 days. The server refuses more than 30 (owner decision 2026-11-17, AD-9). The cap applies when a link is made; an existing link keeps the expiry it was made with, and no production links exist.
  - **Seeing a link again.** The full link is shown only in the tab that made it. After a reload or in another session, a listed link shows its state, expiry and Withdraw, never Copy, because the registry keeps only the token's hash.
  - **The token.** The client generates it. The link is `{app origin}/…#…share={token}`, with the token only after the `#`.
  - **A lost response is not an error.** The client keeps the `share` object (`{token, idempotency_key, path}`) and retries with it. The registry returns the same link, so a retry never makes a second link.
  - **Layout.** The link appears in a share link row, with Copy link and Withdraw link.
  - **Field hint.** "Anyone with this link can see that the registry received this receipt. They still need the files and the receipt message to check the files. This link stops working on {expiry date}."
- **Withdraw link** (any member). No dialog, because a new link can be made at any time. Immediate inline status: "Link withdrawn. It no longer opens. Copies of the receipt someone already has aren't affected." A new link is always a new token.
- **Delete hosted record** (admins only; members don't see this button). It opens a confirmation `<dialog>`:
  - Title: "Delete the hosted record?"
  - Body: "This removes the registry's record of this receipt and stops every link to it. Your sealed files and receipt messages are not touched. Anyone who already downloaded a report keeps it; HashWing can't recall copies."
  - Buttons: "Delete hosted record" (bad fill) and "Keep it" (secondary; it has focus by default).

  After deletion, the row's chip reads "Registered, later deleted" (neutral; the outbox label). The wiring PR sets the saved acknowledgement's `disposition` to `deleted` from the delete response, and the saved time is no longer shown as current.
- **Mark company key as compromised** (admins only, Trust → Your company's keys). This also uses a confirmation dialog. Its body says: "New receipts signed with it will be refused. Older proofs from it will show a warning."

## Voice and Tone

Plain words, short sentences, second person, no exclamation marks and no emoji. Say what happened, what it means and the one next step. Technical words (SHA-256, Ed25519, chain head) appear only under "What is this?" or in data cells.

| Do | Don't |
|---|---|
| "Saved on this device. It will register when you're back online." | "Error: network unavailable (ERR_OFFLINE)" |
| "Bytes differ" plus the existing explanation | "Tampered!" or "File corrupted" |
| "Last confirmed by this device 14:03. This is the registry's statement, not proof of the files." | "Verified by HashWing Cloud ✓" |
| "Signed by a key you trust: Skyline Inspections (added from contract or invoice)" | "Identity verified" |
| "Replaced" for an old company key | "Rotated", "deprecated" or "revoked" (the internal registry value `rotated` is never shown) |
| "This link doesn't open. It may have been withdrawn or expired, or it was copied incompletely. Ask the sender for a new link." | Different messages for withdrawn, expired and unknown links |

### Honest-status copy

These strings are binding. Existing strings are reused verbatim from `recipient-trust.mjs`. Do not paraphrase them in new surfaces.

- **Bytes differ (Existing, `BYTES_DIFFER`).** "This file's bytes are not the ones that were sealed. Editing, re-saving, metadata changes, recompression, truncation or corruption can cause this. It is not proof of tampering, and HashWing doesn't pick a cause. Ask for the original file, or an archive that keeps the original bytes." It uses the warn style, never bad.
- **Reported vs verified time (Existing, `timeFields()`).** Every time is shown with its basis line:
  - Reported landing time: "operator-entered, signed, not verified" (manifest) or "operator-entered, not signed, not verified" (embedded)
  - Sealed on this computer at: "this computer's clock, not verified; from the receipt message, not signed"
  - Trusted timestamp: "None", with basis "receipt v1 has no signed time"
  - Reported landing-to-seal interval: stays negative when negative, with the existing explanation

  No new surface may call a time "verified" unless it was independently checked.
- **Registry acceptance (Change, extending `timeFields()`).**
  - Flag off: "Not registered", with basis "no registry was used" (Existing).
  - Flag on, the line comes from this device's saved outbox row for the checked receipt (`registryTimeField()`), unless a signed-in Refresh in this session has looked the registration up:
    - Saved acknowledgement: "Last confirmed by this device {observed_at}", with basis "saved on this device; the registry's statement, not proof of the files", and a Refresh action (owner decision 2026-11-17; today the code shows "Registered at {received_at}").
    - After a successful Refresh in this session: "Registered at {received_at}", with basis "the registry's clock; the registry's statement, not proof of the files".
    - Saved under a different recovery version (AD-19): the saved wording plus "The registry was restored; refresh to check this record".
    - Saved acknowledgement, record later deleted: "Registered, later deleted".
    - A row still waiting: "Not yet registered", with basis "this device's list: {row label}".
    - A row that needs attention: "Needs attention", with the row's message.
    - No row: "Not signed in" ("No account needed" for a client who opened a share link), "Not available yet" (the list isn't open yet) or "No registry record on this device".
- **Key trust provenance (Existing, `trustLine()`).** The trusted, untrusted, replaced, compromised, wrong-key, invalid-signature and weak-key lines are reused verbatim. On the share-link page, add: "The registry checked that this key is enrolled for the company's account. It did not check who the company is. Compare the fingerprint with one you got from the company yourself." (New)
- **Key state display (New).** The registry key states `active`, `rotated` and `compromised` display as "Active", "Replaced on {date}" and "Marked compromised on {date}". This matches the local pin wording in `historyStatus()`.
- **Limits (Existing, Trust page).** Sealing shows that the file has not changed since it was sealed. It cannot show what happened before sealing. Nothing here claims legal admissibility, sensor truth or insurer acceptance.

## Component Patterns

Behavior only. Visual specs are in `DESIGN.md` under Components.

| Component | Behavior |
|---|---|
| Step panel (Change) | One task. It has a heading, the fields, "More options" (closed), and one primary button at the end. A finished step collapses to a one-line summary with "Change", except a finished seal, which offers "Seal more files" instead. |
| "More options" disclosure (Existing) | Native `<details>`, closed by default. It holds optional fields: reported landing time, notes, include file names, edited copy, `.fseal` workbench inputs, export pending proof. |
| "What is this?" disclosure (Existing) | Native `<details>` with two to four short paragraphs. Never required to finish a task. |
| Registry chip (New) | A status word in a pill. It is not a button. The row it sits in is the button. Its text changes are announced through the row's live region (see Accessibility Floor). |
| Sealed item row (New) | A whole-row button with the item name, "sealed {local time}" and the chip. It opens the detail inline (an accordion, not a dialog). Keyboard: Enter or Space toggles it. |
| Share link row (New) | Read-only text field, then Copy link, then Withdraw link. Copy reports "Link copied" in a polite live region. |
| Confirm dialog (Existing `ConfirmBox`; New `<dialog>` for delete) | Used only for replacing a key, marking a key compromised, deleting a hosted record and removing a company. The safe choice has the default focus. Escape cancels. Focus returns to the button that opened it. |
| Inline notice (New) | Sits under what it is about. One or two sentences and at most one action. Never auto-dismissed, never animated. |
| Trust line (Existing) | Always appears beside a verification result, as a word, a shape and a color. |
| Fingerprint (Existing) | Groups of four, wrapped, with a full-value copy. Never shortened without a copy action. |

## State Patterns

| Surface | Empty | Loading | Error | Offline |
|---|---|---|---|---|
| Seal & send, small file | "Choose a file to seal." Primary button disabled until a file is chosen. | "Sealing…" in the button. Busy state with `aria-busy`. | Existing message plus the next step, for example "This file is larger than 45 MiB. Choose Large files instead." | Works fully. No notice. |
| Seal & send, large files | "Add the files you want to fingerprint. They stay on this device." | Existing per-file progress with "Cancel". Cancelling keeps the files already hashed. | "Couldn't read {name}. Check that it is still on this device, then add it again." | Works fully. |
| Sealed on this device (New) | "Nothing sealed on this device yet." | Rows render from the outbox. Use a skeleton only if loading takes more than 300 ms. | "Couldn't open this device's saved list. Your sealed files aren't affected. Try reloading." | The notice from state rule 6. |
| Verify, link (New) | "Paste the link you were sent." | "Checking the link…" | The single 404 message from Voice and Tone; the 503 message from the table below. | "You're offline. Opening a link needs a connection. You can still check files." Action: "Check files instead". |
| Verify, files (Existing) | Existing field hints. | "Checking the sealed list…" | "Manifest not verified" plus the existing three-point next step. | Works fully. |
| Records / Receipts (Existing) | Existing `EmptyState`, which points to Verify or Samples. | Existing. | "Could not load this record page. Retry by changing pages." (Existing) | Works. |
| Trust → Trusted companies (Existing) | "No trusted companies yet." | n/a | Existing field errors. | Works. |
| Trust → Your company's keys (New) | "No company key enrolled yet." Admins also see "Enroll your signing key". | "Loading keys…" | The table below. | "You're offline. Key changes need a connection." Actions are disabled, with a visible reason. |

Stale results: changing any input clears the previous verified or registered result shown for that input (Existing rule in the root `DESIGN.md`).

### Registry errors (New)

Every error shows one sentence saying what happened and one action. Raw codes appear only under "More options" ("Technical details: HTTP 422 envelope_expired"). The response handling below is the outbox's (`docs/OUTBOX.md`, "What each response does"). This table adds only the words. "Try again" calls `retryNow(id)`.

| Response (row `reason`) | Chip | Message | Action |
|---|---|---|---|
| Network error, timeout, 503, throttling 429, other 5xx, `bad_response` | Waiting for connection | "Saved on this device. It will register when you're back online." (503: "The registry is busy right now. It will try again by itself.") | "Try now" |
| 401 (row stays queued, `needsSignIn`) | unchanged | List notice: "Sign in to the company registry to send these." | "Sign in" (opens Trust → Company registry) |
| 403 `key_not_enrolled` | Needs attention | "This signing key isn't enrolled for your company yet. Ask your company's registry admin to enroll this key's fingerprint, then try again." The row shows the key fingerprint. | "Try again" |
| 403 `key_not_active` | Needs attention | "This signing key was replaced or marked compromised, so the registry won't accept new receipts from it. Seal again with your company's current key." | "Open Trust" |
| 422 `envelope_expired` | Needs attention | "This saved request was waiting too long and has expired. Try again to send it with a fresh request; the proof itself is unchanged." | "Try again" |
| 422 `epoch_mismatch` | Needs attention | "Your company reset its registry requests since this was saved. Try again to send it with a fresh request." | "Try again" |
| 422 `sub_mismatch` | Needs attention | "This request was prepared under a different sign-in. Try again to send it under your current sign-in." | "Try again" |
| 429 `quota_exceeded` | Needs attention | "Your company's monthly registration limit is reached; this proof is saved and can be exported" (verbatim, `attentionMessage()`). It is not retried automatically. | "Export pending proofs" ("Try again" under "More options", for example next month) |
| 409 `conflict` | Needs attention | "The registry already holds a different request with this ID. Export this proof and contact your admin." | "Export pending proofs" |
| 410 `registration_deleted` | Needs attention | "This receipt's hosted record was deleted, so it can't be registered again." | none (final) |
| 422 `bad_signature`, 400, 413 | Needs attention | "The registry couldn't accept this receipt. Export it and contact your admin." | "Export pending proofs" |
| `attempts_exhausted` (after 10 tries) | Needs attention | "This couldn't be sent after several tries. It is still saved here." | "Try again" |

## Interaction Primitives

- **One primary action per step.** No surface shows two primary buttons at once.
- **Automatic, quiet retries.** The outbox uses exponential backoff with jitter. "Try now" is always available, and retries never cause a layout change or a focus jump.
- **Keyboard.** Tab order follows the reading order. Enter activates and Space toggles. Escape closes the open disclosure or dialog and returns focus to its trigger (Existing `closeDisclosure`). On route change, focus moves to the `<h1>` (Existing). There are no single-key shortcuts.
- **Never banned, never hidden.** No hover-only actions, no infinite scroll, no auto-advancing steps, no surprise modals, no auto-dismissing messages.
- **Clipboard.** Copy actions report through a polite live region and fall back to selecting the text.

## Accessibility Floor

- WCAG 2.2 AA. Every target is at least 44 by 44 px. Focus is always visible (`{colors.focus}`, 3px ring). The skip link stays (Existing).
- Every status pairs a word with a shape and a color, including under `forced-colors: active`.
- Registry chip changes are announced once, politely, from one `role="status"` region per list, for example "Flight 12: Registered". The announcement is never repeated on re-render. Needs attention uses the same polite region, not `alert`.
- Field errors use `role="alert"` next to the field, linked to it with `aria-describedby`.
- Dialogs are native `<dialog>` elements. They trap focus, are labelled by their title and return focus to the button that opened them.
- Reduced motion: no spinners or transitions. "Registering" shows static dots.
- Hashes and fingerprints carry an accessible name, for example "Key fingerprint, 64 hexadecimal digits", plus a copy button. A screen reader is not made to read 64 characters on every pass.
- Record which assistive technology was actually tested (for example VoiceOver with Safari) instead of claiming universal support.

## Responsive & Platform

| Width | Behavior |
|---|---|
| 1440px | Rail visible. A step panel takes the main column. The "Sealed on this device" list sits below it. |
| 768px | The rail becomes the "Menu" button (Existing). One column. "More tools" stays a disclosure inside the menu. |
| 390px and 200% zoom | Same as 320px. See "Release layout, locked" for the per-screen rules. |
| 320px | One column with a 16px gutter. The share link row stacks: field, then two full-width buttons. Time fields stack label, value, basis. Nothing scrolls horizontally, and no control is clipped. |

Installed and offline: sealing, checking and the outbox work offline. The service worker never caches registry API responses (Existing rule: private APIs are never cached).

## Inspiration & Anti-patterns

- **Kept:** the existing honest-wording discipline (`BYTES_DIFFER`, time basis lines, the trust line). It is the product's voice.
- **Rejected:** toast stacks, red banners for offline, cloud badges like "Verified by HashWing", spinners on every state, onboarding carousels, and a dark-first "aerospace" theme (already rejected in the root `DESIGN.md`).

## Key Flows

### Flow 1: Priya seals and sends after an inspection (pilot)

Priya is a pilot for a three-person roof-inspection company. She has just landed beside a warehouse with one bar of signal, and the flag is on.

1. She opens Seal & send. The step "What are you sealing?" offers "Small file (seal the whole file, up to 45 MiB)" and "Large files (fingerprint only)".
2. **Small file:** she chooses the `.ulg` log. Under "More options" she enters the reported landing time. She presses **Seal this file**.
3. **Large files:** she adds 14 video files totalling 9 GB. Per-file progress shows, with Cancel. Each file is hashed on the device and nothing is uploaded. She presses **Seal the list**.
4. The step collapses to "Sealed · 14 files". "Send these to your client" leads with **Download** the list (primary), lists the originals to send separately, then **Copy message**, which becomes primary once the list is downloaded.
5. Below, the new row in "Sealed on this device" shows **Waiting for connection**, with "Saved on this device. It will register when you're back online. You can close this tab."
6. She closes the laptop. Back in the van, with signal, she reopens HashWing. The chip moves to **Registering**, then **Registered**, announced once.
7. **Climax:** she opens the row and sees "Last confirmed by this device 15:42. This is the registry's statement, not proof of the files." She presses Refresh and it reads "Registered at 15:41 UTC." She presses **Make a share link**, copies it and pastes it into her email to the client next to the receipt message.

Failure paths:

- **Lost acknowledgement.** The retry returns the original `received_at`. There is still one row.
- **429.** The chip shows Needs attention with the quota message. Everything stays saved locally.
- **Next morning.** The ops lead withdraws an old link from the row detail and gets the inline confirmation. For a record sent to the wrong client, the admin uses "Delete hosted record", and the dialog's safe default is "Keep it".

### Flow 2: Daniel checks what he was sent (outside reviewer, no account)

Daniel is a claims reviewer at an insurer. He has the email: a link, a receipt message and a shared folder of files.

1. He opens the link. Verify loads with "I have a HashWing link" already chosen and the link opened. There is no sign-in prompt.
2. The panel shows the registry's statement: "The registry received a receipt for 14 items from the key with fingerprint 3f9a 1c… on 2026-11-17 15:41 UTC." Below it is the provenance line: the registry checked enrollment, not who the company is.
3. One next step: **Check the files**. It switches to "I have files" with the link's record kept for comparison.
4. He adds the sealed list, pastes the receipt message and adds the 14 files. For the trusted key, he chooses "Skyline Inspections", which he pinned last month from the contract.
5. **Climax:** the headline reads **Files differ** and the signature line reads **Valid** (see "Verify verdicts"). The trust line reads "Signed by a key you trust: Skyline Inspections (added from contract or invoice)". The registry row reads "Matches the registry's record". Thirteen items read **Matches**, and one reads **Bytes differ**, with the existing explanation and no accusation. The time fields show reported landing (operator-entered, signed, not verified), the seal time on Priya's computer, and the registry acceptance with its basis.
6. He downloads the PDF report, which carries the same lines.

Failure paths:

- **Withdrawn, expired or mangled link.** One message: "This link doesn't open. It may have been withdrawn or expired, or it was copied incompletely. Ask the sender for a new link." Then "Check files instead".
- **No pinned key.** He sees the existing untrusted line, plus "What is this?", which explains how to get a fingerprint from a channel he already knows.

### Flow 3: Marcus sets up company trust (ops lead / admin)

Marcus is the ops lead and owns the company's signing key. `[ASSUMPTION]`: "adds trusted keys" covers both halves of trust, enrolling the company key and a reviewer pinning it.

1. **Your signing key** (Trust; Existing controls, moved). He loads or generates the company signing key. The page shows its fingerprint with "Give it to recipients through a channel they already know, so they can add you as a trusted company."
2. **Company registry** and **Your company's keys** (Trust; New, flag on, admin). He signs in in the Company registry panel, then presses **Enroll this key**. HashWing gets a one-time challenge, signs it and enrolls the key in one step. The list shows the fingerprint as **Active**, with "Enrolled {date} by you".
3. **Climax:** the pilots' outstanding rows that showed "This signing key isn't enrolled…" move from Needs attention to Registering, then to Registered, after one **Try again** each.
4. He puts the fingerprint on the company website and in client contracts.
5. **Reviewer half** (Existing). Daniel, in Trust → Trusted companies, adds "Skyline Inspections", pastes the fingerprint and chooses "contract or invoice" as the source. The fingerprint and its source show in the company list.
6. **Replacing a key.** Marcus enrolls a new key. The old key shows **Replaced on {date}**, never "rotated". Daniel replacing his pin needs the existing in-page confirmation, "Replace key" or "Keep current key".

## Release layout, locked (2026-11-17)

Locked before any code, from the owner's release brief (Phase A) and the owner decisions of 2026-11-17, and revised after the two independent reviews of PR #35. Ledger IDs (R12 to R76) are in `../initiative-hashwing-aws.md`. Task packets are in `../plan-ui-backend-release.md`. Tokens are the ones in `DESIGN.md` beside this file. Every item here is **Change** or **New** unless it says Existing. Nothing below is built yet. Where an older section of this file disagreed, it has been edited to match this one.

### Frame and page shell

- **Command bar (48px), by identity state.** It holds the route title and one menu, "Profile on this device".
  - Guest: the menu offers "Use a local profile", "Create a local profile" and "Demo session". The menu says once: "Profiles live in this browser. They are not company accounts."
  - Local profile open: the menu shows the profile's email with "Local profile" under it, and "Log out".
  - Flag on and signed in to the company registry: the bar also shows "{company} registry" as a text link to Trust → Company registry. Company sign-in and sign-out happen only on Trust, never in the bar.
- **Rail.** The existing 220px left rail with four labelled Lucide links (Seal & send, Verify, Jobs, Trust), then the More tools disclosure, then the existing "Other apps" group.
- **Workbench session strip and "Source and report actions".** Shown only on Verify and the More tools routes. Hidden on the front door, Seal & send, Jobs and Trust.
- **Width rules (by container, not viewport).** The main column is at most 1040px. A summary column (240px) appears only when the content area is at least 1200px wide; it holds the current task's facts (files and bytes, mode, signing key, job reference) and nothing else. A table keeps its columns only when its container is at least 720px wide; below that it becomes per-row summaries.
- **One primary per step.** Each step panel, and each Trust section, has at most one `.button.primary`. Everything else is secondary or a text link.
- **Results link out.** A result links to the More tools page that explains it, for example "Open in Records" from a chain failure.
- **Links and targets.** Standalone controls and links are at least 44 by 44px. A link inside a sentence is exempt (WCAG 2.5.8 inline exception) and is never the only way to reach its destination.
- **Units.** Byte counts are exact integers with separators; sizes in prose and progress use binary units (KiB, MiB, GiB), matching the 45 MiB limit.

### Wireframes

Text wireframes. `[Primary]` is the only primary button in its step. `(secondary)` is a secondary button. `‹link›` is a text link. `▸` is a closed disclosure.

**Front door (`landing`)**

```
HashWing
Seal files on this device and let your client check them.        <- one factual line, no kicker, no lede
[Seal files]   (Verify files)   ‹Try a sample›                     <- Try a sample opens Samples, which runs the real engine
Files stay on this device. ‹How checking works›
-- footer --
Install · Feedback · Privacy · Terms · Security & offline data · Source      <- kept from today's landing
```

No rotating preview, no numbered steps, no metrics, logos or testimonials, no login wall. The Mavframe link moves to More tools → System.

**Seal & send (`protect`)**

```
Seal & send
  What are you sealing?
    (o) Small file: seal the whole file, up to 45 MiB
    ( ) Large files: fingerprint only, files stay where they are
  Files       flight-12.ulg                       18,442,112 bytes
              Total 1 file                         18,442,112 bytes     <- JetBrains Mono, tabular
  Job reference (optional)  [______________]        <- local label, never signed, never sent to the registry
  Signing     one of three lines, below
  ▸ More options (landing time, technical options)
  [Seal this file]          (Seal the list in large-file mode)
  -- while sealing --
  <progress> Sealing 2 of 14 · 4.1 GiB of 8.4 GiB   (Cancel)
  ‹Checking files someone sent you? Go to Verify›
```

Signing line, one of three states:

1. No key loaded: "One-time key for this file. Your client can't check who sealed it." ‹Set up a company key on Trust›
2. Key loaded: "Signing as {name}" and the full fingerprint in groups of four, wrapped, with (Copy fingerprint).
3. Flag on and signed in: state 2, plus "Registering for {company} as {email}".

Going to Trust and back keeps the chosen files and mode. Cancel stops the seal, keeps the selection and the files already hashed, and leaves "Seal the list" as the one next action.

**After sealing (same route; the step panel becomes a one-line summary "Sealed · 1 file" with no Change action)**

```
Send these to your client
  1 Download the sealed file   flight-12.fseal        [Download]        <- primary until it has been downloaded once
  2 Send the receipt message                          (Copy message)    <- becomes primary after step 1
  -- large-file mode instead --
  1 Download the list          job-12.manifest        [Download]
    Send these originals separately (not inside the list):
    roof-north-01.mp4, roof-north-02.mp4, roof-north-03.mp4, roof-east-01.mp4, roof-east-02.mp4  ‹Show all 14›
  2 Send the receipt message                          (Copy message)
  Copying the message does not show that your client kept it.
  ▸ Share link (flag on): a link to the registry's record, not to the files
  (Seal more files)                                  <- clears the result and the selection, back to the first step;
                                                        if the sealed file or list was not downloaded: confirm
                                                        "You haven't downloaded {name}. Download it first?"
                                                        [Download] (default focus) / (Discard it)
Sealed on this device                                <- compact list, last 5, ‹All jobs› to Jobs
  flight-12.fseal   Sealed locally   17 Nov 15:41
```

Here the step numbers are the order of a real task, not decoration. The "not downloaded" confirmation reuses today's `sealOutputAcknowledged` guard (`newweb/src/main.jsx:167`, used at `:213`).

**Verify (`verify`)**

Flag on:

```
Verify
  <fieldset> What were you sent?
    (o) I have a HashWing link     ( ) I have files              <- native radio group, styled as two choice buttons
  -- I have a HashWing link --
  Link [paste the link______________]  [Open link]   <- prefilled and opened at once when arriving from a share link
  The registry received a receipt for 14 items from the key 3f9a 1c0b … (Copy) at 2026-11-17 15:41 UTC (the registry's clock).
  Files not checked yet.                             <- a link never marks files verified
  [Check the files]                                  <- switches to "I have files", keeping the link's record
```

Flag off (GitHub Pages): there is no link choice. Verify opens directly on "I have files". A URL carrying `share=` on a flag-off build shows one inline notice, "This copy of HashWing can't open HashWing share links. Check the files instead.", above the files form. (Checked in `newweb/src/main.jsx:159`: the share token is read only when `__REGISTRY_URL__` is set; the Pages build's only Verify deep links are included-sample links.)

Both builds, files:

```
  Sealed file or list   [Choose]              <- a .fseal or a manifest
  Receipt message       [paste]               <- required; Check files stays disabled with "Paste the receipt message" until it is there
  Trusted company       [Skyline ▾]           <- with no pins: "No trusted companies yet" ‹Add one on Trust›
  Originals             [Choose files]        <- shown only for a list (manifest); a .fseal holds its own bytes
  [Check files]
  -- result, full width --
  Files: Incomplete                           <- headline, from the verdict table below
  Signature            Valid
  Key trust            Signed by a key you trust: Skyline Inspections (contract or invoice)
  Files                12 match · 1 differs · 1 missing · 0 not in the list
  Receipt coverage     All items covered
  Registry             Last confirmed by this device 17 Nov 15:42 (Refresh)   <- flag on only
  Times                reported landing, sealed at, registry acceptance, each with its basis
  +------------------------------------------------------------------------------+
  | File              | Bytes        | Status          | SHA-256                 |
  | roof-north-01.mp4 | 812,004,113  | Matches         | 9c1e… (Copy)            |
  | roof-north-02.mp4 | 790,113,020  | Bytes differ    | 41aa… (Copy)            |
  | roof-east-07.mp4  | —            | Missing         | 07d2… (Copy)            |
  +------------------------------------------------------------------------------+
```

### Verify verdicts

The headline combines the files check with key trust (provisional, decided by the coordinator 2026-11-18, awaiting owner confirmation): green "Verified" needs complete files and a trusted key. Signature, key trust and registry still each keep their own line under the headline. The first row that applies wins.

| Headline | Style | When | One sentence | One next action |
|---|---|---|---|---|
| Signed by a key marked compromised | bad | Signature valid, and the signing key is marked compromised in your trusted list (whatever the files show) | "This key was reported as compromised. Don't rely on these files until the company confirms them." | "Ask the company for a new seal" |
| Not verified | bad | The signature is invalid, the key is wrong, weak or malformed, or the list or receipt can't be read. Files are not compared | The existing `trustLine()` sentence for that case | The existing three-point next step |
| Files differ | warn | Signature valid, and at least one file reads Bytes differ | `BYTES_DIFFER` (existing, verbatim) | "Ask for the original files" |
| Incomplete | warn | Signature valid, no file differs, and at least one file is Missing, or the receipts do not cover every item | "{n} of {total} files were checked. A file that is missing can't be checked." (or "Receipts cover {k} of {total} items.") | "Add the missing originals" |
| Not in the list | warn | Signature valid, every listed file matches, none missing, full coverage, and at least one chosen file is not in the list | "Every listed file matches. {n} other files you chose aren't in the list and were not checked." | "Remove files that aren't in the list" |
| Files match · signer not confirmed | warn | Files complete (every listed file matches, none missing, none not in the list, receipts cover every item), and the key is not pinned, or is replaced, or is a one-time key, or its pin was saved without the "confirmed by you" tick (an older pin) | "The files match what was sealed, but you haven't confirmed who sealed them." | "Confirm the company's fingerprint on Trust" |
| Verified | ok | Files complete, and the key is pinned in your trusted list, confirmed by you, and not compromised | "Every file matches what was sealed, signed by a company you trust." | "Download report" |

- The key trust line still shows on its own: trusted, "Signed by a key you have not confirmed" (no pin or a one-time key), "Signed by a key saved for {name}, but how you confirmed it isn't recorded" (an older pin without the tick), replaced, or "Marked compromised". Rows Files differ, Incomplete and Not in the list keep their headline whatever the key; the key trust line qualifies them. Every one-time guest key reads "Files match · signer not confirmed" at best.
- Small-file `.fseal` checks use the same headlines; they have one file, so only Not verified, Files differ and Verified apply.
- Files are matched by relative path and name when the picker gives a relative path (a folder pick); with a plain file picker there is no path, so matching is by name. A renamed byte-identical file reads Missing (old name) plus Not in the list (new name). Two chosen files with the same path stop the check with "Two chosen files have the same path: {path}. Choose one." If the list holds two items with the same name in different folders and the files were chosen without paths, the check stops with "The list has two files named {name} in different folders. Choose the folder instead of single files so each can be matched."
- "Not in the list" is the one name for extra files, in rows and counts. It replaces today's "Not in manifest" label at every site listed in "Tests that change on purpose", and its chip moves from neutral to warn. These headlines are UI and report wording only: `docs/verifier.js` verdicts and the `not-in-manifest` status key in `docs/manifest.mjs` are unchanged.

**Jobs (`jobs`, New)**

```
Jobs                                        Saved in this browser only. Not a cloud copy.
  [Search job reference or file name____]   Status [All ▾]
  Job ref | Package          | Status                                 | Sealed        | Actions
  J-1042  | job-12.manifest  | Last confirmed by this device 17 Nov   | 17 Nov 15:41  | (Resume) (Export) (Remove)
  —       | flight-9.fseal   | Sealed locally                         | 16 Nov 09:02  | (Resume) (Export) (Remove)
  Showing 1–25 of 61   (Previous) (Next)
```

- **What a job is.** A local record of one sealing: optional job reference, package name, mode, item count and byte total, the receipt message, the registry row state (flag on), and the sealed time. Never file bytes, never the signing key.
- **Status values and filter.** Sealed locally, Waiting for connection, Registering, Last confirmed by this device {date}, Needs attention, Registered, later deleted. Flag off shows Sealed locally only, and the filter is hidden. Filter options are those values plus All.
- **Search.** Case-insensitive substring over job reference and package name, applied as you type, 25 rows per page. The page and search are in the URL (`#/jobs?q=…&page=2`) so Back and Forward step through them.
- **Resume.** Opens Seal & send at the after-sealing step for that job: download (only while the sealed file or list is still held in this tab's memory; it is never written to browser storage), copy message, share link. If the package bytes are not held, it says "HashWing didn't keep a copy of {name}. Use the copy you downloaded when you sealed it." (changed 2026-11-18 in review: there is no file chooser on that step), and the download step drops its "It holds…" line. Large-file originals are never held. While a seal is running, Resume is disabled with "Finish or cancel the seal in progress first."
- **Export.** Downloads `hashwing-job-{ref or date}.json` with the job's metadata and receipt message. Not the files.
- **Remove.** A confirm dialog: "Remove this job from this browser? The sealed file and anything you sent are not affected." Buttons "Remove" and "Keep it" (default focus). A job with a pending registry proof says the proof stays in the export list until it registers or is exported.
- **Retention.** "Kept until you remove it or clear this browser's data." Shown once under the heading.
- **Owner.** Jobs belong to the local profile (or the guest) that sealed them. When a company registry sign-in is also active, the list is still the local profile's; rows sealed while signed in to the company carry a "{company}" label, and their registry status follows that sign-in. Signing out of the company keeps the rows and hides their registry status; logging out of the local profile hides the list (AC-57).
- **Row detail (flag on).** Opening a row shows the registry detail that Seal & send's recent list shows: share links (make, copy in the creating tab only, withdraw) and, for admins, "Delete hosted record". This is where links for older items are managed.
- **States.** Empty: "Nothing sealed in this browser yet." with ‹Seal files›. No match: "No jobs match "{q}"." with (Clear search). Export failed: "Couldn't save the export. Try again, or check that downloads are allowed." Storage unavailable: "This browser isn't keeping jobs (private window or storage blocked). Jobs you seal now will be gone when you close it."
- **320 and 390px.** Each row becomes a summary: package name (wraps at separators), status word with shape, sealed time, then the three actions as full-width secondary buttons.

**Trust (`help`)**

```
Trust
  Trusted companies       list; [Add company] opens the form: name, fingerprint, where you confirmed it, and the
                          checkbox "I confirmed this fingerprint through a channel I already knew" (required; unticked by default, required on Add company and on the
                          check form's pin; unticked: "Tick the box to confirm you checked this fingerprint yourself.").
                          Each row reads "Added from {source} on {date} · confirmed by you on {date}"; an older pin without the
                          tick reads "Not confirmed yet. Add it again above and tick the box." with (Confirm)
  Your signing key        fingerprint with Copy; [Load a key] or (Generate a key)
  Company registry        flag on only: who is signed in, for which company; [Sign in] / (Sign out);
                          identity service unavailable: "Company sign-in isn't available right now. Local tools still work."
  Your company's keys     flag on, admins: [Enroll this key]; list (Active / Replaced on / Marked compromised); (Mark compromised)
  Trust and limits        existing text
```

Section names are the existing ones, so the `FORBIDDEN` strings, AC-38 to AC-40 and AC-50 keep their text. With the flag off, Company registry and Your company's keys are absent (AC-50), and Trust and limits says "Company sign-in isn't part of this copy of HashWing." Each section's bracketed button is its one primary. No Verify workbench strip on Trust.

**More tools**

A closed disclosure under the four links: Records, Receipts, Samples, Video, Benchmarks, System. It opens on its own only when one of them is the current page, and Escape closes it and returns focus to its summary (Existing behaviour, AC-05).

### Route, state and action matrix

| Route | States | Primary action | Secondary actions | Leaves to |
|---|---|---|---|---|
| `landing` | idle | Seal files | Verify files, Try a sample | `protect`, `verify`, `sandbox` |
| `protect` | choose mode, files chosen, sealing (with progress), cancelled, seal error, storage full | Seal this file / Seal the list | Cancel, More options, Go to Verify | `verify`, `help` (signing key) |
| `protect` after sealing | sealed, download failed, copy failed | Download, then Copy message | Seal more files, Make a share link (flag on), All jobs | `jobs` |
| `verify` | files form, link form (flag on), link unavailable, share link on a flag-off build, checking, each verdict in "Verify verdicts" | Check files (or Open link, then Check the files) | Refresh (flag on), Download report | `records`, `receipts` from a result |
| `jobs` | empty, list, no match, page n, export failed, storage unavailable | none (list screen) | Resume, Export, Remove, Previous, Next | `protect` |
| `help` (Trust) | no pins, pins, replace-confirm, compromised, signed out, signed in, admin, identity unavailable | one per section (see Trust) | Mark compromised, Copy fingerprint, Sign out | none |
| More tools routes | unchanged | unchanged | unchanged | unchanged |

Every route keeps its hash URL, Back/Forward and heading focus. Inside a route, only the Jobs page and search, and the Verify choice (`#/verify?mode=link|files`, written with `history.replaceState` so arrowing through the choice adds no history entries), are in the URL; the after-sealing step is not, so Back from it leaves Seal & send. `#/help` stays the Trust route; no alias is added. A share link lands on `verify` with the token after `#` only.

### Focus and announcements

| Event | Focus moves to | Polite live text |
|---|---|---|
| Verify choice changed (arrow keys or click) | stays on the radio (moving focus would break the group, WCAG 3.2.2); the chosen form follows next in tab order | none (the radio change is announced natively) |
| "Check the files" from a link | the "Sealed file or list" field | "Link record kept for comparison" |
| Seal finished | the "Send these to your client" heading | "Sealed 14 files" |
| Seal cancelled | the Seal button | "Sealing cancelled. Your files are still chosen." |
| Seal or check error | the field in error, which names the message through `aria-describedby` (no `role="alert"` on top) | none; the message is read with the field |
| Check finished | the verdict headline (`tabindex="-1"`), whose text is read on focus | none (no separate live text, so it is not read twice) |
| Seal more files | the "What are you sealing?" heading | none |
| Jobs page changed (Previous, Next) | the table caption, which is read on focus | none (not read twice) |
| Jobs search changed (as you type) | stays in the search field | "3 jobs match" |
| Job removed | the next row's Resume button, or the heading if none | "Job removed" |
| Progress | stays put | `<progress>` with `aria-valuetext` ("4.1 GiB of 8.4 GiB"); announced at 25%, 50%, 75% and on completion |

### Responsive rules

| Width | Rule |
|---|---|
| 1440px | Rail, main column, and the summary column when the content area is at least 1200px. A comparison table takes the full main column; the summary column moves below it while it is shown. |
| 769 to 1439px | Rail stays; no summary column below a 1200px content area. Tables follow the 720px container rule. |
| 768px | Rail becomes the Menu button. One column. Tables follow the 720px container rule. |
| 390px and 320px | One column, 16px gutter, no horizontal page scroll. The file comparison becomes one summary per file: name (wraps at word and separator boundaries, never letter by letter), status word with its shape, bytes, then a "Details" disclosure with the full hash and Copy. Statuses are never hidden off screen. |
| 200% zoom | The rule for the resulting CSS width. No clipped control, no overlap, every 44px target kept. |
| Reduced motion | No transitions or animated progress; progress shows numbers only. |
| Forced colours | Every status keeps its word and shape. The chosen Verify option keeps its check mark and thicker border, and uses `Highlight` / `HighlightText`. |

Long hashes wrap only inside their own detail cell and always have a full-value Copy.

### Design guidance applied and rejected

- **UI/UX Pro Max** (design-system search, run by the coordinating session, returned "Minimalism & Swiss Style"). Applied: strict alignment, clear hierarchy, 44px targets, visible labels, errors next to their field, progress for multi-step work, full-width tables on desktop and per-file summaries on mobile. Rejected: its suggested navy and Plus Jakarta Sans palette (the existing slate, white and cobalt tokens and the bundled Space Grotesk and JetBrains Mono stay), and its marketing "Trust & Authority" hero pattern (HashWing is an operational workspace).
- **Frontend Taste 2.5.1** (read by the coordinating session). Applied, system rules only: one button pair (primary and secondary), one panel style, equal edges, no captions or filler copy, hover and press feedback, no carousels or timed tabs, reduced motion respected. Not applied: its marketing-page rules on photography, hero entrances, shader effects and "dealt moments", which are for company websites and do not fit an operational console.

## Builder defaults awaiting owner confirmation (2026-11-17)

These were chosen by the builder and are built, but the owner has not confirmed them.

- **Registry sign-in.** A small "Company registry" panel on the Trust page.
- **Setting.** Build-time `VITE_REGISTRY_URL`. It is empty on the public Pages build, so the feature is off there.

## Decided (2026-11-17)

- **Key-management home.** Trusted companies and the signing-key controls live on the Trust page.
- **Flag-off Verify (deliberate deviation from the brief, pending owner confirmation).** The brief asks Verify to open on "I have a link" / "I have files". The flag-off Pages build has nothing to open a share link with (`newweb/src/main.jsx:159`), so it opens straight on "I have files" (AC-65). If the owner wants the two-choice opening there too, the link choice could only say that this copy can't open share links.
- **Verified needs a trusted key (provisional, decided by the coordinator 2026-11-18, awaiting owner confirmation).** Green "Verified" needs complete files and a pinned, uncompromised key; otherwise "Files match · signer not confirmed" (warn) or "Signed by a key marked compromised" (bad). See "Verify verdicts".
- **Owner decisions, 2026-11-17 (binding).** Registry sign-in lives on Trust. The registry stays off the public Pages build until a dedicated origin and production sign-in exist (a subpath of the same github.io origin is not origin isolation). "Sealed on this device" stays as a compact list below the sealing result, in every build, and a Jobs page is added. Share links default to 30 days with 7 days as the one alternative, and the server refuses more than 30 (AD-9). These supersede the matching builder defaults above.

## Open

- **Trust shows the Verify workbench strip.** The Trust page currently shows the strip that belongs to Verify: "Choose a source or sealed log", the demo status, "Copy hash" and "Source and report actions". It should appear only on Verify. To be fixed in the Seal & send / Verify restructure, which is pending owner sign-off.
- ~~**"Enroll it on the Trust page" has no control yet.**~~ Resolved 2026-11-19: Trust → Your company's keys has Enroll this key (AC-38..AC-40). The `key_not_enrolled` row text is unchanged; `newweb/tests/registry-wiring.mjs` "admin, no key loaded: …" goes from Needs attention to Registered after enrolling and Try again.
- **Verify chooser.** Built in PR #43 for registry-on builds ("I have a HashWing link" / "I have files", AC-09); Pages has no chooser (AC-65).

## Acceptance checklist

The wiring PR tests against these items. Each one is observable in the browser.

Build status, checked against the code and tests on `main` at e279032 (2026-11-17; read, not re-run); the commits from there to b2cec46 change only docs and evidence files, and AC-13 and AC-25 were re-read at b2cec46. The tag after each ID means: `built` (in the code and asserted by a test), `built, partly tested` (a test covers only part of the item), `built, untested` (in the code, no test asserts it), `partial` (part is missing or not met) or `open` (not built). Totals: 26 built, 10 partly tested, 6 untested, 4 partial, 4 open; after the 2026-11-17 changes (AC-04 now open; AC-13 and AC-25 now partial), 25 built, 8 partly tested, 6 untested, 6 partial, 5 open. Still to build: AC-37 ("Matches the registry's record"), the Verify chooser (AC-09) and one primary button per step (AC-06). Jobs PR (2026-11-18, registry-off build only): AC-04 `built, tested`, AC-58 and AC-60 `built`, AC-56 and AC-57 `partial` (their flag-on parts are open). Trust company keys PR (2026-11-19, flag-on build): AC-38, AC-39, AC-40 and AC-59 `open` → `built` (4 fewer open), and AC-50's second half is now a real check, not a trivial pass. The totals above predate this change and were not recomputed.

### With the registry flag off

- **AC-01** `built` No registry URL is configured. No registry chip, share link, "Your company's keys" section or registry sign-in appears on any page.
- **AC-02** `built, partly tested` (2026-11-18: `newweb/tests/jobs.mjs` now seals a small file and a large-file set and asserts no request leaves the origin and no outbox or pending database exists; checking a large-file set on the flag-off build is still not asserted) No registry URL is configured. Sealing and checking a small file and a large-file set make no network request to a registry origin, and no outbox IndexedDB database is created.
- **AC-03** `built` No registry URL is configured. The Verify time fields show "Registry acceptance", "Not registered", "no registry was used".
- **AC-04** `built, tested` (changed 2026-11-18, Jobs PR; `newweb/tests/console.mjs`, `newweb/tests/jobs.mjs`) The primary nav shows exactly Seal & send, Verify, Jobs and Trust, in that order. "More tools" contains Records, Receipts, Samples, Video, Benchmarks and System, and is closed unless one of them is the current page. `#/records` and `#/receipts` still load and focus their heading.
- **AC-05** `built, partly tested` With "More tools" open, Escape closes it and moves focus to its summary.
- **AC-06** `partial` No Seal & send or Verify step shows more than one `.button.primary` at a time. Not met today: after sealing, "Seal this log" and "Copy message" are both primary; Verify shows "Run Interactive Demo" and "Run check" as primary together.
- **AC-07** `built, untested` "More options" and "What is this?" are closed on first load of every page.
- **AC-08** `built` Trust contains "Trusted companies" and "Your signing key" in console mode. The seal hint refers to Trust, not Settings.
- **AC-09** `partial` With the flag on, Verify opens with "What were you sent?" ("I have a HashWing link" / "I have files"); with the flag off, on the files form (AC-65). The sample demo is reachable from a "Try a sample" link. Not met today: Verify opens with the sample panel; the chooser and the "Try a sample" link are not built.
- **AC-10** `built` A byte-different file shows "Bytes differ" in the warn style with the exact `BYTES_DIFFER.text`. No surface shows "tampered" for it.
- **AC-11** `built` Every time row shows its basis line verbatim from `timeFields()`. A negative interval is shown as negative.
- **AC-12** `built` The trust line strings match `trustLine()` verbatim for trusted, unconfirmed (a pin saved without the confirmation tick, R34), untrusted, replaced, compromised, wrong-key, invalid-signature and weak.
- **AC-13** `partial` Every interactive element is at least 44 by 44 px at 320, 768 and 1440 px, except links inside a sentence (WCAG 2.5.8 inline exception). Not met today (UX review of PR #35): `.offline-control-actions .button` is 38px tall (`newweb/src/style.css`, about line 406), a Dismiss button is 40px, and Trust's "Source and issue tracker" link is 18px tall.
- **AC-14** `built, partly tested` At 320, 768 and 1440 px there is no horizontal page scroll and no clipped control. Fingerprints and SHA-256 values wrap within their cells.
- **AC-15** `built, untested` Under `forced-colors: active`, every status still shows its word and its distinct shape.
- **AC-16** `built, untested` With reduced motion set, no spinner or transition animates.
- **AC-17** `built` On route change, focus moves to the page `<h1>`. The skip link reaches `#main`.
- **AC-18** `built` Automated axe finds no serious or critical violations on Seal & send, Verify, Trust, Records and Receipts.

### With the registry flag on

- **AC-19** `built` `VITE_REGISTRY_URL` is set and nobody is signed in. A new seal shows the chip "Sealed locally". The list shows "Sign in to the company registry to send these." Its "Sign in" action opens Trust → Company registry.
- **AC-20** `built` Signed in and offline. A new seal shows "Waiting for connection", and the list shows the notice "You're offline. Sealing and checking still work. Registrations will send when you reconnect."
- **AC-21** `built` A queued item survives a tab close and reopen, and registers after reconnecting without user action.
- **AC-22** `built, partly tested` The chip moves Registering, then Registered. Each change is announced once through `role="status"`.
- **AC-23** `built` The summary reads "Not yet registered" until `commitAck` has written the acknowledgement to `acks`. If a response arrived but was not saved (for example, the tab was killed mid-write), it still reads "Not yet registered" after reopening, and the next send returns the original acknowledgement.
- **AC-24** `built` A lost acknowledgement followed by a retry yields exactly one row, showing the original `received_at`.
- **AC-25** `partial` After the acknowledgement is saved, the Verify time row reads "Last confirmed by this device {observed_at}" with basis "saved on this device; the registry's statement, not proof of the files" and a Refresh action (AC-63). Not met today: the row reads "Registered at {received_at}" from the saved row (`registry-ui.jsx:200`).
- **AC-26** `built` "Not registered" and "Not yet registered" never appear for the same item.
- **AC-27** `built` Counts show registered and not-yet-registered items separately. Queued items are never counted as registered.
- **AC-28** `built` Signing out or switching account stops dispatch. Rows owned by the other account are not shown and are not sent.
- **AC-29** `built, partly tested` Each row of "Registry errors" shows its exact message and action: network error or 5xx, 401, `key_not_enrolled`, `key_not_active`, `envelope_expired`, `epoch_mismatch`, `sub_mismatch`, `quota_exceeded`, `conflict`, `registration_deleted`, `bad_signature`/400/413 and `attempts_exhausted`. Raw codes appear only under "More options".
- **AC-30** `partial` "Make a share link" appears only for Registered items. The token is in the URL fragment and does not appear in analytics, storage or server request logs from the app. Gap: withdrawing and opening a link send the raw token in the request path, so registry server logs can record it (see AC-48).
- **AC-31** `built, partly tested` A withdrawn, expired, unknown or malformed link shows the same message: "This link doesn't open. It may have been withdrawn or expired, or it was copied incompletely. Ask the sender for a new link."
- **AC-32** `built` "Withdraw link" removes the link immediately, with the inline message "Link withdrawn. It no longer opens. Copies of the receipt someone already has aren't affected." The withdrawn link then gives the AC-31 message.
- **AC-33** `built` "Delete hosted record" is visible only to admins. Its dialog has "Keep it" focused by default, Escape cancels, and focus returns to the trigger.
- **AC-34** `built, partly tested` After deletion, the row reads "Registered, later deleted", and every link to it gives the AC-31 message.
- **AC-35** `built` The share-link page shows the head, count, key fingerprint and received time only (no file names or manifest), plus the provenance sentence "The registry checked that this key is enrolled for the company's account. It did not check who the company is…".
- **AC-36** `built` A reviewer with no account can open a link and then check files without being asked to sign in.
- **AC-37** `open` When the loaded receipt's head and key match the link's record, Verify shows "Matches the registry's record". When they don't, it shows a warn line and never a verified state.
- **AC-38** `built` (2026-11-19, Trust company keys PR; `newweb/tests/registry-wiring.mjs` "replace: …" asserts the old row reads "Replaced on {date}" and "rotated" is in neither `document.body.innerText` nor the HTML; `newweb/tests/company-keys.test.mjs` "labels: … never \"rotated\"") Trust → Your company's keys shows registry key state `rotated` as "Replaced on {date}". The string "rotated" never appears in the UI or in reports.
- **AC-39** `built` (2026-11-19; `newweb/tests/registry-wiring.mjs` "admin, no key loaded: …" enrolls as an admin, and "member (pilot, orgK): …" sees the list with no button but Copy) Enroll and Mark compromised are visible only to admins. Members see the key list read-only.
- **AC-40** `built` (2026-11-19; `newweb/tests/registry-wiring.mjs` "offline: key actions are disabled and the reason is shown") With the flag on and the device offline, Trust → Your company's keys disables its actions with the visible reason "You're offline. Key changes need a connection."
- **AC-41** `built, untested` The service worker does not cache any registry API response.
- **AC-42** `built` "Export pending proofs" (under "More options") downloads a `hashwing-outbox-export` v1 JSON file with one receipt line per row that is not registered. The status line reports the count.
- **AC-43** `built` A row with reason `quota_exceeded` shows exactly "Your company's monthly registration limit is reached; this proof is saved and can be exported". It makes no automatic retry, and "Export pending proofs" is its action.
- **AC-44** `built` For `envelope_expired`, `epoch_mismatch` and `sub_mismatch`, "Try again" sends the row with a new envelope. The row then reaches Registered, and the proof is not resealed. Tested at outbox level; the UI "Try again" path is not driven.
- **AC-45** `built, untested` With nothing to export, "Export pending proofs" shows "There's nothing waiting to export here. If this browser lost its saved data, only an export file you saved earlier can bring those proofs back." It downloads no file.
- **AC-46** `built, partly tested` Importing an export file queues its receipts, and already-registered ones show their original `received_at`. A non-export file shows "This file isn't a HashWing pending-proofs export."
- **AC-47** `built, untested` When the outbox runs in memory or `exportOffered` is true, the notice "This browser can't keep these proofs after you close the tab. Export them now." appears, and stays until an export succeeds.
- **AC-48** `built` A new share link defaults to 30 days. The only other length is 7 days (`registry-ui.jsx` offers 7 and 30), and the server answers 400 for more than 30 (`app.py` `create_share`, built 2026-11-18 in #55). The token appears in the page URL only after `#`. When the link is made, the registry receives only its SHA-256. This holds for share creation only: opening a link (`GET /v1/shares/{token}`) and withdrawing it (`DELETE /v1/shares/{token}`) carry the raw token in the request path.
- **AC-49** `built` A share request whose response was lost, when retried, returns the same link. Exactly one share exists.
- **AC-50** `built` On the public Pages build (`VITE_REGISTRY_URL` empty), the Trust page shows Trusted companies and Your signing key, and does not show Company registry or Your company's keys. Since 2026-11-19 "Your company's keys" is real, so the second half is now a real check: `newweb/tests/registry-wiring.mjs` "flag off: …" asserts Trust's panel headings are exactly Trusted companies, Your signing key, Trust and limits, Limits, and the flag-off bundle check scans `docs/console` for "Your company's keys", `/v1/keys` and `hashwing-key-enroll`. The flag-off sentence "Company sign-in isn't part of this copy of HashWing." is still not added (deferred: it changes flag-off text).


### Release layout (added 2026-11-17, all `open`)

These cover "Release layout, locked" above. Ledger IDs are in brackets.

- **AC-51** `open` [R13] The landing route shows HashWing, one value line, "Seal files" (primary), "Verify files" and "Try a sample" (which opens Samples), and keeps the footer links. Nothing on it changes on a timer during 10 seconds, and it has no numbered step list.
- **AC-52** `open` [R17] Seal & send shows the chosen files with a byte total in tabular mono, the mode, an optional job reference and one of the three signing lines (one-time key, loaded key with full fingerprint and Copy, or registering company and user). Going to Trust and back keeps the selection. Cancel during sealing keeps the selection and leaves one next action.
- **AC-53** `open` [R18] After sealing, the first step is Download (primary until done), then Copy message (primary after that). "Seal more files" before a download asks "You haven't downloaded {name}. Download it first?" with Download focused. Large-file mode lists the originals that travel separately (first five, then "Show all"). The share-link disclosure says it links to the registry's record, not the files. "Seal more files" clears the result and returns to the first step.
- **AC-54** `open` [R19] With the flag on, opening a share link lands on Verify with "I have a HashWing link" chosen and the link opened, and no file row is marked Matches until files are checked.
- **AC-55** `open` [R21] The headline follows the "Verify verdicts" table for each of its rows (including a one-time key reading "Files match · signer not confirmed" and a compromised key reading "Signed by a key marked compromised"), the counts equal the rows, and signature, key trust and registry stay on separate lines. At 1440px the comparison spans the main column. A renamed byte-identical file reads Missing plus Not in the list.
- **AC-56** `partial` (2026-11-18, Jobs PR: built and tested in `newweb/tests/jobs.mjs` for the registry-off build; 2026-11-19, built in #59: the flag-on status filter, registry status per row and row detail built and tested in `newweb/tests/registry-wiring.mjs`, the registry-off build's behaviour unchanged; share links and delete in the row detail, the "{company}" label, a company switch and "Last confirmed by this device" are not built) [R22] Jobs lists this browser's jobs 25 per page with search and a status filter (flag on), Resume, Export and Remove. Page and search are in the URL. Its heading area says jobs are saved in this browser only.
- **AC-57** `partial` (2026-11-18, Jobs PR: local logout and profile switch built and tested in `newweb/tests/jobs.mjs`; a company switch needs the registry and is not built) [R23] After logout or a profile or company switch, Jobs shows none of the previous owner's rows, and signing back in as that owner shows them again. No copy calls this server-enforced isolation.
- **AC-58** `built` (2026-11-18, Jobs PR; `newweb/tests/jobs.mjs`) [R22] Resuming a job whose package bytes are not held asks for the file again by name and never claims the bytes were saved. Remove asks first, with "Keep it" focused.
- **AC-59** `built` (2026-11-19; `newweb/tests/registry-wiring.mjs` "AC-59 (flag on): …" asserts the panel headings in order; "company keys: axe …" asserts `#company-keys` has exactly one `.button.primary` when it reads Replace with this key, and "admin, no key loaded: …" asserts the same when it reads Enroll this key) [R24] Trust shows these sections in this order: Trusted companies, Your signing key, Company registry and Your company's keys (both only with the flag on), then Trust and limits, with at most one primary button per section.
- **AC-60** `built` (2026-11-18, Jobs PR; `newweb/tests/jobs.mjs` and the flag-off check in `newweb/tests/registry-wiring.mjs`; 2026-11-19: flag-on builds keep the registry list on Seal & send and show registry status on Jobs, see R26) [R26] On the Pages build, "Sealed on this device" appears below the sealing result and Jobs works, and neither makes a request to any registry origin.
- **AC-61** `open` [R32] The command bar's menu is labelled "Profile on this device", and its entries and the profile screens say they use a local profile, not a company account. Company sign-in appears only on Trust.
- **AC-62** `open` [R36] With the flag on, an admin sees a registration's shares (active, expired, withdrawn, with expiry) after a reload and in another admin's session, and can withdraw one without the original link. A listed link never offers Copy after a reload; the full link is shown only in the tab that made it.
- **AC-63** `open` [R39] Refresh on a saved ack looks the registration up while signed in. On success the line reads "Registered at {received_at}" for the rest of that session; a failed or unauthorized lookup keeps "Last confirmed by this device {time}" and says why.
- **AC-64** `open` [R48] When the registry's recovery version differs from the one saved with an ack, the ack reads "Last confirmed by this device" with "The registry was restored; refresh to check this record" until refreshed. A record missing after a restore offers re-registration and never reopens a deleted proof or withdrawn link.
- **AC-65** `open` [R19] On a flag-off build, Verify opens on the files form with no link choice, and a URL with `share=` shows "This copy of HashWing can't open HashWing share links. Check the files instead."
- **AC-66** `open` [R24] The workbench session strip and "Source and report actions" appear only on Verify and the More tools routes.
- **AC-67** `open` [R67] Each event in "Focus and announcements" handles focus and announcements as given there; in particular, changing the Verify choice with the arrow keys keeps focus on the radio and adds no history entry. The chosen Verify option is shown by a check mark and border width as well as colour, also under forced colours.

Totals after this addition: 67 items; 25 built, 8 partly tested, 6 untested, 6 partial, 22 open.

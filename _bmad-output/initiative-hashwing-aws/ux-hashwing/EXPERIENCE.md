---
name: HashWing
status: in-review
updated: 2026-11-17
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

- **Existing**: in `main` at 951c3dc. Keep it as it is.
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

Primary nav (Existing: `PRIMARY_NAV`). The order is fixed.

| Nav item | Route | Purpose | Who |
|---|---|---|---|
| Seal & send | `protect` | Seal a small file or a set of large files, then send the receipt message. With the flag on, it also lists items sealed on this device with their registry status. | Pilot, ops lead |
| Verify | `verify` | Check what you were sent: a share link, or files plus a receipt message. | Reviewer |
| Records | `records` | Browse the records inside a loaded `.fseal` log. | Anyone with a log loaded |
| Receipts | `receipts` | Receipt coverage and signature checks for a loaded log. | Anyone with a log loaded |
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
- **Change: Verify opens on the reviewer's task.** The first panel is "Check what you were sent", with two choices: "I have a link" and "I have files". The sample demo panel moves behind a text link "Try a sample" that goes to Samples. The existing `.fseal` workbench inputs stay, under "More options". `[ASSUMPTION]`
- **New (registry): "Sealed on this device" list** at the bottom of Seal & send. Each row shows a registry chip; opening a row gives its detail (status, share links, delete). Builder default awaiting owner confirmation: it lives here rather than in Records, because Records means log records.
- **New (registry): share-link landing.** A reviewer opening a link lands on Verify with the "I have a link" choice already filled in. The share token is generated by the client (`registry-client.mjs` `createShare`). Only its SHA-256 goes to the registry when the link is made. In the page URL the token is carried only in the fragment, after the `#` (the console already routes by fragment, so it rides as a parameter of the Verify hash route), never in the page path or a query, which keeps it out of Referer headers and the app host's logs. The page reads it, then calls `GET /v1/shares/{token}`, which does carry the raw token in the API request path (as does withdrawing, `DELETE`), so registry access logs must not record the path. It is never written to analytics, history state beyond the current entry, or storage.
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
| Withdraw a link | Seal & send detail | 1 |
| Delete a hosted record | Seal & send detail | 1 |

## Feature flag: registry

- **Rule (built; the variable name and the empty Pages value are builder defaults awaiting owner confirmation).** All registry UI appears only when the build-time setting `VITE_REGISTRY_URL` is a non-empty URL. It is a public origin, not a secret. It is empty on the public GitHub Pages build, so the feature is off there. "Registry UI" means:
  - the registry chip and the "Sealed on this device" list
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
| `sealed_local` | Sealed locally | "Sealed on this device. Not sent to the registry yet." | none (sending starts automatically when signed in) |
| `waiting_for_connection` | Waiting for connection | "Saved on this device. It will register when you're back online. You can close this tab." | "Try now" (secondary) |
| `registering` | Registering | "Sending the receipt to the registry…" | none |
| `registered`, disposition `active` | Registered | "Registered at {received_at}. This is the registry's statement, not proof of the files." | "Make a share link" |
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
  - **Expiry.** The default is 30 days. Other lengths (7, 90 or 365 days) are under "More options" (builder default awaiting owner confirmation).
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
| "Registered at 14:02 UTC. This is the registry's statement, not proof of the files." | "Verified by HashWing Cloud ✓" |
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
  - Flag on, the line comes only from this device's saved outbox row for the checked receipt, never from a live registry lookup (`registryTimeField()`):
    - Saved acknowledgement: "Registered at {received_at}", with basis "the registry's clock; the registry's statement, not proof of the files".
    - Saved acknowledgement, record later deleted: "Registered, later deleted".
    - A row still waiting: "Not yet registered", with basis "this device's list: {row label}".
    - A row that needs attention: "Needs attention", with the row's message.
    - No row: "Not signed in", "Not available yet" (the list isn't open yet) or "No registry record on this device".
- **Key trust provenance (Existing, `trustLine()`).** The trusted, untrusted, replaced, compromised, wrong-key, invalid-signature and weak-key lines are reused verbatim. On the share-link page, add: "The registry checked that this key is enrolled for the company's account. It did not check who the company is. Compare the fingerprint with one you got from the company yourself." (New)
- **Key state display (New).** The registry key states `active`, `rotated` and `compromised` display as "Active", "Replaced on {date}" and "Marked compromised on {date}". This matches the local pin wording in `historyStatus()`.
- **Limits (Existing, Trust page).** Sealing shows that the file has not changed since it was sealed. It cannot show what happened before sealing. Nothing here claims legal admissibility, sensor truth or insurer acceptance.

## Component Patterns

Behavior only. Visual specs are in `DESIGN.md` under Components.

| Component | Behavior |
|---|---|
| Step panel (Change) | One task. It has a heading, the fields, "More options" (closed), and one primary button at the end. A finished step collapses to a one-line summary with "Change". |
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
| Seal & send, small file | "Choose a flight log to seal." Primary button disabled until a file is chosen. | "Sealing…" in the button. Busy state with `aria-busy`. | Existing message plus the next step, for example "This file is larger than 45 MiB. Choose Large files instead." | Works fully. No notice. |
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
| 403 `key_not_enrolled` | Needs attention | "This signing key isn't enrolled for your company yet. Ask your admin to enroll it on the Trust page, then try again." | "Try again" |
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
| 320px | One column with a 16px gutter. The share link row stacks: field, then two full-width buttons. Time fields stack label, value, basis. Nothing scrolls horizontally, and no control is clipped. |

Installed and offline: sealing, checking and the outbox work offline. The service worker never caches registry API responses (Existing rule: private APIs are never cached).

## Inspiration & Anti-patterns

- **Kept:** the existing honest-wording discipline (`BYTES_DIFFER`, time basis lines, the trust line). It is the product's voice.
- **Rejected:** toast stacks, red banners for offline, cloud badges like "Verified by HashWing", spinners on every state, onboarding carousels, and a dark-first "aerospace" theme (already rejected in the root `DESIGN.md`).

## Key Flows

### Flow 1: Priya seals and sends after an inspection (pilot)

Priya is a pilot for a three-person roof-inspection company. She has just landed beside a warehouse with one bar of signal, and the flag is on.

1. She opens Seal & send. The step "What are you sealing?" offers "Small file (seal the whole file, up to 45 MiB)" and "Large files (fingerprint only)".
2. **Small file:** she chooses the `.ulg` log. Under "More options" she enters the reported landing time. She presses **Seal this log**.
3. **Large files:** she adds 14 video files totalling 9 GB. Per-file progress shows, with Cancel. Each file is hashed on the device and nothing is uploaded. She presses **Seal the list**.
4. The step collapses to "Sealed · 14 files". The next step, "Send this receipt to someone else now", has one primary button, **Copy message**. Email and Download are secondary.
5. Below, the new row in "Sealed on this device" shows **Waiting for connection**, with "Saved on this device. It will register when you're back online. You can close this tab."
6. She closes the laptop. Back in the van, with signal, she reopens HashWing. The chip moves to **Registering**, then **Registered**, announced once.
7. **Climax:** she opens the row and sees "Registered at 15:41 UTC. This is the registry's statement, not proof of the files." She presses **Make a share link**, copies it and pastes it into her email to the client next to the receipt message.

Failure paths:

- **Lost acknowledgement.** The retry returns the original `received_at`. There is still one row.
- **429.** The chip shows Needs attention with the quota message. Everything stays saved locally.
- **Next morning.** The ops lead withdraws an old link from the row detail and gets the inline confirmation. For a record sent to the wrong client, the admin uses "Delete hosted record", and the dialog's safe default is "Keep it".

### Flow 2: Daniel checks what he was sent (outside reviewer, no account)

Daniel is a claims reviewer at an insurer. He has the email: a link, a receipt message and a shared folder of files.

1. He opens the link. Verify loads with "I have a link" already chosen. There is no sign-in prompt.
2. The panel shows the registry's statement: "The registry received a receipt for 14 items from the key with fingerprint 3f9a 1c… on 2026-11-17 15:41 UTC." Below it is the provenance line: the registry checked enrollment, not who the company is.
3. One next step: **Check the files**. It switches to "I have files" with the link's record kept for comparison.
4. He adds the sealed list, pastes the receipt message and adds the 14 files. For the trusted key, he chooses "Skyline Inspections", which he pinned last month from the contract.
5. **Climax:** "Manifest verified". The trust line reads "Signed by a key you trust: Skyline Inspections (added from contract or invoice)". The registry row reads "Matches the registry's record". Thirteen items read **Matches**, and one reads **Bytes differ**, with the existing explanation and no accusation. The time fields show reported landing (operator-entered, signed, not verified), the seal time on Priya's computer, and the registry acceptance with its basis.
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

## Builder defaults awaiting owner confirmation (2026-11-17)

These were chosen by the builder and are built, but the owner has not confirmed them.

- **Registry sign-in.** A small "Company registry" panel on the Trust page.
- **Setting.** Build-time `VITE_REGISTRY_URL`. It is empty on the public Pages build, so the feature is off there.
- **"Sealed on this device".** At the bottom of Seal & send.
- **Share-link expiry.** 30 days by default; other lengths under "More options".

## Decided (2026-11-17)

- **Key-management home.** Trusted companies and the signing-key controls live on the Trust page.

## Open

- **Trust shows the Verify workbench strip.** The Trust page currently shows the strip that belongs to Verify: "Choose a source or sealed log", the demo status, "Copy hash" and "Source and report actions". It should appear only on Verify. To be fixed in the Seal & send / Verify restructure, which is pending owner sign-off.
- **"Enroll it on the Trust page" has no control yet.** The `key_not_enrolled` message sends the user to Trust, but "Your company's keys" (AC-38..AC-40) is not built, so there is nothing to press there.
- **Verify chooser not built.** The "Check what you were sent" panel with "I have a link" and "I have files" (Information Architecture above, AC-09) is not built yet.

## Acceptance checklist

The wiring PR tests against these items. Each one is observable in the browser.

Build status, checked against the code and tests on `main` at e279032 (2026-11-17; read, not re-run). The tag after each ID means: `built` (in the code and asserted by a test), `built, partly tested` (a test covers only part of the item), `built, untested` (in the code, no test asserts it), `partial` (part is missing or not met) or `open` (not built). Totals: 26 built, 10 partly tested, 6 untested, 4 partial, 4 open. Still to build: AC-37 ("Matches the registry's record"), AC-38..AC-40 ("Your company's keys"), the Verify chooser (AC-09) and one primary button per step (AC-06).

### With the registry flag off

- **AC-01** `built` No registry URL is configured. No registry chip, "Sealed on this device" list, share link, "Your company's keys" section or registry sign-in appears on any page.
- **AC-02** `built, partly tested` No registry URL is configured. Sealing and checking a small file and a large-file set make no network request to a registry origin, and no outbox IndexedDB database is created.
- **AC-03** `built` No registry URL is configured. The Verify time fields show "Registry acceptance", "Not registered", "no registry was used".
- **AC-04** `built, partly tested` The primary nav shows exactly Seal & send, Verify, Records, Receipts and Trust, in that order. "More tools" contains Samples, Video, Benchmarks and System, and is closed unless one of them is the current page.
- **AC-05** `built, partly tested` With "More tools" open, Escape closes it and moves focus to its summary.
- **AC-06** `partial` No Seal & send or Verify step shows more than one `.button.primary` at a time. Not met today: after sealing, "Seal this log" and "Copy message" are both primary; Verify shows "Run Interactive Demo" and "Run check" as primary together.
- **AC-07** `built, untested` "More options" and "What is this?" are closed on first load of every page.
- **AC-08** `built` Trust contains "Trusted companies" and "Your signing key" in console mode. The seal hint refers to Trust, not Settings.
- **AC-09** `partial` Verify opens with "Check what you were sent". The sample demo is reachable from a "Try a sample" link. Not met today: Verify opens with the sample panel; the "I have a link / I have files" chooser and the "Try a sample" link are not built.
- **AC-10** `built` A byte-different file shows "Bytes differ" in the warn style with the exact `BYTES_DIFFER.text`. No surface shows "tampered" for it.
- **AC-11** `built` Every time row shows its basis line verbatim from `timeFields()`. A negative interval is shown as negative.
- **AC-12** `built` The trust line strings match `trustLine()` verbatim for trusted, untrusted, replaced, compromised, wrong-key, invalid-signature and weak.
- **AC-13** `built, partly tested` Every interactive element is at least 44 by 44 px at 320, 768 and 1440 px.
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
- **AC-25** `built` After the acknowledgement is saved, the Verify time row reads "Registered at {received_at}" with basis "the registry's clock; the registry's statement, not proof of the files".
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
- **AC-38** `open` Trust → Your company's keys shows registry key state `rotated` as "Replaced on {date}". The string "rotated" never appears in the UI or in reports.
- **AC-39** `open` Enroll and Mark compromised are visible only to admins. Members see the key list read-only.
- **AC-40** `open` With the flag on and the device offline, Trust → Your company's keys disables its actions with the visible reason "You're offline. Key changes need a connection."
- **AC-41** `built, untested` The service worker does not cache any registry API response.
- **AC-42** `built` "Export pending proofs" (under "More options") downloads a `hashwing-outbox-export` v1 JSON file with one receipt line per row that is not registered. The status line reports the count.
- **AC-43** `built` A row with reason `quota_exceeded` shows exactly "Your company's monthly registration limit is reached; this proof is saved and can be exported". It makes no automatic retry, and "Export pending proofs" is its action.
- **AC-44** `built` For `envelope_expired`, `epoch_mismatch` and `sub_mismatch`, "Try again" sends the row with a new envelope. The row then reaches Registered, and the proof is not resealed. Tested at outbox level; the UI "Try again" path is not driven.
- **AC-45** `built, untested` With nothing to export, "Export pending proofs" shows "There's nothing waiting to export here. If this browser lost its saved data, only an export file you saved earlier can bring those proofs back." It downloads no file.
- **AC-46** `built, partly tested` Importing an export file queues its receipts, and already-registered ones show their original `received_at`. A non-export file shows "This file isn't a HashWing pending-proofs export."
- **AC-47** `built, untested` When the outbox runs in memory or `exportOffered` is true, the notice "This browser can't keep these proofs after you close the tab. Export them now." appears, and stays until an export succeeds.
- **AC-48** `partial` A new share link defaults to 30 days. Other lengths are only under "More options". The token appears in the page URL only after `#`. When the link is made, the registry receives only its SHA-256. This holds for share creation only: opening a link (`GET /v1/shares/{token}`) and withdrawing it (`DELETE /v1/shares/{token}`) carry the raw token in the request path.
- **AC-49** `built` A share request whose response was lost, when retried, returns the same link. Exactly one share exists.
- **AC-50** `built` On the public Pages build (`VITE_REGISTRY_URL` empty), the Trust page shows Trusted companies and Your signing key, and does not show Company registry or Your company's keys. "Your company's keys" is not built yet, so that half passes trivially.

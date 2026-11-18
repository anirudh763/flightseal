# Adversarial review: architecture-hashwing-aws spine

Reviewer lens: build two units one level down that each follow every AD word for word but still don't fit together. Each pair below is a hole, and each comes with exact Rule wording to close it. Evidence is from the worktree code as it stands (2026-11-17).

**Verdict:** The spine holds on the server side, but it has 3 high-severity holes and 3 medium/low ones on the client side, which the newly added AD-15, AD-16 and AD-17 text and the label convention cover. The worst one: AD-5 and AD-15 disagree about how long an idempotency key lives, and the server's payload hash makes the literal AD-5 reading fail with a 409.

---

## F1 (High): AD-5 vs AD-15, idempotency key lifetime across a new envelope

**Unit A (outbox, follows AD-5 literally):** "Clients keep the original idempotency key for every retry ... one owner/payload-bound idempotency key per receipt for the life of its retries." When it gets a 422 `envelope_expired` and the user clicks `retryNow(id)`, it binds a fresh envelope and *keeps* the original key.

**Unit B (registry, `app.py` register):** hashes the payload as `{"receipt", "envelope_id"}` (app.py ~272) and answers 409 `idempotency_conflict` for the same key with a different payload.

**Result:** every envelope retry from Unit A gets 409. The client maps that to the terminal `conflict` reason ("Export this proof and contact your admin"), so a fixable expiry becomes a dead end. The merged `outbox.mjs` avoids this only because it ignores AD-5's wording: `idempotencyKey(ownerId, receipt, envelopeId)` and `retryNow` deletes `idempotency_key` on the envelope reasons. AD-15 and AD-5 never say that the envelope id is part of "payload".

**Rule fix (AD-5, replace the last two sentences):**
> The idempotency key is `b64url(sha256(owner + "\n" + receipt + "\n" + envelope_id))`, and the server's payload hash covers exactly `{receipt, envelope_id}`. The key is kept for every retry of one bound envelope (network, timeout, 408, 5xx, throttling 429, a lost ack). It changes only when the row is rebound to a new envelope, and only through an explicit `retryNow(id)` after `envelope_expired`, `sub_mismatch` or `epoch_mismatch`. Never send a stored key with a different envelope id. A retry never creates a share.

Then change AD-15's "one owner/payload-bound idempotency key" to "one key per (owner, receipt, envelope), as AD-5 defines it".

---

## F2 (High): AD-17 `logout` scope vs the per-profile local logout, which discards another user's unsent proofs

**Unit A (`main.jsx` `logoutFromAnotherTab`):** acts only when `message.userId` matches this tab's active local profile. The local session lives in `sessionStorage` (`local-auth.mjs` `setLocalSession`), so two tabs can hold two different local profiles (X and Y).

**Unit B (`registry-ui.jsx`, AD-17 literally):** `{type: 'logout'}` acts in "every tab" and "discards, in every open tab, the unsent proofs held in memory".

**Result:** profile X logs out in tab 1. Tab 2, signed in as profile Y, drops its registry sign-in and **silently loses Y's in-memory unsent proofs**: ones sealed while signed out, or kept in memory because the queue was full. Y is still logged in. The rule meant to protect "the user who left" deletes data that belongs to the user who stayed. Also, `logoutFromAnotherTab` calls `registryLogout()`, which re-broadcasts `{type:'logout'}`, and it does so even when `!activeSession`. So one logout echoes once per tab, and the two channels have different scoping rules for the same event.

**Rule fix (AD-17, replace the `{type: 'logout'}` clause and the "App logout also discards" sentence):**
> `{type: 'logout', user}` names the local app session's `userId` (an opaque local id, never a token). Only tabs whose active local session has that `userId` drop their registry token, close the outbox, and discard their in-memory unsent proofs and display names. A tab with another local session ignores it. A tab that receives a logout never re-broadcasts it. The local-auth logout channel and `hashwing-registry` carry the same `userId` for the same event, and the registry acts on exactly one of them.

---

## F3 (High): who owns an in-memory unsent proof? Registry sign-out then a sign-in as someone else

**Unit A (`registry-ui.jsx` `sealed()`):** if the outbox is closed, or `enqueue` throws `RangeError` (queue full at 200), the receipt goes to `state.pending` with no owner tag.

**Unit B (`signIn` for a new owner):** closes the old outbox, keeps the display names of pending proofs, and then enqueues *all* of `state.pending` into the new owner's outbox. AD-15's check "the token's owner must match the outbox owner before every send" passes, because the row is now in B's outbox.

**Result:** A seals while signed in (queue full, so the proof stays in memory), clicks registry **Sign out** (not app logout, so AD-17's discard never runs), and B pastes a token. A's proof is registered under B's `sub` (same org), or ends up as `key_not_enrolled` in B's list (other org). AD-17's "Prevents" line names this exact case ("one user's unsent proofs sent or shown under the next user"), but its Rule covers only app logout. The spine never says whether a pending proof belongs to the registry owner or to the app session, so there are two owners of one entity.

**Rule fix (new sentence in AD-15):**
> An in-memory unsent proof records the registry owner (`<org>/<sub>` or `null`) that was signed in when it was sealed. On sign-in it is enqueued only into an outbox whose owner equals that record, or when the record is `null` and the app session is unchanged. A proof recorded for another owner stays in memory, is offered for export, and is never enqueued, sent or listed under a different owner. Registry sign-out keeps the proof in memory under its recorded owner.

---

## F4 (Medium): label convention, where `null` means two different things and gives "Not registered" in a registry build

**Unit A (`recipient-trust.mjs` `timeFields`):** `registry == null` turns into "Not registered" / "no registry was used". The convention allows this.

**Unit B (`registryTimeField`):** returns `null` when the checked message has no receipt lines, and `main.jsx` passes `''` whenever `protectView` / `outcome.verified` is false. The manifest-check report then keeps `outcome.report` (built with `registry: null`) whenever `registryLine` is falsy.

**Result:** a registry build reports "Not registered — no registry was used", which is false. The convention ("only when the build has no registry") breaks, while each unit follows its own contract. Any future report writer that builds before the registry line resolves hits the same problem.

**Rule fix (Client labels row, and AD-15's last sentence):**
> The registry row is three-way and never inferred from a missing value. In a no-registry build (`__REGISTRY_URL__` empty), and only there, it reads "Not registered" / "no registry was used". In a registry build, `registryTimeField` always returns a value, for example "No receipt to look up" / "this check has no receipt line", and `timeFields` takes the build flag explicitly, so `registry: null` in a registry build is an error that a test catches.

---

## F5 (Medium): AD-15 "this device's saved ack" vs per-tab snapshots, ack eviction and the live share panel

Three pairs that each follow AD-15 but disagree about what the device "has":

1. **Two tabs, same owner.** Tab 1 holds the Web Lock, dispatches and commits the ack to the shared IndexedDB. Tab 2's `rows` come only from its own outbox instance's `emit()`, and that never fires for another tab's commit. Tab 2's Verify line and every report it exports keep saying "Not yet registered — Registering" while the device has the ack.
2. **Eviction.** `MAX_ACKS = 1000` silently drops the oldest acks. A registered receipt then reads "No registry record on this device", which looks the same as "never sent".
3. **Same Verify screen.** `ShareRecordPanel` (AD-9, a live lookup) shows "Received by the registry <time>", while the AD-15 line for the same check reads "Not signed in" or "No registry record on this device". The report carries only the second one. Neither unit is wrong, but the screen contradicts itself.

**Rule fix (AD-15, after "never from a live registry lookup"):**
> "This device's saved row" means the outbox's persisted store, as of when the line is shown. A tab learns about another tab's commits for its owner (a `{type: 'changed', owner}` message on `hashwing-registry`, or a re-list on `visibilitychange`) before it shows or exports a registry line. Evicted acks are counted, and the line then reads "No registry record on this device (older records may have been cleared)". The share-link panel is a separate field, labelled as the link's record. It never fills or overrides the device line, and a report built while a link is open names both sources.

---

## F6 (Low): AD-16 loopback test written twice; AD-17 "user" never defined

- `isLoopback` in `registry-ui.jsx` ("as vite.config.js") and the list in `vite.config.js` are two copies of the same rule. If one copy changes (for example adding `*.localhost` or `127.0.0.0/8`), the build would accept an http URL that the UI then treats as non-loopback, or the reverse. **Rule fix (AD-16):** "The loopback host set is defined once and imported by both `vite.config.js` and `registry-ui.jsx` (or a test asserts the two lists are equal); http is allowed exactly for that set, and Test sign-in appears exactly for that set."
- AD-17 says "the user who left", but outbox databases are keyed by registry owner (`hashwing-outbox-v1-<sha256(owner)>`). When local profile Y signs into the same registry owner after X, Y sees X's saved rows ("closed, not deleted"). **Rule fix (AD-17):** "Saved outbox rows belong to the registry owner `<org>/<sub>`, not to the local profile; any local profile signed in as that owner sees them. In-memory proofs and display names belong to the local session (F2, F3)."

---

## Checked and not a hole

- AD-16 build gating: every registry render and call in `main.jsx` is behind `__REGISTRY_URL__`, and `vite.config.js` rejects credentials, query, fragment and non-loopback http.
- The AD-17 sign-out message names the owner and never a token, and the receiving tab compares it with `state.owner`.
- The AD-15 owner check before send: `authToken()` compares `tokenOwner(tok)` with `ownerId` on every dispatch.
- AD-15 response handling (429 split, envelope codes, 410 terminal) matches `outbox.mjs` `handleResult`.

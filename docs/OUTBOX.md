# Registration outbox (browser client)

`newweb/src/outbox.mjs` holds receipts that are waiting to be sent to the receipt registry
([ARCHITECTURE_AWS.md](aws/ARCHITECTURE_AWS.md)). `newweb/src/registry-client.mjs` is the only code that talks HTTP to
the registry. The console wires them through `newweb/src/registry-ui.jsx` only when it is built with
`VITE_REGISTRY_URL` (a public https origin; http is allowed only for a loopback host). With it empty, the default and the
GitHub Pages build, none of this code ships: `main.jsx` guards every registry render and call with `__REGISTRY_URL__`, and
`newweb/tests/registry-wiring.mjs` scans `docs/console` to prove it.

What the console does with the flag on:

- **Trust → Company registry.** A loopback registry offers "Test sign-in (local only)": paste a dev token. The token
  lives in tab memory and `sessionStorage` (`hashwing-registry-token`) only. Any other registry says sign-in isn't
  available in this build yet.
- **Seal & send → Sealed on this device.** Each successful seal (small file or large-file list) hands the last
  receipt line to `enqueue`. The display name stays in memory only. Signed out, the receipt is saved on this device as
  unassigned local work (see "Pending proofs" below) and is never sent by itself. Each row is a `<details>` with the outbox label as its chip, one detail line and at most one action.
- **Shares and delete.** Registered rows can make, copy and withdraw a share link
  (`#/app/verify?share=<token>`, fragment only). Admins can delete the hosted record; the console then calls
  `markDeleted(id)`, which rewrites the saved ack with `disposition: 'deleted'`.
- **Verify.** A share link shows "The registry's record" from `GET /v1/shares/<token>` with no sign-in. Every field
  is checked first (`head` and `key_fingerprint` 64 lowercase hex, `count` a non-negative safe integer, `received_at` a
  date); anything else, a 429 or a 503 shows "The registry is temporarily unavailable". Each registry panel sits in an
  error boundary, so one bad panel can't blank the app.
- **Check results.** The "Registry acceptance" time row of a small-file or manifest check, and the text, Markdown,
  JSON and PDF reports built from it, read this device's outbox row whose `receipt` equals one of the checked receipt
  lines: "Registered at `received_at`" (the registry's clock; the registry's statement, not proof of the files), "Not
  yet registered", "Registered, later deleted", or "Needs attention" with its message. With no matching row it says
  this device has no registry record for the receipt ("Not signed in" while signed out, "Not available yet" until this
  device's list has been read). With the flag off it stays
  "Not registered" / "no registry was used".
- Sign-out, a token for another owner, and the app's logout paths close the outbox and forget the registry token.
  A registry sign-out is broadcast (`BroadcastChannel('hashwing-registry')`, `{type: 'signout', owner, at}`, never a token)
  to the other open tabs; only tabs of that owner `<org>/<sub>` drop their copy of the token (a duplicated tab copies
  `sessionStorage`) and stop sending. An app logout is not sent on that channel: the app's own logout message names the
  local profile, so only that profile's other tabs sign out of the registry. Signing in to the app, switching account or
  starting the demo signs out of the registry in that tab only, and never touches other tabs.
- **Pending proofs** (`newweb/src/pending-store.mjs`) are unsent proofs not yet in an owner's outbox: sealed while
  signed out of the registry (no owner: "unassigned"), or kept because the owner's outbox could not take them (for
  example when it is full; tagged with that owner). They are saved in IndexedDB, one database per local scope
  (`hashwing-pending-v1-<sha256(scope) hex>`, scope `profile:<local profile id>` or the shared `guest`), at most 200 rows
  of `receipt`, `owner` and `at` only: never a file name, media, key or token. Sign-out and logout never delete them, and
  another local profile never sees them. A row leaves the store only once the owner's outbox holds it.
- An unassigned proof is never sent by itself, whoever signs in. Its row says it was sealed while signed out and offers
  "Assign to <org>" while signed in; the registry still checks that its key is enrolled for that company and that the
  user is a member (a refusal shows as Needs attention, for example `key_not_enrolled`). A proof tagged with an owner is
  sent only under that owner; under any other sign-in its row says so and offers "Export pending proofs", and its file
  name is hidden.
- Without IndexedDB (or when one save fails) a pending proof lives in tab memory only; the list then offers
  "Export pending proofs" at once.
- Before anything unsaved is lost, the app asks first. Reloading or closing the tab warns while a Seal & send result,
  a large-file result, a workbench output or a memory-only pending proof is not saved yet. Logging out, switching
  account, signing in or starting the demo waits until "Download unsaved work" (one zip) has saved them. A logout this
  tab did not choose (the same profile logged out in another tab, or the workspace server signed out) keeps that work
  in tab memory and offers it as one download, with "Discard"; this tab is signed out of the registry at once. After a
  reload, a file that was chosen but not sealed is no longer selected, and the page says to choose it again. Rows in
  the outbox database stay there, closed, for that owner's next sign-in. A new owner neither sees the previous owner's
  file names nor hears them announced.

## Owners and storage

- The owner is `<org>/<sub>`, read from the bearer ID token's `org_id` (dev tokens) or `custom:org_id` (Cognito)
  claim and its `sub` claim. The client reads these claims without verifying them; the server does the verifying.
- Each owner gets its own IndexedDB database, `hashwing-outbox-v1-<sha256(owner) hex>`, with three object stores:
  `queue`, `acks` and `meta` (the cached envelope).
- Before every request, the current token's owner must equal the outbox's owner. If it does not, nothing is sent,
  rows stay queued, and `status().needsSignIn` is true.
- Dispatch runs under the Web Lock `hashwing-outbox:<hash>` (`ifAvailable`), so only one tab of an owner sends at a
  time. A tab that does not get the lock looks again 5 s later.

### Stored fields (`ROW_FIELDS`)

Every row: `id` (sha256 of `owner|receipt`), `receipt`, `envelope_id`, `envelope_expires_at`, `envelope_epoch`,
`idempotency_key`, `state`, `reason`, `attempts`, `next_attempt_at`, `created_at`, `updated_at`.

Rows with an ack only: `registration_id`, `received_at`, `count`, `head`, `key_fingerprint`, `disposition`,
`acked_at`.

A write with any other key throws. The outbox never stores media, manifests, salts, file names or keys.
`idempotency_key` is base64url(SHA-256(`owner\nreceipt\nenvelope_id`)), 43 characters. It is set when an envelope
is bound to the row and does not change while that binding lasts.

## States and labels

| State | Label |
|---|---|
| `sealed_local` | Sealed locally |
| `registering` | Registering |
| `waiting_for_connection` | Waiting for connection |
| `registered` (ack with `disposition: active`) | Registered |
| `registered` (ack with `disposition: deleted`) | Registered, later deleted |
| `needs_attention` | Needs attention (the row's `reason` says why) |

A row shows "Registered" only after the server's ack has been written to `acks`. The same transaction deletes the
row from `queue` (`commitAck`). If that write fails, the queue row stays and the next dispatch resends the same
idempotency key, which returns the original ack.

## What each response does

| Response | Result | Next step |
|---|---|---|
| 201/200 `disposition: active` | `registered`, "Registered" | none |
| 200 `disposition: deleted` | `registered`, "Registered, later deleted" | none (terminal) |
| 410 `registration_deleted` | `needs_attention`, `registration_deleted` | terminal; `retryNow` ignores it |
| 409 `idempotency_conflict` | `needs_attention`, `conflict` | terminal |
| 422 `envelope_expired`, `epoch_mismatch` or `sub_mismatch`, or the local expiry has passed | `needs_attention`, that code | `retryNow(id)` binds a new envelope and a new key |
| 422 `bad_signature`, 400, 413 | `needs_attention`, the server's code | terminal |
| 403 `key_not_enrolled` / `key_not_active` | `needs_attention`, the server's code | `retryNow(id)` retries with the same binding |
| 401 | stays queued, `needsSignIn: true`, dispatch stops | resumes once a different token for the same owner is available |
| 429 `quota_exceeded` (the org's monthly quota) | `needs_attention`, `quota_exceeded`, message "Your company's monthly registration limit is reached; this proof is saved and can be exported" | final for the month: no automatic retry; `retryNow(id)` tries again (for example next month) |
| 503, any other 429 (API Gateway throttling), other 5xx, network error, timeout, a 2xx that is not a readable JSON ack (`bad_response`) | `waiting_for_connection`, `attempts + 1` | backoff: d = min(15 min, 2 s · 2^(n-1)), delay in [d/2, d]; after 10 attempts `needs_attention`, `attempts_exhausted` (retryable) |

`retryNow()` with no id sends every queued row now, ignoring backoff and `navigator.onLine`. The outbox also
dispatches on open and on the `online` event. It never creates or retries a share. It mints a new envelope only for
a row that has none yet, as a once-per-open prefetch, or through an explicit `retryNow(id)` after one of the three
envelope refusals. The prefetch first reads `GET /v1/epoch` and drops a cached envelope from an older epoch.

Shares are explicit client calls, never queued. `createShare({registration_id, expires_days})` makes the token
locally, sends only its SHA-256 plus an idempotency key, and always returns `share: {token, idempotency_key, path}`,
even on failure. After a lost response, call `createShare({registration_id, ...share})` again: the registry returns
the same share, or its current disposition if it was withdrawn or expired. This also works after the 7-day
idempotency window. A malformed `token`, or a page without Web Crypto (not a secure context), returns
`{ok: false, kind: 'client'}` and sends nothing.

## Limits and recovery

- At most 200 queued rows (`enqueue` throws `RangeError` past that) and 1000 acks (the oldest ack is pruned).
- If IndexedDB cannot be opened, the outbox runs in memory: `status()` is `{storage: 'memory', exportOffered: true}`.
  If one enqueue write fails (quota), that row is kept in memory and `exportOffered` turns true. Memory rows are
  lost when the page closes, so offer `exportPending()` straight away.
- `exportPending()` returns `{ok: true, count, text}`, where `text` is JSON:
  `{"format": "hashwing-outbox-export", "version": 1, "receipts": [<receipt line>, ...]}` with one line per
  unregistered row. If there is nothing to export, it returns `{ok: false, reason: 'needs_previous_export'}`,
  never an empty success: if the browser lost its storage, only an earlier export file can bring the rows back.
- `importProofs(text)` queues the receipt lines from an export file again (anything else is `{ok: false, reason: 'not_an_export'}`). A receipt that was already registered
  gets its original ack back, because the server dedupes by registration id across idempotency keys.
- After `close()`, timers and listeners stop, the in-flight request is aborted, and any late result is dropped.
- A tab ignores a sign-out message older than its own current sign-in (a delayed message). Each sign-out also records
  when that owner signed out in `localStorage` `hashwing-registry-signouts` (a 32-hex hash of the owner and a time, at
  most 50 entries; never a token). A tab that was frozen, discarded, restored with its `sessionStorage`, or has no
  `BroadcastChannel` checks it when it opens or wakes (`pageshow`, `focus`, `visibilitychange`, `resume`) and does not
  use a saved token from before that sign-out.
- **Memory only.** The unsaved work kept after a forced logout, and memory-only pending proofs, live in tab memory. A
  tab that crashes, or a reload the user confirms past the browser's warning, loses them; only an export saved earlier
  brings them back. A removed local profile's pending database is not deleted with it.

## Commands

```sh
node --test newweb/tests/outbox.test.mjs newweb/tests/registry-client.test.mjs   # 49 tests, stub fetch + memory store
node --test newweb/tests/registry-session.test.mjs                                # 9 tests, the console's session store in Node
node --test newweb/tests/outbox-browser.mjs                                      # 8 tests, Chromium + dev server
node newweb/tests/registry-wiring.mjs                                            # 28 checks, flag-off scan + flag-on console
```

The browser tests start `registry/devserver/server.py` (DEV ONLY; it refuses to bind to anything but loopback),
which runs the real registry `App` over `MemoryTable` with dev HS256 tokens, plus `/__dev/*` controls for the
clock, held registrations, dropped registrations or shares, the CORS allowlist, and a request log. Set `PYTHON` to choose the interpreter (default `python3`).

## Contract problems found

1. **No CORS.** Fixed: an allowlist of exact origins, both in the stack and in the Lambda (see ARCHITECTURE_AWS.md,
   CORS). The browser suite registers from a real cross-origin page, and checks that a page from an origin off the
   allowlist is blocked.
2. **Envelopes are bound to `sub`.** An envelope that one user fetched cannot be used by another user in the same org.
   This is why the outbox is scoped per user, not per org.
3. **A deleted registration gets two different answers.** A retry with the original key returns 200
   `disposition: deleted` until the idempotency record expires (7 days). Any other key returns 410. The outbox
   treats both as final.
4. **Every 401 looks the same.** The server does not say whether a token expired or is invalid, so the outbox can only
   say "sign in again".
5. **429 has two meanings.** Fixed: a 429 whose body is `{"error": "quota_exceeded"}` is the monthly quota and is
   final for the month (`needs_attention` with a plain message; the proof stays saved and can be exported). Any other
   429 is API Gateway throttling and is retried with backoff.
6. **`received_at` is rounded to the second** (ISO 8601 UTC), so two commits in the same second have the same
   timestamp.
7. **`POST /v1/shares` took no idempotency key.** Fixed: the client makes the token and sends its hash with an
   idempotency key, so a retry returns the same share (browser test: the server commits, the connection drops, the
   retry gets 200 and the original link works).
8. **There was no way to read the current epoch, and one 422 covered three cases.** Fixed: `GET /v1/epoch`, and
   `envelope_expired` / `epoch_mismatch` / `sub_mismatch`.
9. **Share tokens can only be withdrawn from the tab that made them.** There is no route that lists an org's shares, and
   the console keeps a token in React state only, so a link can be withdrawn only while that row is still on screen in
   the tab that made it. Anyone else must ask an admin to delete the hosted record, which stops every link.
10. **The dev server has no quota control.** The browser test fakes the `429 quota_exceeded` answer with Playwright
    request interception instead.

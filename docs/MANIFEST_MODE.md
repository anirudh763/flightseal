# Manifest-only sealing (`hashwing-manifest v1`)

Seal & send has two modes. **Small file (seal the whole file, up to 45 MiB)** is the unchanged embedded mode
(`docs/rawfile.js`), which puts the whole file inside the sealed log. **Large files (fingerprint only)** is manifest
mode, which seals a list of file sizes and SHA-256 digests instead, so multi-GiB flight
videos and logs, or up to 100 files at once, can be sealed. The originals stay on the operator's storage.

**A manifest is not a backup.** If an original is lost, the manifest cannot bring it back.

The FLTSEAL1 format, receipt v1, the C++ core and `docs/verifier.js` verdicts are unchanged. A sealed manifest is an
ordinary one-record FLTSEAL1 log, and `fseal verify` checks it like any other log.

## Payload

One ASCII line with no CR or LF (the sealer reads one record per line):

```
hashwing-manifest v1 salt=<64 lowercase hex> items=<n>[ item=<i>,<bytes>,<sha256>,<name>,<note>]×n
```

- `salt`: 32 random bytes (`crypto.getRandomValues` / `secrets.token_hex`). It makes every manifest, and its chain
  head, unique. It does not hide the digests.
- `i`: 1..n, contiguous and ascending, in the operator's selection order.
- `bytes`: decimal, no leading zeros, at most 15 digits.
- `sha256`: 64 lowercase hex digits of the file's bytes, hashed in order through one SHA-256 context.
- `name`, `note`: `encodeURIComponent` of the exact UTF-8 text (Python: `quote(s.encode(), safe="-_.!~*'()")`),
  empty when absent. Names are included only when the operator ticks "Include file names". `note` is
  operator-entered text, not something HashWing measured.
- The name is the file's own name, as the browser's `File.name` gives it. `tools/manifest.py` uses
  `os.path.basename`, which gives the same name on the same system: on macOS and Linux only `/` separates folders,
  so a file named `x\y.mp4` keeps that name (`x%5Cy.mp4`); on Windows a backslash separates folders too, so
  `C:\flights\a.mp4` gives `a.mp4`. Check a manifest on the same kind of system that created it if file names
  contain a backslash.
- The parsers (`parseManifest` in `docs/manifest.mjs`, `parse` in `tools/manifest.py`) decode each field, encode it
  again and require byte equality. Any other spelling of the same text is rejected.

It is sealed as the single source line `0<TAB><payload>` with a receipt interval of 1, so the log has record seq 0
and timestamp 0, and one receipt with `count=1`. The chain head of that log is `SHA-256(32 zero bytes ‖ seq u64le ‖
ts u64le ‖ len u32le ‖ payload)`. It depends only on the payload, not on the key.

Published vectors are in `tests/fixtures/manifest/`: `basic.*` has a 0-byte item, a UTF-8 name, an operator note and
an item without a name; `minimal.*` has one item with no name and no note. Each `*.payload` holds the exact bytes and
each `*.head` holds the hex chain head.

### Limits

| Limit | Value |
|---|---|
| Items | 1 to 100 |
| Payload | at most 65,536 bytes |
| Name | at most 255 UTF-8 bytes |
| Note | at most 1,000 UTF-8 bytes |
| Text | unpaired UTF-16 surrogates are rejected (`TypeError`) |

## Verification rule

`verifySealedManifest(blob, receiptText, trustedKey)` returns a manifest only when every one of these holds:

1. The recipient entered a trusted public key, or chose one from a local pin, in the separate "Trusted public
   key" field. The key inside the receipt and any "Public key:" line in the message are never used as the trust
   anchor.
2. The receipt text contains exactly one receipt line, and that line has `count=1`.
3. The chain is intact, has exactly one record, and has no bytes after it.
4. The receipt head equals the scanned head.
5. The Ed25519 signature is valid for the trusted key. If the browser cannot check Ed25519, the result is "not
   verified".
6. Record 0 has seq 0 and timestamp 0, and its payload parses strictly.

The check shows only fields parsed from the signed payload. Names, sizes, digests and times in the handover message
are not signed and are ignored. The handover message carries only the receipt, the public key and the item count.

### Note tags (operator values inside the signed note)

The Seal & send page can put two operator-entered values at the start of an item's `note`, before the free text:

```
[reported-landing=<ISO 8601 UTC>][derived-from=<text>] <free-text note>
```

- `reported-landing` is the landing time the operator typed (one value for all items in a list). `derived-from`
  marks an edited copy and names its original, for example `item 2` or that file's SHA-256.
- Either tag may be absent; tags come in this order and the free text follows after one space. A note with no tags
  is plain text. `derived-from` cannot contain `[` or `]`.
- The tags count toward the 1,000-byte note limit. They are signed because the note is signed, but they are what
  the operator entered: HashWing does not check them, and the check page labels them "operator-entered, signed".
- The payload format is unchanged; the parsers treat a tagged note like any other note.

Embedded mode has no signed slot, so a reported landing time goes in the handover message as
`Reported landing time: <ISO> (operator-entered, not signed, not verified)`. In both modes the seal time shown to
a recipient comes from the handover `Sealed:` line and is labelled as this computer's clock, unsigned. The check
page also lists "Registry acceptance: Not registered" and "Trusted timestamp: None", and the reported
landing-to-seal interval. A negative interval is shown as negative, never clamped to zero.

### Trusted companies (fingerprint pins)

Settings → Trusted companies keeps, in this browser only, a company name, the SHA-256 fingerprint of its public key
and where the user got that fingerprint (company website, contract or invoice, phone call, other). Replacing a key
needs an in-page confirmation and keeps the old one in the key history; a key can be marked as compromised.
A compromised key stays recorded as compromised even after its company is removed, and it cannot be added again under
any name.

- If the "Trusted public key" field is empty, the check uses the key inside the receipt only when its SHA-256
  fingerprint equals an **active** pin. Otherwise the check refuses, as before. A replaced or compromised pin is
  never used this way.
- After a successful check the page says "Signed by a key you trust: <company> (added from <source>)", or that the
  key is not in the trusted list, was replaced, or was marked compromised. A wrong key is still "Manifest not
  verified".
- Reports (text, Markdown, JSON with `keyTrust`, `timeProvenance` and `fileComparison`, and PDF) carry the same
  trust line, source, time fields and Bytes differ wording.

## Pairing rule

`compareFiles` in JavaScript and `compare` in Python follow the same deterministic steps:

1. Take each local file in selection order. It matches the lowest-id unmatched item with an equal size and digest:
   **Matches**.
2. Take each remaining local file. If its name equals the included name of the lowest-id remaining item with that
   name: **Bytes differ**.
3. Remaining items are **Missing**. Remaining local files are **Not in the list** (status key `not-in-manifest`).

This is `compareFiles` in `docs/manifest.mjs` and `tools/manifest.py`. The console's Verify page pairs by name
instead (`pairFiles` in `newweb/src/recipient-trust.mjs`, AC-55): a named item pairs with the chosen file of the
same name, and only items sealed without a name pair by size and digest, so a renamed byte-identical file reads
Missing plus Not in the list.

Duplicate digests are allowed. Each local file and each item pairs at most once. "Bytes differ" means only that a
file with that name now has different bytes. Editing, re-saving, a metadata change, recompression, truncation or
corruption can cause it. It is not proof of tampering, and the check does not pick a cause. Similarity is never
estimated.

## Interface

The owner's copy direction of 2026-11-17 replaces the plan's labels. The mode choices are "Large files (fingerprint
only)" and "Small file (seal the whole file, up to 45 MiB)", and small file stays the default. The page shows "This
keeps a fingerprint, not a copy. Keep your original files." The terms manifest, salt and "A manifest is not a
backup" are explained in a "What is this?" disclosure.

- **Steps**: a step list (Choose files, Seal, Send) marks the current step with `aria-current="step"`.
- **Progress**: each file has its own progress bar with percent and MB/s (10^6 bytes per second), and Cancel on the
  file being read.
  After Cancel, files already fingerprinted are reused if their size and modified time are unchanged; an edit that keeps both is not detected — seal again from a fresh file pick to re-read everything. The message after Cancel says so when it applies: "Files already read are reused; choose them again to re-read everything."
- **More options** (hidden until opened): include file names, operator notes, and the receipt interval and
  signing-key details.
- **Result chips**: Matches is green (circle); Bytes differ, Missing and Not in the list are amber (warn shape).
- **Limits checked first**: limit errors are checked before any file is read.

## Implementation

- **Browser**: `hashFile()` in `docs/wasm/client.mjs` starts one Web Worker per file
  (`docs/wasm/hash-worker.mjs`).
  - The worker reads 4 MiB `File.slice()` chunks, one read in flight, and copies each into one reused WebAssembly
    heap buffer. It then detaches the read (`ArrayBuffer.prototype.transfer(0)`), so Chrome frees those 4 MiB at once
    instead of keeping old reads until the next garbage collection. Browsers without `transfer` skip this step.
  - It calls OpenSSL `EVP_DigestInit_ex/Update/Final_ex` through `fseal_sha256_begin/update/final` in
    `wasm/bridge.cpp`, rebuilt with `scripts/build_wasm.sh`. The Docker build worked, so the JavaScript SHA-256
    fallback was not needed.
  - There is no size cap and no deadline. Cancel terminates the worker. Files are hashed one after another.
- **Privacy**: no network request carries source bytes, names or digests. The manifest state is kept apart from the
  verification result, so "Save current run" cannot upload it.
- **CLI**: `tools/manifest.py digest|create|check`. It hashes with `hashlib.sha256` using 4 MiB `readinto` reads and
  writes the same bytes as the browser. Seal its output with `build/fseal append LOG --key K --receipts R --every 1`,
  then check it with `fseal verify` and the trusted key. `manifest.py check` reads the record but does **not**
  check the signature, and says so.

## Measurements

### Memory gate: 128 MiB extra while hashing (2026-11-17, passes after the fix on one machine)

The target is at most 128 MiB of extra memory while one file larger than 2 GiB is hashed. It was not met before the
fix (worst run +269.6 MiB) and is met after it: worst run +55.1 MiB with each path on a freshly loaded page, and
+94.0 MiB when Check runs on the same page right after Seal (the earlier set below). Scope: one Apple M1 Pro with
headless Chrome 158, measured by a manual script that is not a CI check. Other browsers were not measured; a browser
without `ArrayBuffer.prototype.transfer` keeps the old behaviour.

**Cause.** Each 4 MiB `File.slice().arrayBuffer()` read was a new `ArrayBuffer` that stayed alive until the worker's
next garbage collection. The Wasm heap did not grow (33,554,432 bytes before and after), there are no `postMessage`
copies of file bytes (progress messages carry a number) and only one read is in flight. The growth was all in the
page's renderer process. **Fix**: one line in `docs/wasm/hash-worker.mjs` detaches each read right after it is copied
into the Wasm heap. Digests are unchanged.

**Machine.** MacBookPro18,3 (Apple M1 Pro, 16 GiB), macOS 26.5.2 (25F84), Google Chrome 158.0.8127.36 headless
(Playwright 1.63.0, `executablePath` set to the installed Chrome). The machine was busy: about 80 other Chrome
processes from other sessions were running and `memory_pressure` reported 43% free. Throughput is therefore lower and
noisier than on an idle machine.

**File.** Sparse, 2,152,726,535 bytes (2^31 + 5 MiB + 7), zero apart from `0x5a` at 2^31−1, 2^31 and the last byte,
read through the page cache. SHA-256 `16ace5cf19c483ce9de45aed0e83b551dc7aef8738518521939b482152c9dc15`, the same from
`openssl dgst -sha256` and from the browser in every run (the script reads it back from the sealed list).

**Method** (`node newweb/tests/large-hash-memory.mjs 3`, after `npm --prefix newweb run build`; manual, local only):

- It drives the built console. **Seal path**: Seal & send → Large files → the file → Include file names → Seal.
  **Check path**: a new browser context and a freshly loaded console (as a recipient would open it) → Large files →
  the sealed list, the handover text and the public key → the same file → Check files; the row must say Matches.
- Baseline: the page is loaded and the SHA-256 worker is already created and idle. The page's next
  `new Worker(hash-worker…)` gets that worker. Then 3 s of settling and one sample.
- During hashing, `ps -o rss` for every process in the launched Chrome's tree is sampled every 100 ms. Each process's
  delta is its own peak minus its own baseline.
- **Gate value** = the sum of the per-process deltas. It is never lower than the delta of the summed tree at one
  instant, so another process shrinking (memory compression on a busy machine) cannot hide growth. The same-instant
  tree delta is shown as well.
- A dedicated worker runs as a thread of the page's renderer, so Chrome has no separate worker process. The worker's
  memory is inside the renderer row; the worker cannot be measured on its own with RSS.
- The "idle worker" in the old code has not yet instantiated Wasm (it does that when the file arrives), so the 32 MiB
  Wasm heap and module are inside the deltas below, both before and after.
- Responsiveness: largest lateness of a 50 ms timer on the page's main thread while hashing.

MiB = 2^20 bytes. "Renderer" is the page's renderer (the one that grew); "Other" is the network, storage and other
renderer processes.

| Run | Path | Code | Seconds | MiB/s | Renderer idle → peak (Δ) | GPU idle → peak (Δ) | Browser Δ | Other Δ | Same-instant tree Δ | **Gate value** | Timer lag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Seal | before | 13.14 | 156.3 | 191.0 → 387.4 (+196.4) | 86.5 → 91.5 (+5.0) | +1.8 | +0.1 | +115.9 | **203.3 fail** | 27 ms |
| 1 | Check | before | 12.97 | 158.2 | 156.8 → 391.9 (+235.1) | 61.3 → 66.3 (+5.0) | +3.7 | 0.0 | +110.6 | **243.8 fail** | 34 ms |
| 2 | Seal | before | 13.16 | 156.0 | 152.5 → 388.9 (+236.4) | 80.0 → 84.9 (+4.9) | +4.2 | +0.5 | +122.4 | **246.0 fail** | 27 ms |
| 2 | Check | before | 12.50 | 164.2 | 163.0 → 407.4 (+244.3) | 65.3 → 71.2 (+5.9) | 0.0 | +0.1 | +165.0 | **250.3 fail** | 29 ms |
| 3 | Seal | before | 12.80 | 160.4 | 200.6 → 414.0 (+213.3) | 84.4 → 88.1 (+3.8) | 0.0 | +0.3 | +100.2 | **217.4 fail** | 11 ms |
| 3 | Check | before | 12.50 | 164.2 | 152.9 → 391.8 (+238.9) | 70.2 → 75.8 (+5.7) | +1.4 | +0.1 | +180.4 | **246.1 fail** | 11 ms |
| 1 | Seal | after | 13.00 | 157.9 | 154.3 → 197.4 (+43.1) | 79.2 → 81.0 (+1.9) | +0.8 | 0.0 | +22.6 | **45.8 pass** | 2 ms |
| 1 | Check | after | 12.67 | 162.0 | 152.8 → 193.3 (+40.5) | 69.0 → 75.0 (+6.0) | +2.0 | +0.2 | +48.2 | **48.7 pass** | 31 ms |
| 2 | Seal | after | 12.60 | 162.9 | 189.5 → 210.0 (+20.5) | 85.7 → 90.8 (+5.1) | +0.2 | 0.0 | +25.8 | **25.8 pass** | 13 ms |
| 2 | Check | after | 12.49 | 164.4 | 203.0 → 224.4 (+21.4) | 67.0 → 71.9 (+4.9) | 0.0 | 0.0 | +15.1 | **26.3 pass** | 28 ms |
| 3 | Seal | after | 12.73 | 161.2 | 186.8 → 200.9 (+14.1) | 87.4 → 87.4 (0.0) | 0.0 | +0.2 | 0.0 | **14.3 pass** | 37 ms |
| 3 | Check | after | 12.52 | 164.0 | 156.2 → 200.9 (+44.7) | 68.6 → 74.5 (+6.0) | +4.3 | +0.1 | +54.3 | **55.1 pass** | 28 ms |

Worst gate value: before 250.3 MiB (fail), after 55.1 MiB (pass). Some "after" idles were higher than others (renderer
152–203 MiB), which makes the smallest deltas (14.3, 25.8) less informative; the gate depends on the largest ones.
Throughput moved within the run-to-run noise of this busy machine. The main thread stayed responsive (timer lag at
most 37 ms).

An earlier set ran Check on the same page right after Seal, so the Check baseline was not a fresh page. That set is
kept for the record; its worst run was after 94.0 MiB (pass) and before 269.6 MiB (fail):

| Run | Path | Code | Seconds | MiB/s | Renderer idle → peak (Δ) | GPU idle → peak (Δ) | Browser Δ | Other Δ | Same-instant tree Δ | **Gate value** | Timer lag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Seal | before | 13.42 | 153.0 | 154.1 → 380.4 (+226.3) | 79.2 → 84.5 (+5.4) | +2.2 | +0.1 | +118.0 | **234.0 fail** | 1 ms |
| 1 | Check | before | 14.85 | 138.3 | 155.8 → 404.9 (+249.1) | 68.4 → 74.4 (+6.0) | +6.1 | +8.4 | +222.6 | **269.6 fail** | 2 ms |
| 2 | Seal | before | 13.32 | 154.1 | 155.3 → 406.0 (+250.7) | 79.9 → 84.9 (+4.9) | +1.9 | +0.3 | +179.6 | **257.8 fail** | 22 ms |
| 2 | Check | before | 14.80 | 138.7 | 166.8 → 363.9 (+197.1) | 57.2 → 62.8 (+5.6) | +2.2 | +14.9 | +181.7 | **219.8 fail** | 12 ms |
| 3 | Seal | before | 15.00 | 136.8 | 161.0 → 369.8 (+208.8) | 79.2 → 84.5 (+5.3) | +2.5 | 0.0 | +65.9 | **216.6 fail** | 2 ms |
| 3 | Check | before | 15.17 | 135.3 | 159.9 → 353.3 (+193.4) | 63.7 → 69.3 (+5.6) | +2.8 | +20.0 | +166.7 | **221.8 fail** | 24 ms |
| 1 | Seal | after | 13.38 | 153.4 | 153.7 → 199.0 (+45.3) | 79.5 → 84.7 (+5.1) | +5.6 | +0.7 | +56.0 | **56.7 pass** | 23 ms |
| 1 | Check | after | 17.35 | 118.3 | 176.0 → 231.5 (+55.5) | 71.5 → 76.6 (+5.1) | +24.4 | +9.0 | +60.4 | **94.0 pass** | 12 ms |
| 2 | Seal | after | 12.85 | 159.8 | 152.2 → 193.2 (+41.1) | 78.1 → 83.5 (+5.4) | +4.4 | +0.4 | +41.3 | **51.3 pass** | 12 ms |
| 2 | Check | after | 12.50 | 164.2 | 155.1 → 225.9 (+70.8) | 67.5 → 73.0 (+5.5) | +2.2 | +6.9 | +76.8 | **85.4 pass** | 1 ms |
| 3 | Seal | after | 13.23 | 155.2 | 164.1 → 195.0 (+30.9) | 75.2 → 80.5 (+5.3) | +2.2 | +1.3 | +36.7 | **39.7 pass** | 9 ms |
| 3 | Check | after | 15.25 | 134.6 | 176.4 → 236.1 (+59.7) | 66.4 → 71.8 (+5.4) | 0.0 | +17.2 | +61.0 | **82.3 pass** | 1 ms |
| 4 | Seal | before, rerun after the "after" runs | 13.68 | 150.0 | 156.9 → 386.3 (+229.4) | 79.5 → 84.8 (+5.2) | +2.4 | +0.1 | +140.6 | **237.1 fail** | 8 ms |
| 4 | Check | before, rerun after the "after" runs | 12.83 | 160.0 | 176.9 → 412.2 (+235.4) | 73.4 → 78.8 (+5.4) | +0.6 | +13.8 | +187.1 | **255.2 fail** | 10 ms |

Cancel is unchanged: the worker is terminated, and
`node --test tests/wasm/hash-browser.test.mjs` and `npm --prefix newweb run test:browser` ("Cancel stops hashing and
the UI is usable again") pass.

The older blank-page command (`FSEAL_LARGE_HASH=1 node --test tests/wasm/hash-browser.test.mjs`; launched browser's
whole-tree RSS at one instant, baseline = `client.mjs` imported, no worker yet) after the fix, same machine, three runs:
11.94 s / 172.0 MiB/s / +27.1 MiB; 13.10 s / 156.8 MiB/s / +14.4 MiB; 12.09 s / 169.8 MiB/s / +26.9 MiB. The Wasm heap
was 33,554,432 bytes and parity with `openssl dgst -sha256` held in each run.

### History: first run, before the fix (2026-11-17, gate not met)

These numbers come from one local run on 2026-11-17 on an Apple Silicon Mac running macOS 26.5.2, with
Google Chrome (Playwright `chrome` channel, headless) and the repository's Python venv. They predate the fix above.

The test file was the same sparse file. It was read through the page cache, so these are best-case local numbers,
not disk-bound ones. Both digests matched `openssl dgst -sha256`.

| Path | Seconds | Throughput | Memory |
|---|---|---|---|
| Browser worker (`FSEAL_LARGE_HASH=1 node --test tests/wasm/hash-browser.test.mjs`) | 12.13 | 169.3 MiB/s | Browser process tree RSS 647.1 MiB idle → 787.4 MiB peak (+140.3 MiB). WebAssembly heap 33,554,432 bytes (unchanged from initial). Page JS heap used, peak 2.3 MiB. |
| CLI (`FSEAL_LARGE_HASH=1 python3 -m pytest -q -s tests/test_manifest.py -k large`) | 1.70 | 1,205.2 MiB/s | Child peak RSS 21.5 MiB |

A second run of the same two commands on the same machine gave: browser 12.12 s, 169.4 MiB/s, process tree RSS
600.8 → 760.3 MiB (+159.5 MiB), WebAssembly heap 33,554,432 bytes, page JS heap 2.3 MiB; CLI 1.60 s, 1,279.5 MiB/s,
child peak RSS 22.1 MiB.

The proposed target was at most 128 MiB of extra payload working memory. These runs do not show that it is met.
The browser RSS delta was 140.3 and 159.5 MiB. It also counts things that are not payload memory: worker start-up,
the Wasm module and its fixed 32 MiB heap, and Chrome's own caching. No per-component breakdown was measured.

How those browser numbers were measured:

- RSS is the sum of `ps -o rss` over the launched Chrome process and its descendants (7 processes), sampled every
  250 ms.
- The JS heap is CDP `Performance.getMetrics` `JSHeapUsedSize` for the page. The worker's heap is not included.
- The CLI child reports its own `ru_maxrss`.

## Limitations

- A digest describes the bytes read at hashing time, not the producer's history. Sealing shows that the bytes have
  not changed since sealing; it says nothing about what happened before.
- A manifest is not a backup.
- An item sealed without a name can only be Matches or Missing, never Bytes differ.
- The receipt carries no signed time. The "Sealed:" line uses the sealing computer's clock.
- Sealing and checking a manifest in the browser need WebCrypto Ed25519, because the signature check runs in
  `docs/verifier.js`. Without it, the result is "Manifest not verified". Embedded mode verifies in WebAssembly and
  does not have this requirement.

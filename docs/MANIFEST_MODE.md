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

## Pairing rule

`compareFiles` in JavaScript and `compare` in Python follow the same deterministic steps:

1. Take each local file in selection order. It matches the lowest-id unmatched item with an equal size and digest:
   **Matches**.
2. Take each remaining local file. If its name equals the included name of the lowest-id remaining item with that
   name: **Bytes differ**.
3. Remaining items are **Missing**. Remaining local files are **Not in manifest**.

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
- **More options** (hidden until opened): include file names, operator notes, and the receipt interval and
  signing-key details.
- **Result chips**: Matches is green, Bytes differ is amber, Missing is grey and Not in manifest is neutral.
- **Limits checked first**: limit errors are checked before any file is read.

## Implementation

- **Browser**: `hashFile()` in `docs/wasm/client.mjs` starts one Web Worker per file
  (`docs/wasm/hash-worker.mjs`).
  - The worker reads 4 MiB `File.slice()` chunks, one read in flight, and copies each into one reused WebAssembly
    heap buffer.
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

These numbers come from one local run on 2026-11-17 on an Apple Silicon Mac running macOS 26.5.2, with
Google Chrome (Playwright `chrome` channel, headless) and the repository's Python venv.

The test file is sparse: 2,152,726,535 bytes (2^31 + 5 MiB + 7), all zero apart from `0x5a` markers at 2^31−1,
2^31 and the last byte. It was read through the page cache, so these are best-case local numbers, not
disk-bound ones. Both digests matched `openssl dgst -sha256`.

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

How the browser numbers were measured:

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

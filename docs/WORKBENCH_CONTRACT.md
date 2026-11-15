# FlightSeal workbench contract

The 2026-11-14 owner direction replaces the mint folio with a compact, light-neutral workbench. Existing FLTSEAL1 records and v1 receipts remain unchanged. The browser verifies locally; it does not provide a cloud notary, legal certification or sensor authenticity.

## Source import

Raw imports use the existing native Writer and Ed25519 receipt code. The original input is preserved in record payloads, rather than treating a telemetry projection as the original log. Payload schema `FSRAW001` is separate from the FLTSEAL1 file format:

| Byte | Meaning |
| --- | --- |
| 0–7 | ASCII `FSRAW001` |
| 8 | Source format: 1 ULog, 2 DataFlash, 3 timestamped MAVLink, 4 CSV |
| 9 | Kind: 0 original bytes, 1 final source digest |
| 10–17 | Unsigned little-endian original byte offset; final digest uses total original size |
| 18 onward | Original bytes, or exactly 32 SHA-256 digest bytes for kind 1 |

Kind-0 offsets start at zero and are contiguous. Concatenating their contents reconstructs the exact source, including headers and line endings. A final kind-1 record binds its size and SHA-256. Its record timestamp is the last observed source timestamp, never an invented wall clock. The terminal v1 receipt covers the final digest and all preceding bytes through the existing hash chain. There is no detached signature, new receipt dialect or implied independent signer. Import generates an ephemeral local key; the private key is discarded when the worker ends. Users must separately establish trust in the exported public key and retain receipts independently.

ULog framing is parsed in native C++ with strict length/version checks; telemetry decoding must identify supported fields, units and clock domains. Unknown decoded fields remain unavailable, while their original bytes remain preserved. A structural parse failure aborts import rather than producing an apparently complete source-bound artifact. Unsupported formats are explicitly rejected until their native adapters pass tests. No Python parser or JavaScript crypto substitute is used in the browser.

Native import API: `importFile(file, {every, signal})` returns `{log: Blob, receipts, publicKey, records, source: {format, bytes, sha256}, telemetry}`. Existing `sealFile()` TSV behavior remains compatible. Telemetry points use `{record, timestampUs: string, altitudeM?, latitudeDeg?, longitudeDeg?, speedMps?, batteryV?, mode?}`; missing values are absent, finite values only. Each decoded point refers to its source-bearing sealed record. Decimation must be stated, never passed off as every sample.

## Verification and inspection

Verification remains native C++/OpenSSL. A separate browser index checks parity and retains bounded sparse checkpoints with on-demand page loading; it must not stop navigation at 100,000 records. One GiB is an acceptance workload to measure on a named browser, not a universal device guarantee. Workers own cancellation and ephemeral keys. Streaming outputs use owned temporary browser storage with quota/error/cleanup handling; no whole-file JavaScript array copies for large captures or mutations.

Result errors use their actual type: hash, CRC, sequence, length or incomplete data. Reports include first-failure record, byte offset and expected/actual values. A simulated byte mutation has a known changed byte; an uploaded damaged file establishes the first failing record, not necessarily the original altered byte.

## Interface and report

Desktop uses a 220px session rail, 48px command bar, hairline dividers and compact panes. Mobile reflows without losing labelled 44px targets or keyboard focus. The command bar contains the file/session control, copyable abbreviated hash, Seal new log and Export PDF. No compiler badges, decorative numbers or marketing heading. Never invent drone ID, date, GPS or duration when absent.

One selected record/time anchors the record inspector, offline GPS plot, telemetry chart and video alignment. Video is aligned to a nearest playable frame, not guaranteed microsecond precision; container creation dates are optional suggestions, never signed capture-time evidence. No map tile service or private-file upload is required.

PDF is a verification/integrity report. Include full chain head, key fingerprint, first failure, receipt checks, available source metadata and explicit limits. Receipt v1 has no signed issue timestamp. Do not label this a court-admissible certificate. Keep TXT and JSON exports. Root/legacy links resolve into the canonical console rather than maintaining two applications.

## Release proof

Preserve native/CTest, pytest, Wasm parity and trust tests. Add raw-source reconstruction/digest/receipt vectors, malformed ULog cases, sparse paging beyond 100k, bounded mutations, report error types and PDF extraction. Browser gates cover 320/768/1440, keyboard/focus, axe, offline, cancellation, all existing nine engine cases and import/chart/video/report flows. Record measured large-file time/heap and remaining platform limits. Two critics and green current-head CI precede release.

# C++ browser bridge

`docs/wasm/flightseal.mjs` and `flightseal.wasm` are generated from `src/fseal.cpp`
and `wasm/bridge.cpp`, linked with OpenSSL. `BUILD_WASM` defaults OFF.

UI entry point (ES module):

```js
import { verifyFile, sealFile } from './wasm/client.mjs';
const result = await verifyFile(logFile, receiptsText, trustedKeyHex, { signal });
const sealed = await sealFile(tsvFile, { every: 1000, signal });
// sealed = { log: Blob, receipts: string, publicKey: string, records: number }
```

Files are mounted read-only via WORKERFS, not copied into a JavaScript array or
MEMFS. Work runs in a dedicated module worker. Abort terminates that worker and
releases its native memory; no partially completed result is returned. Inputs
never leave the browser. The generated module also runs in Node for parity tests.
The result includes `engine: 'C++ / OpenSSL / WebAssembly'`, `verdict` (`intact`,
`tampered`, `incomplete`, `unverified`), `status`, `records`, `goodBytes`, `head`,
`timeReversals`, `covered`, `uncovered`, and `receipts` (per-receipt check).
Receipt `count` values are decimal strings, preserving all 64 bits. File-derived
`records`, `goodBytes`, `covered`, `uncovered`, and `timeReversals` are numbers
bounded by the upload limit and remain exact in JavaScript. The native
heap has a 256 MiB hard ceiling; file verification is limited to 500 MiB, receipt
text to 4 MiB / 10,000 receipts, and sandbox sealing to 16 MiB of input / 64 MiB of output. The result
includes `nativeHeapBytes` for observing the actual Wasm memory allocation.
Invalid inputs and crypto failures reject; they never become an intact verdict.

Sealing accepts UTF-8 `timestamp_us<TAB>payload` lines, using native Writer,
Ed25519 key generation and sign_receipt. It returns an actual FLTSEAL1 log,
receipts, and public key. The private key lives only in the disposable worker and
is deleted on completion. This is an ephemeral browser sandbox: MEMFS fsync is
not durable storage and does not establish a production sealing deployment.
Receipt protection still requires independently obtaining the key and separately
keeping receipts while sealing; an end-of-file download alone is not a witness.
The format and existing cross-log receipt ambiguity are unchanged.

Build: `scripts/build_wasm.sh` uses the pinned official Emscripten Docker image,
fetches a SHA-256-verified official OpenSSL source archive in a temporary build
folder, and emits only module artifacts plus a provenance JSON file. No OpenSSL
sources or private keys are committed. Test with `node --test tests/wasm/*.test.mjs`.

Large-file proof: `python3 tests/wasm/make_large_probe.py /tmp/large.fseal`,
then `node tests/wasm/large-probe.mjs /tmp/large.fseal` and
`FSEAL_LARGE_PROBE=/tmp/large.fseal node --test tests/wasm/browser.test.mjs`.
The browser suite uses installed Chrome by default (`PLAYWRIGHT_CHANNEL` can
select another installed channel). The compiled OpenSSL and Emscripten licenses
are distributed beside the generated module.

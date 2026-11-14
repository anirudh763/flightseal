// Opt-in proof: python3 tests/wasm/make_large_probe.py /tmp/large.fseal
// node tests/wasm/large-probe.mjs /tmp/large.fseal
import assert from 'node:assert/strict';
import { dirname, basename, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import createFlightSeal from '../../docs/wasm/flightseal.mjs';
const path = resolve(process.argv[2]);
const module = await createFlightSeal({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
module.FS.mkdir('/probe');
module.FS.mount(module.NODEFS, { root: dirname(path) }, '/probe');
const heapBytes = () => module.ccall('fseal_heap_bytes', 'number', [], []);
const before = heapBytes(), start = performance.now();
const result = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], [`/probe/${basename(path)}`, '', '']));
const proof = { result, heapBefore: before, heapAfter: heapBytes(), elapsedMs: performance.now() - start };
assert.equal(result.verdict, 'intact');
assert.equal(result.records, 500);
assert.equal(result.goodBytes, 500 * 1024 * 1024);
assert.ok(proof.heapAfter <= 64 * 1024 * 1024);
console.log(JSON.stringify(proof, null, 2));

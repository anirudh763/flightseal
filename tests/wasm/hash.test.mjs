// The streaming SHA-256 glue in wasm/bridge.cpp (fseal_sha256_begin/update/final) against `openssl dgst -sha256`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createFlightSeal from '../../docs/wasm/flightseal.mjs';

const MiB = 1024 * 1024, CHUNK = 4 * MiB;
const module = await createFlightSeal({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
const dir = await mkdtemp(join(tmpdir(), 'fseal-hash-'));
test.after(() => rm(dir, { recursive: true, force: true }));

function wasmDigest(bytes, split) {
  assert.equal(module._fseal_sha256_begin(), 1);
  const buffer = module._malloc(Math.max(1, split));
  try {
    for (let at = 0; at < bytes.length; at += split) {
      const part = bytes.subarray(at, Math.min(bytes.length, at + split));
      module.HEAPU8.set(part, buffer);
      assert.equal(module._fseal_sha256_update(buffer, part.length), 1);
    }
  } finally { module._free(buffer); }
  return module.ccall('fseal_sha256_final', 'string', [], []);
}

async function openssl(bytes) {
  const path = join(dir, 'f.bin');
  await writeFile(path, bytes);
  const r = spawnSync('openssl', ['dgst', '-sha256', '-r', path], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split(' ')[0];
}

for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 46 * MiB]) {
  test(`${size} bytes: 4 MiB updates equal openssl`, async () => {
    const bytes = randomBytes(size);
    const expected = await openssl(bytes);
    assert.equal(wasmDigest(bytes, CHUNK), expected);
    assert.equal(wasmDigest(bytes, 1000003), expected, 'an odd split gives the same digest');
    if (size <= 1) assert.equal(wasmDigest(bytes, 1), expected);
  });
}

test('1-byte-at-a-time updates agree with one update', async () => {
  const bytes = randomBytes(70000);
  assert.equal(wasmDigest(bytes, 1), wasmDigest(bytes, CHUNK));
  assert.equal(wasmDigest(bytes, 1), await openssl(bytes));
});

test('update or final without begin fails closed; begin resets an unfinished context', () => {
  assert.equal(module.ccall('fseal_sha256_final', 'string', [], []), '', 'no context');
  assert.equal(module._fseal_sha256_update(0, 0), 0);
  assert.equal(module._fseal_sha256_begin(), 1);
  const p = module._malloc(3); module.HEAPU8.set([1, 2, 3], p); module._fseal_sha256_update(p, 3); module._free(p);
  assert.equal(wasmDigest(new Uint8Array(0), CHUNK), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

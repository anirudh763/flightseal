import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';

const factoryPath = new URL('../../docs/wasm/flightseal.mjs', import.meta.url);
const sample = name => new URL(`../../docs/samples/${name}`, import.meta.url);
let factory;
try { factory = (await import(factoryPath.href)).default; } catch {}

test('a real compiled C++ WebAssembly bridge is present', () => {
  assert.equal(typeof factory, 'function', 'build the native C++ bridge before shipping');
});

for (const [filename, verdict] of [
  ['intact.fseal', 'intact'], ['tampered.fseal', 'tampered'],
  ['rewritten.fseal', 'tampered'], ['truncated.fseal', 'tampered'],
]) {
  test(`native verification of ${filename}`, async () => {
    assert.equal(typeof factory, 'function');
    const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
    module.FS.writeFile('/input', await readFile(sample(filename)));
    const receipts = await readFile(sample('flight.receipts'), 'utf8');
    const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
    const result = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/input', receipts, key]));
    assert.equal(result.error, undefined);
    assert.equal(result.verdict, verdict);
    assert.equal(result.engine, 'C++ / OpenSSL / WebAssembly');
  });
}

test('no receipts means chain only and a wrong key means unverified', async () => {
  assert.equal(typeof factory, 'function');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  module.FS.writeFile('/input', await readFile(sample('intact.fseal')));
  const run = (receipts, key) => JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/input', receipts, key]));
  assert.equal(run('', '').verdict, 'intact');
  assert.equal(run('', '').covered, 0);
  assert.equal(run('', '').fileSha256, createHash('sha256').update(await readFile(sample('intact.fseal'))).digest('hex'));
  assert.equal(run(await readFile(sample('flight.receipts'), 'utf8'), '00'.repeat(32)).verdict, 'unverified');
});

test('native Writer creates a downloadable log and Ed25519 receipts which native verifier accepts', async () => {
  assert.equal(typeof factory, 'function');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  module.FS.writeFile('/source', '100\tGPS 1\n200\tGPS 2\n300\tGPS 3\n');
  const sealed = JSON.parse(module.ccall('fseal_seal', 'string', ['string', 'number'], ['/source', 2]));
  assert.equal(sealed.error, undefined);
  assert.equal(sealed.records, 3);
  assert.equal(new TextDecoder().decode(module.FS.readFile('/sealed.fseal').slice(0, 8)), 'FLTSEAL1');
  assert.equal(sealed.receipts.trim().split('\n').length, 2);
  const result = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/sealed.fseal', sealed.receipts, sealed.publicKey]));
  assert.equal(result.verdict, 'intact');
  assert.equal(result.covered, 3);
  assert.throws(() => module.FS.stat('/ephemeral.pem'));
});

test('C++ WebAssembly sealer uses an explicitly supplied PKCS#8 Ed25519 private key', async () => {
  assert.equal(typeof factory, 'function');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const expectedPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  module.FS.writeFile('/source.tsv', '100\t{"x":1}\n200\t{"x":2}\n');
  const sealed = JSON.parse(module.ccall('fseal_seal_with_key', 'string', ['string', 'number', 'string'], ['/source.tsv', 1, privatePem]));
  assert.equal(sealed.error, undefined);
  assert.equal(sealed.publicKey, expectedPublic);
  const log = module.FS.readFile('/sealed.fseal');
  module.FS.writeFile('/sealed-input', log);
  const verified = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/sealed-input', sealed.receipts, expectedPublic]));
  assert.equal(verified.verdict, 'intact');
  assert.equal(verified.records, 2);
});

test('invalid receipt input and invalid source records produce errors, never an intact verdict', async () => {
  assert.equal(typeof factory, 'function');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  module.FS.writeFile('/input', await readFile(sample('intact.fseal')));
  const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
  const result = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/input', 'not a receipt', key]));
  assert.match(result.error, /invalid receipt/);
  assert.equal(result.verdict, undefined);
  module.FS.writeFile('/invalid', '-1\tpayload\n');
  const sealed = JSON.parse(module.ccall('fseal_seal', 'string', ['string', 'number'], ['/invalid', 1000]));
  assert.match(sealed.error, /invalid unsigned timestamp/);
  assert.throws(() => module.FS.stat('/ephemeral.pem'));
  assert.throws(() => module.FS.stat('/sealed.fseal'));
});

test('a receipt count above JavaScript safe integer is preserved exactly', async () => {
  assert.equal(typeof factory, 'function');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  module.FS.writeFile('/input', await readFile(sample('intact.fseal')));
  const original = await readFile(sample('flight.receipts'), 'utf8');
  const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
  const altered = original.trim().split('\n')[0].replace(/count=\d+/, 'count=18446744073709551615');
  const result = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/input', altered, key]));
  assert.equal(result.receipts[0].count, '18446744073709551615');
  assert.equal(result.verdict, 'unverified');
});

test('10,000 receipts cross the native API without truncation or stack overflow', async () => {
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  module.FS.writeFile('/input', await readFile(sample('intact.fseal')));
  const one = (await readFile(sample('flight.receipts'), 'utf8')).trim().split('\n')[0] + '\n';
  const receipts = one.repeat(10000);
  assert.ok(receipts.length > 65536);
  const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
  const result = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/input', receipts, key]));
  assert.equal(result.error, undefined);
  assert.equal(result.receipts.length, 10000);
  assert.equal(result.verdict, 'intact');
});

test('interactive payload flip uses the immutable included sample and original receipt/key, then native restore passes', async () => {
  const { blobSource, scanLog } = await import('../../docs/verifier.js');
  const { mutateFile } = await import('../../docs/records.mjs');
  const original = await readFile(sample('intact.fseal'));
  const receipts = await readFile(sample('flight.receipts'), 'utf8');
  const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
  const file = new File([original], 'intact.fseal');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  const verify = async input => {
    module.FS.writeFile('/interactive-input', new Uint8Array(await input.arrayBuffer()));
    return JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/interactive-input', receipts, key]));
  };
  const valid = await verify(file);
  assert.equal(valid.verdict, 'intact');
  assert.equal(valid.records, 800);
  const changed = await mutateFile(file, await scanLog(blobSource(file), { sparse: true }), 'flip');
  assert.equal(changed.mutation.record, 0);
  const bad = await verify(changed.file);
  assert.equal(bad.verdict, 'tampered');
  assert.equal(bad.status, 'bad-link'); // CRC was recomputed; the stored hash detects the payload change.
  assert.equal(bad.records, 0);
  assert.notEqual(bad.fileSha256, valid.fileSha256);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(original));
  const restored = await verify(file);
  assert.equal(restored.verdict, 'intact');
  assert.equal(restored.fileSha256, valid.fileSha256);
  assert.deepEqual(restored.receipts, valid.receipts);
  assert.equal(await readFile(sample('flight.receipts'), 'utf8'), receipts);
  assert.equal((await readFile(sample('pubkey.txt'), 'utf8')).trim(), key);
});

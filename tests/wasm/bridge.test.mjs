import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

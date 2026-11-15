import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const factoryPath = new URL('../../docs/wasm/flightseal.mjs', import.meta.url);
let factory;
try { factory = (await import(factoryPath.href)).default; } catch {}

function bytes(...chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function le(value, width) {
  const out = new Uint8Array(width);
  const view = new DataView(out.buffer);
  if (width === 8) view.setBigUint64(0, BigInt(value), true);
  else if (width === 4) view.setUint32(0, value >>> 0, true);
  else if (width === 2) view.setUint16(0, value, true);
  else out[0] = value;
  return out;
}
function message(type, payload) { return bytes(le(payload.length, 2), Uint8Array.of(type.charCodeAt(0)), payload); }
function makeUlog() {
  const header = bytes(new TextEncoder().encode('ULog\x01\x12\x35'), Uint8Array.of(1), le(100, 8));
  const flags = new Uint8Array(40);
  const fmt = new TextEncoder().encode('vehicle_global_position:uint64_t timestamp;double lat;double lon;float alt;float vel_n;float vel_e;');
  const add = bytes(Uint8Array.of(0), le(0, 2), new TextEncoder().encode('vehicle_global_position'));
  const data = new Uint8Array(2 + 8 + 8 + 8 + 4 + 4 + 4);
  const view = new DataView(data.buffer);
  view.setUint16(0, 0, true); view.setBigUint64(2, 123456n, true);
  view.setFloat64(10, 52.5, true); view.setFloat64(18, -4.125, true);
  view.setFloat32(26, 20, true); view.setFloat32(30, 3, true); view.setFloat32(34, 4, true);
  return bytes(header, message('B', flags), message('F', fmt), message('A', add), message('D', data));
}

test('native ULog import preserves exact raw bytes and signs the final source digest', async () => {
  assert.equal(typeof factory, 'function', 'build the native C++ bridge before shipping');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  const source = makeUlog();
  module.FS.writeFile('/source.ulg', source);
  const result = JSON.parse(module.ccall('fseal_import', 'string', ['string', 'string', 'number'], ['/source.ulg', '/sealed-import.fseal', 1]));
  assert.equal(result.error, undefined);
  assert.equal(result.source.format, 'ULog');
  assert.equal(result.source.bytes, source.length);
  assert.equal(result.source.sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(result.records, 2);
  assert.equal(result.telemetry.length, 1);
  const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let dataMessageOffset = 16;
  while (source[dataMessageOffset + 2] !== 0x44) dataMessageOffset += 3 + sourceView.getUint16(dataMessageOffset, true);
  assert.deepEqual(result.telemetry[0], {
    record: 0, sourceOffset: String(dataMessageOffset), timestampUs: '123456',
    altitudeM: 20, latitudeDeg: 52.5, longitudeDeg: -4.125, speedMps: 5,
  });

  const sealed = module.FS.readFile('/sealed-import.fseal');
  assert.equal(new TextDecoder().decode(sealed.subarray(0, 8)), 'FLTSEAL1');
  const rebuilt = [];
  const view = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  let offset = 8, seenDigest = false;
  while (offset < sealed.length) {
    const length = view.getUint32(offset, true);
    const payload = sealed.subarray(offset + 20, offset + 20 + length);
    assert.equal(new TextDecoder().decode(payload.subarray(0, 8)), 'FSRAW001');
    if (payload[9] === 0) rebuilt.push(...payload.subarray(18));
    else {
      assert.equal(payload[9], 1);
      assert.equal(new DataView(payload.buffer, payload.byteOffset + 10, 8).getBigUint64(0, true), BigInt(source.length));
      assert.equal(Buffer.from(payload.subarray(18)).toString('hex'), result.source.sha256);
      seenDigest = true;
    }
    offset += 20 + length + 36;
  }
  assert.equal(seenDigest, true);
  assert.deepEqual(Uint8Array.from(rebuilt), source);
  const verified = JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/sealed-import.fseal', result.receipts, result.publicKey]));
  assert.equal(verified.verdict, 'intact');
  assert.equal(verified.covered, result.records);
  assert.throws(() => module.FS.stat('/ephemeral-import.pem'));
});

test('native ULog import rejects unsupported versions and malformed frames', async () => {
  assert.equal(typeof factory, 'function');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  const source = makeUlog();
  const invalid = Uint8Array.from(source); invalid[7] = 2;
  module.FS.writeFile('/bad-version.ulg', invalid);
  const versionResult = JSON.parse(module.ccall('fseal_import', 'string', ['string', 'string', 'number'], ['/bad-version.ulg', '/sealed-import.fseal', 1000]));
  assert.match(versionResult.error, /versions 0 and 1 are supported/);
  assert.throws(() => module.FS.stat('/sealed-import.fseal'));
  const truncated = source.subarray(0, source.length - 1);
  module.FS.writeFile('/truncated.ulg', truncated);
  const truncatedResult = JSON.parse(module.ccall('fseal_import', 'string', ['string', 'string', 'number'], ['/truncated.ulg', '/sealed-import.fseal', 1000]));
  assert.match(truncatedResult.error, /truncated final message/);
  assert.throws(() => module.FS.stat('/sealed-import.fseal'));
});

test('native import reads multi-megabyte source through buffered file operations', async () => {
  assert.equal(typeof factory, 'function');
  const module = await factory({ wasmBinary: await readFile(new URL('../../docs/wasm/flightseal.wasm', import.meta.url)) });
  const parts = [makeUlog()];
  for (let i = 0; i < 40; i++) {
    const payload = new Uint8Array(60002);
    payload[0] = 1; payload[1] = 120; payload.fill(97, 2);
    parts.push(message('I', payload));
  }
  const source = bytes(...parts);
  assert.ok(source.length > 2 * 1024 * 1024);
  module.FS.writeFile('/large-source.ulg', source);
  const originalRead = module.FS.read.bind(module.FS);
  let calls = 0, requested = 0, returned = 0;
  module.FS.read = (stream, buffer, offset, length, position) => {
    ++calls;
    requested += length;
    const count = originalRead(stream, buffer, offset, length, position);
    returned += count;
    return count;
  };
  const result = JSON.parse(module.ccall('fseal_import', 'string', ['string', 'string', 'number'], ['/large-source.ulg', '/large-out.fseal', 1000]));
  module.FS.read = originalRead;
  assert.equal(result.error, undefined);
  assert.equal(result.source.bytes, source.length);
  assert.equal(result.source.sha256, createHash('sha256').update(source).digest('hex'));
  assert.ok(returned >= source.length * 2 && returned < source.length * 2 + 4096,
    `expected two source passes, observed ${returned} returned bytes for ${source.length} source bytes`);
  assert.ok(calls < 32, `expected buffered file reads, observed ${calls} calls for ${requested} requested bytes`);
});

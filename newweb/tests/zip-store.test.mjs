import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createStoreZip } from '../src/zip-store.mjs';

test('ZIP store export has valid local, central and end records with CRC', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = await createStoreZip([{ name: 'report.txt', bytes: new TextEncoder().encode('verified') }]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  const central = view.getUint32(bytes.length - 22 + 16, true);
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(zip.type, 'application/zip');
});

test('ZIP store export rejects unsafe filenames and size overages', async () => {
  await assert.rejects(createStoreZip([{ name: '../private.pem', bytes: new Uint8Array([1]) }]), /safe ASCII/);
  await assert.rejects(createStoreZip([{ name: 'large', bytes: new Uint8Array(8) }], { maxBytes: 4 }), /size limit/);
});

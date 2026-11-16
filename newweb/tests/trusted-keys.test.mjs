import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { listTrustedKeys, matchingTrustedKey, pinTrustedKey, removeTrustedKey } from '../src/trusted-keys.mjs';

class MemoryStorage { values = new Map(); getItem(k) { return this.values.get(k) ?? null; } setItem(k, v) { this.values.set(k, String(v)); } }
const keyA = '01'.repeat(32);
const keyB = '02'.repeat(32);

test('public-key pins are explicit, named, fingerprinted and remain public-only', async () => {
  const storage = new MemoryStorage();
  const first = await pinTrustedKey('Flight unit A', keyA, { storage, cryptoObject: webcrypto });
  assert.equal(first.fingerprint.length, 64);
  assert.equal(first.fingerprint, Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(keyA, 'hex'))).toString('hex'));
  assert.deepEqual(await matchingTrustedKey(keyA, { storage, cryptoObject: webcrypto }), first);
  assert.equal(await matchingTrustedKey(keyB, { storage, cryptoObject: webcrypto }), null);
  assert.equal(JSON.stringify(storage.values).includes('PRIVATE KEY'), false);
});

test('changed key under a name warns and requires explicit rotation confirmation', async () => {
  const storage = new MemoryStorage();
  await pinTrustedKey('Flight unit A', keyA, { storage, cryptoObject: webcrypto });
  await assert.rejects(pinTrustedKey('Flight unit A', keyB, { storage, cryptoObject: webcrypto }), /Confirm rotation/);
  assert.equal(listTrustedKeys({ storage })[0].publicKey, keyA);
  const rotated = await pinTrustedKey('Flight unit A', keyB, { storage, cryptoObject: webcrypto, confirmRotation: true });
  assert.equal(rotated.publicKey, keyB);
  assert.equal(removeTrustedKey('Flight unit A', { storage }), true);
  assert.deepEqual(listTrustedKeys({ storage }), []);
});

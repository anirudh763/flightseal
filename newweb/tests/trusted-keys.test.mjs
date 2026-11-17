import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  SOURCES, addTrustedCompany, fingerprintHex, formatFingerprint, listTrustedHistory, listTrustedKeys, markCompromised,
  matchingTrustedKey, normalizeFingerprint, pinTrustedKey, removeTrustedKey, trustForKey,
} from '../src/trusted-keys.mjs';

class MemoryStorage { values = new Map(); getItem(k) { return this.values.get(k) ?? null; } setItem(k, v) { this.values.set(k, String(v)); } }
const keyA = '01'.repeat(32);
const keyB = '02'.repeat(32);
const STORE = 'flightseal_trusted_keys_v1';
const fpA = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(keyA, 'hex'))).toString('hex');
const fpB = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(keyB, 'hex'))).toString('hex');
const opts = (storage, extra = {}) => ({ storage, cryptoObject: webcrypto, ...extra });

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

test('add company: grouped, colon or SHA-256: prefixed fingerprints are saved active with their source', () => {
  const storage = new MemoryStorage();
  const entry = addTrustedCompany('  Acme Survey  ', `SHA-256: ${formatFingerprint(fpA).toUpperCase()}`, { storage, source: 'contract', now: '2026-11-17T10:00:00.000Z' });
  assert.deepEqual(entry, { name: 'Acme Survey', publicKey: '', fingerprint: fpA, source: 'contract', addedAt: '2026-11-17T10:00:00.000Z', status: 'active' });
  assert.equal(normalizeFingerprint(fpA.match(/../g).join(':')), fpA);
  assert.equal(normalizeFingerprint(`SHA-256:${fpA}`), fpA);
  const groups = formatFingerprint(fpA).split(' ');
  assert.equal(groups.length, 16);
  assert.ok(groups.every((group) => group.length === 4));
  assert.equal(SOURCES.contract, 'contract or invoice');
  assert.deepEqual(listTrustedKeys({ storage }), [entry]);
});

test('add company: no source, bad hex or a long name gives a friendly error and saves nothing', () => {
  const storage = new MemoryStorage();
  assert.throws(() => addTrustedCompany('Acme', fpA, { storage }), /Choose where you got this fingerprint/);
  assert.throws(() => addTrustedCompany('Acme', fpA, { storage, source: 'not-recorded' }), /Choose where/);
  assert.throws(() => addTrustedCompany('Acme', `${fpA.slice(1)}g`, { storage, source: 'website' }), /64 hexadecimal digits/);
  assert.throws(() => addTrustedCompany('Acme', fpA.slice(2), { storage, source: 'website' }), /64 hexadecimal digits/);
  assert.throws(() => addTrustedCompany('x'.repeat(81), fpA, { storage, source: 'website' }), /up to 80 characters/);
  assert.equal(storage.getItem(STORE), null);
});

test('replace needs confirmation and names the old key; confirmed keeps history; compromised is marked in place', () => {
  const storage = new MemoryStorage();
  addTrustedCompany('Acme', fpA, { storage, source: 'phone', now: '2026-01-01T00:00:00.000Z' });
  const before = storage.getItem(STORE);
  assert.throws(() => addTrustedCompany('acme', fpB, { storage, source: 'website' }),
    (error) => error.code === 'replace-needs-confirm' && error.message.includes(formatFingerprint(fpA)) && error.previous === formatFingerprint(fpA));
  assert.equal(storage.getItem(STORE), before, 'store unchanged');
  addTrustedCompany('Acme', fpB, { storage, source: 'website', confirmReplace: true, now: '2026-02-02T00:00:00.000Z' });
  assert.deepEqual(listTrustedHistory({ storage }).map((e) => [e.fingerprint, e.status, e.replacedAt]), [[fpA, 'replaced', '2026-02-02T00:00:00.000Z'], [fpB, 'active', undefined]]);
  assert.deepEqual(listTrustedKeys({ storage }).map((e) => e.fingerprint), [fpB]);
  const marked = markCompromised('Acme', formatFingerprint(fpB), { storage, now: '2026-03-03T00:00:00.000Z' });
  assert.equal(marked.status, 'compromised');
  assert.equal(marked.compromisedAt, '2026-03-03T00:00:00.000Z');
  assert.throws(() => markCompromised('Nobody', fpB, { storage }), /No saved company/);
  assert.deepEqual(listTrustedKeys({ storage }), []);
  assert.equal(listTrustedHistory({ storage }).length, 2);
});

test('legacy pins read as active with source not recorded; trust lookup covers every status', async () => {
  const storage = new MemoryStorage();
  storage.setItem(STORE, JSON.stringify([{ name: 'Old', publicKey: keyA, fingerprint: fpA }]));
  assert.deepEqual(listTrustedKeys({ storage }), [{ name: 'Old', publicKey: keyA, fingerprint: fpA, source: 'not-recorded', addedAt: '', status: 'active' }]);
  const trusted = await trustForKey(keyA, opts(storage));
  assert.equal(trusted.status, 'trusted');
  assert.equal(trusted.entry.name, 'Old');
  assert.equal((await trustForKey(keyB, opts(storage))).status, 'untrusted');
  assert.equal((await trustForKey('not a key', opts(storage))).status, 'untrusted');
  addTrustedCompany('Old', fpB, { storage, source: 'other', confirmReplace: true, now: '2026-04-04T00:00:00.000Z' });
  const replaced = await trustForKey(keyA, opts(storage));
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.entry.replacedAt, '2026-04-04T00:00:00.000Z');
  assert.equal((await trustForKey(keyB, opts(storage))).status, 'trusted', 'a fingerprint-only pin trusts the matching key');
  addTrustedCompany('Second', fpB, { storage, source: 'website' });
  markCompromised('Second', fpB, { storage });
  assert.equal((await trustForKey(keyB, opts(storage))).status, 'compromised', 'compromised wins over an active pin of the same key');
  assert.equal(await fingerprintHex(keyB, webcrypto), fpB);
});

test('pinning the full key over a fingerprint-only entry is not a rotation; a real rotation keeps history', async () => {
  const storage = new MemoryStorage();
  addTrustedCompany('Acme', fpA, { storage, source: 'contract' });
  const pinned = await pinTrustedKey('Acme', keyA, opts(storage));
  assert.equal(pinned.publicKey, keyA);
  assert.equal(pinned.source, 'contract');
  await assert.rejects(pinTrustedKey('Acme', keyB, opts(storage, { source: 'phone' })), (error) => error.code === 'replace-needs-confirm' && /Confirm rotation/.test(error.message));
  await pinTrustedKey('Acme', keyB, opts(storage, { source: 'phone', confirmRotation: true }));
  assert.deepEqual(listTrustedHistory({ storage }).map((e) => e.status), ['replaced', 'active']);
  assert.equal(removeTrustedKey('Acme', { storage }), true, 'removal takes every entry with that name');
  assert.deepEqual(listTrustedHistory({ storage }), []);
});

test('the store refuses to grow past 64 entries, history included', () => {
  const storage = new MemoryStorage();
  for (let i = 0; i < 64; i++) addTrustedCompany(`C${i}`, i.toString(16).padStart(64, '0'), { storage, source: 'other' });
  assert.throws(() => addTrustedCompany('C64', 'f'.repeat(64), { storage, source: 'other' }), /maximum of 64/);
  assert.equal(listTrustedHistory({ storage }).length, 64);
});

test('remove ignores case, history entries need their dates, rotation message shows grouped fingerprint', async () => {
  const storage = new MemoryStorage();
  addTrustedCompany('Acme', 'ab'.repeat(32), { source: 'website', storage, now: '2026-11-01T00:00:00.000Z' });
  addTrustedCompany('acme', 'cd'.repeat(32), { source: 'phone', storage, confirmReplace: true, now: '2026-11-02T00:00:00.000Z' });
  assert.equal(removeTrustedKey('ACME', { storage }), true);
  assert.deepEqual(listTrustedHistory({ storage }), []);
  storage.setItem(STORE, JSON.stringify([{ name: 'X', publicKey: '', fingerprint: 'ab'.repeat(32), source: 'other', addedAt: '', status: 'replaced' }]));
  assert.throws(() => listTrustedHistory({ storage }), /unsupported format/);
  const pins = new MemoryStorage();
  await pinTrustedKey('Unit', keyA, { storage: pins, cryptoObject: webcrypto, source: 'other' });
  await assert.rejects(pinTrustedKey('Unit', keyB, { storage: pins, cryptoObject: webcrypto, source: 'other' }), (error) => /(?:[0-9a-f]{4} ){15}[0-9a-f]{4}/.test(error.message) && /Confirm rotation/.test(error.message));
});

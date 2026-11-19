import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  const first = await pinTrustedKey('Flight unit A', keyA, { storage, cryptoObject: webcrypto, source: 'website', confirmed: true });
  assert.equal(first.fingerprint.length, 64);
  assert.equal(first.fingerprint, Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(keyA, 'hex'))).toString('hex'));
  assert.deepEqual(await matchingTrustedKey(keyA, { storage, cryptoObject: webcrypto }), first);
  assert.equal(await matchingTrustedKey(keyB, { storage, cryptoObject: webcrypto }), null);
  assert.equal(JSON.stringify(storage.values).includes('PRIVATE KEY'), false);
});

test('changed key under a name warns and requires explicit rotation confirmation', async () => {
  const storage = new MemoryStorage();
  await pinTrustedKey('Flight unit A', keyA, { storage, cryptoObject: webcrypto, source: 'website', confirmed: true });
  await assert.rejects(pinTrustedKey('Flight unit A', keyB, { storage, cryptoObject: webcrypto, source: 'website', confirmed: true }), /Confirm rotation/);
  assert.equal(listTrustedKeys({ storage })[0].publicKey, keyA);
  const rotated = await pinTrustedKey('Flight unit A', keyB, { storage, cryptoObject: webcrypto, source: 'website', confirmed: true, confirmRotation: true });
  assert.equal(rotated.publicKey, keyB);
  assert.equal(removeTrustedKey('Flight unit A', { storage }), true);
  assert.deepEqual(listTrustedKeys({ storage }), []);
});

test('add company: grouped, colon or SHA-256: prefixed fingerprints are saved active with their source', async () => {
  const storage = new MemoryStorage();
  const entry = await addTrustedCompany('  Acme Survey  ', `SHA-256: ${formatFingerprint(fpA).toUpperCase()}`, { storage, source: 'contract', confirmed: true, now: '2026-11-17T10:00:00.000Z' });
  assert.deepEqual(entry, { name: 'Acme Survey', publicKey: '', fingerprint: fpA, source: 'contract', addedAt: '2026-11-17T10:00:00.000Z', status: 'active', confirmedAt: '2026-11-17T10:00:00.000Z' });
  assert.equal(normalizeFingerprint(fpA.match(/../g).join(':')), fpA);
  assert.equal(normalizeFingerprint(`SHA-256:${fpA}`), fpA);
  const groups = formatFingerprint(fpA).split(' ');
  assert.equal(groups.length, 16);
  assert.ok(groups.every((group) => group.length === 4));
  assert.equal(SOURCES.contract, 'contract or invoice');
  assert.deepEqual(listTrustedKeys({ storage }), [entry]);
});

test('add company: no source, bad hex or a long name gives a friendly error and saves nothing', async () => {
  const storage = new MemoryStorage();
  await assert.rejects(addTrustedCompany('Acme', fpA, { storage }), /Choose where you got this fingerprint/);
  await assert.rejects(addTrustedCompany('Acme', fpA, { storage, source: 'not-recorded' }), /Choose where/);
  await assert.rejects(addTrustedCompany('Acme', `${fpA.slice(1)}g`, { storage, source: 'website', confirmed: true }), /64 hexadecimal digits/);
  await assert.rejects(addTrustedCompany('Acme', fpA.slice(2), { storage, source: 'website', confirmed: true }), /64 hexadecimal digits/);
  await assert.rejects(addTrustedCompany('x'.repeat(81), fpA, { storage, source: 'website', confirmed: true }), /up to 80 characters/);
  assert.equal(storage.getItem(STORE), null);
});

test('replace needs confirmation and names the old key; confirmed keeps history; compromised is marked in place', async () => {
  const storage = new MemoryStorage();
  await addTrustedCompany('Acme', fpA, { storage, source: 'phone', confirmed: true, now: '2026-01-01T00:00:00.000Z' });
  const before = storage.getItem(STORE);
  await assert.rejects(addTrustedCompany('acme', fpB, { storage, source: 'website', confirmed: true }),
    (error) => error.code === 'replace-needs-confirm' && error.message.includes(formatFingerprint(fpA)) && error.previous === formatFingerprint(fpA));
  assert.equal(storage.getItem(STORE), before, 'store unchanged');
  await addTrustedCompany('Acme', fpB, { storage, source: 'website', confirmed: true, confirmReplace: true, now: '2026-02-02T00:00:00.000Z' });
  assert.deepEqual(listTrustedHistory({ storage }).map((e) => [e.fingerprint, e.status, e.replacedAt]), [[fpA, 'replaced', '2026-02-02T00:00:00.000Z'], [fpB, 'active', undefined]]);
  assert.deepEqual(listTrustedKeys({ storage }).map((e) => e.fingerprint), [fpB]);
  const marked = markCompromised('Acme', formatFingerprint(fpB), { storage, now: '2026-03-03T00:00:00.000Z' });
  assert.equal(marked.status, 'compromised');
  assert.equal(marked.compromisedAt, '2026-03-03T00:00:00.000Z');
  assert.throws(() => markCompromised('Nobody', fpB, { storage }), /No saved company/);
  assert.deepEqual(listTrustedKeys({ storage }), []);
  assert.equal(listTrustedHistory({ storage }).length, 2);
});

test('legacy pins read as active, source not recorded and unconfirmed; trust lookup covers every status', async () => {
  const storage = new MemoryStorage();
  storage.setItem(STORE, JSON.stringify([{ name: 'Old', publicKey: keyA, fingerprint: fpA }]));
  assert.deepEqual(listTrustedKeys({ storage }), [{ name: 'Old', publicKey: keyA, fingerprint: fpA, source: 'not-recorded', addedAt: '', status: 'active' }]);
  const legacy = await trustForKey(keyA, opts(storage));
  assert.equal(legacy.status, 'unconfirmed', 'a pin without confirmedAt is never trusted (R34)');
  assert.equal(legacy.entry.name, 'Old');
  assert.equal((await trustForKey(keyB, opts(storage))).status, 'untrusted');
  assert.equal((await trustForKey('not a key', opts(storage))).status, 'untrusted');
  await addTrustedCompany('Old', fpB, { storage, source: 'other', confirmed: true, confirmReplace: true, now: '2026-04-04T00:00:00.000Z' });
  const replaced = await trustForKey(keyA, opts(storage));
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.entry.replacedAt, '2026-04-04T00:00:00.000Z');
  assert.equal((await trustForKey(keyB, opts(storage))).status, 'trusted', 'a fingerprint-only pin trusts the matching key');
  await addTrustedCompany('Second', fpB, { storage, source: 'website', confirmed: true });
  markCompromised('Second', fpB, { storage });
  assert.equal((await trustForKey(keyB, opts(storage))).status, 'compromised', 'compromised wins over an active pin of the same key');
  assert.equal(await fingerprintHex(keyB, webcrypto), fpB);
});

test('pinning the full key over a fingerprint-only entry is not a rotation; a real rotation keeps history', async () => {
  const storage = new MemoryStorage();
  await addTrustedCompany('Acme', fpA, { storage, source: 'contract', confirmed: true });
  const pinned = await pinTrustedKey('Acme', keyA, opts(storage, { source: 'website', confirmed: true }));
  assert.equal(pinned.publicKey, keyA);
  assert.equal(pinned.source, 'contract');
  await assert.rejects(pinTrustedKey('Acme', keyB, opts(storage, { source: 'phone', confirmed: true })), (error) => error.code === 'replace-needs-confirm' && /Confirm rotation/.test(error.message));
  await pinTrustedKey('Acme', keyB, opts(storage, { source: 'phone', confirmed: true, confirmRotation: true }));
  assert.deepEqual(listTrustedHistory({ storage }).map((e) => e.status), ['replaced', 'active']);
  assert.equal(removeTrustedKey('Acme', { storage }), true, 'removal takes every entry with that name');
  assert.deepEqual(listTrustedHistory({ storage }), []);
});

test('the store refuses to grow past 64 entries, history included', async () => {
  const storage = new MemoryStorage();
  for (let i = 0; i < 64; i++) await addTrustedCompany(`C${i}`, i.toString(16).padStart(64, '0'), { storage, source: 'other', confirmed: true });
  await assert.rejects(addTrustedCompany('C64', 'f'.repeat(64), { storage, source: 'other', confirmed: true }), /maximum of 64/);
  assert.equal(listTrustedHistory({ storage }).length, 64);
});

test('remove ignores case, history entries need their dates, rotation message shows grouped fingerprint', async () => {
  const storage = new MemoryStorage();
  await addTrustedCompany('Acme', 'ab'.repeat(32), { source: 'website', confirmed: true, storage, now: '2026-11-01T00:00:00.000Z' });
  await addTrustedCompany('acme', 'cd'.repeat(32), { source: 'phone', confirmed: true, storage, confirmReplace: true, now: '2026-11-02T00:00:00.000Z' });
  assert.equal(removeTrustedKey('ACME', { storage }), true);
  assert.deepEqual(listTrustedHistory({ storage }), []);
  storage.setItem(STORE, JSON.stringify([{ name: 'X', publicKey: '', fingerprint: 'ab'.repeat(32), source: 'other', addedAt: '', status: 'replaced' }]));
  assert.deepEqual(listTrustedHistory({ storage }), [], 'a history entry without its date is dropped');
  const pins = new MemoryStorage();
  await pinTrustedKey('Unit', keyA, { storage: pins, cryptoObject: webcrypto, source: 'other', confirmed: true });
  await assert.rejects(pinTrustedKey('Unit', keyB, { storage: pins, cryptoObject: webcrypto, source: 'other', confirmed: true }), (error) => /(?:[0-9a-f]{4} ){15}[0-9a-f]{4}/.test(error.message) && /Confirm rotation/.test(error.message));
});

test('a weak (small-order or non-canonical) Ed25519 key cannot be pinned', async () => {
  const { weak, error } = JSON.parse(readFileSync(new URL('../../tests/fixtures/ed25519-weak-keys.json', import.meta.url), 'utf8'));
  const storage = new MemoryStorage();
  for (const { key } of weak) await assert.rejects(pinTrustedKey('Flight unit A', key, { storage, cryptoObject: webcrypto, source: 'website', confirmed: true }), { message: error });
  assert.deepEqual(listTrustedKeys({ storage }), []);
});

test('a weak key can never be trusted: its fingerprint is refused, and a stored one reads as weak', async () => {
  const { weak, error } = JSON.parse(readFileSync(new URL('../../tests/fixtures/ed25519-weak-keys.json', import.meta.url), 'utf8'));
  const storage = new MemoryStorage();
  for (const { key } of weak) {
    const fingerprint = await fingerprintHex(key, webcrypto);
    await assert.rejects(addTrustedCompany('Weak Co', formatFingerprint(fingerprint), { storage, source: 'website', confirmed: true }), { message: error });
  }
  assert.equal(storage.getItem(STORE), null);
  // A pin written before this guard existed (or by hand) still never makes a weak key "trusted".
  const [{ key }] = weak;
  storage.setItem(STORE, JSON.stringify([{ name: 'Weak Co', publicKey: '', fingerprint: await fingerprintHex(key, webcrypto), source: 'website', addedAt: '', status: 'active' }]));
  assert.equal((await trustForKey(key, opts(storage))).status, 'weak');
});

test('the browser fingerprint equals the registry fingerprint (SHA-256 of the 32 raw key bytes, lowercase hex)', async () => {
  const sample = readFileSync(new URL('../../docs/samples/pubkey.txt', import.meta.url), 'utf8').trim();
  const { weak } = JSON.parse(readFileSync(new URL('../../tests/fixtures/ed25519-weak-keys.json', import.meta.url), 'utf8'));
  const keys = [sample, keyA, weak[0].key];
  const registry = spawnSync('python3', ['-c', 'import sys\nfrom registry.receipt import fingerprint\nfor k in sys.argv[1:]: print(fingerprint(bytes.fromhex(k)))', ...keys], { cwd: new URL('../../registry/', import.meta.url), encoding: 'utf8' });
  assert.equal(registry.status, 0, registry.stderr);
  const expected = registry.stdout.trim().split('\n');
  assert.equal(expected.length, keys.length);
  for (const [i, key] of keys.entries()) {
    assert.equal(await fingerprintHex(key, webcrypto), expected[i]);
    assert.equal(normalizeFingerprint(formatFingerprint(expected[i])), expected[i]);
  }
});

const copyOf = (storage) => { const next = new MemoryStorage(); for (const [k, v] of storage.values) next.setItem(k, v); return next; };

test('a compromised key stays compromised after its company is removed, and cannot be added again', async () => {
  const storage = new MemoryStorage();
  await pinTrustedKey('Acme', keyA, opts(storage, { source: 'website', confirmed: true }));
  await addTrustedCompany('Other Co', fpA, { storage, source: 'phone', confirmed: true });
  await addTrustedCompany('Fp Only', fpB, { storage, source: 'phone', confirmed: true });
  markCompromised('ACME', fpA, { storage, now: '2026-11-01T00:00:00.000Z' });
  markCompromised('fp only', fpB, { storage, now: '2026-11-02T00:00:00.000Z' });
  assert.equal(removeTrustedKey('Acme', { storage }), false, 'only the compromised record was left, so nothing is removed');
  removeTrustedKey('Other Co', { storage });
  removeTrustedKey('Fp Only', { storage });
  const reloaded = copyOf(storage); // a fresh read from storage, as after a page reload
  const trust = await trustForKey(keyA, opts(reloaded));
  assert.equal(trust.status, 'compromised');
  assert.equal(trust.entry.name, 'Acme');
  assert.equal((await trustForKey(keyB, opts(reloaded))).status, 'compromised', 'a fingerprint-only compromised record survives too');
  assert.deepEqual(listTrustedKeys({ storage: reloaded }), []);
  const before = reloaded.getItem(STORE);
  const refused = /marked as compromised/;
  await assert.rejects(addTrustedCompany('New Co', formatFingerprint(fpA), { storage: reloaded, source: 'website', confirmed: true }), refused);
  await assert.rejects(addTrustedCompany('Acme', fpB, { storage: reloaded, source: 'website', confirmed: true }), refused);
  await assert.rejects(pinTrustedKey('New Co', keyA, opts(reloaded, { source: 'website', confirmed: true })), refused);
  assert.equal(reloaded.getItem(STORE), before, 'nothing was saved');
});

test('read drops malformed entries and entries whose fingerprint is not SHA-256 of their key', async () => {
  const keys = ['00'.repeat(32), 'ff'.repeat(32), '80'.repeat(16) + '7f'.repeat(16), keyA, keyB];
  const good = await Promise.all(keys.map(async (publicKey, i) => ({ name: `K${i}`, publicKey, fingerprint: await fingerprintHex(publicKey, webcrypto), source: 'other', addedAt: '', status: 'active' })));
  const storage = new MemoryStorage();
  storage.setItem(STORE, JSON.stringify([
    { name: 'Forged', publicKey: keyA, fingerprint: fpB, source: 'website', addedAt: '', status: 'active' },
    { name: 'Fingerprint only', publicKey: '', fingerprint: fpB, source: 'website', addedAt: '', status: 'active' },
    { name: '', publicKey: '', fingerprint: fpA },
    null, 7, 'text',
    ...good,
  ]));
  assert.deepEqual(listTrustedHistory({ storage }).map((e) => e.name), ['Fingerprint only', ...keys.map((_, i) => `K${i}`)]);
  const forged = await trustForKey(keyA, opts(storage));
  assert.equal(forged.entry.name, 'K3', 'the forged entry is ignored');
  storage.setItem(STORE, '{not json');
  assert.throws(() => listTrustedHistory({ storage }), /unreadable/);
  storage.setItem(STORE, '{}');
  assert.throws(() => listTrustedHistory({ storage }), /unsupported format/);
});


// R34: a trusted pin needs a real source and the user's own "I confirmed this" tick, on both paths.
test('R34: both pin paths refuse without a source or without the confirmation tick, and save nothing', async () => {
  const storage = new MemoryStorage();
  const tick = /Tick the box to confirm you checked this fingerprint yourself/;
  for (const extra of [{}, { source: 'not-recorded', confirmed: true }, { source: '', confirmed: true }]) {
    await assert.rejects(pinTrustedKey('Unit', keyA, opts(storage, extra)), /Choose where you got this key/);
    await assert.rejects(addTrustedCompany('Acme', fpA, { storage, ...extra }), /Choose where you got this fingerprint/);
  }
  for (const confirmed of [undefined, false, 'yes', 1]) {
    await assert.rejects(pinTrustedKey('Unit', keyA, opts(storage, { source: 'phone', confirmed })), tick);
    await assert.rejects(addTrustedCompany('Acme', fpA, { storage, source: 'phone', confirmed }), tick);
  }
  assert.equal(storage.getItem(STORE), null, 'store unchanged');
  await pinTrustedKey('Unit', keyA, opts(storage, { source: 'phone', confirmed: true }));
  const before = storage.getItem(STORE);
  await assert.rejects(pinTrustedKey('Unit', keyB, opts(storage, { source: 'phone', confirmRotation: true })), tick, 'a confirmed rotation still needs the tick');
  await assert.rejects(addTrustedCompany('Unit', fpB, { storage, source: 'phone', confirmReplace: true }), tick);
  assert.equal(storage.getItem(STORE), before, 'store unchanged');
});

test('R34: an attested pin stores confirmedAt and reads trusted; a legacy pin is confirmed in place by re-adding it', async () => {
  const storage = new MemoryStorage();
  const pinned = await pinTrustedKey('Unit', keyA, opts(storage, { source: 'phone', confirmed: true, now: '2026-11-19T08:00:00.000Z' }));
  assert.equal(pinned.confirmedAt, '2026-11-19T08:00:00.000Z');
  assert.equal((await trustForKey(keyA, opts(storage))).status, 'trusted');
  for (const legacy of [{ name: 'Old', publicKey: keyA, fingerprint: fpA }, { name: 'Old', publicKey: '', fingerprint: fpA, source: 'contract', addedAt: '2026-01-01T00:00:00.000Z', status: 'active' }]) {
    storage.setItem(STORE, JSON.stringify([legacy]));
    assert.equal((await trustForKey(keyA, opts(storage))).status, 'unconfirmed', 'with or without a source');
    const upgraded = await addTrustedCompany('old', formatFingerprint(fpA), { storage, source: 'website', confirmed: true, now: '2026-11-19T09:00:00.000Z' });
    assert.deepEqual(listTrustedHistory({ storage }), [upgraded], 'upgraded in place, no history entry');
    assert.equal(upgraded.source, 'website');
    assert.equal(upgraded.confirmedAt, '2026-11-19T09:00:00.000Z');
    assert.equal(upgraded.addedAt, legacy.addedAt || '', 'the original added date is kept');
    assert.equal((await trustForKey(keyA, opts(storage))).status, 'trusted');
  }
  // The pin path upgrades a legacy entry the same way.
  storage.setItem(STORE, JSON.stringify([{ name: 'Old', publicKey: keyA, fingerprint: fpA }]));
  await pinTrustedKey('Old', keyA, opts(storage, { source: 'contract', confirmed: true }));
  assert.equal((await trustForKey(keyA, opts(storage))).status, 'trusted');
});

test('R34: a confirmed pin wins over a legacy pin of the same key; compromised still wins over both', async () => {
  const storage = new MemoryStorage();
  storage.setItem(STORE, JSON.stringify([{ name: 'Old', publicKey: keyA, fingerprint: fpA }]));
  await addTrustedCompany('New', fpA, { storage, source: 'phone', confirmed: true });
  storage.setItem(STORE, JSON.stringify([...JSON.parse(storage.getItem(STORE)), { name: 'Later legacy', publicKey: '', fingerprint: fpA }]));
  const trust = await trustForKey(keyA, opts(storage));
  assert.deepEqual([trust.status, trust.entry.name], ['trusted', 'New']);
  markCompromised('Later legacy', fpA, { storage });
  assert.equal((await trustForKey(keyA, opts(storage))).status, 'compromised');
});

test('R34: a bad confirmedAt makes an entry unconfirmed, never dropped; a compromised entry with one stays compromised', async () => {
  const storage = new MemoryStorage();
  storage.setItem(STORE, JSON.stringify([
    { name: 'Bad date', publicKey: keyA, fingerprint: fpA, source: 'phone', addedAt: '', status: 'active', confirmedAt: 'yesterday' },
    { name: 'Burned', publicKey: keyB, fingerprint: fpB, source: 'phone', addedAt: '', status: 'compromised', compromisedAt: '2026-06-01T00:00:00.000Z', confirmedAt: 42 },
  ]));
  assert.deepEqual(listTrustedHistory({ storage }).map((e) => [e.name, Object.hasOwn(e, 'confirmedAt')]), [['Bad date', false], ['Burned', false]]);
  assert.equal((await trustForKey(keyA, opts(storage))).status, 'unconfirmed');
  assert.equal((await trustForKey(keyB, opts(storage))).status, 'compromised');
});

// Verify's delegated path for pilot keys (Option B, design §7.2): trustForProof and the two trustLine cases.
// Switch off: a plain import, as every shipped build has it. Switch on: the same modules through Vite, with a
// test-only Vite plugin that rewrites `export const PILOT_AUTHORIZATION_ACCEPTED = false` to true (no runtime option).
// Uses the shared vectors (tests/fixtures/pilot-authorization.json) and an injected verifier clock.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { createServer } from 'vite';
import * as offKeys from '../src/trusted-keys.mjs';
import * as offTrust from '../src/recipient-trust.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = JSON.parse(readFileSync(resolve(ROOT, '../tests/fixtures/pilot-authorization.json'), 'utf8'));
const vector = (name) => VECTORS.cases.find((c) => c.name === name);
const SWITCH = 'export const PILOT_AUTHORIZATION_ACCEPTED = false;';
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
  plugins: [{ name: 'pilot-switch-on', load(id) {
    if (!id.endsWith('/src/recipient-trust.mjs')) return null;
    const code = readFileSync(id, 'utf8');
    if (!code.includes(SWITCH)) throw new Error('switch line not found');
    return code.replace(SWITCH, 'export const PILOT_AUTHORIZATION_ACCEPTED = true;');
  } }],
});
after(() => vite.close());
const onTrust = await vite.ssrLoadModule('/src/recipient-trust.mjs');
const onKeys = await vite.ssrLoadModule('/src/trusted-keys.mjs');

class MemoryStorage { values = new Map(); getItem(k) { return this.values.get(k) ?? null; } setItem(k, v) { this.values.set(k, String(v)); } }
const STORE = 'flightseal_trusted_keys_v1';
const fp = async (key) => Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(key, 'hex'))).toString('hex');
const valid = vector('valid');
const PILOT = valid.pilot_key, COMPANY = valid.company_key, OTHER = vector('wrong org: another company key expected').company_key;
const NOW_MS = valid.now * 1000;
const AT = '2026-11-01T00:00:00.000Z';
/** Storage holding the given pins, written as JSON (no pilotKeys setter exists yet; part 2 adds the Trust UI). */
async function pins(...entries) {
  const storage = new MemoryStorage();
  const list = [];
  for (const { key, fingerprintOnly = false, ...rest } of entries) {
    list.push({ name: 'Acme Air', publicKey: fingerprintOnly ? '' : key, fingerprint: await fp(key), source: 'website', addedAt: AT, status: 'active', confirmedAt: AT, ...rest });
  }
  storage.setItem(STORE, JSON.stringify(list));
  return storage;
}
const companyPin = (extra = {}) => ({ key: COMPANY, pilotKeys: true, ...extra });
const opts = (storage, now = NOW_MS) => ({ storage, cryptoObject: webcrypto, now });
const message = (line, sealed = '') => `Original file: flight.ulg\n${sealed ? `Sealed: ${sealed}\n` : ''}fseal-receipt v1 count=1 head=${'a'.repeat(64)} key=${PILOT} sig=${'b'.repeat(128)}\n${line}\n`;
const complete = [{ id: 1, name: 'a.ulg', bytes: 1, sha256: 'a'.repeat(64), status: 'match', local: 0, note: '' }];
const headline = (trustModule, trust) => trustModule.verdict({ signed: true, trust, items: complete }).headline;

test('switch: off in the shipped source, on through the test plugin only', () => {
  assert.equal(offTrust.PILOT_AUTHORIZATION_ACCEPTED, false);
  assert.equal(onTrust.PILOT_AUTHORIZATION_ACCEPTED, true); // canary: the on-tests below really run with it on
  assert.ok(readFileSync(resolve(ROOT, 'src/recipient-trust.mjs'), 'utf8').includes(SWITCH));
});

test('switch off: a valid authorization changes nothing, on screen or in any report', async () => {
  const storage = await pins(companyPin());
  const withLine = await offKeys.trustForProof(PILOT, message(valid.line), opts(storage));
  const without = await offKeys.trustForProof(PILOT, message(''), opts(storage));
  const plain = await offKeys.trustForKey(PILOT, opts(storage));
  assert.deepEqual(withLine, plain);
  assert.deepEqual(without, plain);
  assert.equal(withLine.status, 'untrusted');
  assert.equal(headline(offTrust, withLine), 'Files match · signer not confirmed');
  assert.equal(offTrust.trustLine(withLine), offTrust.trustLine(plain));
  const report = (trust) => offTrust.manifestReport({ sealedName: 'f.manifest.fseal', trust, sources: offKeys.SOURCES, keyFingerprint: plain.fingerprint, head: 'c'.repeat(64), sealedAt: '2026-11-01T00:00:00Z', items: complete, extras: [], locals: [{ name: 'a.ulg', sha256: 'a'.repeat(64) }] });
  const a = report(withLine), b = report(plain);
  for (const field of ['text', 'markdown', 'json']) assert.equal(a[field], b[field], field);
  assert.deepEqual(a.pdfLines, b.pdfLines);
  assert.match(a.text, /^Result: Files match · signer not confirmed\./);
});

test('switch on, every check passes: Verified, with the pilot line (key pin and fingerprint-only pin)', async () => {
  for (const pin of [companyPin(), companyPin({ fingerprintOnly: true })]) {
    const trust = await onKeys.trustForProof(PILOT, message(valid.line), opts(await pins(pin)));
    assert.equal(trust.status, 'trusted');
    assert.equal(trust.via, 'pilot');
    assert.equal(trust.entry.name, 'Acme Air');
    assert.match(trust.notAfter, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(headline(onTrust, trust), 'Verified');
    assert.equal(onTrust.trustLine(trust), `Signed by a pilot key that Acme Air authorized until ${trust.notAfter.slice(0, 10)}`);
    assert.doesNotMatch(onTrust.trustLine(trust), /a key you trust/);
  }
  const atMax = vector('valid at exactly max_days');
  assert.equal((await onKeys.trustForProof(PILOT, message(atMax.line), opts(await pins(companyPin())))).status, 'trusted');
});

test('switch on, authorization ended: not confirmed, with the end date', async () => {
  const ended = vector('ended: not_after before now');
  const trust = await onKeys.trustForProof(PILOT, message(ended.line), opts(await pins(companyPin()), ended.now * 1000));
  assert.equal(trust.status, 'untrusted');
  assert.equal(trust.reason, 'authorization-ended');
  assert.equal(headline(onTrust, trust), 'Files match · signer not confirmed');
  assert.equal(onTrust.trustLine(trust), `The company's authorization for this pilot key ended on ${trust.notAfter.slice(0, 10)}. Ask the company.`);
  // Ended but the pin doesn't qualify: the plain untrusted line, never the ended one.
  const noPilot = await onKeys.trustForProof(PILOT, message(ended.line), opts(await pins({ key: COMPANY }), ended.now * 1000));
  assert.equal(noPilot.reason, undefined);
});

test('switch on, expiry uses only the injected verifier clock, never the seal time in the message', async () => {
  const storage = await pins(companyPin());
  const live = await onKeys.trustForProof(PILOT, message(valid.line), opts(storage));
  const notAfter = Date.parse(live.notAfter);
  const sealed = new Date(notAfter - 86400_000).toISOString(); // sealed a day before not_after
  const trust = await onKeys.trustForProof(PILOT, message(valid.line, sealed), opts(storage, notAfter + 1000));
  assert.equal(trust.reason, 'authorization-ended');
  assert.notEqual(headline(onTrust, trust), 'Verified');
  assert.equal((await onKeys.trustForProof(PILOT, message(valid.line, sealed), opts(storage, notAfter))).status, 'untrusted', 'not_after == now has ended');
  assert.equal((await onKeys.trustForProof(PILOT, message(valid.line, sealed), opts(storage, notAfter - 1000))).status, 'trusted');
});

test('switch on, any one check fails: signer not confirmed (untrusted line)', async () => {
  const good = await pins(companyPin());
  const cases = {
    'other receipt key': [OTHER, message(valid.line), good],
    'other company key pinned': [PILOT, message(valid.line), await pins({ key: OTHER, pilotKeys: true })],
    'pin without pilotKeys': [PILOT, message(valid.line), await pins({ key: COMPANY })],
    'pilotKeys not exactly true': [PILOT, message(valid.line), await pins({ key: COMPANY, pilotKeys: 'true' })],
    'unconfirmed pin': [PILOT, message(valid.line), await pins(companyPin({ confirmedAt: undefined }))],
    'not_after more than 30 days ahead': [PILOT, message(vector('too long: one second past max_days').line), good],
    'two authorization lines': [PILOT, message(vector('two authorization lines in one message').line), good],
    'non-canonical encoding': [PILOT, message(vector('base64 padding').line), good],
    'signed by another key': [PILOT, message(vector('signed by another key').line), good],
    'leading space': [PILOT, message(` ${valid.line}`), good],
    'no line': [PILOT, message(''), good],
  };
  for (const [name, [key, text, storage]] of Object.entries(cases)) {
    const trust = await onKeys.trustForProof(key, text, opts(storage));
    assert.equal(trust.status, 'untrusted', name);
    assert.equal(trust.reason, undefined, name);
    assert.equal(headline(onTrust, trust), 'Files match · signer not confirmed', name);
    assert.equal(onTrust.trustLine(trust), onTrust.trustLine({ status: 'untrusted' }), name);
  }
});

test('switch on, a compromised pilot key or company key never reads Verified', async () => {
  const company = await onKeys.trustForProof(PILOT, message(valid.line), opts(await pins(companyPin({ status: 'compromised', compromisedAt: AT }))));
  assert.equal(company.status, 'compromised');
  const pilot = await onKeys.trustForProof(PILOT, message(valid.line), opts(await pins(companyPin(), { key: PILOT, name: 'Lost laptop', status: 'compromised', compromisedAt: AT })));
  assert.equal(pilot.status, 'compromised');
  // A compromised company record beside an active pilot-keys pin for the same key still wins.
  const both = await onKeys.trustForProof(PILOT, message(valid.line), opts(await pins(companyPin(), companyPin({ name: 'Old', status: 'compromised', compromisedAt: AT }))));
  assert.equal(both.status, 'compromised');
  for (const trust of [company, pilot, both]) assert.equal(headline(onTrust, trust), 'Signed by a key marked compromised');
});

test('switch on, company key only on a replaced pin: replaced', async () => {
  const trust = await onKeys.trustForProof(PILOT, message(valid.line), opts(await pins(companyPin({ status: 'replaced', replacedAt: AT }), { key: OTHER, pilotKeys: true })));
  assert.equal(trust.status, 'replaced');
  assert.equal(headline(onTrust, trust), 'Files match · signer not confirmed');
});

test('a forged line naming a compromised company is not attributed to it (the signature is checked first)', async () => {
  const trust = await onKeys.trustForProof(PILOT, message(vector('signed by another key').line), opts(await pins(companyPin({ status: 'compromised', compromisedAt: AT }))));
  assert.equal(trust.status, 'untrusted');
});

test('pins keep pilotKeys only when exactly true; other pins stay byte-identical after a write', async () => {
  const storage = await pins(companyPin(), { key: OTHER, name: 'Beta', pilotKeys: 'yes' });
  const history = offKeys.listTrustedHistory({ storage });
  assert.equal(history[0].pilotKeys, true);
  assert.equal('pilotKeys' in history[1], false);
  const plain = new MemoryStorage();
  await offKeys.pinTrustedKey('Gamma', OTHER, { storage: plain, cryptoObject: webcrypto, source: 'website', confirmed: true, now: AT });
  const before = plain.getItem(STORE);
  offKeys.markCompromised('Gamma', await fp(OTHER), { storage: plain, now: AT });
  assert.equal(plain.getItem(STORE), before.replace('"status":"active"', '"status":"compromised"').replace('}]', ',"compromisedAt":"2026-11-01T00:00:00.000Z"}]'));
});

// Part 2: the recipient's setter, the compromised-fingerprint list and the step-6 helper, switch on.
const BURNED = 'hashwing_compromised_fingerprints_v1';
const FP_COMPANY = await fp(COMPANY), FP_OTHER = await fp(OTHER), FP_PILOT = await fp(PILOT);
const hexFp = (i) => i.toString(16).padStart(64, '0');

test('pilotKeys setter: only with the tick, on an active confirmed pin that is not compromised; fires PINS_CHANGED', async () => {
  const storage = await pins({ key: COMPANY }, { key: OTHER, name: 'Beta', confirmedAt: undefined });
  let fired = 0; const on = () => { fired++; };
  globalThis.addEventListener?.(onKeys.PINS_CHANGED, on);
  try {
    assert.throws(() => onKeys.setPilotKeys('Acme Air', FP_COMPANY, true, { storage }), /Tick the box/);
    assert.throws(() => onKeys.setPilotKeys('Beta', FP_OTHER, true, { confirmed: true, storage }), /Confirm this company/);
    assert.throws(() => onKeys.setPilotKeys('Nobody', FP_COMPANY, true, { confirmed: true, storage }), /No active saved company/);
    const set = onKeys.setPilotKeys('Acme Air', FP_COMPANY, true, { confirmed: true, storage });
    assert.equal(set.pilotKeys, true);
    assert.equal(onKeys.listTrustedHistory({ storage })[0].pilotKeys, true);
    if (globalThis.addEventListener) assert.ok(fired >= 1, 'PINS_CHANGED');
    assert.equal((await onKeys.trustForProof(PILOT, message(valid.line), opts(storage))).status, 'trusted');
    assert.equal('pilotKeys' in onKeys.setPilotKeys('Acme Air', FP_COMPANY, false, { storage }), false);
    assert.equal((await onKeys.trustForProof(PILOT, message(valid.line), opts(storage))).status, 'untrusted');
  } finally { globalThis.removeEventListener?.(onKeys.PINS_CHANGED, on); }
  const replaced = await pins(companyPin({ status: 'replaced', replacedAt: AT, pilotKeys: undefined }));
  assert.throws(() => onKeys.setPilotKeys('Acme Air', FP_COMPANY, true, { confirmed: true, storage: replaced }), /No active saved company/);
  const listed = await pins({ key: COMPANY });
  onKeys.markFingerprintCompromised(FP_COMPANY, { storage: listed, now: AT });
  assert.throws(() => onKeys.setPilotKeys('Acme Air', FP_COMPANY, true, { confirmed: true, storage: listed }), /compromised/);
});

test('compromised list: survives a reload, re-adding is a no-op keeping the first mark, a bad fingerprint is refused', async () => {
  const storage = new MemoryStorage();
  const first = onKeys.markFingerprintCompromised(`SHA-256: ${(FP_PILOT).match(/.{4}/g).join(' ')}`, { note: 'lost laptop', storage, now: AT });
  assert.deepEqual(first, { fingerprint: FP_PILOT, compromisedAt: AT, note: 'lost laptop' });
  const again = onKeys.markFingerprintCompromised(FP_PILOT, { note: 'other', storage, now: '2026-12-01T00:00:00.000Z' });
  assert.deepEqual(again, first, 'never overwritten');
  assert.deepEqual(onKeys.listCompromisedFingerprints({ storage }), [first], 'read back from storage, as after a reload');
  assert.throws(() => onKeys.markFingerprintCompromised('abc', { storage }), /64 hexadecimal digits/);
  assert.throws(() => onKeys.markFingerprintCompromised(hexFp(1), { note: 'x'.repeat(201), storage }), /under 200/);
});

test('compromised list cap 500: the 501st new entry is refused plainly, existing marks stay, re-adding a listed one still succeeds', async () => {
  const storage = new MemoryStorage();
  storage.setItem(BURNED, JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ fingerprint: hexFp(i + 1), compromisedAt: AT }))));
  const before = storage.getItem(BURNED);
  assert.throws(() => onKeys.markFingerprintCompromised(hexFp(9999), { storage }), /^Error: This list is full/);
  assert.equal(storage.getItem(BURNED), before);
  assert.equal(onKeys.markFingerprintCompromised(hexFp(7), { storage }).fingerprint, hexFp(7));
  assert.equal(onKeys.listCompromisedFingerprints({ storage }).length, 500);
});

test('a malformed compromised list never loses entries and fails closed (never trusted)', async () => {
  for (const raw of ['{', '[{"fingerprint":"zz","compromisedAt":"x"}]', JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ fingerprint: hexFp(i), compromisedAt: AT }))), '{"a":1}']) {
    const storage = await pins(companyPin(), { key: OTHER, name: 'Beta' });
    storage.setItem(BURNED, raw);
    assert.throws(() => onKeys.listCompromisedFingerprints({ storage }), /unreadable/);
    assert.throws(() => onKeys.markFingerprintCompromised(hexFp(1), { storage }), /unreadable/);
    assert.equal(storage.getItem(BURNED), raw, 'nothing written over it');
    assert.equal((await onKeys.trustForProof(PILOT, message(valid.line), opts(storage))).status, 'untrusted', 'pilot proof');
    assert.equal((await onKeys.trustForProof(OTHER, message(''), opts(storage))).status, 'untrusted', 'a trusted company key is not trusted either');
  }
});

test('trustForProof reads the compromised list first: the pilot key, or the signed statement\'s company key', async () => {
  for (const key of [PILOT, COMPANY]) {
    const storage = await pins(companyPin());
    onKeys.markFingerprintCompromised((key === PILOT ? FP_PILOT : FP_COMPANY), { storage, now: AT });
    const trust = await onKeys.trustForProof(PILOT, message(valid.line), opts(storage));
    assert.equal(trust.status, 'compromised', key === PILOT ? 'pilot' : 'company');
    assert.equal(trust.listed, true);
    assert.equal(headline(onTrust, trust), 'Signed by a key marked compromised');
    assert.equal(onTrust.trustLine(trust), "Signed by a key you marked as compromised on 2026-11-01. Don't rely on this proof without checking with the company.");
  }
  // A plain trusted company key on the list reads compromised too.
  const storage = await pins({ key: OTHER, name: 'Beta' });
  onKeys.markFingerprintCompromised(FP_OTHER, { storage, now: AT });
  assert.equal((await onKeys.trustForProof(OTHER, message(''), opts(storage))).status, 'compromised');
  // A forged line naming a listed company key is not attributed to it.
  const forged = await pins(companyPin());
  onKeys.markFingerprintCompromised(FP_COMPANY, { storage: forged, now: AT });
  assert.equal((await onKeys.trustForProof(PILOT, message(vector('signed by another key').line), opts(forged))).status, 'untrusted');
});

test('step 6 helper: a pilot result counts only for the exact company fingerprint or the exact typed company key; switch off never', async () => {
  const trust = await onKeys.trustForProof(PILOT, message(valid.line), opts(await pins(companyPin())));
  assert.equal(trust.companyKey, COMPANY);
  assert.equal(onTrust.pilotAccepted(trust, { companyFingerprint: FP_COMPANY }), true);
  assert.equal(onTrust.pilotAccepted(trust, { companyKey: COMPANY.toUpperCase() }), true);
  assert.equal(onTrust.pilotAccepted(trust, { companyFingerprint: FP_OTHER }), false);
  assert.equal(onTrust.pilotAccepted(trust, { companyKey: OTHER }), false);
  assert.equal(onTrust.pilotAccepted(trust, {}), false);
  assert.equal(onTrust.pilotAccepted({ ...trust, via: undefined }, { companyKey: COMPANY }), false);
  assert.equal(onTrust.pilotAccepted({ status: 'untrusted', reason: 'authorization-ended', entry: trust.entry }, { companyFingerprint: FP_COMPANY }), false);
  assert.equal(offTrust.pilotAccepted(trust, { companyFingerprint: FP_COMPANY, companyKey: COMPANY }), false);
});

test('an open pilot Verified is re-checked when the authorization ends: the delay, its clamp, and the drop', async () => {
  const storage = await pins(companyPin());
  const trust = await onKeys.trustForProof(PILOT, message(valid.line), opts(storage));
  const end = Date.parse(trust.notAfter);
  assert.equal(onTrust.pilotRecheckDelay(trust, end - 5000), 6000, 'fires just after not_after');
  assert.equal(onTrust.pilotRecheckDelay(trust, end + 9000), 0);
  assert.equal(onTrust.pilotRecheckDelay(trust, end - 40 * 86400_000), 2 ** 31 - 1, 'clamped to setTimeout range');
  assert.equal(onTrust.pilotRecheckDelay({ status: 'trusted', entry: trust.entry }), null, 'not a pilot result');
  assert.equal(offTrust.pilotRecheckDelay(trust, end - 5000), null, 'switch off');
  const later = await onKeys.trustForProof(PILOT, message(valid.line), opts(storage, end - 5000 + onTrust.pilotRecheckDelay(trust, end - 5000)));
  assert.equal(headline(onTrust, later), 'Files match · signer not confirmed');
  assert.equal(onTrust.trustLine(later), `The company's authorization for this pilot key ended on ${trust.notAfter.slice(0, 10)}. Ask the company.`);
});

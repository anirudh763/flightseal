import { SMALL_ORDER_Y, WEAK_KEY_MESSAGE, parseHex, weakPublicKey } from '../../docs/verifier.js';
import { PILOT_AUTHORIZATION_ACCEPTED } from './recipient-trust.mjs';
import { check as checkAuthorization, iso, parseLine } from './pilot-authorization.mjs';
// Local trusted-companies list (public keys and fingerprints only; never a private key). History is kept: a
// replaced or compromised key stays listed with its status, so an old proof can still be explained. Removing a
// company keeps its compromised records.
const STORAGE_KEY = 'flightseal_trusted_keys_v1';
export const PINS_CHANGED = 'hashwing-trusted-keys-changed';
// ponytail: compromised records are never removed, so they count toward this cap for good; add a separate
// compromised-fingerprint list if a user ever fills 64 entries.
const MAX_KEYS = 64; // history entries count
const HEX64 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STATUSES = new Set(['active', 'replaced', 'compromised']);
export const SOURCES = Object.freeze({ website: 'company website you already knew', contract: 'contract or invoice', phone: 'phone call with a known contact', other: 'other', 'not-recorded': 'not recorded' });

export async function fingerprintHex(publicKey, cryptoObject = globalThis.crypto) {
  const value = String(publicKey || '').trim().toLowerCase();
  if (!HEX64.test(value)) throw new Error('A public key must contain exactly 64 hexadecimal digits.');
  const rawKey = Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
  const digest = new Uint8Array(await cryptoObject.subtle.digest('SHA-256', rawKey));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Accepts spaces, colons, line breaks and a `SHA-256:` prefix. */
export function normalizeFingerprint(input) {
  const value = String(input || '').trim().replace(/^sha-?256\s*:?/i, '').replace(/[\s:]/g, '').toLowerCase();
  if (!HEX64.test(value)) throw new Error('A fingerprint has 64 hexadecimal digits (0–9, a–f). Check it and try again.');
  return value;
}
// Every weak Ed25519 encoding (small-order y, or non-canonical y >= p; either sign bit), filtered through the shared
// weakPublicKey rule, so a fingerprint of one of them can never be added as a trusted company.
function weakKeys() {
  const ys = SMALL_ORDER_Y.map((y) => parseHex(y, 32));
  for (let low = 0xed; low <= 0xff; low++) ys.push(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? low : i === 31 ? 0x7f : 0xff)));
  return ys.flatMap((y) => [y, Uint8Array.from(y, (b, i) => (i === 31 ? b | 0x80 : b))]).filter(weakPublicKey);
}
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
let weakFingerprints = null;
const weakFingerprintSet = (cryptoObject) => (weakFingerprints ??= Promise.all(weakKeys().map((key) => fingerprintHex(toHex(key), cryptoObject))).then((list) => new Set(list)));
export const formatFingerprint = (hex) => String(hex || '').match(/.{1,4}/g)?.join(' ') || '';

// Synchronous SHA-256 (FIPS 180-4) so read() can check each stored fingerprint against its key: read() and the
// list/remove/mark calls that use it are synchronous, and crypto.subtle.digest is not.
const K256 = Uint32Array.from('428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'.split(' '), (h) => Number.parseInt(h, 16));
function sha256Hex(bytes) {
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const data = new Uint8Array(blocks * 64);
  data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(data.length - 4, bytes.length * 8); // inputs here are 32 bytes, far below 2^29
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 64; i++) {
      w[i] = i < 16 ? view.getUint32(off + 4 * i)
        : (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) + w[i - 7] + (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 16];
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => { h[i] += v; });
  }
  return [...h].map((v) => v.toString(16).padStart(8, '0')).join('');
}
const keyFingerprint = (publicKey) => sha256Hex(Uint8Array.from(publicKey.match(/../g), (byte) => Number.parseInt(byte, 16)));

function clean(entry) {
  const { name, publicKey, fingerprint, source, addedAt, status, confirmedAt, replacedAt, compromisedAt, pilotKeys } = entry;
  // pilotKeys (Option B, "This company uses pilot keys") is kept only when exactly true, so other pins stay byte-identical.
  return { name, publicKey, fingerprint, source, addedAt, status, ...(confirmedAt ? { confirmedAt } : {}), ...(replacedAt ? { replacedAt } : {}), ...(compromisedAt ? { compromisedAt } : {}), ...(pilotKeys === true ? { pilotKeys } : {}) };
}
function read(storage = globalThis.localStorage) {
  let entries;
  try { entries = JSON.parse(storage.getItem(STORAGE_KEY) || '[]'); } catch { throw new Error('Named key pins are unreadable. No existing pin was changed.'); }
  if (!Array.isArray(entries) || entries.length > MAX_KEYS) throw new Error('Named key pins have an unsupported format.');
  // A malformed entry, or one whose fingerprint is not SHA-256 of its stored key, is dropped (and is gone after the
  // next write) instead of making every pin unreadable. A fingerprint-only entry (publicKey '') is legitimate.
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    // Legacy pins are { name, publicKey, fingerprint } and read as active with no recorded source.
    const next = { source: 'not-recorded', addedAt: '', status: 'active', ...entry };
    // confirmedAt is the user's "I confirmed this myself" time (R34). A bad one only makes the entry unconfirmed; it
    // never drops the entry, which could lose a compromised record.
    if (!(typeof next.confirmedAt === 'string' && ISO.test(next.confirmedAt) && !Number.isNaN(Date.parse(next.confirmedAt)))) delete next.confirmedAt;
    const dated = (key) => typeof next[key] === 'string' && !Number.isNaN(Date.parse(next[key]));
    if ((next.status === 'replaced' && !dated('replacedAt')) || (next.status === 'compromised' && !dated('compromisedAt'))) return [];
    if (typeof next.name !== 'string' || !next.name || next.name.length > 80 || !(next.publicKey === '' || HEX64.test(next.publicKey)) || !HEX64.test(next.fingerprint)
      || !STATUSES.has(next.status) || !Object.hasOwn(SOURCES, next.source) || typeof next.addedAt !== 'string') return [];
    if (next.publicKey && keyFingerprint(next.publicKey) !== next.fingerprint) return [];
    return [clean(next)];
  });
}
function write(storage, entries) {
  if (entries.length > MAX_KEYS) throw new Error(`A maximum of ${MAX_KEYS} saved keys (including history) is supported. Remove a company first.`);
  const text = JSON.stringify(entries);
  storage.setItem(STORAGE_KEY, text);
  if (storage.getItem(STORAGE_KEY) !== text) throw new Error('Public-key pin could not be verified after storage.');
  // Lets open results re-check their trust line after a pin changes in this tab.
  if (typeof globalThis.dispatchEvent === 'function') globalThis.dispatchEvent(new Event(PINS_CHANGED));
}
function checkName(input) {
  const name = String(input || '').trim();
  if (!name || name.length > 80) throw new Error('Enter a company name up to 80 characters.');
  return name;
}
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// Shared by pinTrustedKey and addTrustedCompany: same name and fingerprint keeps the entry (and confirms a legacy
// one in place); a different fingerprint needs confirmation and then keeps the old one as history.
function upsert(entries, { name, publicKey, fingerprint, source, now, confirm, message }) {
  if (entries.some((entry) => entry.status === 'compromised' && entry.fingerprint === fingerprint)) {
    throw new Error('This key was marked as compromised, so it can’t be added again. Ask the company for a new key.');
  }
  const existing = entries.find((entry) => entry.status === 'active' && sameName(entry.name, name));
  if (existing && existing.fingerprint === fingerprint) {
    if (!existing.publicKey && publicKey) existing.publicKey = publicKey;
    if (!existing.confirmedAt) { existing.source = source; existing.confirmedAt = now; }
    return { entries, entry: existing };
  }
  if (existing && !confirm) throw Object.assign(new Error(message(existing)), { code: 'replace-needs-confirm', previous: formatFingerprint(existing.fingerprint) });
  if (existing) { existing.status = 'replaced'; existing.replacedAt = now; }
  const entry = { name, publicKey, fingerprint, source, addedAt: now, status: 'active', confirmedAt: now };
  return { entries: [...entries, entry], entry };
}

export function listTrustedKeys({ storage = globalThis.localStorage } = {}) { return read(storage).filter((entry) => entry.status === 'active'); }
export function listTrustedHistory({ storage = globalThis.localStorage } = {}) { return read(storage); }

export const CONFIRM_MESSAGE = 'Tick the box to confirm you checked this fingerprint yourself.';
const pickedSource = (source) => !!source && source !== 'not-recorded' && Object.hasOwn(SOURCES, source);

export async function pinTrustedKey(nameInput, publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto, confirmRotation = false, source, confirmed = false, now = new Date().toISOString() } = {}) {
  const name = String(nameInput || '').trim();
  if (!name || name.length > 80) throw new Error('Enter a key profile name up to 80 characters.');
  if (!pickedSource(source)) throw new Error('Choose where you got this key.');
  if (confirmed !== true) throw new Error(CONFIRM_MESSAGE);
  const value = String(publicKey || '').trim().toLowerCase();
  const fingerprint = await fingerprintHex(value, cryptoObject);
  if (weakPublicKey(parseHex(value, 32))) throw new Error(WEAK_KEY_MESSAGE);
  const { entries, entry } = upsert(read(storage), { name, publicKey: value, fingerprint, source, now, confirm: confirmRotation,
    message: (old) => `Key changed for “${old.name}” (old fingerprint ${formatFingerprint(old.fingerprint)}). Confirm rotation after verifying the new key independently.` });
  write(storage, entries);
  return clean(entry);
}

export async function addTrustedCompany(nameInput, fingerprintInput, { source, confirmed = false, confirmReplace = false, now = new Date().toISOString(), storage = globalThis.localStorage, cryptoObject = globalThis.crypto } = {}) {
  const name = checkName(nameInput);
  const fingerprint = normalizeFingerprint(fingerprintInput);
  if (!pickedSource(source)) throw new Error('Choose where you got this fingerprint.');
  if (confirmed !== true) throw new Error(CONFIRM_MESSAGE);
  if ((await weakFingerprintSet(cryptoObject)).has(fingerprint)) throw new Error(WEAK_KEY_MESSAGE);
  const { entries, entry } = upsert(read(storage), { name, publicKey: '', fingerprint, source, now, confirm: confirmReplace,
    message: (old) => `“${old.name}” already has the key ${formatFingerprint(old.fingerprint)}. Replace it only if the company told you about a new key through a channel you already know.` });
  write(storage, entries);
  return clean(entry);
}

export function markCompromised(name, fingerprintInput, { now = new Date().toISOString(), storage = globalThis.localStorage } = {}) {
  const fingerprint = normalizeFingerprint(fingerprintInput);
  const entries = read(storage);
  const entry = entries.find((item) => sameName(item.name, String(name)) && item.fingerprint === fingerprint && item.status !== 'compromised');
  if (!entry) throw new Error('No saved company has that name and key.');
  entry.status = 'compromised'; entry.compromisedAt = now;
  write(storage, entries);
  return clean(entry);
}

/** compromised / trusted (active pin the user confirmed) / unconfirmed (active pin without confirmedAt, R34) / replaced /
 * untrusted. Compromised wins if the key is saved more than once, then a confirmed active pin. */
export async function trustForKey(publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto } = {}) {
  let fingerprint;
  try { fingerprint = await fingerprintHex(publicKey, cryptoObject); } catch { return { status: 'untrusted', fingerprint: '' }; }
  if (weakPublicKey(parseHex(String(publicKey).trim().toLowerCase(), 32))) return { status: 'weak', fingerprint };
  const matches = read(storage).filter((entry) => entry.fingerprint === fingerprint);
  for (const [test, result] of [[(e) => e.status === 'compromised', 'compromised'], [(e) => e.status === 'active' && e.confirmedAt, 'trusted'], [(e) => e.status === 'active', 'unconfirmed'], [(e) => e.status === 'replaced', 'replaced']]) {
    const entry = matches.findLast(test);
    if (entry) return { status: result, entry, fingerprint };
  }
  return { status: 'untrusted', fingerprint };
}

/**
 * Trust for a proof whose receipt message may carry an `Authorized by company key:` line (Option B, design §7.2).
 * Switch off: exactly trustForKey. Switch on, and only when trustForKey says untrusted: the line's statement must
 * authorize this key, be signed by its company key, and that company key must be a confirmed active pin with
 * pilotKeys on; then { status: 'trusted', via: 'pilot', entry, notAfter }. A pin is attributed only once the
 * company signature checked out, so a forged line can't name a company: compromised and replaced come from a signed
 * statement, and 'authorization-ended' only after every pin check passed. `now` is the verifier's clock (epoch ms,
 * like Date.now()); no time from the proof or message is read.
 */
export async function trustForProof(publicKey, message, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto, now = Date.now() } = {}) {
  const base = await trustForKey(publicKey, { storage, cryptoObject });
  if (!PILOT_AUTHORIZATION_ACCEPTED || base.status !== 'untrusted' || !base.fingerprint) return base;
  const line = parseLine(message);
  if (!line.found || line.malformed) return base;
  const key = String(publicKey).trim().toLowerCase();
  const { reason, auth } = await checkAuthorization(line.authorization, line.sig, parseHex(key, 32), null, Math.floor(now / 1000));
  if (![null, 'ended', 'too_long'].includes(reason)) return base;
  const companyHex = toHex(auth.companyKey);
  const matches = read(storage).filter((entry) => entry.fingerprint === keyFingerprint(companyHex));
  const compromised = matches.findLast((entry) => entry.status === 'compromised');
  if (compromised) return { status: 'compromised', entry: compromised, fingerprint: base.fingerprint };
  const pin = matches.findLast((entry) => entry.status === 'active' && entry.confirmedAt && entry.pilotKeys === true && (!entry.publicKey || entry.publicKey === companyHex));
  if (!pin) {
    const replaced = !matches.some((entry) => entry.status === 'active') && matches.findLast((entry) => entry.status === 'replaced');
    return replaced ? { status: 'replaced', entry: replaced, fingerprint: base.fingerprint } : base;
  }
  const notAfter = iso(auth.notAfter);
  if (reason === null) return { status: 'trusted', via: 'pilot', entry: pin, notAfter, fingerprint: base.fingerprint };
  if (reason === 'ended') return { status: 'untrusted', reason: 'authorization-ended', entry: pin, notAfter, fingerprint: base.fingerprint };
  return base;
}

export async function matchingTrustedKey(publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto } = {}) {
  const fingerprint = await fingerprintHex(publicKey, cryptoObject);
  return listTrustedKeys({ storage }).find((entry) => entry.fingerprint === fingerprint && entry.publicKey === String(publicKey).trim().toLowerCase()) || null;
}
export function removeTrustedKey(name, { storage = globalThis.localStorage } = {}) {
  const entries = read(storage);
  // A compromised record is kept, so that key never reads as trusted again through another pin or a re-add.
  const updated = entries.filter((entry) => entry.status === 'compromised' || !sameName(entry.name, String(name)));
  write(storage, updated);
  return updated.length !== entries.length;
}

// Local trusted-companies list (public keys and fingerprints only; never a private key). History is kept: a
// replaced or compromised key stays listed with its status, so an old proof can still be explained.
const STORAGE_KEY = 'flightseal_trusted_keys_v1';
export const PINS_CHANGED = 'hashwing-trusted-keys-changed';
const MAX_KEYS = 64; // history entries count
const HEX64 = /^[a-f0-9]{64}$/;
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
export const formatFingerprint = (hex) => String(hex || '').match(/.{1,4}/g)?.join(' ') || '';

function clean(entry) {
  const { name, publicKey, fingerprint, source, addedAt, status, replacedAt, compromisedAt } = entry;
  return { name, publicKey, fingerprint, source, addedAt, status, ...(replacedAt ? { replacedAt } : {}), ...(compromisedAt ? { compromisedAt } : {}) };
}
function read(storage = globalThis.localStorage) {
  let entries;
  try { entries = JSON.parse(storage.getItem(STORAGE_KEY) || '[]'); } catch { throw new Error('Named key pins are unreadable. No existing pin was changed.'); }
  if (!Array.isArray(entries) || entries.length > MAX_KEYS) throw new Error('Named key pins have an unsupported format.');
  return entries.map((entry) => {
    // Legacy pins are { name, publicKey, fingerprint } and read as active with no recorded source.
    const next = { source: 'not-recorded', addedAt: '', status: 'active', ...entry };
    const dated = (key) => typeof next[key] === 'string' && !Number.isNaN(Date.parse(next[key]));
    if ((next.status === 'replaced' && !dated('replacedAt')) || (next.status === 'compromised' && !dated('compromisedAt'))) throw new Error('Named key pins have an unsupported format.');
    if (typeof next.name !== 'string' || !next.name || next.name.length > 80 || !(next.publicKey === '' || HEX64.test(next.publicKey)) || !HEX64.test(next.fingerprint)
      || !STATUSES.has(next.status) || !Object.hasOwn(SOURCES, next.source) || typeof next.addedAt !== 'string') throw new Error('Named key pins have an unsupported format.');
    return clean(next);
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

// Shared by pinTrustedKey and addTrustedCompany: same name and fingerprint keeps the entry; a different
// fingerprint needs confirmation and then keeps the old one as history.
function upsert(entries, { name, publicKey, fingerprint, source, now, confirm, message }) {
  const existing = entries.find((entry) => entry.status === 'active' && sameName(entry.name, name));
  if (existing && existing.fingerprint === fingerprint) {
    if (!existing.publicKey && publicKey) existing.publicKey = publicKey;
    return { entries, entry: existing };
  }
  if (existing && !confirm) throw Object.assign(new Error(message(existing)), { code: 'replace-needs-confirm', previous: formatFingerprint(existing.fingerprint) });
  if (existing) { existing.status = 'replaced'; existing.replacedAt = now; }
  const entry = { name, publicKey, fingerprint, source, addedAt: now, status: 'active' };
  return { entries: [...entries, entry], entry };
}

export function listTrustedKeys({ storage = globalThis.localStorage } = {}) { return read(storage).filter((entry) => entry.status === 'active'); }
export function listTrustedHistory({ storage = globalThis.localStorage } = {}) { return read(storage); }

export async function pinTrustedKey(nameInput, publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto, confirmRotation = false, source = 'not-recorded', now = new Date().toISOString() } = {}) {
  const name = String(nameInput || '').trim();
  if (!name || name.length > 80) throw new Error('Enter a key profile name up to 80 characters.');
  if (!Object.hasOwn(SOURCES, source)) throw new Error('Choose where you got this key.');
  const value = String(publicKey || '').trim().toLowerCase();
  const fingerprint = await fingerprintHex(value, cryptoObject);
  const { entries, entry } = upsert(read(storage), { name, publicKey: value, fingerprint, source, now, confirm: confirmRotation,
    message: (old) => `Key changed for “${old.name}” (old fingerprint ${formatFingerprint(old.fingerprint)}). Confirm rotation after verifying the new key independently.` });
  write(storage, entries);
  return clean(entry);
}

export function addTrustedCompany(nameInput, fingerprintInput, { source, confirmReplace = false, now = new Date().toISOString(), storage = globalThis.localStorage } = {}) {
  const name = checkName(nameInput);
  const fingerprint = normalizeFingerprint(fingerprintInput);
  if (!source || source === 'not-recorded' || !Object.hasOwn(SOURCES, source)) throw new Error('Choose where you got this fingerprint.');
  const { entries, entry } = upsert(read(storage), { name, publicKey: '', fingerprint, source, now, confirm: confirmReplace,
    message: (old) => `“${old.name}” already has the key ${formatFingerprint(old.fingerprint)}. Replace it only if the company told you about a new key through a channel you already know.` });
  write(storage, entries);
  return clean(entry);
}

export function markCompromised(name, fingerprintInput, { now = new Date().toISOString(), storage = globalThis.localStorage } = {}) {
  const fingerprint = normalizeFingerprint(fingerprintInput);
  const entries = read(storage);
  const entry = entries.find((item) => item.name === name && item.fingerprint === fingerprint && item.status !== 'compromised');
  if (!entry) throw new Error('No saved company has that name and key.');
  entry.status = 'compromised'; entry.compromisedAt = now;
  write(storage, entries);
  return clean(entry);
}

/** trusted (active pin) / replaced / compromised / untrusted. Compromised wins if the key is saved more than once. */
export async function trustForKey(publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto } = {}) {
  let fingerprint;
  try { fingerprint = await fingerprintHex(publicKey, cryptoObject); } catch { return { status: 'untrusted', fingerprint: '' }; }
  const matches = read(storage).filter((entry) => entry.fingerprint === fingerprint);
  for (const [status, result] of [['compromised', 'compromised'], ['active', 'trusted'], ['replaced', 'replaced']]) {
    const entry = matches.findLast((item) => item.status === status);
    if (entry) return { status: result, entry, fingerprint };
  }
  return { status: 'untrusted', fingerprint };
}

export async function matchingTrustedKey(publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto } = {}) {
  const fingerprint = await fingerprintHex(publicKey, cryptoObject);
  return listTrustedKeys({ storage }).find((entry) => entry.fingerprint === fingerprint && entry.publicKey === String(publicKey).trim().toLowerCase()) || null;
}
export function removeTrustedKey(name, { storage = globalThis.localStorage } = {}) {
  const entries = read(storage);
  const updated = entries.filter((entry) => !sameName(entry.name, String(name)));
  write(storage, updated);
  return updated.length !== entries.length;
}

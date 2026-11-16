const STORAGE_KEY = 'flightseal_trusted_keys_v1';
const MAX_KEYS = 32;
export async function fingerprintHex(publicKey, cryptoObject = globalThis.crypto) {
  const value = String(publicKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('A public key must contain exactly 64 hexadecimal digits.');
  const rawKey = Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
  const digest = new Uint8Array(await cryptoObject.subtle.digest('SHA-256', rawKey));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function read(storage = globalThis.localStorage) {
  let entries;
  try { entries = JSON.parse(storage.getItem(STORAGE_KEY) || '[]'); } catch { throw new Error('Named key pins are unreadable. No existing pin was changed.'); }
  if (!Array.isArray(entries) || entries.length > MAX_KEYS || entries.some((entry) => !entry || typeof entry.name !== 'string' || entry.name.length > 80 || !/^[a-f0-9]{64}$/.test(entry.publicKey) || !/^[a-f0-9]{64}$/.test(entry.fingerprint))) throw new Error('Named key pins have an unsupported format.');
  return entries;
}
export function listTrustedKeys({ storage = globalThis.localStorage } = {}) { return read(storage).map(({ name, publicKey, fingerprint }) => ({ name, publicKey, fingerprint })); }
export async function pinTrustedKey(nameInput, publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto, confirmRotation = false } = {}) {
  const name = String(nameInput || '').trim();
  if (!name || name.length > 80) throw new Error('Enter a key profile name up to 80 characters.');
  const value = String(publicKey || '').trim().toLowerCase();
  const fingerprint = await fingerprintHex(value, cryptoObject);
  const entries = read(storage);
  const existing = entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (existing && existing.publicKey !== value && !confirmRotation) throw new Error(`Key changed for “${existing.name}” (old fingerprint ${existing.fingerprint}). Confirm rotation after verifying the new key independently.`);
  const next = { name, publicKey: value, fingerprint };
  const updated = existing ? entries.map((entry) => entry === existing ? next : entry) : [...entries, next];
  if (!existing && updated.length > MAX_KEYS) throw new Error(`A maximum of ${MAX_KEYS} named public-key pins is supported.`);
  storage.setItem(STORAGE_KEY, JSON.stringify(updated));
  if (storage.getItem(STORAGE_KEY) !== JSON.stringify(updated)) throw new Error('Public-key pin could not be verified after storage.');
  return next;
}
export async function matchingTrustedKey(publicKey, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto } = {}) {
  const fingerprint = await fingerprintHex(publicKey, cryptoObject);
  return listTrustedKeys({ storage }).find((entry) => entry.fingerprint === fingerprint && entry.publicKey === String(publicKey).trim().toLowerCase()) || null;
}
export function removeTrustedKey(name, { storage = globalThis.localStorage } = {}) {
  const entries = read(storage);
  const updated = entries.filter((entry) => entry.name !== name);
  storage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated.length !== entries.length;
}

import {
  APP_ID, PBKDF2_HASH, PBKDF2_ITERATIONS, PROFILE_SCHEMA, WORKSPACE_SCHEMA,
  MAX_PROFILE_REGISTRY_BYTES, MAX_SAVED_CONTEXT_BYTES, localAuthStorageKeys,
  listLocalProfiles,
} from './local-auth.mjs';

export const BACKUP_FORMAT = 'flightseal-encrypted-profile-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_MAX_BYTES = 256 * 1024;
const MIN_PASSPHRASE = 12;
const MAX_PASSPHRASE = 128;

const utf8 = new TextEncoder();
function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value, expectedLength) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Encrypted backup has invalid binary data.');
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length !== expectedLength) throw new Error('Encrypted backup has invalid cryptographic field sizes.');
  return bytes;
}
function checkPassphrase(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSPHRASE || value.length > MAX_PASSPHRASE) throw new Error(`Use a backup passphrase between ${MIN_PASSPHRASE} and ${MAX_PASSPHRASE} characters.`);
}
async function derive(passphrase, salt, cryptoObject) {
  const material = await cryptoObject.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return cryptoObject.subtle.deriveKey({ name: 'PBKDF2', hash: PBKDF2_HASH, salt, iterations: PBKDF2_ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function readPayload(storage, profileId) {
  const registryRaw = storage.getItem(localAuthStorageKeys.profile);
  if (!registryRaw || utf8.encode(registryRaw).length > MAX_PROFILE_REGISTRY_BYTES) throw new Error('Local profile registry is missing or exceeds its safe size limit.');
  let registry;
  try { registry = JSON.parse(registryRaw); } catch { throw new Error('Local profile registry is unreadable; backup was not created.'); }
  if (registry?.app !== APP_ID || registry?.schema !== PROFILE_SCHEMA || !Array.isArray(registry.profiles)) throw new Error('Local profile registry has an unsupported format.');
  const profile = registry.profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error('The active local profile could not be found.');
  const workspaceKey = `flightseal_user_${profileId}_workspace_v1`;
  const workspaceRaw = storage.getItem(workspaceKey);
  let workspace = null;
  if (workspaceRaw != null) {
    if (utf8.encode(workspaceRaw).length > MAX_SAVED_CONTEXT_BYTES) throw new Error('Saved workspace view exceeds its safe size limit.');
    try { workspace = JSON.parse(workspaceRaw); } catch { throw new Error('Saved workspace view is unreadable; backup was not created.'); }
    if (workspace?.app !== APP_ID || workspace?.schema !== WORKSPACE_SCHEMA || workspace?.userId !== profileId || typeof workspace.screen !== 'string' || typeof workspace.sample !== 'string' || !Number.isSafeInteger(workspace.record)) throw new Error('Saved workspace view has an unsupported format.');
  }
  return { app: APP_ID, schema: BACKUP_VERSION, profile, workspace };
}
function validatePayload(payload) {
  const profile = payload?.profile;
  if (payload?.app !== APP_ID || payload?.schema !== BACKUP_VERSION || !profile ||
      typeof profile.id !== 'string' || !/^[a-f0-9]{32}$/.test(profile.id) ||
      typeof profile.email !== 'string' || profile.email.length > 254 || profile.email !== profile.email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) ||
      profile.algorithm !== 'PBKDF2' || profile.hash !== PBKDF2_HASH || profile.version !== 1 || profile.iterations !== PBKDF2_ITERATIONS ||
      fromBase64(profile.salt, 16).length !== 16 || fromBase64(profile.verifier, 32).length !== 32) {
    throw new Error('Decrypted backup has invalid profile data or an unsupported schema.');
  }
  if (payload.workspace != null) {
    const workspace = payload.workspace;
    if (workspace.app !== APP_ID || workspace.schema !== WORKSPACE_SCHEMA || workspace.userId !== profile.id ||
        !['sandbox', 'verify', 'records', 'receipts', 'video', 'help'].includes(workspace.screen) ||
        !['intact', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full'].includes(workspace.sample) ||
        !Number.isSafeInteger(workspace.record) || workspace.record < 0) throw new Error('Decrypted backup has an invalid saved view.');
  }
  return payload;
}

export async function createEncryptedProfileBackup(profileId, { storage = globalThis.localStorage, passphrase, cryptoObject = globalThis.crypto } = {}) {
  checkPassphrase(passphrase);
  if (!cryptoObject?.subtle || !cryptoObject?.getRandomValues) throw new Error('Web Crypto is unavailable; encrypted backup cannot be created.');
  const payload = readPayload(storage, profileId);
  const salt = cryptoObject.getRandomValues(new Uint8Array(16));
  const iv = cryptoObject.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt, cryptoObject);
  const aad = utf8.encode(`${BACKUP_FORMAT}:${BACKUP_VERSION}`);
  const ciphertext = new Uint8Array(await cryptoObject.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, utf8.encode(JSON.stringify(payload))));
  const envelope = { format: BACKUP_FORMAT, version: BACKUP_VERSION, kdf: { name: 'PBKDF2', hash: PBKDF2_HASH, iterations: PBKDF2_ITERATIONS, salt: base64(salt) }, cipher: { name: 'AES-GCM', bits: 256, iv: base64(iv), tagBits: 128 }, ciphertext: base64(ciphertext) };
  const output = JSON.stringify(envelope);
  if (utf8.encode(output).length > BACKUP_MAX_BYTES) throw new Error('Encrypted backup exceeds its safe size limit.');
  return new Blob([output], { type: 'application/vnd.flightseal.profile-backup+json' });
}

export async function inspectEncryptedProfileBackup(file, passphrase, { cryptoObject = globalThis.crypto } = {}) {
  checkPassphrase(passphrase);
  if (!(file instanceof Blob) || file.size > BACKUP_MAX_BYTES) throw new Error(`Choose an encrypted FlightSeal backup up to ${BACKUP_MAX_BYTES.toLocaleString()} bytes.`);
  if (!cryptoObject?.subtle) throw new Error('Web Crypto is unavailable; encrypted backup cannot be opened.');
  let envelope;
  try { envelope = JSON.parse(await file.text()); } catch { throw new Error('Backup envelope is not valid JSON.'); }
  if (envelope?.format !== BACKUP_FORMAT || envelope?.version !== BACKUP_VERSION || envelope?.kdf?.name !== 'PBKDF2' || envelope?.kdf?.hash !== PBKDF2_HASH || envelope?.kdf?.iterations !== PBKDF2_ITERATIONS || envelope?.cipher?.name !== 'AES-GCM' || envelope?.cipher?.bits !== 256 || envelope?.cipher?.tagBits !== 128) throw new Error('Backup app, version, KDF or cipher is unsupported.');
  const salt = fromBase64(envelope.kdf.salt, 16);
  const iv = fromBase64(envelope.cipher.iv, 12);
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > BACKUP_MAX_BYTES * 1.5) throw new Error('Encrypted backup payload exceeds its safe size limit.');
  const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (char) => char.charCodeAt(0));
  if (ciphertext.length < 16 || ciphertext.length > BACKUP_MAX_BYTES) throw new Error('Encrypted backup payload has an invalid size.');
  const key = await derive(passphrase, salt, cryptoObject);
  let clear;
  try { clear = await cryptoObject.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(`${BACKUP_FORMAT}:${BACKUP_VERSION}`), tagLength: 128 }, key, ciphertext); }
  catch { throw new Error('Backup authentication failed. Check the passphrase or file integrity.'); }
  if (clear.byteLength > MAX_PROFILE_REGISTRY_BYTES + MAX_SAVED_CONTEXT_BYTES) throw new Error('Decrypted backup exceeds its safe size limit.');
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)); } catch { throw new Error('Decrypted backup content is unreadable.'); }
  return validatePayload(payload);
}

export function previewBackupRestore(payload, storage = globalThis.localStorage) {
  validatePayload(payload);
  const raw = storage.getItem(localAuthStorageKeys.profile);
  let registry = { app: APP_ID, schema: PROFILE_SCHEMA, profiles: [] };
  if (raw != null) {
    if (utf8.encode(raw).length > MAX_PROFILE_REGISTRY_BYTES) throw new Error('Current profile registry exceeds its safe size limit.');
    try { registry = JSON.parse(raw); } catch { throw new Error('Current profile registry is unreadable; restore preview stopped without changes.'); }
    if (registry?.app !== APP_ID || registry?.schema !== PROFILE_SCHEMA || !Array.isArray(registry.profiles) || registry.profiles.length > 24) throw new Error('Current profile registry has an unsupported format.');
    listLocalProfiles({ storage }); // validates all existing cryptographic and identity fields before merge
  }
  const sameId = registry.profiles.some((entry) => entry.id === payload.profile.id);
  const sameEmail = registry.profiles.some((entry) => entry.email === payload.profile.email);
  if (sameId || sameEmail) throw new Error('A profile with this ID or email already exists on this device. Choose merge only after signing in to that profile.');
  if (registry.profiles.length >= 24) throw new Error('This device has reached its local profile limit. Remove a profile before restoring.');
  return { email: payload.profile.email, hasSavedView: !!payload.workspace, action: 'add-profile', mergeTarget: null };
}

export async function commitBackupRestore(payload, storage = globalThis.localStorage) {
  const locks = globalThis.navigator?.locks;
  if (globalThis.window && !locks?.request) throw new Error('This browser cannot coordinate a profile restore safely. Use a current browser with Web Locks enabled.');
  const commit = () => {
    const preview = previewBackupRestore(payload, storage);
    const rawRegistry = storage.getItem(localAuthStorageKeys.profile);
    const registry = rawRegistry == null ? { app: APP_ID, schema: PROFILE_SCHEMA, profiles: [] } : JSON.parse(rawRegistry);
    const profileKey = localAuthStorageKeys.profile;
    const workspaceKey = `flightseal_user_${payload.profile.id}_workspace_v1`;
    const before = new Map([[profileKey, rawRegistry], [workspaceKey, storage.getItem(workspaceKey)]]);
    const nextRegistry = JSON.stringify({ ...registry, profiles: [...registry.profiles, payload.profile] });
    if (utf8.encode(nextRegistry).length > MAX_PROFILE_REGISTRY_BYTES) throw new Error('Restored profiles would exceed the safe registry size. Nothing was changed.');
    try {
      storage.setItem(profileKey, nextRegistry);
      if (payload.workspace) storage.setItem(workspaceKey, JSON.stringify(payload.workspace));
      if (storage.getItem(profileKey) !== nextRegistry || (payload.workspace && storage.getItem(workspaceKey) !== JSON.stringify(payload.workspace))) throw new Error('Storage read-back did not match.');
    } catch (cause) {
      for (const [key, oldValue] of before) {
        try { if (oldValue == null) storage.removeItem(key); else storage.setItem(key, oldValue); } catch { /* best-effort rollback; expose failure below */ }
      }
      throw new Error(`Backup restore could not be committed. Existing browser data was left unchanged where storage allowed rollback (${cause?.message || 'storage failure'}).`);
    }
    return preview;
  };
  return globalThis.window ? locks.request(`${APP_ID}:profile-registry`, { mode: 'exclusive' }, commit) : commit();
}

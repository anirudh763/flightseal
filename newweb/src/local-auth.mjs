export const APP_ID = 'flightseal';
export const PROFILE_SCHEMA = 1;
export const SESSION_SCHEMA = 1;
export const PBKDF2_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_HASH = 'SHA-256';
export const PROFILE_LIMIT = 24;
export const MAX_PROFILE_REGISTRY_BYTES = 32_768;
export const WORKSPACE_SCHEMA = 1;
export const MAX_SAVED_CONTEXT_BYTES = 2048;

const PROFILE_KEY = 'flightseal_profiles_v1';
const SESSION_KEY = 'flightseal_session_v1';
const LOGOUT_SIGNAL_KEY = 'flightseal_logout_v1';
// When each profile last logged out ({userId: ms}, newest 50): a tab that missed the message (frozen, discarded,
// restored with its old sessionStorage) drops a session started before it.
const LOGOUTS_KEY = 'flightseal_logouts_v1';
const MAX_LOGOUT_MARKS = 50;
const LEGACY_PROFILE_KEY = 'hashwing:local-profiles:v1';
const LEGACY_SESSION_KEY = 'hashwing:active-session:v1';
const LEGACY_LOGOUT_SIGNAL_KEY = 'hashwing:logout-signal:v1';
const channelNames = ['flightseal_auth_v1', 'hashwing:local-auth:v1'];
export const allowedScreens = new Set(['protect', 'sandbox', 'verify', 'records', 'receipts', 'video', 'help']);
export const MAX_SAVED_RECORD = 64_541; // last record of the bundled full PX4 sample
export const allowedSamples = new Set(['intact', 'byte-flip', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full']);

function storageOrThrow(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new Error('Browser storage is unavailable. Local profiles need storage on this device.');
  }
  return storage;
}

function withWriteLock(name, action) {
  const locks = globalThis.navigator?.locks;
  if (!globalThis.window) return Promise.resolve().then(action); // deterministic storage adapter for Node unit tests
  if (!locks?.request) throw new Error('This browser cannot coordinate local profile writes safely. Use a current browser with Web Locks enabled.');
  return locks.request(`${APP_ID}:${name}`, { mode: 'exclusive' }, action);
}

export function ensureCurrent(isCurrent) {
  if (typeof isCurrent === 'function' && !isCurrent()) throw new Error('This operation was canceled because the local session changed. Nothing was saved.');
}

function encode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(text) {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomId(cryptoObject) {
  if (!cryptoObject?.getRandomValues) throw new Error('Secure random generation is unavailable in this browser.');
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address.');
  return value;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('Use a password between 12 and 128 characters.');
  }
}

function decodeRegistry(raw, legacy = false) {
  if (!raw) return { app: APP_ID, schema: PROFILE_SCHEMA, profiles: [] };
  if (new TextEncoder().encode(raw).length > MAX_PROFILE_REGISTRY_BYTES) throw new Error('Saved local profile data exceeds the safe size limit.');
  let registry;
  try { registry = JSON.parse(raw); }
  catch { throw new Error('Saved local profiles are unreadable. Remove the damaged profile data before continuing.'); }
  if (registry?.app !== (legacy ? 'hashwing' : APP_ID) || registry?.schema !== PROFILE_SCHEMA || !Array.isArray(registry.profiles) || registry.profiles.length > PROFILE_LIMIT) {
    throw new Error('Saved local profiles use an unsupported format.');
  }
  const ids = new Set();
  const emails = new Set();
  for (const profile of registry.profiles) {
    if (!profile || typeof profile.id !== 'string' || !/^[a-f0-9]{32}$/.test(profile.id) || typeof profile.email !== 'string' ||
        profile.algorithm !== 'PBKDF2' || profile.hash !== PBKDF2_HASH || profile.version !== PBKDF2_VERSION ||
        profile.iterations !== PBKDF2_ITERATIONS || typeof profile.salt !== 'string' || typeof profile.verifier !== 'string') {
      throw new Error('Saved local profile metadata is invalid.');
    }
    const normalized = normalizeEmail(profile.email);
    if (normalized !== profile.email || ids.has(profile.id) || emails.has(profile.email)) throw new Error('Saved local profile identities are invalid or duplicated.');
    ids.add(profile.id); emails.add(profile.email);
    try {
      if (decode(profile.salt).length !== 16 || decode(profile.verifier).length !== 32) throw new Error('invalid size');
    } catch { throw new Error('Saved local profile cryptographic values are invalid.'); }
  }
  return { app: APP_ID, schema: PROFILE_SCHEMA, profiles: registry.profiles };
}

function readRegistry(storage) {
  const store = storageOrThrow(storage);
  const current = store.getItem(PROFILE_KEY);
  const legacy = store.getItem(LEGACY_PROFILE_KEY);
  if (current && legacy) {
    const newRegistry = decodeRegistry(current);
    const oldRegistry = decodeRegistry(legacy, true);
    if (JSON.stringify(newRegistry.profiles) !== JSON.stringify(oldRegistry.profiles)) {
      throw new Error('Current and legacy HashWing profile lists both contain data. Nothing was overwritten; use the local profile recovery instructions before continuing.');
    }
    return newRegistry;
  }
  return current ? decodeRegistry(current) : legacy ? decodeRegistry(legacy, true) : { app: APP_ID, schema: PROFILE_SCHEMA, profiles: [] };
}

function migrateRegistryUnderLock(storage) {
  const store = storageOrThrow(storage);
  const current = store.getItem(PROFILE_KEY);
  const legacy = store.getItem(LEGACY_PROFILE_KEY);
  const registry = readRegistry(store);
  if (!current && legacy) {
    try {
      const encoded = JSON.stringify(registry);
      store.setItem(PROFILE_KEY, encoded);
      if (store.getItem(PROFILE_KEY) !== encoded) throw new Error('verification failed');
      store.removeItem(LEGACY_PROFILE_KEY);
    } catch { throw new Error('The local profile migration could not be verified. The original profile data remains available.'); }
  } else if (current && legacy) {
    try { store.removeItem(LEGACY_PROFILE_KEY); }
    catch { /* The verified current copy remains usable; legacy data is retained for recovery. */ }
  }
  return registry;
}

function workspaceKey(userId) { return `flightseal_user_${userId}_workspace_v1`; }
function legacyWorkspaceKey(userId) { return `hashwing:workspace:v1:${userId}`; }

function migrateWorkspaceUnderLock(store, userId) {
  const key = workspaceKey(userId);
  const legacyKey = legacyWorkspaceKey(userId);
  const current = store.getItem(key);
  const legacy = store.getItem(legacyKey);
  if (current && legacy && current !== legacy) throw new Error('Current and legacy saved views both contain data. Nothing was overwritten; review the local recovery instructions.');
  if (!current && legacy) {
    try {
      const value = JSON.parse(legacy);
      if (value?.app !== 'hashwing' || value?.schema !== WORKSPACE_SCHEMA || value?.userId !== userId) throw new Error('unsupported legacy view');
      const encoded = JSON.stringify({ ...value, app: APP_ID });
      if (new TextEncoder().encode(encoded).length > MAX_SAVED_CONTEXT_BYTES) throw new Error('legacy view exceeds the safe size limit');
      store.setItem(key, encoded);
      if (store.getItem(key) !== encoded) throw new Error('migration verification failed');
      store.removeItem(legacyKey);
    } catch (cause) {
      throw new Error(`The legacy saved view could not be migrated safely (${cause?.message || 'invalid data'}). The original local data remains available.`);
    }
  } else if (current && legacy) {
    try { store.removeItem(legacyKey); } catch { /* Keep both verified copies for recovery. */ }
  }
}

async function derive(password, salt, cryptoObject) {
  if (!cryptoObject?.subtle) throw new Error('Secure browser cryptography is unavailable. Local profiles cannot be created or checked here.');
  const material = await cryptoObject.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await cryptoObject.subtle.deriveBits({ name: 'PBKDF2', hash: PBKDF2_HASH, salt, iterations: PBKDF2_ITERATIONS }, material, 256));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export async function createLocalProfile(emailInput, password, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto, isCurrent } = {}) {
  const email = normalizeEmail(emailInput);
  validatePassword(password);
  const store = storageOrThrow(storage);
  const salt = new Uint8Array(16);
  if (!cryptoObject?.getRandomValues) throw new Error('Secure random generation is unavailable in this browser.');
  cryptoObject.getRandomValues(salt);
  const verifier = await derive(password, salt, cryptoObject);
  ensureCurrent(isCurrent);
  const profile = {
    id: randomId(cryptoObject), email, algorithm: 'PBKDF2', hash: PBKDF2_HASH,
    iterations: PBKDF2_ITERATIONS, version: PBKDF2_VERSION, salt: encode(salt), verifier: encode(verifier),
  };
  return withWriteLock('profile-registry', () => {
    ensureCurrent(isCurrent);
    const registry = migrateRegistryUnderLock(store);
    if (registry.profiles.some((entry) => entry.email === email)) throw new Error('A local profile already uses this email on this device.');
    if (registry.profiles.length >= PROFILE_LIMIT) throw new Error(`This device has reached the ${PROFILE_LIMIT}-profile limit. Remove a local profile from the profile menu to make room.`);
    registry.profiles.push(profile);
    try { store.setItem(PROFILE_KEY, JSON.stringify(registry)); }
    catch { throw new Error('This device could not save the local profile. Check available browser storage and try again.'); }
    return { id: profile.id, email: profile.email };
  });
}

export async function authenticateLocalProfile(emailInput, password, { storage = globalThis.localStorage, cryptoObject = globalThis.crypto, isCurrent } = {}) {
  const email = normalizeEmail(emailInput);
  if (typeof password !== 'string' || password.length > 128) throw new Error('Email or password does not match a local profile on this device.');
  const store = storageOrThrow(storage);
  const registry = readRegistry(store);
  const profile = registry.profiles.find((candidate) => candidate.email === email);
  if (!profile) throw new Error('Email or password does not match a local profile on this device.');
  let actual;
  try { actual = await derive(password, decode(profile.salt), cryptoObject); }
  catch (cause) { if (/cryptography|storage|random/i.test(cause?.message || '')) throw cause; throw new Error('Email or password does not match a local profile on this device.'); }
  if (!constantTimeEqual(actual, decode(profile.verifier))) throw new Error('Email or password does not match a local profile on this device.');
  ensureCurrent(isCurrent);
  return withWriteLock('profile-registry', () => {
    ensureCurrent(isCurrent);
    const latest = migrateRegistryUnderLock(store);
    const current = latest.profiles.find((candidate) => candidate.id === profile.id && candidate.email === email);
    if (!current || current.salt !== profile.salt || current.verifier !== profile.verifier) throw new Error('Email or password does not match a local profile on this device.');
    return { id: current.id, email: current.email };
  });
}

export function listLocalProfiles({ storage = globalThis.localStorage } = {}) {
  return readRegistry(storageOrThrow(storage)).profiles.map(({ id, email }) => ({ id, email }));
}

export function setLocalSession(session, { storage = globalThis.sessionStorage, cryptoObject = globalThis.crypto } = {}) {
  const value = session?.kind === 'account'
    ? { app: APP_ID, schema: SESSION_SCHEMA, kind: 'account', userId: session.userId, at: Date.now() }
    : { app: APP_ID, schema: SESSION_SCHEMA, kind: 'guest', userId: randomId(cryptoObject) };
  if (value.kind === 'account' && !/^[a-f0-9]{32}$/.test(value.userId || '')) throw new Error('The local profile ID is invalid.');
  try {
    const store = storageOrThrow(storage);
    store.setItem(SESSION_KEY, JSON.stringify(value));
    store.removeItem(LEGACY_SESSION_KEY);
  }
  catch { throw new Error('This tab could not save its local session. Check browser storage and try again.'); }
  const { at, ...shown } = value;
  return shown;
}

function readLogoutMarks(storage) {
  try {
    const value = JSON.parse(storage?.getItem(LOGOUTS_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function recordLogoutMark(userId, storage) {
  try {
    const marks = Object.entries({ ...readLogoutMarks(storage), [userId]: Date.now() })
      .filter(([, t]) => Number.isFinite(t)).sort((a, b) => b[1] - a[1]).slice(0, MAX_LOGOUT_MARKS);
    storage?.setItem(LOGOUTS_KEY, JSON.stringify(Object.fromEntries(marks)));
  } catch { /* the BroadcastChannel and storage event still reach open tabs */ }
}

// An account session started before its profile's last logout (in any tab).
function isRevoked(value, profileStorage) {
  if (value?.kind !== 'account') return false;
  const mark = readLogoutMarks(profileStorage)[value.userId];
  return Number.isFinite(mark) && !(Number(value.at) > mark);
}

function readStoredSession(storage) {
  try { return JSON.parse(storage?.getItem(SESSION_KEY) || storage?.getItem(LEGACY_SESSION_KEY) || 'null'); } catch { return null; }
}

// true (after clearing it) when this tab's saved account session predates its profile's last logout elsewhere.
export function dropRevokedLocalSession(options = {}) {
  try { // the storage getters throw when site storage is blocked: then there is no saved session to drop
    const { storage = globalThis.sessionStorage, profileStorage = globalThis.localStorage } = options;
    if (!isRevoked(readStoredSession(storage), profileStorage)) return false;
    clearLocalSession({ storage });
    return true;
  } catch { return false; }
}

export function getLocalSession({ storage = globalThis.sessionStorage, profileStorage = globalThis.localStorage } = {}) {
  try {
    const raw = storage?.getItem(SESSION_KEY) || storage?.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    if (new TextEncoder().encode(raw).length > 512) return null;
    const value = JSON.parse(raw);
    if (!['flightseal', 'hashwing'].includes(value?.app) || value?.schema !== SESSION_SCHEMA || !['account', 'guest'].includes(value.kind) || !/^[a-f0-9]{32}$/.test(value.userId || '')) return null;
    if (value.kind === 'account' && !listLocalProfiles({ storage: profileStorage }).some((profile) => profile.id === value.userId)) return null;
    if (isRevoked(value, profileStorage)) return null;
    const { at, ...shown } = value;
    return { ...shown, app: APP_ID };
  } catch { return null; }
}

export function clearLocalSession({ storage = globalThis.sessionStorage } = {}) {
  try { storage?.removeItem(SESSION_KEY); storage?.removeItem(LEGACY_SESSION_KEY); } catch { /* memory and active work are cleared by the caller */ }
}

export function saveWorkspaceContext(userId, context, { storage = globalThis.localStorage, isCurrent } = {}) {
  if (!/^[a-f0-9]{32}$/.test(userId || '')) throw new Error('A local profile is required to save this view.');
  if (!context || !allowedScreens.has(context.screen)) throw new Error('Choose a supported workspace view before saving.');
  const clean = {
    app: APP_ID, schema: WORKSPACE_SCHEMA, userId,
    screen: context.screen,
    sample: allowedSamples.has(context.sample) ? context.sample : null,
    record: Number.isSafeInteger(context.record) && context.record >= 0 && context.record <= MAX_SAVED_RECORD ? context.record : 0,
  };
  const encoded = JSON.stringify(clean);
  if (new TextEncoder().encode(encoded).length > MAX_SAVED_CONTEXT_BYTES) throw new Error('Saved workspace context exceeds the local size limit.');
  const store = storageOrThrow(storage);
  return withWriteLock(`workspace:${userId}`, () => {
    ensureCurrent(isCurrent);
    try {
      migrateWorkspaceUnderLock(store, userId);
      store.setItem(workspaceKey(userId), encoded);
      store.removeItem(legacyWorkspaceKey(userId));
    }
    catch (cause) { throw new Error(`This device could not save the workspace context. ${cause?.message || 'Check available browser storage and try again.'}`); }
    return clean;
  });
}

export function readWorkspaceContext(userId, { storage = globalThis.localStorage } = {}) {
  if (!/^[a-f0-9]{32}$/.test(userId || '')) return null;
  const store = storageOrThrow(storage);
  const raw = store.getItem(workspaceKey(userId)) || store.getItem(legacyWorkspaceKey(userId));
  if (!raw) return null;
  if (new TextEncoder().encode(raw).length > MAX_SAVED_CONTEXT_BYTES) throw new Error('Saved view exceeds the safe size limit. Remove it and save a supported view.');
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Saved view data is unreadable. Remove the damaged saved view before saving another.'); }
  if (!['flightseal', 'hashwing'].includes(value?.app) || value?.schema !== WORKSPACE_SCHEMA || value?.userId !== userId || !allowedScreens.has(value.screen)) {
    throw new Error('Saved view uses an unsupported format. Remove the old view and save it again from this version.');
  }
  if (value.sample !== null && !allowedSamples.has(value.sample)) throw new Error('Saved view contains an unsupported sample reference. Remove it before saving another view.');
  if (!Number.isSafeInteger(value.record) || value.record < 0 || value.record > MAX_SAVED_RECORD) throw new Error('Saved view contains an invalid record selection. Remove it before saving another view.');
  return { screen: value.screen, sample: value.sample, record: value.record };
}

export function removeWorkspaceContext(userId, { storage = globalThis.localStorage, isCurrent } = {}) {
  if (!/^[a-f0-9]{32}$/.test(userId || '')) return;
  const store = storage;
  return withWriteLock(`workspace:${userId}`, () => {
    ensureCurrent(isCurrent);
    try { store?.removeItem(workspaceKey(userId)); store?.removeItem(legacyWorkspaceKey(userId)); }
    catch { throw new Error('The saved view could not be removed from this device.'); }
  });
}

export function removeLocalProfile(userId, { storage = globalThis.localStorage, isCurrent } = {}) {
  if (!/^[a-f0-9]{32}$/.test(userId || '')) throw new Error('Choose a valid local profile to remove.');
  const store = storageOrThrow(storage);
  return withWriteLock('profile-registry', () => {
    ensureCurrent(isCurrent);
    const registry = migrateRegistryUnderLock(store);
    const next = registry.profiles.filter((profile) => profile.id !== userId);
    if (next.length === registry.profiles.length) throw new Error('This local profile is no longer on this device.');
    try {
      store.setItem(PROFILE_KEY, JSON.stringify({ ...registry, profiles: next }));
      store.removeItem(workspaceKey(userId));
      store.removeItem(legacyWorkspaceKey(userId));
    } catch { throw new Error('The local profile could not be removed completely. Check browser storage and try again.'); }
    return true;
  });
}

export function announceLocalLogout({ userId = null, storage = globalThis.localStorage, sessionStorage = globalThis.sessionStorage, windowObject = globalThis, cryptoObject = globalThis.crypto } = {}) {
  clearLocalSession({ storage: sessionStorage });
  if (typeof userId === 'string' && /^[a-f0-9]{32}$/.test(userId)) recordLogoutMark(userId, storage);
  const nonce = cryptoObject?.getRandomValues ? randomId(cryptoObject) : String(Date.now());
  const message = { type: 'logout', app: APP_ID, schema: SESSION_SCHEMA, userId: typeof userId === 'string' ? userId : null, nonce };
  const legacyMessage = { ...message, app: 'hashwing' };
  try { storage?.setItem(LOGOUT_SIGNAL_KEY, JSON.stringify(message)); storage?.setItem(LEGACY_LOGOUT_SIGNAL_KEY, JSON.stringify(legacyMessage)); }
  catch { /* BroadcastChannel remains available when storage is blocked */ }
  for (const [channelName, channelMessage] of channelNames.map((name) => [name, name.includes('hashwing:') ? legacyMessage : message])) try {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(channelMessage);
    channel.close();
  } catch { /* browser has no BroadcastChannel */ }
  return nonce;
}

export function subscribeToLocalLogout(callback, { windowObject = globalThis, storage = globalThis.localStorage } = {}) {
  const onStorage = (event) => {
    if ([LOGOUT_SIGNAL_KEY, LEGACY_LOGOUT_SIGNAL_KEY].includes(event.key) && event.newValue) {
      try {
        const message = JSON.parse(event.newValue);
        if (message?.type === 'logout' && ['flightseal', 'hashwing'].includes(message?.app) && message?.schema === SESSION_SCHEMA) callback(message);
      } catch { /* Ignore malformed notification values. */ }
      return;
    }
    if (event.key === null) callback({ type: 'profile-storage-cleared', app: APP_ID, schema: SESSION_SCHEMA, scope: 'all' });
    else if ([PROFILE_KEY, LEGACY_PROFILE_KEY].includes(event.key)) {
      if (event.key === LEGACY_PROFILE_KEY && storage?.getItem(PROFILE_KEY)) return;
      const registryValue = event.newValue || storage?.getItem(event.key === PROFILE_KEY ? LEGACY_PROFILE_KEY : PROFILE_KEY);
      if (!registryValue) { callback({ type: 'profile-storage-cleared', app: APP_ID, schema: SESSION_SCHEMA, scope: 'all' }); return; }
      try {
        const value = JSON.parse(registryValue);
        if (['flightseal', 'hashwing'].includes(value?.app) && value?.schema === PROFILE_SCHEMA && Array.isArray(value.profiles)) {
          callback({ type: 'profile-registry-changed', app: APP_ID, schema: SESSION_SCHEMA, scope: 'profiles', profileIds: value.profiles.map((profile) => profile?.id).filter((id) => typeof id === 'string') });
        }
      } catch { callback({ type: 'profile-storage-cleared', app: APP_ID, schema: SESSION_SCHEMA, scope: 'all' }); }
    }
  };
  windowObject.addEventListener?.('storage', onStorage);
  const channels = channelNames.map((name) => {
    try {
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event) => {
        if (event.data?.type === 'logout' && ['flightseal', 'hashwing'].includes(event.data?.app) && event.data?.schema === SESSION_SCHEMA) callback(event.data);
      };
      return channel;
    } catch { return null; }
  }).filter(Boolean);
  return () => { windowObject.removeEventListener?.('storage', onStorage); channels.forEach((channel) => channel.close()); };
}

export const localAuthStorageKeys = Object.freeze({ profile: PROFILE_KEY, session: SESSION_KEY, logoutSignal: LOGOUT_SIGNAL_KEY, legacyProfile: LEGACY_PROFILE_KEY, legacySession: LEGACY_SESSION_KEY });

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  APP_ID, PBKDF2_ITERATIONS, authenticateLocalProfile, createLocalProfile, getLocalSession,
  listLocalProfiles, localAuthStorageKeys, readWorkspaceContext, removeLocalProfile,
  removeWorkspaceContext, saveWorkspaceContext, setLocalSession,
} from '../src/local-auth.mjs';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('local profiles use per-profile random salt and versioned PBKDF2-SHA-256 metadata', async () => {
  const storage = new MemoryStorage();
  const first = await createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto });
  const second = await createLocalProfile('reviewer@example.test', 'battery staple correct horse', { storage, cryptoObject: webcrypto });
  const registry = JSON.parse(storage.getItem(localAuthStorageKeys.profile));
  assert.equal(registry.app, APP_ID);
  assert.equal(registry.schema, 1);
  assert.equal(registry.profiles[0].iterations, PBKDF2_ITERATIONS);
  assert.equal(registry.profiles[0].algorithm, 'PBKDF2');
  assert.equal(registry.profiles[0].hash, 'SHA-256');
  assert.equal(registry.profiles[0].version, 1);
  assert.notEqual(registry.profiles[0].salt, registry.profiles[1].salt);
  assert.notEqual(first.id, second.id);
  assert.equal(JSON.stringify(registry).includes('correct horse battery staple'), false);
  assert.deepEqual(await authenticateLocalProfile('PILOT@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto }), first);
  await assert.rejects(authenticateLocalProfile('pilot@example.test', 'incorrect password', { storage, cryptoObject: webcrypto }), /does not match/);
  await assert.rejects(createLocalProfile('PILOT@example.test', 'another password 123', { storage, cryptoObject: webcrypto }), /already uses/);
});

test('profile storage failure is an explicit error and does not return an account', async () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  await assert.rejects(createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto }), /could not save/);
});

test('malformed, oversized and unsupported profile metadata fails closed', async () => {
  const storage = new MemoryStorage();
  storage.setItem(localAuthStorageKeys.profile, '{broken');
  assert.throws(() => listLocalProfiles({ storage }), /unreadable/);
  storage.setItem(localAuthStorageKeys.profile, ' '.repeat(33_000));
  assert.throws(() => listLocalProfiles({ storage }), /size limit/);
  storage.setItem(localAuthStorageKeys.profile, JSON.stringify({ app: APP_ID, schema: 1, profiles: [{
    id: 'a'.repeat(32), email: 'pilot@example.test', algorithm: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, version: 1, salt: 'AA==', verifier: 'AA==',
  }] }));
  assert.throws(() => listLocalProfiles({ storage }), /cryptographic values/);
});

test('stale profile and workspace writes stop before touching storage', async () => {
  const storage = new MemoryStorage();
  await assert.rejects(createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto, isCurrent: () => false }), /canceled/);
  assert.equal(storage.getItem(localAuthStorageKeys.profile), null);
  const profile = await createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto });
  await assert.rejects(saveWorkspaceContext(profile.id, { screen: 'records', sample: 'intact', record: 1 }, { storage, isCurrent: () => false }), /canceled/);
  assert.equal(readWorkspaceContext(profile.id, { storage }), null);
});

test('session and saved context are scoped to one stable profile ID and bounded safe fields', async () => {
  const storage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const first = await createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto });
  const second = await createLocalProfile('reviewer@example.test', 'battery staple correct horse', { storage, cryptoObject: webcrypto });
  setLocalSession({ kind: 'account', userId: first.id }, { storage: sessionStorage, cryptoObject: webcrypto });
  assert.deepEqual(getLocalSession({ storage: sessionStorage, profileStorage: storage }), { app: APP_ID, schema: 1, kind: 'account', userId: first.id });
  const saved = await saveWorkspaceContext(first.id, { screen: 'records', sample: 'px4', record: 123 }, { storage });
  assert.deepEqual(saved, { app: APP_ID, schema: 1, userId: first.id, screen: 'records', sample: 'px4', record: 123 });
  assert.deepEqual(readWorkspaceContext(first.id, { storage }), { screen: 'records', sample: 'px4', record: 123 });
  assert.equal(readWorkspaceContext(second.id, { storage }), null);
  await removeWorkspaceContext(first.id, { storage });
  assert.equal(readWorkspaceContext(first.id, { storage }), null);
});

test('corrupt or unsupported saved context is reported instead of treated as absent', async () => {
  const storage = new MemoryStorage();
  const profile = await createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto });
  const key = `flightseal_user_${profile.id}_workspace_v1`;
  storage.setItem(key, '{broken');
  assert.throws(() => readWorkspaceContext(profile.id, { storage }), /unreadable/);
  storage.setItem(key, JSON.stringify({ app: 'hashwing', schema: 7, userId: profile.id, screen: 'records', sample: 'intact', record: 1 }));
  assert.throws(() => readWorkspaceContext(profile.id, { storage }), /unsupported format/);
  storage.setItem(key, ' '.repeat(3_000));
  assert.throws(() => readWorkspaceContext(profile.id, { storage }), /size limit/);
});

test('guest session is distinct and contains no profile identity', () => {
  const sessionStorage = new MemoryStorage();
  const guest = setLocalSession({ kind: 'guest' }, { storage: sessionStorage, cryptoObject: webcrypto });
  assert.equal(guest.kind, 'guest');
  assert.equal(guest.userId.length, 32);
  assert.equal(JSON.parse(sessionStorage.getItem(localAuthStorageKeys.session)).kind, 'guest');
  assert.deepEqual(listLocalProfiles({ storage: new MemoryStorage() }), []);
});

test('known legacy HashWing profile and saved-view data migrates without touching unrelated origin keys', async () => {
  const storage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const profile = await createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto });
  const currentRegistry = JSON.parse(storage.getItem(localAuthStorageKeys.profile));
  storage.removeItem(localAuthStorageKeys.profile);
  storage.setItem('hashwing:local-profiles:v1', JSON.stringify({ ...currentRegistry, app: 'hashwing' }));
  storage.setItem('hashwing:workspace:v1:' + profile.id, JSON.stringify({ app: 'hashwing', schema: 1, userId: profile.id, screen: 'records', sample: 'intact', record: 24 }));
  storage.setItem('issue_warehouse_auth_v1', 'other app data');
  sessionStorage.setItem('hashwing:active-session:v1', JSON.stringify({ app: 'hashwing', schema: 1, kind: 'account', userId: profile.id }));

  assert.deepEqual(listLocalProfiles({ storage }), [{ id: profile.id, email: profile.email }]);
  assert.deepEqual(getLocalSession({ storage: sessionStorage, profileStorage: storage }), { app: APP_ID, schema: 1, kind: 'account', userId: profile.id });
  assert.deepEqual(await authenticateLocalProfile(profile.email, 'correct horse battery staple', { storage, cryptoObject: webcrypto }), profile);
  assert.equal(JSON.parse(storage.getItem(localAuthStorageKeys.profile)).app, APP_ID);
  assert.equal(storage.getItem('hashwing:local-profiles:v1'), null);
  assert.deepEqual(readWorkspaceContext(profile.id, { storage }), { screen: 'records', sample: 'intact', record: 24 });
  await saveWorkspaceContext(profile.id, { screen: 'records', sample: 'intact', record: 25 }, { storage });
  assert.equal(storage.getItem('hashwing:workspace:v1:' + profile.id), null);
  assert.equal(storage.getItem('issue_warehouse_auth_v1'), 'other app data');
});

test('conflicting current and legacy profile registries fail safely and profiles can be removed', async () => {
  const storage = new MemoryStorage();
  const current = await createLocalProfile('pilot@example.test', 'correct horse battery staple', { storage, cryptoObject: webcrypto });
  storage.setItem('hashwing:local-profiles:v1', JSON.stringify({ app: 'hashwing', schema: 1, profiles: [] }));
  assert.throws(() => listLocalProfiles({ storage }), /both contain data/);
  storage.removeItem('hashwing:local-profiles:v1');
  await saveWorkspaceContext(current.id, { screen: 'sandbox', sample: 'intact', record: 0 }, { storage });
  await removeLocalProfile(current.id, { storage });
  assert.deepEqual(listLocalProfiles({ storage }), []);
  assert.equal(readWorkspaceContext(current.id, { storage }), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createLocalProfile, localAuthStorageKeys, readWorkspaceContext, saveWorkspaceContext } from '../src/local-auth.mjs';
import { BACKUP_FORMAT, BACKUP_MAX_BYTES, commitBackupRestore, createEncryptedProfileBackup, inspectEncryptedProfileBackup, previewBackupRestore } from '../src/profile-backup.mjs';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('encrypted backup round trips a local profile and Unicode workspace into a fresh browser store', async () => {
  const source = new MemoryStorage();
  const profile = await createLocalProfile('pilot@example.test', 'local profile password 123', { storage: source, cryptoObject: webcrypto });
  await saveWorkspaceContext(profile.id, { screen: 'records', sample: 'intact', record: 42 }, { storage: source });
  const backup = await createEncryptedProfileBackup(profile.id, { storage: source, passphrase: 'backup passphrase 🛡️', cryptoObject: webcrypto });
  assert.ok(backup.size < BACKUP_MAX_BYTES);
  const envelope = JSON.parse(await backup.text());
  assert.equal(envelope.format, BACKUP_FORMAT);
  assert.equal(envelope.kdf.iterations, 600_000);
  assert.equal(envelope.cipher.name, 'AES-GCM');
  const fresh = new MemoryStorage();
  const payload = await inspectEncryptedProfileBackup(backup, 'backup passphrase 🛡️', { cryptoObject: webcrypto });
  assert.deepEqual(previewBackupRestore(payload, fresh), { email: profile.email, hasSavedView: true, action: 'add-profile', mergeTarget: null });
  await commitBackupRestore(payload, fresh);
  assert.equal(JSON.parse(fresh.getItem(localAuthStorageKeys.profile)).profiles[0].email, profile.email);
  assert.deepEqual(readWorkspaceContext(profile.id, { storage: fresh }), { screen: 'records', sample: 'intact', record: 42 });
});

test('wrong passphrase, tampering and unsupported envelope fail before destination changes', async () => {
  const source = new MemoryStorage();
  const profile = await createLocalProfile('pilot@example.test', 'local profile password 123', { storage: source, cryptoObject: webcrypto });
  const backup = await createEncryptedProfileBackup(profile.id, { storage: source, passphrase: 'separate backup password', cryptoObject: webcrypto });
  await assert.rejects(inspectEncryptedProfileBackup(backup, 'incorrect backup password', { cryptoObject: webcrypto }), /authentication failed/);
  const envelope = JSON.parse(await backup.text());
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
  await assert.rejects(inspectEncryptedProfileBackup(new Blob([JSON.stringify(envelope)]), 'separate backup password', { cryptoObject: webcrypto }), /authentication failed/);
  envelope.version = 999;
  await assert.rejects(inspectEncryptedProfileBackup(new Blob([JSON.stringify(envelope)]), 'separate backup password', { cryptoObject: webcrypto }), /unsupported/);
});

test('restore collision and quota failure preserve prior profile/workspace data', async () => {
  const source = new MemoryStorage();
  const profile = await createLocalProfile('pilot@example.test', 'local profile password 123', { storage: source, cryptoObject: webcrypto });
  await saveWorkspaceContext(profile.id, { screen: 'records', sample: 'intact', record: 4 }, { storage: source });
  const backup = await createEncryptedProfileBackup(profile.id, { storage: source, passphrase: 'separate backup password', cryptoObject: webcrypto });
  const payload = await inspectEncryptedProfileBackup(backup, 'separate backup password', { cryptoObject: webcrypto });
  assert.throws(() => previewBackupRestore(payload, source), /already exists/);

  const destination = new MemoryStorage();
  destination.setItem(localAuthStorageKeys.profile, JSON.stringify({ app: 'flightseal', schema: 1, profiles: [] }));
  destination.setItem = function (key, value) {
    if (key.includes('_workspace_')) throw new Error('quota');
    this.values.set(key, String(value));
  };
  await assert.rejects(commitBackupRestore(payload, destination), /could not be committed/);
  assert.deepEqual(JSON.parse(destination.getItem(localAuthStorageKeys.profile)).profiles, []);
  assert.equal(readWorkspaceContext(profile.id, { storage: destination }), null);
});

test('canceled backup operations retain no new backup or profile writes', async () => {
  const source = new MemoryStorage();
  await createLocalProfile('canceled@example.test', 'local profile password 123', { storage: source, cryptoObject: webcrypto });
  const payload = { app: 'flightseal', schema: 1, profile: JSON.parse(source.getItem(localAuthStorageKeys.profile)).profiles[0], workspace: null };
  const destination = new MemoryStorage();
  await assert.rejects(commitBackupRestore(payload, destination, { isCurrent: () => false }), /canceled/);
  await assert.rejects(createEncryptedProfileBackup(payload.profile.id, { storage: source, passphrase: 'separate backup password', cryptoObject: webcrypto, isCurrent: () => false }), /canceled/);
  assert.equal(destination.values.size, 0);
});

test('logout while a restore waits for its Web Lock cancels before any write', async () => {
  const source = new MemoryStorage();
  await createLocalProfile('queued@example.test', 'local profile password 123', { storage: source, cryptoObject: webcrypto });
  const payload = { app: 'flightseal', schema: 1, profile: JSON.parse(source.getItem(localAuthStorageKeys.profile)).profiles[0], workspace: null };
  const destination = new MemoryStorage();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let release, current = true;
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { locks: { request(name, options, callback) {
    return new Promise((resolve, reject) => { release = () => Promise.resolve().then(callback).then(resolve, reject); });
  } } }, configurable: true });
  try {
    const restoring = commitBackupRestore(payload, destination, { isCurrent: () => current });
    current = false;
    release();
    await assert.rejects(restoring, /canceled/);
    assert.equal(destination.values.size, 0);
  } finally {
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
  }
});

test('a saved view of the user\'s own file (no bundled sample) on the Seal & send screen backs up and restores', async () => {
  const source = new MemoryStorage();
  const profile = await createLocalProfile('own-file@example.test', 'local profile password 123', { storage: source, cryptoObject: webcrypto });
  await saveWorkspaceContext(profile.id, { screen: 'protect', sample: null, record: 0 }, { storage: source });
  const backup = await createEncryptedProfileBackup(profile.id, { storage: source, passphrase: 'backup passphrase 123', cryptoObject: webcrypto });
  const fresh = new MemoryStorage();
  await commitBackupRestore(await inspectEncryptedProfileBackup(backup, 'backup passphrase 123', { cryptoObject: webcrypto }), fresh);
  assert.deepEqual(readWorkspaceContext(profile.id, { storage: fresh }), { screen: 'protect', sample: null, record: 0 });
});

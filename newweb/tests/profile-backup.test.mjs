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

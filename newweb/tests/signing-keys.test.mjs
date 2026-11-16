import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { generateEd25519SigningKey, validateEd25519PrivateKey } from '../src/signing-keys.mjs';

test('generated Ed25519 PKCS#8 key validates and signs against its raw public key', async () => {
  const pair = await generateEd25519SigningKey(webcrypto);
  assert.match(pair.publicKeyHex, /^[a-f0-9]{64}$/);
  const normalized = await validateEd25519PrivateKey(pair.privateKeyPem, webcrypto);
  const encoded = normalized.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const privateKey = await webcrypto.subtle.importKey('pkcs8', Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)), { name: 'Ed25519' }, false, ['sign']);
  const publicKey = await webcrypto.subtle.importKey('raw', Uint8Array.from(pair.publicKeyHex.match(/../g), (part) => parseInt(part, 16)), { name: 'Ed25519' }, false, ['verify']);
  const message = new TextEncoder().encode('HashWing signing key self-test');
  const signature = await webcrypto.subtle.sign('Ed25519', privateKey, message);
  assert.equal(await webcrypto.subtle.verify('Ed25519', publicKey, signature, message), true);
});

test('private key importer rejects unsupported or oversized material', async () => {
  await assert.rejects(validateEd25519PrivateKey('not a key', webcrypto), /PKCS#8 Ed25519/);
  await assert.rejects(validateEd25519PrivateKey('x'.repeat(16385), webcrypto), /16 KiB/);
});

function toHex(bytes) { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function toBase64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).match(/.{1,64}/g).join('\n');
}

export async function generateEd25519SigningKey(cryptoObject = globalThis.crypto) {
  if (!cryptoObject?.subtle) throw new Error('Web Crypto is unavailable in this browser.');
  let pair;
  try { pair = await cryptoObject.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); }
  catch { throw new Error('This browser cannot generate Ed25519 keys. The existing ephemeral sealer remains available.'); }
  const [pkcs8, publicRaw] = await Promise.all([
    cryptoObject.subtle.exportKey('pkcs8', pair.privateKey),
    cryptoObject.subtle.exportKey('raw', pair.publicKey),
  ]);
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${toBase64(pkcs8)}\n-----END PRIVATE KEY-----\n`;
  return { privateKeyPem, publicKeyHex: toHex(publicRaw), backupFilename: 'hashwing-ed25519-private-key.pem' };
}

export async function validateEd25519PrivateKey(privateKeyPem, cryptoObject = globalThis.crypto) {
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length > 16384 || privateKeyPem.includes('\0')) throw new Error('Private key PEM must be valid text no longer than 16 KiB.');
  const match = privateKeyPem.trim().match(/^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----$/);
  if (!match) throw new Error('Expected a PKCS#8 Ed25519 private key PEM.');
  const encoded = match[1].replace(/\s/g, '');
  let binary;
  try { binary = atob(encoded); } catch { throw new Error('Private key PEM contains invalid base64.'); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try { await cryptoObject.subtle.importKey('pkcs8', bytes, { name: 'Ed25519' }, false, ['sign']); }
  catch { throw new Error('The PEM is not a usable Ed25519 private key.'); }
  return privateKeyPem.trim() + '\n';
}

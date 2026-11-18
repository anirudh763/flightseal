// Manifest-only sealing: originals stay where they are; one FLTSEAL1 record holds their sizes and SHA-256
// digests. Format (one ASCII line, see docs/MANIFEST_MODE.md; tools/manifest.py writes identical bytes):
//   hashwing-manifest v1 salt=<64 hex> items=<n> item=<i>,<bytes>,<sha256>,<name>,<note> ...
// name/note are encodeURIComponent of the exact UTF-8 text, empty when absent.
import { WEAK_KEY_MESSAGE, blobSource, checkReceipts, hex, parseHex, parseReceipts, readRecord, scanLog, weakPublicKey } from './verifier.js';
import { parseHandover } from './rawfile.js';

export const MANIFEST_LIMITS = Object.freeze({ maxItems: 100, maxPayloadBytes: 65536, maxNameBytes: 255, maxNoteBytes: 1000, maxSize: 999_999_999_999_999 });
export const MANIFEST_STATUS = Object.freeze({ match: 'Matches', 'bytes-differ': 'Bytes differ', missing: 'Missing', 'not-in-manifest': 'Not in manifest' });
const MAX_SEALED_BYTES = 8 + 20 + MANIFEST_LIMITS.maxPayloadBytes + 36;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FIELD = "[A-Za-z0-9%\\-_.!~*'()]*";
const ITEM = new RegExp(`^([1-9][0-9]{0,2}),(0|[1-9][0-9]{0,14}),([0-9a-f]{64}),(${FIELD}),(${FIELD})$`);
const HEAD = /^hashwing-manifest v1 salt=([0-9a-f]{64}) items=([1-9][0-9]{0,2})((?: item=[^ ]*)*)$/;
const utf8Bytes = (s) => new TextEncoder().encode(s).length;

function encodeText(value, label, limit) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  if (LONE_SURROGATE.test(value)) throw new TypeError(`${label} contains an unpaired surrogate and is not valid UTF-8.`);
  if (utf8Bytes(value) > limit) throw new RangeError(`${label} exceeds ${limit} UTF-8 bytes.`);
  return encodeURIComponent(value);
}

export function newSalt() { return hex(crypto.getRandomValues(new Uint8Array(32))); }

/** items: [{ bytes, sha256, name?, note? }] in the operator's selection order. Returns the payload bytes. */
export function encodeManifest({ salt, items }) {
  if (typeof salt !== 'string' || !/^[0-9a-f]{64}$/.test(salt)) throw new TypeError('Salt must be 64 lowercase hexadecimal digits.');
  if (!Array.isArray(items) || items.length < 1 || items.length > MANIFEST_LIMITS.maxItems) throw new RangeError(`A manifest holds 1 to ${MANIFEST_LIMITS.maxItems} files.`);
  const parts = [`hashwing-manifest v1 salt=${salt} items=${items.length}`];
  items.forEach((item, index) => {
    const { bytes, sha256 } = item || {};
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MANIFEST_LIMITS.maxSize) throw new RangeError(`File ${index + 1}: size must be a whole number of at most 15 digits.`);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError(`File ${index + 1}: SHA-256 must be 64 lowercase hexadecimal digits.`);
    const name = encodeText(item.name, `File ${index + 1} name`, MANIFEST_LIMITS.maxNameBytes);
    const note = encodeText(item.note, `File ${index + 1} note`, MANIFEST_LIMITS.maxNoteBytes);
    parts.push(`item=${index + 1},${bytes},${sha256},${name},${note}`);
  });
  const payload = new TextEncoder().encode(parts.join(' '));
  if (payload.length > MANIFEST_LIMITS.maxPayloadBytes) throw new RangeError(`Manifest exceeds ${MANIFEST_LIMITS.maxPayloadBytes} bytes; include fewer names or shorter notes.`);
  return payload;
}

function decodeText(encoded, label, limit) {
  let value;
  try { value = decodeURIComponent(encoded); } catch { throw new TypeError(`${label} is not valid percent-encoded UTF-8.`); }
  if (encodeURIComponent(value) !== encoded) throw new TypeError(`${label} is not in canonical form.`);
  if (utf8Bytes(value) > limit) throw new RangeError(`${label} exceeds ${limit} UTF-8 bytes.`);
  return value;
}

/** Strict parser: only the exact bytes encodeManifest would write are accepted. */
export function parseManifest(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Manifest payload must be bytes.');
  if (bytes.length > MANIFEST_LIMITS.maxPayloadBytes) throw new RangeError(`Manifest exceeds ${MANIFEST_LIMITS.maxPayloadBytes} bytes.`);
  for (const b of bytes) if (b < 0x20 || b > 0x7e) throw new TypeError('Manifest payload must be printable ASCII.');
  const text = new TextDecoder().decode(bytes);
  const head = HEAD.exec(text);
  if (!head) throw new TypeError('Not a hashwing-manifest v1 payload.');
  const count = Number(head[2]);
  if (count > MANIFEST_LIMITS.maxItems) throw new RangeError(`A manifest holds at most ${MANIFEST_LIMITS.maxItems} files.`);
  const fields = head[3] ? head[3].slice(' item='.length).split(' item=') : [];
  if (fields.length !== count) throw new TypeError('Manifest item count does not match its items.');
  const items = fields.map((field, index) => {
    const m = ITEM.exec(field);
    if (!m || Number(m[1]) !== index + 1) throw new TypeError(`Manifest item ${index + 1} is malformed.`);
    return { id: index + 1, bytes: Number(m[2]), sha256: m[3], name: decodeText(m[4], `Item ${index + 1} name`, MANIFEST_LIMITS.maxNameBytes), note: decodeText(m[5], `Item ${index + 1} note`, MANIFEST_LIMITS.maxNoteBytes) };
  });
  return { salt: head[1], items };
}

/** The sealer input: one record, timestamp 0. */
export function manifestRecordsBlob(bytes) {
  return new Blob([new TextEncoder().encode('0\t'), bytes, new TextEncoder().encode('\n')], { type: 'text/plain' });
}

const reject = (reason) => ({ verified: false, reason });

/**
 * Verifies a sealed manifest against a key the recipient trusts independently. The key inside the receipt is
 * never the trust anchor. Returns { verified: true, manifest, head, publicKey } or { verified: false, reason }.
 */
export async function verifySealedManifest(blob, receiptsText, trustedKeyHex) {
  const trusted = parseHex(String(trustedKeyHex || '').trim().toLowerCase(), 32);
  if (!trusted) return reject('Enter the trusted public key (64 hexadecimal digits) you received separately.');
  if (!(blob instanceof Blob) || blob.size === 0) return reject('Choose the sealed manifest file.');
  if (blob.size > MAX_SEALED_BYTES) return reject('This file is too large to be a sealed manifest.');
  const receiptLines = parseHandover(String(receiptsText || '')).receipts; // receipt lines only; any stated key is ignored
  const { receipts, error } = parseReceipts(receiptLines);
  if (error || receipts.length === 0) return reject('No receipt found in the receipt message.');
  if (receipts.length !== 1) return reject('The receipt message must contain exactly one receipt.');
  if (receipts[0].count !== 1n) return reject('The receipt must cover exactly one record.');
  const source = blobSource(blob);
  const scan = await scanLog(source, { linksAt: [1], maxRows: 2 });
  if (scan.status !== 'ok') return reject(`The sealed manifest is damaged (${scan.status}).`);
  if (scan.records !== 1) return reject('A sealed manifest must contain exactly one record.');
  if (scan.goodBytes !== blob.size) return reject('Unexpected bytes after the manifest record.');
  if (hex(receipts[0].head) !== hex(scan.head)) return reject('The receipt does not match this sealed manifest.');
  if (weakPublicKey(trusted)) return reject(WEAK_KEY_MESSAGE);
  const check = await checkReceipts(receipts, trusted, scan);
  const result = check.results[0];
  if (result.result === 'wrong-key') return reject('The receipt was not signed by the trusted public key.');
  if (!check.signaturesChecked || !result.sigChecked) return reject('This browser cannot check Ed25519 signatures.');
  if (result.result !== 'ok') return reject('The receipt signature or head does not match.');
  const record = await readRecord(source, 8);
  if (!record?.whole || record.seq !== 0n || record.ts !== 0n) return reject('The manifest record is not in the expected form.');
  let manifest;
  try { manifest = parseManifest(record.payload); } catch (cause) { return reject(`The sealed record is not a valid manifest: ${cause.message}`); }
  return { verified: true, manifest, head: hex(scan.head), publicKey: hex(trusted) };
}

/**
 * Deterministic pairing. locals: [{ name, bytes, sha256 }] in selection order.
 * 1. each local matches the lowest-id unmatched item with equal size and digest -> match
 * 2. each remaining local whose name equals the included name of the lowest-id remaining item with it -> bytes-differ
 * 3. remaining items -> missing; remaining locals -> not-in-manifest
 */
export function compareFiles(manifest, locals) {
  const items = manifest.items.map((item) => ({ ...item, status: null, local: null }));
  const extras = [];
  const pending = [];
  locals.forEach((local, index) => {
    const item = items.find((it) => it.status === null && it.bytes === local.bytes && it.sha256 === local.sha256);
    if (item) { item.status = 'match'; item.local = index; } else pending.push(index);
  });
  for (const index of pending) {
    const item = items.find((it) => it.status === null && it.name !== '' && it.name === locals[index].name);
    if (item) { item.status = 'bytes-differ'; item.local = index; }
    else extras.push({ local: index, name: locals[index].name, bytes: locals[index].bytes, sha256: locals[index].sha256, status: 'not-in-manifest' });
  }
  for (const item of items) if (item.status === null) item.status = 'missing';
  return { items, extras, allMatch: extras.length === 0 && items.every((it) => it.status === 'match') };
}

/** The message sent to a witness. Only the receipt, key and item count: names and digests stay in the sealed file. */
export function manifestHandoverText({ items, receipts, publicKey, sealedAt }) {
  return [
    'HashWing manifest receipt',
    `Sealed: ${sealedAt} (from the sealing computer's clock, not independently verified)`,
    `Files listed: ${items}`,
    `Public key: ${publicKey}`,
    ...String(receipts).trim().split('\n'),
    '',
    'Keep this message. Confirm the public key with the sender through another channel.',
  ].join('\n') + '\n';
}

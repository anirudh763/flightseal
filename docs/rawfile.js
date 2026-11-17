// Seal any file, byte for byte, as an ordinary FLTSEAL1 log (the format is unchanged).
// Record 0 is a manifest line; every later record is one base64 chunk whose timestamp is the chunk's byte offset:
//   0<TAB>flightseal-file v1 name=<encodeURIComponent(name)> bytes=<n> sha256=<hex> chunk=<bytes per chunk>
//   <offset><TAB><base64 of bytes offset..offset+chunk>
// tools/raw_file.py writes and reads the same lines; tests/web/rawfile.test.mjs checks they agree.

export const RAW_CHUNK = 48 * 1024; // base64 makes each record 64 KiB, well under the 1 MiB record limit
export const RAW_MAX_BYTES = 45 * 1024 * 1024; // base64 + record overhead stays under the 64 MiB browser sealer output cap
const MAGIC = 'FLTSEAL1';
const HEADER = 20;
const TRAILER = 36;

const pause = () => new Promise((resolve) => setTimeout(resolve, 0)); // lets the page repaint between batches
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(bytes) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}

/** Turns a file into the timestamp<TAB>payload lines the C++ sealer reads. */
export async function fileToRecords(file) {
  if (!(file instanceof Blob)) throw new TypeError('Choose a file first.');
  if (file.size === 0) throw new RangeError('This file is empty; there is nothing to seal.');
  if (file.size > RAW_MAX_BYTES) throw new RangeError(`This file is larger than ${RAW_MAX_BYTES / 1024 / 1024} MiB. Use the command-line tool (tools/raw_file.py) for larger logs.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const name = (file.name || 'flight-log').split(/[\\/]/).pop() || 'flight-log'; // File.name never holds a lone surrogate
  const lines = [`0\tflightseal-file v1 name=${encodeURIComponent(name)} bytes=${bytes.length} sha256=${sha256} chunk=${RAW_CHUNK}\n`];
  for (let at = 0; at < bytes.length; at += RAW_CHUNK) {
    lines.push(`${at}\t${base64(bytes.subarray(at, at + RAW_CHUNK))}\n`);
    if (lines.length % 16 === 0) await pause();
  }
  return { records: new Blob(lines, { type: 'text/plain' }), name, bytes: bytes.length, sha256 };
}

/** Parses a manifest payload; null if it is not one. */
export function parseManifest(text) {
  const m = /^flightseal-file v1 name=([\x21-\x7e]*) bytes=(\d{1,15}) sha256=([0-9a-f]{64}) chunk=(\d{1,7})$/.exec(text);
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[1]); } catch { return null; }
  return { name: name.split(/[\\/]/).pop() || 'flight-log', bytes: Number(m[2]), sha256: m[3], chunk: Number(m[4]) };
}

/**
 * Rebuilds the original file from a sealed log. Call it only after the log verified as intact. Returns null if the
 * log is not a sealed file (for example a PX4 record log); throws if it claims to be one but does not add up.
 */
export async function recordsToFile(sealed) {
  const data = new Uint8Array(sealed instanceof Blob ? await sealed.arrayBuffer() : sealed);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 8 || new TextDecoder().decode(data.subarray(0, 8)) !== MAGIC) return null;
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // a BOM is kept, then rejected, as in Python
  const fail = () => { throw new Error('This log says it holds a file, but its parts do not add up. Treat it as damaged.'); };
  let at = 8, manifest = null, out = null, filled = 0, records = 0;
  while (at + HEADER <= data.length) {
    const len = view.getUint32(at, true);
    const ts = view.getBigUint64(at + 12, true);
    if (at + HEADER + len + TRAILER > data.length) fail();
    const payload = data.subarray(at + HEADER, at + HEADER + len);
    at += HEADER + len + TRAILER;
    if (!manifest) {
      let line;
      try { line = text.decode(payload); } catch { return null; }
      manifest = ts === 0n ? parseManifest(line) : null;
      if (!manifest) return null;
      // base64 only grows data, so a real original is always smaller than its sealed log; refuse before allocating.
      if (manifest.bytes > data.length || manifest.chunk < 1) fail();
      out = new Uint8Array(manifest.bytes);
      continue;
    }
    if (ts !== BigInt(filled)) fail();
    let chunk;
    try {
      const encoded = text.decode(payload);
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail(); // as strict as Python's b64decode(validate=True)
      const binary = atob(encoded);
      chunk = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) chunk[i] = binary.charCodeAt(i);
    } catch { fail(); }
    if (++records % 16 === 0) await pause();
    if (chunk.length === 0 || chunk.length > manifest.chunk || filled + chunk.length > out.length) fail();
    if (chunk.length < manifest.chunk && filled + chunk.length !== out.length) fail(); // only the last chunk may be short
    out.set(chunk, filled);
    filled += chunk.length;
  }
  if (!manifest) return null; // an empty log holds no file
  if (at !== data.length || filled !== out.length) fail();
  const sha256 = await sha256Hex(out);
  return { ...manifest, data: out, matches: sha256 === manifest.sha256, actualSha256: sha256 };
}

/** The text a pilot sends to a witness right after sealing. Its receipt line carries the public key. */
export function handoverText({ name, bytes, sha256, receipts, publicKey, sealedAt, checkUrl }) {
  return [
    `HashWing receipt for ${name}`,
    `Sealed: ${sealedAt} (from the sealing computer's clock, not independently verified)`,
    `Original file: ${bytes} bytes, SHA-256 ${sha256}`,
    `Public key: ${publicKey}`,
    ...receipts.trim().split('\n'),
    '',
    'Keep this message. It is what proves the file was not changed later.',
    `To check the file, open ${checkUrl} and paste this whole message.`,
  ].join('\n') + '\n';
}

/** Pulls receipt lines and the public key out of a pasted handover message (or a bare receipts file). */
export function parseHandover(text) {
  // Email replies quote lines with "> ", and mail programs wrap long lines, even inside the hex fields, so the
  // lines are rejoined and every field may contain line breaks.
  const joined = text.split(/\r?\n/).map((line) => line.replace(/^[>\s]+/, '')).join('\n');
  const hexOf = (n) => `((?:[0-9a-fA-F]\\s*){${n}})`;
  const receiptPattern = new RegExp(`fseal-receipt\\s+v1\\s+count=\\s*([0-9]+)\\s+head=\\s*${hexOf(64)}key=\\s*${hexOf(64)}sig=\\s*${hexOf(128)}`, 'g');
  const squash = (s) => s.replace(/\s+/g, '').toLowerCase();
  const found = [...joined.matchAll(receiptPattern)].map((m) => ({ line: `fseal-receipt v1 count=${m[1]} head=${squash(m[2])} key=${squash(m[3])} sig=${squash(m[4])}`, key: squash(m[3]) }));
  const receipts = [...new Set(found.map((r) => r.line))]; // a quoted reply plus a forward can repeat it
  const keys = new Set(found.map((r) => r.key));
  const statedMatch = new RegExp(`Public key:\\s*${hexOf(64)}`).exec(joined);
  const stated = statedMatch && squash(statedMatch[1]);
  if (stated) keys.add(stated);
  return { receipts: receipts.length ? receipts.join('\n') + '\n' : '', publicKey: keys.size === 1 ? [...keys][0] : '', keyConflict: keys.size > 1 };
}

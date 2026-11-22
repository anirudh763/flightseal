import { crc32, createStoreZip } from './zip-store.mjs';

const reportMarker = 'hashwing-proof-report v1';
const names = ['manifest.fseal', 'receipt.txt', 'report.json'];
const limits = [66 * 1024, 64 * 1024, 256 * 1024];
const maxSize = limits.reduce((a, b) => a + b, 0) + 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const invalid = () => new Error('Use the original HashWing proof ZIP. The archive is incomplete or has unexpected contents.');

export const validCaseId = (value)  => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const isoTime = (value) => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function makeProofReport({ caseId, flightEnded, sealedAt, inspection }) {
  if (!validCaseId(caseId) || (flightEnded !== null && !isoTime(flightEnded)) || !isoTime(sealedAt)) {
    throw new Error('Enter a valid case ID and flight end time.');
  }
  return new File([JSON.stringify({ format: 'hashwing-proof-v1', caseId, flightEnded, sealedAt, inspection }, null, 2) + '\n'],
    'report.json', { type: 'application/json' });
}

export async function proofReportItem(report) {
  if (report.size > limits[2]) throw new Error('The bundled report exceeds 256 KiB.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await report.arrayBuffer()));
  return { name: names[2], note: reportMarker, bytes: report.size, sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') };
}

export async function readSignedReport(report, manifest) {
  const item = await proofReportItem(report);
  const tail = manifest.items.at(-1);
  if (manifest.items.length < 2 || !tail || tail.name !== item.name || tail.note !== item.note || tail.bytes !== item.bytes || tail.sha256 !== item.sha256) {
    throw new Error('The bundled report does not match the signed list. Request the original proof ZIP.');
  }
  let value;
  try { value = JSON.parse(await report.text()); }
  catch { throw new Error('The signed report cannot be read. Request a new proof ZIP.'); }
  if (value?.format !== 'hashwing-proof-v1' || !validCaseId(value.caseId) ||
      (value.flightEnded !== null && !isoTime(value.flightEnded)) || !isoTime(value.sealedAt)) {
    throw new Error('The signed report format is unsupported. Request a new proof ZIP.');
  }
  return value;
}

export function createProofBundle(log, receipt, report) {
  const blobs = [log, new Blob([receipt]), report];
  if (blobs.some((blob, index) => blob.size > limits[index])) throw invalid();
  return createStoreZip(blobs.map((blob, index) => ({ name: names[index], blob })), { maxBytes: maxSize });
}

// Read only the fixed stored ZIP layout emitted by createStoreZip. Nothing is extracted to disk.
export async function openProofBundle(file) {
  try {
    if (file.size > maxSize || file.size < 22) throw invalid();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const u16 = (offset) => view.getUint16(offset, true);
    const u32 = (offset) => view.getUint32(offset, true);
    const end = bytes.length - 22;
    if (u32(end) !== 0x06054b50 || u32(end + 4) || u16(end + 8) !== 3 || u16(end + 10) !== 3 || u16(end + 20)) throw invalid();
    let central = u32(end + 16);
    const centralStart = central;
    if (central + u32(end + 12) !== end) throw invalid();
    let local = 0;
    const contents = names.map((name, index) => {
      const nameSize = encoder.encode(name).length;
      const start = local + 30 + nameSize;
      const size = u32(local + 18);
      const checksum = u32(local + 14);
      if (start + size > centralStart || central + 46 + nameSize > end || size > limits[index] ||
          u32(local) !== 0x04034b50 || u32(local + 6) !== 0x0800 || u32(local + 22) !== size ||
          u32(local + 26) !== nameSize || decoder.decode(bytes.subarray(local + 30, start)) !== name ||
          u32(central) !== 0x02014b50 || u32(central + 8) !== 0x0800 || u32(central + 16) !== checksum ||
          u32(central + 20) !== size || u32(central + 24) !== size || u32(central + 28) !== nameSize ||
          u32(central + 32) || u16(central + 36) || u32(central + 38) || u32(central + 42) !== local ||
          decoder.decode(bytes.subarray(central + 46, central + 46 + nameSize)) !== name) throw invalid();
      const data = bytes.subarray(start, start + size);
      if (crc32(data) !== checksum) throw invalid();
      local = start + size;
      central += 46 + nameSize;
      return data;
    });
    if (local !== centralStart || central !== end) throw invalid();
    const text = decoder.decode(contents[1]);
    if (!text.trim()) throw invalid();
    return { log: new File([contents[0]], names[0]), text, report: new File([contents[2]], names[2]) };
  } catch {
    throw invalid();
  }
}

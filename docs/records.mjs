import { HEADER, TRAILER, MAX_PAYLOAD, blobSource, crc32 } from './verifier.js';

function cancelled(signal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

export async function readIndexedRecords(source, scan, start, count = 50, { signal } = {}) {
  cancelled(signal);
  const total = scan.records + Number(!!scan.problem);
  if (!Number.isSafeInteger(start) || start < 0 || start > total || !Number.isInteger(count) || count < 1 || count > 256)
    throw new RangeError('Choose a valid record range of at most 256 rows.');
  if (source.size !== scan.size) throw new Error('The source snapshot no longer matches this verification.');
  if (start === total) return [];
  const end = Math.min(total, start + count), stride = scan.rows.stride || 1;
  const anchor = Math.min(Math.floor(start / stride), scan.rows.count - 1);
  let index = anchor >= 0 ? anchor * stride : 0;
  let offset = anchor >= 0 ? scan.rows.offset[anchor] : 8;
  let window = new Uint8Array(0), windowStart = 0;
  const rows = [];
  while (index < end) {
    cancelled(signal);
    if (index === scan.problem?.record) offset = scan.problem.offset;
    if (offset < windowStart || offset + HEADER > windowStart + window.length) {
      window = await source.read(offset, Math.min(256 * 1024, source.size - offset));
      windowStart = offset;
    }
    const available = window.length - (offset - windowStart);
    const problem = index === scan.problem?.record;
    if (available < HEADER) {
      if (!problem) throw new Error('The source does not contain the verified record.');
      if (index >= start) rows.push({ index, offset, len: 0, ts: null, problem: true });
      break;
    }
    const view = new DataView(window.buffer, window.byteOffset + offset - windowStart, HEADER);
    const len = view.getUint32(0, true), ts = view.getBigUint64(12, true);
    if (!problem && (len > MAX_PAYLOAD || offset + HEADER + len + TRAILER > scan.goodBytes || view.getBigUint64(4, true) !== BigInt(index)))
      throw new Error('The source record no longer matches the verified snapshot.');
    if (index >= start) rows.push({ index, offset, len, ts, ...(problem ? { problem: true } : {}) });
    offset += HEADER + len + TRAILER;
    index++;
    if (index % 256 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  cancelled(signal);
  return rows;
}

export async function recordAt(source, scan, index, options = {}) {
  const rows = await readIndexedRecords(source, scan, index, 1, options);
  if (!rows.length) throw new RangeError('That record is outside the verified snapshot.');
  return rows[0];
}

export async function mutateFile(file, scan, kind, { signal } = {}) {
  cancelled(signal);
  if (!['flip', 'delete', 'truncate'].includes(kind)) throw new RangeError('Unknown mutation.');
  if (kind === 'truncate') {
    const offset = Math.max(8, scan.goodBytes - 7);
    return { file: new File([file.slice(0, offset)], 'tail-truncated.fseal'), description: 'copied with final seven bytes removed', mutation: { kind, offset, removedBytes: file.size - offset } };
  }
  const index = kind === 'flip' ? 0 : Math.floor(scan.records / 2);
  if (scan.records < (kind === 'flip' ? 1 : 3)) throw new RangeError('There are not enough verified records for this mutation.');
  const row = await recordAt(blobSource(file), scan, index, { signal });
  const end = row.offset + HEADER + row.len + TRAILER;
  if (kind === 'delete') return { file: new File([file.slice(0, row.offset), file.slice(end)], 'record-removed.fseal'), description: `copied with record ${index} removed`, mutation: { kind, record: index, offset: row.offset, removedBytes: end - row.offset } };
  if (!row.len) throw new RangeError('The first record has no payload byte to flip.');
  const record = new Uint8Array(await file.slice(row.offset, end).arrayBuffer());
  cancelled(signal);
  record[HEADER] ^= 1;
  new DataView(record.buffer).setUint32(record.length - 4, crc32(record, 0, record.length - 4), true);
  return { file: new File([file.slice(0, row.offset), record, file.slice(end)], 'byte-flipped.fseal'), description: 'copied with one payload byte flipped (CRC recomputed)', mutation: { kind, record: index, offset: row.offset, changedByte: row.offset + HEADER } };
}

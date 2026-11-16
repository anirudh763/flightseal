const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

export async function createStoreZip(files, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > 64) throw new TypeError('A bundle needs between 1 and 64 files.');
  const encoder = new TextEncoder();
  const entries = [];
  let total = 0;
  for (const file of files) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(file.name) || file.name === '.' || file.name === '..') throw new TypeError('Bundle file names must be short safe ASCII names.');
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.blob.arrayBuffer());
    total += bytes.byteLength;
    if (total > maxBytes || total > 0xffffffff) throw new RangeError(`Bundle exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB size limit.`);
    entries.push({ name: encoder.encode(file.name), bytes, crc: crc32(bytes), offset: 0 });
  }
  const { time, date } = dosDateTime(new Date());
  const localParts = [];
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    const header = new Uint8Array(30 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true); view.setUint16(8, 0, true);
    view.setUint16(10, time, true); view.setUint16(12, date, true); view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.bytes.length, true); view.setUint32(22, entry.bytes.length, true); view.setUint16(26, entry.name.length, true);
    header.set(entry.name, 30); localParts.push(header, entry.bytes); offset += header.length + entry.bytes.length;
  }
  const centralParts = [];
  for (const entry of entries) {
    const header = new Uint8Array(46 + entry.name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0x0800, true); view.setUint16(10, 0, true);
    view.setUint16(12, time, true); view.setUint16(14, date, true); view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.bytes.length, true); view.setUint32(24, entry.bytes.length, true); view.setUint16(28, entry.name.length, true);
    view.setUint32(42, entry.offset, true); header.set(entry.name, 46); centralParts.push(header);
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, entries.length, true); endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

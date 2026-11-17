export const TELEMETRY_CONVERTER_VERSION = 'hashwing-telemetry-converter/1.0';
export const TELEMETRY_IMPORT_MAX_BYTES = 16 * 1024 * 1024;
export const TELEMETRY_RECORD_MAX = 200_000;

function digest(bytes) {
  return crypto.subtle.digest('SHA-256', bytes).then((hash) => [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
}

function finiteTimestamp(value, index) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Record ${index + 1}: numeric timestamp_us must be a safe unsigned 64-bit integer; use a decimal string for larger values.`);
  const raw = String(value ?? '').trim();
  if (!/^\d{1,20}$/.test(raw) || BigInt(raw) > 18446744073709551615n) throw new Error(`Record ${index + 1}: timestamp_us must be an unsigned 64-bit integer.`);
  return raw;
}

function parseCsvTable(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      if (cell) throw new Error('CSV quote must begin at the start of a cell.');
      quoted = true;
    } else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
    if (rows.length > TELEMETRY_RECORD_MAX + 1) throw new Error(`CSV exceeds ${TELEMETRY_RECORD_MAX.toLocaleString()} records.`);
  }
  if (quoted) throw new Error('CSV ends inside a quoted cell.');
  row.push(cell); if (row.some((value) => value !== '')) rows.push(row);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row.');
  const headers = rows[0].map((value) => value.trim());
  if (new Set(headers).size !== headers.length || headers.some((value) => !value || value.length > 128)) throw new Error('CSV headers must be unique, non-empty and at most 128 characters.');
  const values = rows.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV record ${index + 1} has ${cells.length} cells; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });
  return { headers, rows: values };
}

function validateCsvMapping(headers, mapping = {}) {
  const timestampColumn = mapping.timestampColumn;
  if (!timestampColumn) throw new Error('Choose one CSV column for timestamps in microseconds.');
  if (!headers.includes(timestampColumn)) throw new Error(`Mapped CSV timestamp column “${timestampColumn}” is not present in this file.`);
  if (mapping.timestampUnit !== 'microseconds') throw new Error('CSV timestamps must be explicitly declared in microseconds. Other timestamp units are not supported.');
  if (mapping.latitudeColumn && mapping.latitudeUnit !== 'degrees') throw new Error('CSV latitude units must be explicitly declared as degrees.');
  if (mapping.longitudeColumn && mapping.longitudeUnit !== 'degrees') throw new Error('CSV longitude units must be explicitly declared as degrees.');
  if (mapping.altitudeColumn && mapping.altitudeUnit !== 'meters') throw new Error('CSV altitude units must be explicitly declared in meters.');
  if (mapping.speedColumn && mapping.speedUnit !== 'meters per second') throw new Error('CSV speed units must be explicitly declared in meters per second.');
  const selected = [timestampColumn, mapping.latitudeColumn, mapping.longitudeColumn, mapping.altitudeColumn, mapping.speedColumn].filter(Boolean);
  if (new Set(selected).size !== selected.length) throw new Error('A CSV column can be assigned to only one mapped field.');
  for (const column of selected) if (!headers.includes(column)) throw new Error(`Mapped CSV column “${column}” is not present in this file.`);
  if (!!mapping.latitudeColumn !== !!mapping.longitudeColumn) throw new Error('Choose both latitude and longitude columns, or leave both unmapped.');
  const conflicts = [
    [timestampColumn, /(?:^|[_\s-])(s|sec|secs|second|seconds|ms|millisecond|milliseconds)$/i, 'microseconds'],
    [mapping.latitudeColumn, /(?:^|[_\s-])(rad|radian|radians)$/i, 'degrees'],
    [mapping.longitudeColumn, /(?:^|[_\s-])(rad|radian|radians)$/i, 'degrees'],
    [mapping.altitudeColumn, /(?:^|[_\s-])(ft|feet|foot|cm|mm|km)$/i, 'meters'],
    [mapping.speedColumn, /(?:^|[_\s-])(knot|knots|kph|kmh|mph)$/i, 'meters per second'],
  ];
  for (const [column, pattern, unit] of conflicts) if (column && pattern.test(column)) throw new Error(`CSV column “${column}” declares an unsupported unit; this mapping requires ${unit}.`);
  return { timestampColumn, timestampUnit: 'microseconds', latitudeColumn: mapping.latitudeColumn || null, latitudeUnit: mapping.latitudeColumn ? 'degrees' : null, longitudeColumn: mapping.longitudeColumn || null, longitudeUnit: mapping.longitudeColumn ? 'degrees' : null, altitudeColumn: mapping.altitudeColumn || null, altitudeUnit: mapping.altitudeColumn ? 'meters' : null, speedColumn: mapping.speedColumn || null, speedUnit: mapping.speedColumn ? 'meters per second' : null };
}

function parseCsv(text, mapping) {
  const { headers, rows } = parseCsvTable(text);
  const normalizedMapping = validateCsvMapping(headers, mapping);
  const parsedRecords = rows.map((fields, index) => {
    const timestamp = finiteTimestamp(fields[normalizedMapping.timestampColumn], index);
    const record = { timestamp, fields, record: index, sourceIdentifier: `csv-data-row:${index + 1}` };
    if (normalizedMapping.latitudeColumn && normalizedMapping.longitudeColumn) {
      const latitudeRaw = fields[normalizedMapping.latitudeColumn];
      const longitudeRaw = fields[normalizedMapping.longitudeColumn];
      if (latitudeRaw === '' && longitudeRaw === '') return record;
      if (latitudeRaw === '' || longitudeRaw === '') throw new Error(`CSV record ${index + 1}: provide both mapped coordinates or leave both blank.`);
      const latitude = Number(latitudeRaw);
      const longitude = Number(longitudeRaw);
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw new Error(`CSV record ${index + 1}: mapped coordinates must be valid degrees.`);
      record.latitudeDeg = latitude; record.longitudeDeg = longitude;
    }
    if (normalizedMapping.altitudeColumn) {
      const raw = fields[normalizedMapping.altitudeColumn];
      if (raw !== '') { const value = Number(raw); if (!Number.isFinite(value)) throw new Error(`CSV record ${index + 1}: mapped altitude must be a number of meters.`); record.altitudeM = value; }
    }
    if (normalizedMapping.speedColumn) {
      const raw = fields[normalizedMapping.speedColumn];
      if (raw !== '') { const value = Number(raw); if (!Number.isFinite(value) || value < 0) throw new Error(`CSV record ${index + 1}: mapped speed must be a non-negative number of meters per second.`); record.speedMps = value; }
    }
    return record;
  });
  return { records: parsedRecords, mapping: normalizedMapping };
}

export async function inspectCsvFile(file) {
  if (!(file instanceof Blob) || !String(file.name || '').toLowerCase().endsWith('.csv')) throw new TypeError('Choose a CSV file to preview.');
  if (file.size > TELEMETRY_IMPORT_MAX_BYTES) throw new RangeError('CSV imports are limited to 16 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('CSV must use valid UTF-8.'); }
  const { headers, rows } = parseCsvTable(text);
  return { headers, preview: rows.slice(0, 5), rows: rows.length };
}

function parseJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('JSON must be a valid array of record objects.'); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > TELEMETRY_RECORD_MAX) throw new Error(`JSON schema requires 1–${TELEMETRY_RECORD_MAX.toLocaleString()} record objects in an array.`);
  return parsed.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, 'timestamp_us')) throw new Error(`JSON record ${index + 1} must be an object with timestamp_us.`);
    const timestamp = finiteTimestamp(row.timestamp_us, index);
    const fields = Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]));
    return { timestamp, fields, record: index };
  });
}

function parseTlog(bytes) {
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error(`Tlog ends inside the 8-byte timestamp at byte ${offset}.`);
    const time = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false);
    offset += 8;
    if (offset >= bytes.length) throw new Error(`Tlog ends after its 8-byte timestamp without a MAVLink frame at byte ${offset}.`);
    const start = offset;
    const magic = bytes[offset++];
    let frameLength;
    if (magic === 0xfe) {
      if (bytes.length - offset < 5) throw new Error(`MAVLink v1 header is truncated at byte ${start}.`);
      const payload = bytes[offset++];
      offset += 4; // sequence, system, component and message id
      frameLength = 6 + payload + 2;
    } else if (magic === 0xfd) {
      if (bytes.length - offset < 9) throw new Error(`MAVLink v2 header is truncated at byte ${start}.`);
      const payload = bytes[offset++];
      const incompat = bytes[offset++];
      offset += 7; // compat, sequence, system, component and 24-bit message id
      if (incompat & ~1) throw new Error(`Unsupported MAVLink v2 incompatibility flags at byte ${start}.`);
      frameLength = 10 + payload + ((incompat & 1) ? 13 : 0) + 2;
    } else throw new Error(`Tlog expected a MAVLink v1/v2 frame at byte ${start}; unsupported frame marker 0x${magic.toString(16).padStart(2, '0')}.`);
    const frameStart = start;
    const frameEnd = frameStart + frameLength;
    if (frameEnd > bytes.length) throw new Error(`MAVLink frame is truncated at byte ${frameStart}.`);
    const frame = bytes.slice(frameStart, frameEnd);
    const protocol = magic === 0xfe ? 'MAVLink v1' : 'MAVLink v2';
    const fields = { protocol, frame_hex: [...frame].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    records.push({ timestamp: String(time), fields, record: records.length, timestampUs: String(time), protocol, sourceIdentifier: `tlog-byte-offset:${start}` , sourceOffset: start });
    if (records.length > TELEMETRY_RECORD_MAX) throw new Error(`Tlog exceeds ${TELEMETRY_RECORD_MAX.toLocaleString()} frames.`);
    offset = frameEnd;
  }
  if (!records.length) throw new Error('Tlog contains no complete MAVLink frames.');
  return records;
}

function validateCoordinates(records) {
  return records.map((record) => {
    const fields = record.fields;
    const latRaw = fields.latitude_deg ?? fields.lat;
    const lonRaw = fields.longitude_deg ?? fields.lon;
    const blank = (value) => value == null || (typeof value === 'string' && value.trim() === '');
    if (blank(latRaw) || blank(lonRaw)) return record;
    const lat = Number(latRaw), lon = Number(lonRaw);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) throw new Error(`Record ${record.record + 1}: coordinates are outside valid latitude/longitude ranges.`);
    return { ...record, latitudeDeg: lat, longitudeDeg: lon };
  });
}

export async function convertTelemetryFile(file, { signal, csvMapping } = {}) {
  if (!(file instanceof Blob)) throw new TypeError('Choose a CSV, JSON or Tlog file.');
  if (file.size > TELEMETRY_IMPORT_MAX_BYTES) throw new RangeError('CSV, JSON and Tlog imports are limited to 16 MiB.');
  if (signal?.aborted) throw new DOMException('Telemetry import canceled.', 'AbortError');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw new DOMException('Telemetry import canceled.', 'AbortError');
  let records, format, transformations, fieldMapping = null;
  const extension = String(file.name || '').toLowerCase().split('.').pop();
  if (extension === 'tlog') {
    records = parseTlog(bytes); format = 'MAVLink Tlog';
    transformations = ['Each 8-byte big-endian microsecond timestamp and complete v1/v2 frame was encoded as one canonical JSON payload.', 'Frame boundaries are checked; MAVLink CRC_EXTRA/checksum validity is not checked by this converter.'];
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`${extension.toUpperCase()} must use valid UTF-8.`); }
    if (extension === 'csv') {
      const parsed = parseCsv(text, csvMapping);
      records = parsed.records;
      fieldMapping = parsed.mapping;
    } else records = extension === 'json' ? parseJson(text).map((record) => ({ ...record, sourceIdentifier: `json-array-index:${record.record}` })) : null;
    if (!records) throw new Error('Supported conversion inputs are .tlog, .csv and .json only.');
    format = extension.toUpperCase();
    transformations = extension === 'csv'
      ? ['CSV values were parsed as UTF-8 text; selected timestamps are retained as unsigned decimal strings.', 'Every source column is retained in each payload; mapped fields and declared units are recorded in provenance.', 'Records were re-encoded as compact JSON payloads in input row order.']
      : ['JSON object keys were sorted for deterministic compact payload encoding; timestamp_us is retained as an unsigned decimal string.', 'Record order is preserved.'];
  }
  if (format !== 'CSV') records = validateCoordinates(records); // CSV uses only the columns the user mapped
  if (signal?.aborted) throw new DOMException('Telemetry import canceled.', 'AbortError');
  const sourceSha256 = await digest(bytes);
  const lines = records.map((record) => `${record.timestamp}\t${JSON.stringify(record.fields)}`).join('\n') + '\n';
  const converted = new File([lines], `${file.name}.flightseal.tsv`, { type: 'text/tab-separated-values;charset=utf-8' });
  if (converted.size > TELEMETRY_IMPORT_MAX_BYTES) throw new RangeError('Converted telemetry exceeds the 16 MiB sealer input limit.');
  const coordinateRecords = records.filter((record) => record.latitudeDeg !== undefined && record.longitudeDeg !== undefined).length;
  // JSON and Tlog may name these fields directly; CSV values count only when the user mapped the column.
  const named = (record, a, b) => {
    if (format === 'CSV') return undefined;
    const raw = record.fields[a] ?? record.fields[b];
    if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim() !== '')) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const telemetry = records.map((record) => ({
    record: record.record, timestampUs: record.timestampUs ?? record.timestamp,
    latitudeDeg: record.latitudeDeg, longitudeDeg: record.longitudeDeg,
    altitudeM: record.altitudeM ?? named(record, 'altitude_m', 'altitudeM'),
    speedMps: record.speedMps ?? named(record, 'speed_mps', 'speedMps'),
  })).filter((point) => (point.latitudeDeg !== undefined && point.longitudeDeg !== undefined) || point.altitudeM !== undefined || point.speedMps !== undefined);
  return {
    file: converted, telemetry, records: records.length,
    source: {
      format, filename: file.name, bytes: file.size, sha256: sourceSha256,
      converterVersion: TELEMETRY_CONVERTER_VERSION, transformations,
      ...(fieldMapping ? { fieldMapping } : {}),
      coordinateRecords, coordinateLessRecords: records.length - coordinateRecords,
      recordMappings: records.map(({ record, sourceIdentifier, sourceOffset }) => ({ record, sourceIdentifier, ...(sourceOffset == null ? {} : { sourceOffset }) })),
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { convertTelemetryFile, inspectCsvFile } from '../src/telemetry-import.mjs';

globalThis.crypto ||= webcrypto;
globalThis.File ||= class File extends Blob { constructor(parts, name, options = {}) { super(parts, options); this.name = name; } };

test('CSV preview and explicit mapping preserve original fields, unit provenance and valid telemetry', async () => {
  const source = new File(['epoch,lat_deg,lon_deg,height_m,speed_mps,note\n100,42.1,-71.2,12,3.5,kept\n'], 'flight.csv');
  const preview = await inspectCsvFile(source);
  assert.deepEqual(preview.headers, ['epoch', 'lat_deg', 'lon_deg', 'height_m', 'speed_mps', 'note']);
  assert.equal(preview.rows, 1);
  assert.equal(preview.preview[0].note, 'kept');
  const converted = await convertTelemetryFile(source, { csvMapping: {
    timestampColumn: 'epoch', timestampUnit: 'microseconds', latitudeColumn: 'lat_deg', latitudeUnit: 'degrees', longitudeColumn: 'lon_deg', longitudeUnit: 'degrees',
    altitudeColumn: 'height_m', altitudeUnit: 'meters', speedColumn: 'speed_mps', speedUnit: 'meters per second',
  } });
  assert.equal(converted.records, 1);
  assert.equal(converted.source.recordMappings[0].sourceIdentifier, 'csv-data-row:1');
  assert.equal(converted.telemetry[0].latitudeDeg, 42.1);
  assert.equal(converted.telemetry[0].altitudeM, 12);
  assert.equal(converted.telemetry[0].speedMps, 3.5);
  assert.deepEqual(converted.source.fieldMapping, {
    timestampColumn: 'epoch', timestampUnit: 'microseconds', latitudeColumn: 'lat_deg', latitudeUnit: 'degrees',
    longitudeColumn: 'lon_deg', longitudeUnit: 'degrees', altitudeColumn: 'height_m', altitudeUnit: 'meters',
    speedColumn: 'speed_mps', speedUnit: 'meters per second',
  });
  assert.match(converted.source.sha256, /^[a-f0-9]{64}$/);
  assert.match(await converted.file.text(), /^100\t\{"epoch":"100"/);
  assert.match(await converted.file.text(), /"note":"kept"/);
  assert.equal(converted.source.converterVersion, 'hashwing-telemetry-converter/1.0');
});

test('CSV mapping requires explicit supported units and rejects conflicts, missing columns and partial coordinates', async () => {
  const file = new File(['epoch_s,lat_rad,lon_deg,height_ft,velocity_knots\n1,0.2,2,3,4\n'], 'units.csv');
  const map = (overrides = {}) => ({ timestampColumn: 'epoch_s', timestampUnit: 'microseconds', latitudeColumn: 'lat_rad', latitudeUnit: 'degrees', longitudeColumn: 'lon_deg', longitudeUnit: 'degrees', altitudeColumn: 'height_ft', altitudeUnit: 'meters', speedColumn: 'velocity_knots', speedUnit: 'meters per second', ...overrides });
  await assert.rejects(convertTelemetryFile(file, { csvMapping: map() }), /unsupported unit.*microseconds/i);
  await assert.rejects(convertTelemetryFile(file, { csvMapping: map({ timestampColumn: 'missing', timestampUnit: 'microseconds' }) }), /not present in this file/);
  await assert.rejects(convertTelemetryFile(file, { csvMapping: map({ timestampColumn: 'epoch_s', timestampUnit: 'seconds' }) }), /explicitly declared in microseconds/);
  const otherUnits = new File(['timestamp_us,lat_rad,lon_deg,height_ft,velocity_knots\n1,0.2,2,3,4\n'], 'other-units.csv');
  await assert.rejects(convertTelemetryFile(otherUnits, { csvMapping: map({ timestampColumn: 'timestamp_us', timestampUnit: '' }) }), /explicitly declared in microseconds/);
  await assert.rejects(convertTelemetryFile(otherUnits, { csvMapping: map({ timestampColumn: 'timestamp_us', latitudeUnit: '' }) }), /explicitly declared as degrees/);
  await assert.rejects(convertTelemetryFile(otherUnits, { csvMapping: map({ timestampColumn: 'timestamp_us', altitudeUnit: '' }) }), /explicitly declared in meters/);
  await assert.rejects(convertTelemetryFile(otherUnits, { csvMapping: map({ timestampColumn: 'timestamp_us', latitudeColumn: '', latitudeUnit: '', longitudeColumn: '' }) }), /unsupported unit.*meters/i);
  await assert.rejects(convertTelemetryFile(otherUnits, { csvMapping: map({ timestampColumn: 'timestamp_us', latitudeColumn: '', latitudeUnit: '', longitudeColumn: '', altitudeColumn: '', altitudeUnit: '', speedColumn: 'velocity_knots' }) }), /unsupported unit.*meters per second/i);
  await assert.rejects(convertTelemetryFile(otherUnits, { csvMapping: map({ timestampColumn: 'timestamp_us', latitudeColumn: '', latitudeUnit: '', longitudeColumn: 'lon_deg' }) }), /both latitude and longitude/);
  await assert.rejects(convertTelemetryFile(otherUnits, { csvMapping: map({ timestampColumn: 'timestamp_us', latitudeColumn: 'timestamp_us', longitudeColumn: 'lon_deg' }) }), /one mapped field/);
  const partial = new File(['time,lat_deg,lon_deg\n1,42,\n'], 'partial.csv');
  await assert.rejects(convertTelemetryFile(partial, { csvMapping: { timestampColumn: 'time', timestampUnit: 'microseconds', latitudeColumn: 'lat_deg', latitudeUnit: 'degrees', longitudeColumn: 'lon_deg', longitudeUnit: 'degrees' } }), /both mapped coordinates or leave both blank/);
});

test('CSV altitude and speed can be plotted while GPS remains explicitly unknown', async () => {
  const source = new File(['time,height_m,speed_mps\n10,4,2\n20,5,3\n'], 'no-gps.csv');
  const converted = await convertTelemetryFile(source, { csvMapping: {
    timestampColumn: 'time', timestampUnit: 'microseconds', altitudeColumn: 'height_m', altitudeUnit: 'meters',
    speedColumn: 'speed_mps', speedUnit: 'meters per second',
  } });
  assert.equal(converted.telemetry.length, 2);
  assert.equal(converted.telemetry[0].latitudeDeg, undefined);
  assert.equal(converted.telemetry[0].altitudeM, 4);
  assert.equal(converted.telemetry[0].speedMps, 2);
  assert.equal(converted.source.coordinateRecords, 0);
  assert.equal(converted.source.coordinateLessRecords, 2);
});

test('JSON conversion requires unsigned timestamp and canonicalizes field order', async () => {
  const converted = await convertTelemetryFile(new File(['[{"longitude_deg":2,"timestamp_us":7,"latitude_deg":1}]'], 'sample.json'));
  assert.equal(converted.telemetry.length, 1);
  assert.match(await converted.file.text(), /^7\t\{"latitude_deg":1,"longitude_deg":2,"timestamp_us":7\}/);
  await assert.rejects(convertTelemetryFile(new File(['[{"timestamp_us":-1}]'], 'bad.json')), /unsigned 64-bit/);
  await assert.rejects(convertTelemetryFile(new File(['[{"timestamp_us":9007199254740992}]'], 'unsafe.json')), /safe unsigned 64-bit integer/);
  const exact = await convertTelemetryFile(new File(['[{"timestamp_us":"18446744073709551615"}]'], 'exact.json'));
  assert.match(await exact.file.text(), /^18446744073709551615\t/);
});

test('Tlog conversion parses timestamps and complete MAVLink v1 frames without claiming CRC validation', async () => {
  const bytes = new Uint8Array([0,0,0,0,0,0,0,42, 0xfe,0,1,2,3,4,0,0]);
  const converted = await convertTelemetryFile(new File([bytes], 'flight.tlog'));
  assert.equal(converted.records, 1);
  assert.match((await converted.file.text()), /"protocol":"MAVLink v1"/);
  assert.match(converted.source.transformations.join(' '), /CRC_EXTRA\/checksum validity is not checked/);
  assert.equal(converted.source.recordMappings[0].sourceIdentifier, 'tlog-byte-offset:8');
  assert.equal(converted.source.recordMappings[0].sourceOffset, 8);
});

test('malformed CSV, out-of-range coordinates and truncated tlog are rejected', async () => {
  const map = { timestampColumn: 'timestamp_us', timestampUnit: 'microseconds', latitudeColumn: 'latitude_deg', latitudeUnit: 'degrees', longitudeColumn: 'longitude_deg', longitudeUnit: 'degrees' };
  await assert.rejects(convertTelemetryFile(new File(['timestamp_us,x\n1,"unterminated'], 'bad.csv'), { csvMapping: map }), /ends inside a quoted cell/);
  await assert.rejects(convertTelemetryFile(new File(['timestamp_us,latitude_deg,longitude_deg\n1,91,0'], 'bad.csv'), { csvMapping: map }), /mapped coordinates must be valid degrees/);
  await assert.rejects(convertTelemetryFile(new File([new Uint8Array([0,0,0])], 'bad.tlog')), /inside the 8-byte timestamp/);
  await assert.rejects(convertTelemetryFile(new File([new Uint8Array(8)], 'empty-frame.tlog')), /without a MAVLink frame/);
  const nullPosition = await convertTelemetryFile(new File(['[{"timestamp_us":2,"latitude_deg":null,"longitude_deg":null}]'], 'null-coords.json'));
  assert.equal(nullPosition.telemetry.length, 0);
  const nullAltitude = await convertTelemetryFile(new File(['[{"timestamp_us":2,"latitude_deg":1,"longitude_deg":2,"altitude_m":null,"speed_mps":null}]'], 'null-altitude.json'));
  assert.equal(nullAltitude.telemetry[0].altitudeM, undefined);
  assert.equal(nullAltitude.telemetry[0].speedMps, undefined);
});

test('CSV uses only mapped columns: unmapped lat/lon/altitude columns never override them', async () => {
  const source = new File(['epoch,gps_lat,gps_lon,lat,lon,altitude_m\n100,42.1,-71.2,1,2,999\n'], 'flight.csv');
  const converted = await convertTelemetryFile(source, { csvMapping: {
    timestampColumn: 'epoch', timestampUnit: 'microseconds', latitudeColumn: 'gps_lat', latitudeUnit: 'degrees', longitudeColumn: 'gps_lon', longitudeUnit: 'degrees',
  } });
  assert.equal(converted.telemetry[0].latitudeDeg, 42.1);
  assert.equal(converted.telemetry[0].longitudeDeg, -71.2);
  assert.equal(converted.telemetry[0].altitudeM, undefined);
});

test('JSON coordinates of only spaces are missing, not 0,0', async () => {
  const source = new File([JSON.stringify([{ timestamp_us: 1, lat: ' ', lon: ' ' }])], 'flight.json');
  const converted = await convertTelemetryFile(source);
  assert.equal(converted.telemetry.length, 0);
});

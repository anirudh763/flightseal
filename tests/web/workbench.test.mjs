import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scanLog, bytesSource, blobSource, crc32 } from '../../docs/verifier.js';
import { recordAt, readIndexedRecords, mutateFile } from '../../docs/records.mjs';

function fixture(count) {
  const bytes = new Uint8Array(8 + count * 60);
  bytes.set(new TextEncoder().encode('FLTSEAL1'));
  let previous = new Uint8Array(32);
  for (let index = 0; index < count; index++) {
    const offset = 8 + index * 60;
    const view = new DataView(bytes.buffer, offset, 60);
    view.setUint32(0, 4, true);
    view.setBigUint64(4, BigInt(index), true);
    view.setBigUint64(12, BigInt(index) * 1000n, true);
    view.setUint32(20, index, true);
    const input = new Uint8Array(56);
    input.set(previous);
    input.set(bytes.subarray(offset + 4, offset + 20), 32);
    input.set(bytes.subarray(offset, offset + 4), 48);
    input.set(bytes.subarray(offset + 20, offset + 24), 52);
    previous = createHash('sha256').update(input).digest();
    bytes.set(previous, offset + 24);
    view.setUint32(56, crc32(bytes, offset, offset + 56), true);
  }
  return bytes;
}

const large = fixture(100321);
const indexed = await scanLog(bytesSource(large), { maxRows: 64, sparse: true });

test('sparse checkpoints retain a bounded index while verifying past 100k', () => {
  assert.equal(indexed.status, 'ok');
  assert.equal(indexed.records, 100321);
  assert.ok(indexed.rows.count <= 64);
  assert.ok(indexed.rows.stride > 1);
  for (let i = 0; i < indexed.rows.count; i++) {
    assert.equal(indexed.rows.offset[i], 8 + i * indexed.rows.stride * 60);
  }
});

test('last page and arbitrary record remain reachable past the old display cap', async () => {
  const rows = await readIndexedRecords(bytesSource(large), indexed, 100300, 50);
  assert.equal(rows.length, 21);
  assert.equal(rows.at(-1).index, 100320);
  assert.equal(rows.at(-1).offset, large.length - 60);
  assert.equal(rows.at(-1).ts, 100320000n);
  assert.deepEqual(await recordAt(bytesSource(large), indexed, 100310), rows[10]);
  await assert.rejects(recordAt(bytesSource(large), indexed, 100321), RangeError);
  await assert.rejects(readIndexedRecords(bytesSource(large), indexed, 0, 10000), RangeError);
});

test('indexed reads honor cancellation and reject a different/truncated snapshot', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(recordAt(bytesSource(large), indexed, 5, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(recordAt(bytesSource(large.subarray(0, 500)), indexed, 100310), /snapshot|source|record/i);
});

test('all sandbox mutations avoid a whole-file arrayBuffer copy and preserve original', async () => {
  const file = new File([large], 'large.fseal');
  file.arrayBuffer = () => { throw new Error('whole source copied'); };
  const before = createHash('sha256').update(large).digest('hex');
  for (const [kind, token, record] of [['flip', 'bad-link', 0], ['delete', 'bad-seq', 50160], ['truncate', 'torn-tail', 100320]]) {
    const mutation = await mutateFile(file, indexed, kind);
    const scan = await scanLog(blobSource(mutation.file), { maxRows: 64, sparse: true });
    assert.equal(scan.status, token);
    assert.equal(scan.problem.record, record);
    assert.equal(mutation.mutation.kind, kind);
  }
  assert.equal(createHash('sha256').update(large).digest('hex'), before);
});

test('indexed access includes the real first failing record', async () => {
  const file = new File([fixture(9)], 'small.fseal');
  const intact = await scanLog(blobSource(file), { maxRows: 4, sparse: true });
  const mutation = await mutateFile(file, intact, 'delete');
  const broken = await scanLog(blobSource(mutation.file), { maxRows: 4, sparse: true });
  const row = await recordAt(blobSource(mutation.file), broken, 4);
  assert.equal(row.index, 4);
  assert.equal(row.problem, true);
  assert.equal(row.ts, 5000n);
});

test('sparse configuration and mutation kind are validated', async () => {
  await assert.rejects(scanLog(bytesSource(large), { maxRows: 1, sparse: true }), /at least 2/);
  await assert.rejects(mutateFile(new File([large], 'large.fseal'), indexed, 'unknown'), /mutation/i);
});

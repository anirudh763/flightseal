import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const sample = name => join(ROOT, 'docs/samples', name);
const evidenceFile = process.env.FLIGHTSEAL_EDGE_EVIDENCE || join(ROOT, '.test-artifacts', 'nine-case-native.json');
const wasmFile = join(ROOT, 'docs/wasm/flightseal.wasm');
const factoryFile = join(ROOT, 'docs/wasm/flightseal.mjs');
const cases = [];
const requiredCases = [];

function testCase(name, callback) {
  const item = { name, status: 'not-run' };
  requiredCases.push(item);
  test(name, async () => {
    item.status = 'running';
    try {
      await callback();
      item.status = 'passed';
    } catch (error) {
      item.status = 'failed';
      item.error = String(error?.stack || error);
      throw error;
    }
  });
}

async function native() {
  const { default: factory } = await import(`file://${factoryFile}`);
  const module = await factory({ wasmBinary: await readFile(wasmFile) });
  const verify = (bytes, receipts = '', key = '') => {
    module.FS.writeFile('/edge-input', bytes);
    return JSON.parse(module.ccall('fseal_verify', 'string', ['string', 'string', 'string'], ['/edge-input', receipts, key]));
  };
  const seal = (tsv, every) => {
    module.FS.writeFile('/edge-source.tsv', tsv);
    const result = JSON.parse(module.ccall('fseal_seal', 'string', ['string', 'number'], ['/edge-source.tsv', every]));
    if (!result.error) result.bytes = module.FS.readFile('/sealed.fseal');
    return result;
  };
  return { module, verify, seal };
}

function recordOffsets(bytes) {
  const offsets = [];
  for (let offset = 8; offset + 20 <= bytes.length;) {
    const payloadLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    const end = offset + 20 + payloadLength + 36;
    if (end > bytes.length) throw new Error(`truncated record at ${offset}`);
    offsets.push({ offset, end, payloadLength });
    offset = end;
  }
  return offsets;
}

function record(name, result, extra = {}) {
  cases.push({ name, passed: true, ...extra, native: result });
}

testCase('case a: the included 800-record sample verifies in the compiled C++/OpenSSL Wasm engine', async () => {
  const { verify } = await native();
  const log = await readFile(sample('intact.fseal'));
  const receipts = await readFile(sample('flight.receipts'), 'utf8');
  const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
  const result = verify(log, receipts, key);
  assert.equal(result.engine, 'C++ / OpenSSL / WebAssembly');
  assert.equal(result.verdict, 'intact');
  assert.equal(result.records, 800);
  assert.equal(result.covered, 800);
  assert.equal(result.receipts.length, 8);
  record('a-default-800-record-demo', result, { bytes: log.length, receiptCount: result.receipts.length });
});

testCase('case b: the published 2,422-record PX4 fixture agrees with its bundled key and receipts', async () => {
  const { verify } = await native();
  const log = await readFile(sample('px4-intact.fseal'));
  const receipts = await readFile(sample('px4-flight.receipts'), 'utf8');
  const key = (await readFile(sample('px4-pubkey.txt'), 'utf8')).trim();
  const result = verify(log, receipts, key);
  assert.equal(result.verdict, 'intact');
  assert.equal(result.records, 2422);
  assert.equal(result.covered, 2422);
  record('b-px4-2422-record-fixture', result, { bytes: log.length, receiptCount: result.receipts.length });
});

testCase('case c: the full PX4 fixture verifies all records and all 13 signed checkpoints in native Wasm', async () => {
  const { verify } = await native();
  const log = await readFile(sample('px4-full.fseal'));
  const receipts = await readFile(sample('px4-full.receipts'), 'utf8');
  const key = (await readFile(sample('px4-full-pubkey.txt'), 'utf8')).trim();
  const started = performance.now();
  const result = verify(log, receipts, key);
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(result.verdict, 'intact');
  assert.equal(result.records, 64542);
  assert.equal(result.covered, 64542);
  assert.equal(result.receipts.length, 13);
  assert.equal(log.length, 30294365);
  record('c-full-px4-64542-record-native-baseline', result, { bytes: log.length, receiptCount: result.receipts.length, elapsedMs, workerStreaming: 'covered by newweb/tests/edge-matrix.mjs' });
});

testCase('case d: a copied payload-byte flip with CRC recomputed fails at the hash link', async () => {
  const { verify } = await native();
  const original = await readFile(sample('intact.fseal'));
  const altered = Buffer.from(original);
  const first = recordOffsets(altered)[0];
  assert.ok(first.payloadLength > 0, 'fixture must have a payload byte to flip');
  const byte = first.offset + 20;
  altered[byte] ^= 1;
  const crcStart = first.end - 4;
  altered.writeUInt32LE(crc32(altered.subarray(first.offset, crcStart)), crcStart);
  const result = verify(altered);
  assert.equal(result.verdict, 'tampered');
  assert.equal(result.status, 'bad-link');
  assert.equal(result.records, 0);
  record('d-payload-byte-flip-crc-recomputed', result, { flippedByteOffset: byte, crcRecomputed: true });
});

testCase('case e: deleting one complete middle record fails at that record with a sequence break', async () => {
  const { verify } = await native();
  const original = await readFile(sample('intact.fseal'));
  const offsets = recordOffsets(original);
  const index = Math.floor(offsets.length / 2);
  const removed = offsets[index];
  const altered = Buffer.concat([original.subarray(0, removed.offset), original.subarray(removed.end)]);
  const result = verify(altered);
  assert.equal(result.status, 'bad-seq');
  assert.equal(result.records, index);
  assert.equal(result.verdict, 'tampered');
  record('e-middle-record-deletion', result, { removedRecordIndex: index, removedBytes: removed.end - removed.offset });
});

testCase('case f: a torn tail is incomplete without a receipt and tampered when a trusted receipt proves the suffix', async () => {
  const { verify } = await native();
  const original = await readFile(sample('intact.fseal'));
  const torn = original.subarray(0, original.length - 5);
  const chainOnly = verify(torn);
  assert.equal(chainOnly.status, 'torn-tail');
  assert.equal(chainOnly.verdict, 'incomplete');
  const receipts = await readFile(sample('flight.receipts'), 'utf8');
  const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
  const witnessed = verify(torn, receipts, key);
  assert.equal(witnessed.status, 'torn-tail');
  assert.equal(witnessed.verdict, 'tampered');
  assert.ok(witnessed.receipts.some(item => item.check === 'log-shorter'));
  record('f-torn-final-record-chain-only', chainOnly, { removedTailBytes: 5, receiptConclusion: 'incomplete without trusted receipt' });
  record('f-torn-final-record-trusted-receipt', witnessed, { removedTailBytes: 5, receiptConclusion: 'tampered; signed suffix checkpoint is longer than the log' });
});

testCase('case g: a timestamp reversal is counted while the native hash chain and receipt remain intact', async () => {
  const { verify, seal } = await native();
  const sealed = seal('300\tfirst\n100\tbackward\n200\tforward-again\n', 3);
  assert.equal(sealed.error, undefined);
  const key = sealed.publicKey;
  const result = verify(sealed.bytes, sealed.receipts, key);
  assert.equal(result.verdict, 'intact');
  assert.equal(result.records, 3);
  assert.equal(result.covered, 3);
  assert.equal(result.timeReversals, 1);
  record('g-timestamp-reversal', result, { reversalCount: result.timeReversals, sealedWithActualNativeWriter: true });
});

testCase('case h: malformed and non-log inputs fail natively instead of returning a stale positive verdict', async () => {
  const { verify } = await native();
  const malformedSource = 'not a FlightSeal log\n';
  const logResult = verify(Buffer.from(malformedSource));
  assert.equal(logResult.verdict, 'tampered');
  assert.equal(logResult.status, 'bad-header');
  const receipts = await readFile(sample('flight.receipts'), 'utf8');
  const key = (await readFile(sample('pubkey.txt'), 'utf8')).trim();
  const parseError = verify(await readFile(sample('intact.fseal')), 'not a receipt', key);
  assert.match(parseError.error, /invalid receipt at line 1/);
  record('h-non-log-upload', logResult, { parseFailure: logResult.status });
  record('h-malformed-receipts-input', parseError, { recovery: 'browser retry with valid log and receipt covered by edge-matrix' });
});

testCase('case i: native Writer seals TSV, issues boundary receipts, rejects invalid intervals and malformed rows', async () => {
  const { verify, seal } = await native();
  const rows = '100\talpha\n200\tbravo\n300\tcharlie\n400\tdelta\n500\techo\n';
  const sealed = seal(rows, 2);
  assert.equal(sealed.error, undefined);
  assert.equal(sealed.records, 5);
  assert.equal(sealed.receipts.trim().split('\n').length, 3);
  const checked = verify(sealed.bytes, sealed.receipts, sealed.publicKey);
  assert.equal(checked.verdict, 'intact');
  assert.equal(checked.records, 5);
  assert.equal(checked.covered, 5);
  const invalidIntervals = [0, 1000001].map(every => ({ every, error: seal(rows, every).error }));
  assert.match(invalidIntervals[0].error, /between 1 and 1,000,000/);
  assert.match(invalidIntervals[1].error, /between 1 and 1,000,000/);
  const invalidRows = ['x\tbad\n', '500\tvalid\nno-tab\n', '-1\tnegative\n'];
  const rowErrors = invalidRows.map(tsv => seal(tsv, 2).error);
  assert.match(rowErrors[0], /invalid unsigned timestamp/);
  assert.match(rowErrors[1], /expected timestamp_us<TAB>payload/);
  assert.match(rowErrors[2], /invalid unsigned timestamp/);
  record('i-native-custom-tsv-interval-2', checked, { recordCount: 5, interval: 2, receiptCounts: checked.receipts.map(item => item.count), downloadableArtifacts: ['FLTSEAL1 log bytes', 'receipt text', 'public key'], invalidIntervals, invalidRowErrors: rowErrors });
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

after(async () => {
  await mkdir(dirname(evidenceFile), { recursive: true });
  const passed = requiredCases.filter(item => item.status === 'passed').length;
  const failed = requiredCases.filter(item => item.status === 'failed').length;
  const notRun = requiredCases.filter(item => item.status === 'not-run').length;
  const allPassed = requiredCases.length === 9 && passed === 9 && failed === 0 && notRun === 0 && cases.length === 11;
  await writeFile(evidenceFile, JSON.stringify({
    suite: 'FlightSeal native Wasm nine-case edge matrix',
    testCases: requiredCases.length,
    caseResults: requiredCases,
    passed,
    failed,
    notRun,
    observations: cases.length,
    expectedObservations: 11,
    cases,
    allPassed,
    engine: 'C++ / OpenSSL / WebAssembly',
  }, null, 2));
  console.log(`native edge evidence: ${evidenceFile}`);
});

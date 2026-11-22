import assert from 'node:assert/strict';
import test from 'node:test';
import { createProofBundle, makeProofReport, openProofBundle, proofReportItem, readSignedReport } from '../src/proof-bundle.mjs';
import { createStoreZip } from '../src/zip-store.mjs';

const log = new Blob(['manifest']);
const receipt = 'receipt';
const report = makeProofReport({ caseId: 'CLAIM-123', flightEnded: null, sealedAt: '2026-11-22T12:00:00.000Z' });

test('the archive contains three bounded proof artifacts', async () => {
  const bundle = await openProofBundle(await createProofBundle(log, receipt, report));
  assert.equal(await bundle.log.text(), 'manifest');
  assert.equal(bundle.text, receipt);
  assert.equal(await bundle.report.text(), await report.text());
});

test('truncation, duplicate entries and inconsistent headers fail closed', async () => {
  const bundle = await createProofBundle(log, receipt, report);
  await assert.rejects(openProofBundle(await createProofBundle(log, '', report)), /original HashWing proof ZIP/);
  await assert.rejects(openProofBundle(bundle.slice(0, -1)), /original HashWing proof ZIP/);
  const bad = new Uint8Array(await bundle.arrayBuffer());
  bad[14] ^= 1;
  await assert.rejects(openProofBundle(new Blob([bad])), /original HashWing proof ZIP/);
  const duplicate = await createStoreZip(['manifest.fseal', 'receipt.txt', 'receipt.txt'].map(name => ({ name, blob: log })));
  await assert.rejects(openProofBundle(duplicate), /original HashWing proof ZIP/);
  await assert.rejects(openProofBundle(new Blob([new Uint8Array(400_000)])), /original HashWing proof ZIP/);
});

test('the last signed item identifies the report even when an original shares the name', async () => {
  const item = await proofReportItem(report);
  const manifest = { items: [{ ...item, bytes: 1 }, item] };
  assert.equal((await readSignedReport(report, manifest)).caseId, 'CLAIM-123');
  await assert.rejects(readSignedReport(report, { items: [item, { ...item, note: '' }] }), /does not match the signed list/);
  const altered = new Blob([(await report.text()).replace('CLAIM-123', 'CLAIM-124')]);
  await assert.rejects(readSignedReport(altered, manifest), /does not match the signed list/);
  await assert.rejects(readSignedReport(report, { items: [item] }), /does not match the signed list/);
});

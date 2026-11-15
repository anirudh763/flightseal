import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { createIntegrityPdf, fingerprintPublicKey } from '../src/report-pdf.mjs';

test('public key fingerprint is the full SHA-256 digest of the raw 32-byte key', async () => {
  const publicKey = Buffer.alloc(32, 0xa5);
  const expected = `SHA-256:${createHash('sha256').update(publicKey).digest('hex')}`;
  assert.equal(await fingerprintPublicKey(publicKey.toString('hex')), expected);
  assert.equal((await fingerprintPublicKey(publicKey.toString('hex'))).length, 'SHA-256:'.length + 64);
  assert.equal(await fingerprintPublicKey('not-a-key'), 'Unavailable');
});

test('integrity report builds a readable PDF with complete long hash lines', async () => {
  const head = 'a'.repeat(64);
  const bytes = await createIntegrityPdf({ title: 'HashWing integrity report', lines: [`Chain head: ${head}`, 'Receipt signatures checked: yes', 'No signed issue time is present in receipt v1.'] });
  assert.equal(String.fromCharCode(...bytes.slice(0, 5)), '%PDF-');
  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(loaded.getPageCount(), 1);
  assert.equal(loaded.getTitle(), 'HashWing integrity report');
  assert.equal(loaded.getCreationDate(), undefined, 'a report export date is not receipt evidence');
  assert.ok(bytes.length > 500);
});

test('integrity report paginates long receipt histories', async () => {
  const bytes = await createIntegrityPdf({ lines: Array.from({ length: 180 }, (_, i) => `Receipt ${i + 1}: native check ok; head ${String(i).padStart(64, '0')}`) });
  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.ok(loaded.getPageCount() > 1);
});

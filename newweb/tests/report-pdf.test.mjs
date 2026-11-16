import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString } from 'pdf-lib';
import { decodePDFRawStream } from 'pdf-lib/cjs/core/index.js';
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
  const root = loaded.context.lookup(loaded.catalog.get(PDFName.of('StructTreeRoot')), PDFDict);
  const parentTree = loaded.context.lookup(root.get(PDFName.of('ParentTree')), PDFDict).lookup(PDFName.of('Nums'), PDFArray);
  assert.equal(parentTree.size(), loaded.getPageCount() * 2);
  for (const [index, page] of loaded.getPages().entries()) assert.equal(page.node.get(PDFName.of('StructParents')).asNumber(), index);
});

test('PDF carries document language and preserves unsupported Unicode identifiers losslessly', async () => {
  const bytes = await createIntegrityPdf({ lines: ['## Receipt checks', 'File: Café-東京-שלום.fseal'] });
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(pdf.catalog.lookup(PDFName.of('Lang'), PDFString).decodeText(), 'en');
  assert.equal(pdf.catalog.lookup(PDFName.of('MarkInfo'), PDFDict).lookup(PDFName.of('Marked')).asBoolean(), true);
  const tree = pdf.context.lookup(pdf.catalog.get(PDFName.of('StructTreeRoot')), PDFDict);
  const children = tree.lookup(PDFName.of('K'), PDFArray);
  const roles = Array.from({ length: children.size() }, (_, index) => pdf.context.lookup(children.get(index), PDFDict).lookup(PDFName.of('S'), PDFName).asString());
  assert.deepEqual(roles, ['/H1', '/P', '/P', '/H2', '/P']);
  const parentTree = pdf.context.lookup(tree.get(PDFName.of('ParentTree')), PDFDict);
  const parentNums = parentTree.lookup(PDFName.of('Nums'), PDFArray);
  assert.equal(parentNums.lookup(0, PDFNumber).asNumber(), 0);
  assert.equal(parentNums.lookup(1, PDFArray).size(), children.size());
  const contentRefs = pdf.getPages()[0].node.Contents();
  const streams = pdf.context.lookup(contentRefs, PDFArray);
  const content = Array.from({ length: streams.size() }, (_, index) => {
    const stream = pdf.context.lookup(streams.get(index), PDFRawStream);
    return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  }).join('\n');
  assert.equal((content.match(/BDC/g) || []).length, children.size());
  assert.match(content, /556E69636F64652066616C6C6261636B/);
  assert.match(content, /436166E92D5B552B363737315D5B552B344541435D2D5B552B303545395D5B552B303544435D5B552B303544355D5B552B303544445D2E667365616C/);
  assert.doesNotMatch(content, /4361663F2D3F3F\.667365616C/);
});

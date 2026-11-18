// The visible text of a HashWing PDF (report-pdf.mjs): its Helvetica runs are hex strings of WinAnsi bytes, one
// `<hex> Tj` per wrapped line, so decode them back to text. Lines come back joined with "\n".
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const { PDFArray, PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');
const { decodePDFRawStream } = require('pdf-lib/cjs/core/index.js');

export async function pdfText(pathOrBytes) {
  const bytes = typeof pathOrBytes === 'string' ? readFileSync(pathOrBytes) : pathOrBytes;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPages().map((page) => {
    const refs = page.node.get(PDFName.of('Contents'));
    const list = page.node.context.lookup(refs);
    const streams = list instanceof PDFArray ? Array.from({ length: list.size() }, (_, i) => list.get(i)) : [refs];
    return streams.map((ref) => Buffer.from(decodePDFRawStream(page.node.context.lookup(ref, PDFRawStream)).decode()).toString('latin1')).join('\n');
  }).join('\n').split('\n')
    .map((line) => [...line.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join(''))
    .filter(Boolean).join('\n');
}

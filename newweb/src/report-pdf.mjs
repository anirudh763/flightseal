import { PDFDocument, PDFName, PDFNumber, PDFOperator, StandardFonts, rgb } from 'pdf-lib';

export async function fingerprintPublicKey(publicKeyHex) {
  const text = String(publicKeyHex || '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2}){32}$/.test(text)) return 'Unavailable';
  if (!globalThis.crypto?.subtle) return 'Unavailable';
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `SHA-256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function pdfSafeText(value, font) {
  return Array.from(String(value ?? ''), (character) => {
    if (character === '\n' || character === '\t' || character === '\r') return ' ';
    try { font.encodeText(character); return character; }
    catch { return `[U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`; }
  }).join('');
}

function wrapLine(value, font, width = 92) {
  const words = pdfSafeText(value, font).split(/\s+/).flatMap((word) => {
    if (word.length <= width) return [word];
    const chunks = [];
    for (let offset = 0; offset < word.length; offset += width) chunks.push(word.slice(offset, offset + width));
    return chunks;
  });
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

export async function createIntegrityPdf({ title = 'HashWing integrity report', lines = [] } = {}) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(title);
  pdf.setSubject('Local integrity and receipt checks');
  pdf.setCreator('HashWing');
  pdf.setLanguage('en');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [612, 792];
  const margin = 48;
  let page = pdf.addPage(pageSize);
  const structureRoot = pdf.context.obj({ Type: 'StructTreeRoot', K: [] });
  const structureRootRef = pdf.context.register(structureRoot);
  const kids = structureRoot.lookup(PDFName.of('K'));
  const pages = [{ page, elements: [] }];
  let y = 744;
  const addPage = () => {
    page = pdf.addPage(pageSize); pages.push({ page, elements: [] }); y = 744;
  };
  const addStructuredText = (text, role, font, size) => {
    const pageTags = pages.at(-1).elements;
    const mcid = pageTags.length;
    const element = pdf.context.obj({ Type: 'StructElem', S: role, P: structureRootRef, Pg: page.ref, K: mcid });
    const elementRef = pdf.context.register(element);
    pageTags.push(elementRef); kids.push(elementRef);
    page.pushOperators(PDFOperator.of('BDC', [PDFName.of(role), pdf.context.obj({ MCID: mcid })]));
    page.drawText(text, { x: margin, y, size, font, color: rgb(0.12, 0.17, 0.18), maxWidth: pageSize[0] - margin * 2 });
    page.pushOperators(PDFOperator.of('EMC'));
  };
  const write = (text, { heading = false, gap = 0, role } = {}) => {
    const chosenFont = heading ? bold : font;
    for (const part of wrapLine(text, chosenFont)) {
      if (y < margin + 12) addPage();
      addStructuredText(part, role || (heading ? 'H2' : 'P'), chosenFont, heading ? 12 : 9);
      y -= heading ? 19 : 14;
    }
    y -= gap;
  };
  write(title, { heading: true, gap: 8, role: 'H1' });
  const hasUnicodeFallback = lines.some((line) => pdfSafeText(line, font) !== String(line));
  if (hasUnicodeFallback) write('Unicode fallback: [U+XXXX] preserves the exact code point when this PDF font cannot display a character.');
  for (const line of lines) {
    if (line === '') y -= 7;
    else if (String(line).startsWith('## ')) write(String(line).slice(3), { heading: true, gap: 3 });
    else write(line);
  }
  const parentNums = pdf.context.obj([]);
  pages.forEach(({ page: taggedPage, elements }, key) => {
    taggedPage.node.set(PDFName.of('StructParents'), PDFNumber.of(key));
    const parentArray = pdf.context.obj([]);
    elements.forEach((element) => parentArray.push(element));
    parentNums.push(PDFNumber.of(key)); parentNums.push(parentArray);
  });
  const parentTree = pdf.context.register(pdf.context.obj({ Nums: parentNums }));
  structureRoot.set(PDFName.of('ParentTree'), parentTree);
  structureRoot.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(pages.length));
  pdf.catalog.set(PDFName.of('StructTreeRoot'), structureRootRef);
  pdf.catalog.set(PDFName.of('MarkInfo'), pdf.context.obj({ Marked: true }));
  return pdf.save();
}

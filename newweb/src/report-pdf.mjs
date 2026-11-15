import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function fingerprintPublicKey(publicKeyHex) {
  const text = String(publicKeyHex || '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2}){32}$/.test(text)) return 'Unavailable';
  if (!globalThis.crypto?.subtle) return 'Unavailable';
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `SHA-256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function wrapLine(value, width = 92) {
  const words = String(value ?? '').replace(/[^\x20-\x7e]/g, '?').split(/\s+/).flatMap((word) => {
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
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize = [612, 792];
  const margin = 48;
  let page = pdf.addPage(pageSize);
  let y = 744;
  const addPage = () => { page = pdf.addPage(pageSize); y = 744; };
  const write = (text, { heading = false, gap = 0 } = {}) => {
    const chosenFont = heading ? bold : font;
    for (const part of wrapLine(text)) {
      if (y < margin + 12) addPage();
      page.drawText(part, { x: margin, y, size: heading ? 12 : 9, font: chosenFont, color: rgb(0.12, 0.17, 0.18), maxWidth: pageSize[0] - margin * 2 });
      y -= heading ? 19 : 14;
    }
    y -= gap;
  };
  write(title, { heading: true, gap: 8 });
  for (const line of lines) {
    if (line === '') y -= 7;
    else if (String(line).startsWith('## ')) write(String(line).slice(3), { heading: true, gap: 3 });
    else write(line);
  }
  return pdf.save();
}

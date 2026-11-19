// Seal & send, Manifest only: a real UI flow in Chrome. Seal three files, check them back with one modified, one
// missing and one extra; refuse without a trusted key; Cancel stops hashing; no request body carries file bytes;
// axe 0 violations and no horizontal scroll at 320/768/1440. Run after `npm --prefix newweb run build`.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync, writeSync, utimesSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from '../../tests/web/serve.mjs';
import { BYTES_DIFFER } from '../src/recipient-trust.mjs';
import { pdfText } from './pdf-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const differOnce = async (page) => (await page.locator('#main').innerText()).split(BYTES_DIFFER.text).length - 1;
const EVIDENCE = join(process.env.REACT_CONSOLE_EVIDENCE || join(ROOT, '.test-artifacts'), 'manifest-mode');
mkdirSync(EVIDENCE, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { server, url: rootUrl } = await serve(0, '/flightseal');
const url = `${rootUrl}console/`;
const dir = mkdtempSync(join(tmpdir(), 'hashwing-manifest-ui-'));
const checks = [];
const runtimeErrors = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: String(error.message || error) }); console.error(`FAIL ${name}: ${error.message || error}`); }
}
async function layout(page, label) {
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const d = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(d.doc <= d.client + 1, `${label} ${width}px horizontal scroll: ${JSON.stringify(d)}`);
    await page.evaluate(AXE);
    const results = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
    assert.equal(results.violations.length, 0, `${label} ${width}px: ${results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`).join(' | ')}`);
    await page.screenshot({ path: join(EVIDENCE, `${label.replace(/\W+/g, '-')}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const marker = randomBytes(64);
const write = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
const a = Buffer.concat([randomBytes(100_000), marker, randomBytes(100_000)]);
const b = randomBytes(300_000), c = randomBytes(5_000);
const sealPaths = [write('a.bin', a), write('b.bin', b), write('c.bin', c)];
const secrets = [marker, a.subarray(0, 64), b.subarray(0, 64), c.subarray(0, 64)];

let browser;
try {
  const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const requests = [];
  context.on('request', (request) => requests.push(request));
  const page = await context.newPage();
  page.on('pageerror', (error) => runtimeErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  await page.goto(url);
  await page.getByRole('link', { name: 'Seal files', exact: true }).click(); // the front door's primary action
  await page.waitForFunction(() => location.hash === '#/app/protect' && document.querySelector('.commandbar h1')?.textContent === 'Seal & send');
  let handover, sealedPath, publicKey;
  // The checkers live on Verify and the sealers on Seal & send (R15).
  const goTo = async (screen) => {
    await page.evaluate((s) => { if (location.hash.split('?')[0] !== `#/app/${s}`) location.hash = `/app/${s}`; }, screen);
    await page.waitForFunction((t) => document.querySelector('.commandbar h1')?.textContent === t, screen === 'verify' ? 'Verify' : 'Seal & send');
  };
  // A download click is not proof, so Seal more files asks once whether it saved. The receipt message was not kept in
  // these flows, so "I saved it" is not offered; "Discard it" moves on.
  const confirmedMore = async () => {
    await page.getByRole('button', { name: 'Seal more files' }).click();
    assert.match(await page.locator('#seal-more-ask').innerText(), /^You started a download of .+\. Did it save\? The receipt message isn't saved yet\.$/);
    assert.equal(await page.locator('.confirm-box').getByRole('button', { name: /I saved/ }).count(), 0);
    await page.locator('.confirm-box').getByRole('button', { name: 'Discard it' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'seal-what-title');
  };
  const sealMore = async () => { await goTo('protect'); await confirmedMore(); };
  // Verify's files form: the key someone gave separately sits under More options; Originals appear for a list.
  const fillKey = async (target, key) => {
    const options = target.locator('[aria-labelledby="check-title"] .check-options');
    if (!(await options.evaluate((d) => d.open))) await options.locator('summary').click();
    await target.locator('#check-key').fill(key);
  };


  await check('Small file (embedded) is the default and keeps its controls', async () => {
    assert.equal(await page.getByLabel('Small file: seal the whole file, up to 45 MiB').isChecked(), true);
    assert.equal(await page.locator('#protect-file').count(), 1);
    assert.equal(await page.locator('#manifest-files').isVisible(), false);
  });

  await check('friendly limit errors say what to do next, before any hashing', async () => {
    await page.getByLabel('Large files: fingerprint only, files stay where they are').check();
    const many = Array.from({ length: 101 }, (_, i) => write(`many-${i}.txt`, Buffer.from(String(i))));
    await page.locator('#manifest-files').setInputFiles(many);
    const fieldError = async (re) => { // the focus table: focus on the field, the message read with it, no alert on top
      await page.waitForFunction(() => document.activeElement?.id === 'manifest-files');
      assert.equal(await page.locator('#manifest-files').getAttribute('aria-describedby'), 'manifest-error');
      assert.match(await page.locator('#manifest-error').textContent(), re);
      assert.equal(await page.locator('.manifest-body [role=alert]').count(), 0);
    };
    await fieldError(/You picked 101 files\. Choose up to 100 at a time/);
    await page.locator('#manifest-files').setInputFiles(sealPaths[2]);
    await page.locator('.manifest-options summary').click();
    await page.locator('#manifest-note-0').fill('x'.repeat(1001));
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await fieldError(/note exceeds 1000 UTF-8 bytes\. Shorten it under More options/);
    assert.equal(await page.locator('[id^=manifest-seal-progress-]').count(), 0, 'nothing was hashed');
    await page.locator('.manifest-options summary').click();
  });

  await check('Large files: seal three files, one record and a count=1 receipt, steps and not-a-backup notice', async () => {
    assert.equal(await page.locator('#protect-file').count(), 0);
    assert.match(await page.locator('.manifest-notice').textContent(), /This keeps a fingerprint, not a copy\. Keep your original files\./);
    await page.locator('.manifest-help summary').click();
    assert.match(await page.locator('.manifest-help').innerText(), /A manifest is not a backup\./);
    await page.locator('#manifest-files').setInputFiles([]);
    assert.equal(await page.getByRole('button', { name: 'Seal the list', exact: true }).isEnabled(), false);
    await page.locator('#manifest-files').setInputFiles(sealPaths);
    assert.equal(await page.locator('.seal-total').innerText(), `Total ${sealPaths.length} files\n${sealPaths.reduce((n, f) => n + readFileSync(f).length, 0).toLocaleString('en-US')} bytes`);
    await page.locator('.manifest-options summary').click();
    await page.locator('#manifest-note-0').fill('');
    await page.getByLabel('Include file names').check();
    await page.locator('#manifest-note-1').fill('Camera B, landed 14:02');
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await page.waitForSelector('#manifest-handover-text', { timeout: 60000 });
    assert.equal(await page.locator('#manifest-handoff-title').innerText(), 'Send these to your client');
    assert.deepEqual(await page.locator('[id^=manifest-seal-progress-]').count(), 0);
    handover = await page.locator('#manifest-handover-text').inputValue();
    const receipts = handover.split('\n').filter((line) => line.startsWith('fseal-receipt v1 '));
    assert.equal(receipts.length, 1);
    assert.match(receipts[0], /count=1 /);
    assert.ok(!handover.includes('a.bin') && !handover.includes('Camera B'), 'no names or notes in the handover');
    publicKey = /Public key: ([0-9a-f]{64})/.exec(handover)[1];
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed list' }).click()]);
    assert.match(download.suggestedFilename(), /^hashwing-\d{8}-\d{6}\.manifest\.fseal$/);
    sealedPath = join(EVIDENCE, 'sealed.manifest.fseal');
    await download.saveAs(sealedPath);
    const sealed = readFileSync(sealedPath);
    assert.equal(sealed.subarray(0, 8).toString(), 'FLTSEAL1');
    assert.equal(sealed.length, 8 + 20 + sealed.readUInt32LE(8) + 36, 'exactly one record, nothing after it');
    await layout(page, 'manifest sealed');
  });

  await check('the sealed list survives a route change, with unique ids on the other screen', async () => {
    await page.evaluate(() => { location.hash = '/app/verify'; });
    await page.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Verify');
    const duplicates = await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map((el) => el.id); return ids.filter((id, i) => ids.indexOf(id) !== i); });
    assert.deepEqual(duplicates, []);
    await page.evaluate(() => { location.hash = '/app/protect'; });
    await page.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Seal & send');
    assert.equal(await page.locator('#manifest-handover-text').inputValue(), handover);
    await page.evaluate(() => { location.hash = '/app/verify'; }); // the checker lives on Verify
    await page.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Verify');
  });

  await check('Check: modified, missing and extra files get Bytes differ / Missing / Not in the list, and the headline "Files differ"', async () => {
    const changed = Buffer.from(a); changed[10] ^= 1;
    const localPaths = [join(dir, 'local'), join(dir, 'local', 'a.bin'), join(dir, 'local', 'b.bin'), join(dir, 'local', 'extra.bin')];
    mkdirSync(localPaths[0], { recursive: true });
    writeFileSync(localPaths[1], changed); writeFileSync(localPaths[2], b); writeFileSync(localPaths[3], randomBytes(77));
    await page.locator('#check-file').setInputFiles(sealedPath);
    await page.locator('#check-text').fill(handover);
    await page.locator('#check-originals').setInputFiles(localPaths.slice(1));
    await fillKey(page, publicKey);
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.waitForSelector('.manifest-table', { timeout: 60000 });
    const rows = await page.locator('.manifest-table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim())));
    assert.deepEqual(rows.map((r) => [r[0].split('\n')[0], r[1], r[2].split('\n')[0]]), [['a.bin', '200,064', 'Bytes differ'], ['b.bin', '300,000', 'Matches'], ['c.bin', '—', 'Missing'], ['extra.bin', '77', 'Not in the list']]);
    assert.match(rows[1][0], /Operator note: Camera B, landed 14:02/);
    // EXPERIENCE.md "Verify verdicts": Files differ wins over Incomplete and Not in the list; focus is on the headline.
    assert.equal(await page.locator('#verdict-heading').innerText(), 'Files differ');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'verdict-heading');
    assert.match(await page.locator('.verdict-lines').innerText(), /Signature\s+Valid[\s\S]*Files\s+1 match · 1 differs · 1 missing · 1 not in the list[\s\S]*Receipt coverage\s+All items covered/);
    assert.match(await page.locator('.verdict-next').innerText(), /Next step: Ask for the original files/);
    assert.equal(await page.locator('.manifest-outcome .trust-line').innerText(), "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.");
    const chips = await page.locator('.manifest-table .status-label').evaluateAll((els) => els.map((el) => [el.textContent, el.className]));
    assert.deepEqual(chips, [['Bytes differ', 'status-label warn'], ['Matches', 'status-label ok'], ['Missing', 'status-label warn'], ['Not in the list', 'status-label warn']]);
    const text = await page.locator('.manifest-outcome').innerText();
    assert.doesNotMatch(text, /tampered(?! )/i);
    await layout(page, 'manifest checked');
    assert.ok(!rows[0][2].includes(BYTES_DIFFER.text), 'the row keeps its status; the verdict says why once');
    assert.equal(await differOnce(page), 1, 'the Files differ explanation is shown once');
  });

  await check('Wrong key: Not verified and no item statuses; no key: the message\'s key checks it, signer not confirmed', async () => {
    await fillKey(page, 'ab'.repeat(32));
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.waitForFunction(() => document.querySelector('#verdict-heading')?.textContent === 'Not verified', null, { timeout: 30000 });
    assert.match(await page.locator('.manifest-outcome').innerText(), /Not verified[\s\S]*trusted public key[\s\S]*entered the key the sender gave you separately/);
    assert.equal(await page.locator('.manifest-table').count(), 0);
    await fillKey(page, '');
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.waitForSelector('.manifest-table', { timeout: 60000 });
    assert.equal(await page.locator('#verdict-heading').innerText(), 'Files differ');
    assert.equal(await page.locator('.manifest-outcome .trust-line').innerText(), "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.");
  });

  await check('Cancel stops hashing and the UI is usable again', async () => {
    const big = join(dir, 'big.bin'); const fd = openSync(big, 'w'); ftruncateSync(fd, 2 ** 31); closeSync(fd);
    await page.evaluate(() => { location.hash = '/app/protect'; });
    await confirmedMore(); // the list was downloaded
    await page.locator('#manifest-files').setInputFiles(big);
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await page.waitForSelector('#manifest-seal-progress-0');
    await page.waitForFunction(() => Number(document.querySelector('#manifest-seal-progress-0')?.value) > 0);
    await page.waitForFunction(() => /\d+% · \d+\.\d MB\/s/.test(document.querySelector('.manifest-progress')?.textContent || ''));
    await layout(page, 'manifest hashing');
    const before = await page.locator('#manifest-seal-progress-0').evaluate((el) => el.value);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => !document.querySelector('#manifest-seal-progress-0') && [...document.querySelectorAll('[role=status]')].some((n) => n.textContent === 'Sealing cancelled. Your files are still chosen.'));
    await page.waitForFunction(() => document.activeElement?.id === 'manifest-seal', null, { timeout: 3000 });
    assert.equal(await page.locator('.seal-total').innerText(), 'Total 1 file\n2,147,483,648 bytes', 'the selection is kept');
    assert.ok(before < 2 ** 31, 'cancelled before the end');
    assert.equal(await page.getByRole('button', { name: 'Seal the list', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('#manifest-handover-text').count(), 0);
    rmSync(big);
  });

  await check('Cancel keeps the files already hashed: Seal again does not hash the first file twice', async () => {
    const sparse = (name, size) => { const p = join(dir, name); const fd = openSync(p, 'w'); ftruncateSync(fd, size); closeSync(fd); return p; };
    const zerosDigest = (size) => { const h = createHash('sha256'); const chunk = Buffer.alloc(64 * 2 ** 20); for (let n = 0; n < size; n += chunk.length) h.update(chunk); return h.digest(); };
    const first = sparse('first.bin', 256 * 2 ** 20), second = sparse('second.bin', 2 ** 30);
    await page.locator('#manifest-files').setInputFiles([first, second]);
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('#manifest-seal-progress-1')?.value) > 0, null, { timeout: 60000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => !document.querySelector('#manifest-seal-progress-1') && [...document.querySelectorAll('[role=status]')].some((n) => n.textContent === 'Sealing cancelled. Your files are still chosen. Files already read are reused; choose them again to re-read everything.'));
    await page.evaluate(() => {
      window.__sealLabels = [];
      const note = () => { const label = document.querySelector('.seal-progress label[for="manifest-seal-progress"]'); if (label) window.__sealLabels.push(label.textContent); };
      window.__sealObserver = new MutationObserver(note);
      window.__sealObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await page.waitForSelector('#manifest-handover-text', { timeout: 120000 });
    const labels = await page.evaluate(() => { window.__sealObserver.disconnect(); return window.__sealLabels; });
    const sealedCount = await page.getByText('Sealed 2 files.', { exact: true }).count();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed list' }).click()]);
    const listPath = join(dir, 'kept.manifest.fseal'); await download.saveAs(listPath);
    await confirmedMore(); // clear the result first, so a failure here leaves the next checks a clean page
    rmSync(first); rmSync(second);
    assert.ok(labels.length > 0, 'the progress label was seen');
    assert.ok(!labels.some((text) => text.startsWith('Sealing 1 of 2')), `the first file was hashed again: ${[...new Set(labels)].slice(0, 3).join(' | ')}`);
    assert.equal(sealedCount, 1, 'the result reads 2 files');
    const sealed = readFileSync(listPath);
    const at = (digest) => Math.max(sealed.indexOf(digest), sealed.indexOf(Buffer.from(digest.toString('hex'))));
    const [d1, d2] = [at(zerosDigest(256 * 2 ** 20)), at(zerosDigest(2 ** 30))];
    assert.ok(d1 >= 0 && d2 > d1, `the first item's digest is the 256 MiB file's (${d1}, ${d2})`);
  });

  await check('a kept file changed on disk (new modified time) after Cancel is refused, not sealed with its old fingerprint', async () => {
    const sparse = (name, size) => { const p = join(dir, name); const fd = openSync(p, 'w'); ftruncateSync(fd, size); closeSync(fd); return p; };
    const first = sparse('edited-first.bin', 64 * 2 ** 20), second = sparse('edited-second.bin', 2 ** 30);
    try {
      await page.locator('#manifest-files').setInputFiles([first, second]);
      await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
      await page.waitForFunction(() => Number(document.querySelector('#manifest-seal-progress-1')?.value) > 0, null, { timeout: 60000 });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some((n) => n.textContent === 'Sealing cancelled. Your files are still chosen. Files already read are reused; choose them again to re-read everything.'));
      const fd = openSync(first, 'r+'); writeSync(fd, Buffer.from('edited'), 0, 6, 0); closeSync(fd); // same size, new bytes
      const later = new Date(Date.now() + 60000); utimesSync(first, later, later);
      await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
      await page.locator('#manifest-error').getByText('Could not read edited-first.bin.', { exact: false }).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('#manifest-handover-text').count(), 0, 'nothing was sealed');
    } finally {
      await page.locator('#manifest-files').setInputFiles([]); // clear the selection for the next checks
      rmSync(first); rmSync(second);
    }
  });

  // Trusted companies live in Settings; a second page in the same context shares this browser's local list.
  const settings = await context.newPage();
  settings.on('pageerror', (error) => runtimeErrors.push(`settings: ${error}`));
  const fingerprintOf = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
  const grouped = (hex) => hex.match(/.{4}/g).join(' ');
  const addCompany = async (name, fingerprint, source, { tick = true } = {}) => {
    await settings.locator('#tc-name').fill(name);
    await settings.locator('#tc-fingerprint').fill(fingerprint);
    if (source) await settings.getByLabel(source, { exact: true }).check();
    await settings.locator('#tc-confirmed').setChecked(tick);
    await settings.getByRole('button', { name: 'Add company' }).click();
  };
  // Reports sit behind the verdict's one "Download report" disclosure; every one starts with the headline's Result line.
  const openReports = (target) => target.locator('.manifest-outcome .verdict-downloads').evaluate((d) => { d.open = true; });
  const trustText = () => page.locator('.manifest-outcome .trust-line').innerText();
  const runCheck = async (key) => {
    await goTo('verify');
    await fillKey(page, key);
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.waitForSelector('.manifest-outcome', { timeout: 60000 });
  };

  await check('Settings: Trusted companies add, replace-confirm, history and compromised; axe at 320/768/1440', async () => {
    await settings.goto(`${url}#/app/settings`);
    await settings.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Settings');
    await settings.locator('.trusted-companies-details > summary').click();
    assert.equal(await settings.locator('#tc-confirmed').isChecked(), false, 'the box starts unticked');
    await addCompany('Acme Survey', 'ab'.repeat(32), '');
    assert.match(await settings.getByRole('alert').innerText(), /Choose where you got this fingerprint/);
    // R34: the "I confirmed this myself" box is required; unticked, nothing is saved and the alert names the box.
    await addCompany('Acme Survey', 'ab'.repeat(32), 'company website you already knew', { tick: false });
    assert.equal(await settings.getByRole('alert').innerText(), 'Tick the box to confirm you checked this fingerprint yourself.');
    assert.equal(await settings.locator('.company-list').count(), 0, 'nothing saved without the tick');
    const box = settings.locator('#tc-confirmed');
    assert.equal(await settings.evaluate(() => document.activeElement?.id), 'tc-confirmed', 'focus lands on the box');
    assert.equal(await box.getAttribute('aria-invalid'), 'true');
    assert.equal(await box.getAttribute('aria-describedby'), 'tc-error');
    await box.check(); // ticking it clears the error and the invalid state
    assert.equal(await settings.locator('#tc-error').count(), 0);
    assert.equal(await box.getAttribute('aria-invalid'), null);
    assert.equal(await box.getAttribute('aria-describedby'), null);
    await addCompany('Acme Survey', 'zz', 'company website you already knew');
    assert.match(await settings.getByRole('alert').innerText(), /64 hexadecimal digits/);
    await addCompany('Acme Survey', 'ab'.repeat(32), 'company website you already knew');
    const sender = fingerprintOf(publicKey);
    await addCompany('Acme Survey', `SHA-256: ${grouped(sender).toUpperCase()}`, 'contract or invoice');
    assert.match(await settings.locator('.confirm-box').innerText(), new RegExp(`already has the key ${grouped('ab'.repeat(32))}`));
    await settings.getByRole('button', { name: 'Keep current key' }).click();
    assert.match(await settings.locator('.company-list').innerText(), new RegExp(grouped('ab'.repeat(32))));
    await addCompany('Acme Survey', `SHA-256: ${grouped(sender).toUpperCase()}`, 'contract or invoice');
    await settings.getByRole('button', { name: 'Replace key' }).click();
    const list = await settings.locator('.company-list').innerText();
    assert.match(list, new RegExp(grouped(sender)));
    assert.match(list, /Added from contract or invoice on \d{4}-\d{2}-\d{2} · confirmed by you/);
    assert.equal(await settings.locator('#tc-confirmed').isChecked(), false, 'the box is cleared after a save');
    await settings.locator('#tc-confirmed').check();
    await settings.getByLabel('other', { exact: true }).check();
    assert.equal(await settings.locator('#tc-confirmed').isChecked(), false, 'changing the channel clears the tick');
    await addCompany('Old Co', 'cd'.repeat(32), 'other');
    await settings.getByRole('button', { name: 'Mark as compromised: Old Co' }).click();
    await settings.locator('.confirm-box').getByRole('button', { name: 'Mark as compromised' }).click();
    assert.doesNotMatch(await settings.locator('.company-list').innerText(), /Old Co/);
    await settings.locator('.trusted-companies details > summary', { hasText: 'Key history' }).click();
    const history = await settings.locator('.company-history').innerText();
    assert.match(history, /Acme Survey[\s\S]*Replaced on \d{4}-\d{2}-\d{2}/);
    assert.match(history, /Old Co[\s\S]*Marked compromised on \d{4}-\d{2}-\d{2}/);
    // Removing a company keeps its compromised record, so that key can't come back and Remove is hidden for it.
    assert.equal(await settings.getByRole('button', { name: 'Remove: Old Co' }).count(), 0, 'no Remove for a name with only compromised records');
    // R35: the compromised mark survives a page reload.
    await settings.reload();
    await settings.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Settings');
    await settings.locator('.trusted-companies-details > summary').click();
    await settings.locator('.trusted-companies details > summary', { hasText: 'Key history' }).click();
    assert.match(await settings.locator('.company-history').innerText(), /Old Co[\s\S]*Marked compromised on \d{4}-\d{2}-\d{2}/, 'after reload');
    assert.doesNotMatch(await settings.locator('.company-list').innerText(), /Old Co/);
    await addCompany('Old Co', 'cd'.repeat(32), 'other');
    assert.equal(await settings.getByRole('alert').innerText(), 'This key was marked as compromised, so it can’t be added again. Ask the company for a new key.');
    await addCompany('Temp Co', 'ef'.repeat(32), 'other');
    await settings.locator('.company-list').getByRole('button', { name: 'Remove: Temp Co' }).click();
    assert.equal(await settings.locator('.confirm-box').innerText().then((t) => t.split('\n')[0]), 'Remove Temp Co from this browser? A key you marked as compromised stays recorded as compromised.');
    await settings.locator('.confirm-box').getByRole('button', { name: 'Remove company' }).click();
    assert.equal(await settings.locator('.trusted-companies [role=status]').innerText(), 'Removed Temp Co.');
    // The same key pinned under two names: marking one compromised shows the other as compromised too.
    await addCompany('Twin A', '12'.repeat(32), 'other');
    await addCompany('Twin B', '12'.repeat(32), 'other');
    await settings.getByRole('button', { name: 'Mark as compromised: Twin A' }).click();
    await settings.locator('.confirm-box').getByRole('button', { name: 'Mark as compromised' }).click();
    const twin = settings.locator('.company-list li', { hasText: 'Twin B' });
    assert.match(await twin.innerText(), /This key was marked as compromised under another name/);
    assert.equal(await twin.getByRole('button', { name: 'Mark as compromised: Twin B' }).count(), 0);
    assert.match(await settings.locator('.company-history').innerText(), /Twin B[\s\S]*Marked compromised under another name/);
    await settings.locator('.trusted-companies details > summary', { hasText: 'What is this?' }).click();
    await layout(settings, 'trusted companies');
  });

  await check('Check: a fingerprint pin with an empty key field is trusted; every export carries trust, source and times', async () => {
    await runCheck('');
    assert.equal(await trustText(), 'Signed by a key you trust: Acme Survey (added from contract or invoice)');
    assert.equal(await page.locator('.manifest-table').count(), 1);
    const save = async (name) => { await openReports(page); const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name, exact: true }).click()]); return readFileSync(await d.path()); };
    for (const name of ['Download text report', 'Download Markdown report']) {
      const report = (await save(name)).toString('utf8');
      assert.match(report, /Key trust: Signed by a key you trust: Acme Survey \(added from contract or invoice\)/, name);
      assert.match(report, /Key source: contract or invoice/, name);
      for (const label of ['Reported landing time', 'Sealed on this computer at', 'Registry acceptance', 'Trusted timestamp', 'Reported landing-to-seal interval']) assert.ok(report.includes(label), `${name}: ${label}`);
      assert.ok(report.includes(BYTES_DIFFER.text), name);
    }
    const json = JSON.parse((await save('Download JSON')).toString('utf8'));
    assert.equal(json.keyTrust.status, 'trusted');
    assert.equal(json.keyTrust.sourceLabel, 'contract or invoice');
    assert.equal(json.timeProvenance.fields.length, 5);
    assert.equal(json.fileComparison.items[0].statusLabel, 'Bytes differ');
    assert.equal((await save('Download PDF')).subarray(0, 5).toString(), '%PDF-');
  });

  await check('Check: a compromised key is flagged and never auto-used; the wrong key still refuses', async () => {
    assert.equal(await trustText(), 'Signed by a key you trust: Acme Survey (added from contract or invoice)');
    await settings.getByRole('button', { name: 'Mark as compromised: Acme Survey' }).click();
    await settings.locator('.confirm-box').getByRole('button', { name: 'Mark as compromised' }).click();
    // The open result re-checks its trust line when a pin changes; no stale "trusted" stays on screen or in exports.
    await page.waitForFunction(() => /marked as compromised: Acme Survey/.test(document.querySelector('.manifest-outcome .trust-line')?.textContent || ''));
    await openReports(page);
    const [stale] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download text report', exact: true }).click()]);
    assert.match(readFileSync(await stale.path(), 'utf8'), /Key trust: Signed by a key you marked as compromised: Acme Survey/);
    // The headline row "Signed by a key marked compromised" wins whatever the files show.
    await runCheck('');
    assert.equal(await page.locator('#verdict-heading').innerText(), 'Signed by a key marked compromised');
    await openReports(page);
    const [first] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download text report', exact: true }).click()]);
    assert.ok(readFileSync(await first.path(), 'utf8').startsWith('Result: Signed by a key marked compromised. '), 'the report starts with the headline');
    assert.doesNotMatch(await page.locator('main').innerText(), /\bIntact\b/);
    assert.match(await page.locator('.manifest-outcome').innerText(), /This key was reported as compromised\. Don't rely on these files until the company confirms them\.[\s\S]*Next step: Ask the company for a new seal/);
    // A different company chosen never hides a compromised signer: compromised outranks the company mismatch.
    await addCompany('Bystander Co', 'ef'.repeat(32), 'contract or invoice');
    await page.locator('#check-company option[value="Bystander Co"]').waitFor({ state: 'attached' });
    await page.locator('#check-company').selectOption('Bystander Co');
    await runCheck('');
    assert.equal(await page.locator('#verdict-heading').innerText(), 'Signed by a key marked compromised', 'list: compromised + another company');
    await page.locator('#check-company').selectOption('');
    await runCheck(publicKey);
    assert.equal(await trustText(), "Signed by a key you marked as compromised: Acme Survey. Don't rely on this proof without checking with the company.");
    await runCheck('ab'.repeat(32));
    assert.match(await page.locator('.manifest-outcome').innerText(), /Not verified[\s\S]*trusted public key/);
    assert.equal(await page.locator('.manifest-table').count(), 0);
  });

  await check('Pin controls on the check form: source required, in-page rotation confirm, history kept', async () => {
    const pin = (id) => page.locator(`#check-key-pin-${id}`);
    const pinButton = page.locator('[aria-labelledby="check-title"]').getByRole('button', { name: 'Pin public key on this device' }); // Verify also has its own pin controls now
    await fillKey(page, publicKey);
    await pin('name').fill('Unit A');
    assert.equal(await pinButton.isEnabled(), false, 'a source is required');
    await pin('source').selectOption('phone');
    assert.equal(await pinButton.isEnabled(), false, 'the confirmation tick is required (R34)');
    await pin('confirmed').check();
    await pinButton.click();
    // The previous check marked this key compromised, so it cannot be pinned again under another name.
    assert.match(await page.locator('[aria-labelledby="check-title"] .trusted-key-controls [role=status]').innerText(), /marked as compromised, so it can’t be added again/);
    const firstKey = 'cd'.repeat(32);
    await page.locator('#check-key').fill(firstKey);
    await page.waitForFunction(() => document.querySelector('#check-key-pin-confirmed')?.checked === false, null, { timeout: 3000 }).catch(() => assert.fail('a new key clears the tick'));
    await pin('name').fill('Unit A');
    await pin('source').selectOption('phone');
    await pin('confirmed').check();
    await pinButton.click();
    assert.match(await page.locator('[aria-labelledby="check-title"] .trusted-key-controls [role=status]').innerText(), /Saved local pin Unit A/);
    await page.locator('#check-key').fill('ab'.repeat(32));
    await pin('name').fill('Unit A');
    await pin('source').selectOption('phone');
    await pin('confirmed').check();
    await pinButton.click();
    const box = page.locator('[aria-labelledby="check-title"] .trusted-key-controls .confirm-box');
    assert.match(await box.innerText(), new RegExp(`Key changed for “Unit A” \\(old fingerprint ${grouped(fingerprintOf(firstKey))}\\)`));
    await box.getByRole('button', { name: 'Keep current key' }).click();
    assert.equal(await box.count(), 0);
    await pinButton.click();
    await page.locator('[aria-labelledby="check-title"] .trusted-key-controls .confirm-box').getByRole('button', { name: 'Replace key' }).click();
    assert.match(await page.locator('[aria-labelledby="check-title"] .trusted-key-controls [role=status]').innerText(), /Saved local pin Unit A/);
    await settings.waitForFunction(() => /Unit A[\s\S]*Replaced on \d{4}-\d{2}-\d{2}/.test(document.querySelector('.company-history')?.textContent || ''));
    assert.match(await settings.locator('.company-list').innerText(), new RegExp(`Unit A[\\s\\S]*${grouped(fingerprintOf('ab'.repeat(32))).slice(0, 14)}`));
  });

  await check('A weak key is never trusted: its fingerprint cannot be added, and a pinned one is refused in every check', async () => {
    const WEAK = JSON.parse(readFileSync(resolve(ROOT, '../tests/fixtures/ed25519-weak-keys.json'), 'utf8'));
    const [{ key: weakKey, sig: weakSig }] = WEAK.weak;
    const weakFp = fingerprintOf(weakKey);
    const trusted = /Signed by a key you trust/;
    await addCompany('Weak Co', grouped(weakFp), 'company website you already knew');
    assert.equal(await settings.getByRole('alert').innerText(), WEAK.error);
    // A pin from before this guard (or written by hand) must still never make the weak key "trusted".
    await page.evaluate(({ fp }) => {
      const store = JSON.parse(localStorage.getItem('flightseal_trusted_keys_v1') || '[]');
      store.push({ name: 'Weak Co', publicKey: '', fingerprint: fp, source: 'website', addedAt: '', status: 'active', confirmedAt: '2026-11-19T00:00:00.000Z' });
      localStorage.setItem('flightseal_trusted_keys_v1', JSON.stringify(store));
    }, { fp: weakFp });
    const forge = (message) => message.replace(/key=[0-9a-f]{64} sig=[0-9a-f]{128}/, `key=${weakKey} sig=${weakSig}`).replace(/Public key: [0-9a-f]{64}/, `Public key: ${weakKey}`);
    const forged = forge(handover);
    assert.notEqual(forged, handover);

    // Large files, key field empty.
    await goTo('verify');
    await page.locator('#check-file').setInputFiles(sealedPath);
    await page.locator('#check-text').fill(forged);
    await page.locator('#check-originals').setInputFiles([]);
    await runCheck('');
    const outcome = await page.locator('.manifest-outcome').innerText();
    assert.match(outcome, /Not verified/);
    assert.ok(outcome.includes(WEAK.error), outcome);
    assert.doesNotMatch(outcome, trusted);
    assert.equal(await page.locator('.manifest-table').count(), 0);

    // Verify, key field empty, with the forged receipt file.
    const receiptsPath = join(dir, 'weak.receipts');
    writeFileSync(receiptsPath, `${forged.split('\n').find((line) => line.startsWith('fseal-receipt v1 '))}\n`);
    await page.evaluate(() => { location.hash = '/app/verify'; });
    await page.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Verify');
    await page.locator('#log-input').setInputFiles(sealedPath);
    await page.locator('#receipt-input').setInputFiles(receiptsPath);
    await page.locator('#trusted-key').fill('');
    await page.getByRole('button', { name: 'Run check' }).click();
    await page.locator('.error-alert').filter({ hasText: WEAK.error }).waitFor({ timeout: 30000 });
    assert.doesNotMatch(await page.locator('main').innerText(), trusted);

    // Small file: seal one, then check it with the forged message.
    const small = write('weak-check.log', Buffer.from('0\tflight\n'));
    await page.evaluate(() => { location.hash = '/app/protect'; });
    await page.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Seal & send');
    await page.getByLabel('Small file: seal the whole file, up to 45 MiB').check();
    await page.locator('#protect-file').setInputFiles(small);
    await page.getByRole('button', { name: 'Seal this file' }).click();
    await page.waitForSelector('#handover-text', { timeout: 60000 });
    const smallHandover = await page.locator('#handover-text').inputValue();
    const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
    const smallSealed = join(dir, 'weak-check.log.fseal'); await d.saveAs(smallSealed);
    await goTo('verify');
    await page.locator('#check-file').setInputFiles(smallSealed);
    await page.locator('#check-text').fill(forge(smallHandover));
    await page.locator('#check-originals').waitFor({ state: 'detached' }); // a small file holds its own bytes
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.locator('#check-file-error').filter({ hasText: WEAK.error }).waitFor({ timeout: 30000 }); // read with its field
    assert.equal(await page.locator('#check-file').getAttribute('aria-describedby'), 'check-file-error');
    assert.doesNotMatch(await page.locator('main').innerText(), trusted);
    await sealMore(); // the sealed file was downloaded
    await page.getByLabel('Large files: fingerprint only, files stay where they are').check();
  });

  await check('Edited copy and re-encoded file: Bytes differ wording, signed derived-from link, negative reported interval', async () => {
    const text = 'Flight 42 notes\nBattery 81%\nLanded on pad B\n';
    const original = write('flight-notes.txt', Buffer.from(text));
    const editedDir = join(dir, 'edited'); mkdirSync(editedDir, { recursive: true });
    const edited = join(editedDir, 'flight-notes-cropped.txt'); writeFileSync(edited, Buffer.from(text.replace('Battery 81%\n', '')));
    const pad = (n) => String(n).padStart(2, '0');
    const later = new Date(Date.now() + 2 * 3600e3);
    const local = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}:${pad(later.getSeconds())}`.replace(/:00$/, ''); // Chrome drops zero seconds; fill() rejects a changed value
    await page.locator('#manifest-files').setInputFiles([original, edited]);
    if (!(await page.locator('.manifest-options').evaluate((d) => d.open))) await page.locator('.manifest-options summary').click();
    await page.getByLabel('Include file names').check();
    await page.locator('#manifest-landing').fill(local);
    await page.locator('#manifest-edited-1').check();
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await page.locator('#manifest-error').filter({ hasText: /Fill in “Derived from”/ }).waitFor({ timeout: 5000 }); // an empty edited-copy link is never dropped silently
    await page.locator('#manifest-derived-1').fill('item [1]');
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await page.locator('#manifest-error').filter({ hasText: /can’t contain \[ or \]/ }).waitFor({ timeout: 5000 });
    await page.locator('#manifest-derived-1').fill('item 1');
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await page.waitForSelector('#manifest-handover-text', { timeout: 60000 });
    const message = await page.locator('#manifest-handover-text').inputValue();
    assert.doesNotMatch(message, /item 1|reported-landing/, 'notes stay in the sealed file, not the message');
    const key = /Public key: ([0-9a-f]{64})/.exec(message)[1];
    assert.equal(await page.locator('.handover .fingerprint').count(), 0, 'a one-time key has no fingerprint to hand out');
    assert.match(grouped(fingerprintOf(key)), /^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed list' }).click()]);
    const sealed2 = join(EVIDENCE, 'derived.manifest.fseal'); await download.saveAs(sealed2);
    const localDir = join(dir, 'recipient'); mkdirSync(localDir, { recursive: true });
    const reencoded = join(localDir, 'flight-notes.txt');
    writeFileSync(reencoded, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\n/g, '\r\n'))]));
    const copy = join(localDir, 'flight-notes-cropped.txt'); writeFileSync(copy, readFileSync(edited));
    await goTo('verify');
    await page.locator('#check-file').setInputFiles(sealed2);
    await page.locator('#check-text').fill(message);
    await page.locator('#check-originals').setInputFiles([reencoded, copy]);
    await runCheck(key);
    await page.waitForSelector('.manifest-table');
    const rows = await page.locator('.manifest-table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim())));
    assert.deepEqual(rows.map((r) => [r[0].split('\n')[0], r[2].split('\n')[0]]), [['flight-notes.txt', 'Bytes differ'], ['flight-notes-cropped.txt', 'Matches']]);
    assert.equal(await differOnce(page), 1, 'the Files differ explanation is shown once');
    assert.match(rows[1][0], /Edited copy of: item 1 \(operator-entered, signed\)/);
    assert.doesNotMatch(rows[1][0], /reported-landing|derived-from/);
    assert.equal(await trustText(), "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.");
    const fields = await page.locator('.manifest-outcome .time-fields > div').evaluateAll((divs) => divs.map((d) => [d.querySelector('dt').innerText, d.querySelector('dd span').innerText, d.querySelector('dd small').innerText]));
    assert.deepEqual(fields.map((f) => f[0]), ['Reported landing time', 'Sealed on this computer at', 'Registry acceptance', 'Trusted timestamp', 'Reported landing-to-seal interval']);
    assert.equal(fields[0][2], 'operator-entered, signed, not verified');
    assert.equal(fields[1][2], "this computer's clock, not verified; from the receipt message, not signed");
    assert.match(fields[4][1], /^-1 h \d+ min \d+ s \(reported landing is after the seal time/);
    assert.doesNotMatch(fields[4][1], /verified/i, 'no verified-delay wording');
    assert.doesNotMatch(await page.locator('.manifest-outcome').innerText(), /identical|verified delay|delay verified/i);
    await layout(page, 'manifest derived');
    await sealMore();
    await page.locator('#manifest-files').setInputFiles([original]);
    assert.equal(await page.locator('#manifest-landing').inputValue(), '', 'a landing time is never carried into the next batch');
  });

  await check('A key marked compromised while files are hashing shows compromised on screen and in every export', async () => {
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
    try {
      const checker = await ctx.newPage();
      checker.on('pageerror', (error) => runtimeErrors.push(`stale-trust: ${error}`));
      const admin = await ctx.newPage(); // "another tab" sharing this browser's trusted companies
      await admin.goto(`${url}#/app/settings`);
      await admin.locator('.trusted-companies-details > summary').click();
      await admin.locator('#tc-name').fill('Late Co');
      await admin.locator('#tc-fingerprint').fill(fingerprintOf(publicKey));
      await admin.getByLabel('contract or invoice', { exact: true }).check();
      await admin.locator('#tc-confirmed').check();
      await admin.getByRole('button', { name: 'Add company' }).click();
      await admin.getByRole('button', { name: 'Mark as compromised: Late Co' }).waitFor();
      await checker.goto(`${url}#/app/verify`);
      const big = join(dir, 'slow.bin'); const fd = openSync(big, 'w'); ftruncateSync(fd, 1536 * 1024 * 1024); closeSync(fd);
      await checker.locator('#check-file').setInputFiles(sealedPath);
      await checker.locator('#check-text').fill(handover);
      await checker.locator('#check-originals').setInputFiles(big);
      await fillKey(checker, publicKey);
      await checker.getByRole('button', { name: 'Check files' }).click();
      await checker.locator('#manifest-check-progress-0').waitFor({ timeout: 30000 });
      await admin.getByRole('button', { name: 'Mark as compromised: Late Co' }).click();
      await admin.locator('.confirm-box').getByRole('button', { name: 'Mark as compromised' }).click();
      assert.equal(await checker.locator('#manifest-check-progress-0').count(), 1, 'still hashing when the key was marked');
      const line = checker.locator('.manifest-outcome .trust-line');
      await line.waitFor({ timeout: 120000 });
      await checker.waitForFunction(() => /marked as compromised: Late Co/.test(document.querySelector('.manifest-outcome .trust-line')?.textContent || ''), null, { timeout: 5000 });
      const save = async (name) => { await openReports(checker); const [d] = await Promise.all([checker.waitForEvent('download'), checker.getByRole('button', { name, exact: true }).click()]); return readFileSync(await d.path()); };
      for (const name of ['Download text report', 'Download Markdown report']) assert.match((await save(name)).toString('utf8'), /Key trust: Signed by a key you marked as compromised: Late Co/, name);
      assert.equal(JSON.parse((await save('Download JSON')).toString('utf8')).keyTrust.status, 'compromised');
      const pdf = await save('Download PDF');
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      const pdfWords = (await pdfText(pdf)).replace(/\s+/g, ' ');
      assert.match(pdfWords, /Key trust: Signed by a key you marked as compromised: Late Co\./, 'PDF key trust line');
      // R75: the seal time is earlier than the mark, yet nothing says the signature came before (or after) the compromise.
      const near = /\b(before|after|predat\w*|prior to)\b\W+(?:\w+\W+){0,3}compromis|compromis\w*\W+(?:\w+\W+){0,3}(before|after|predat\w*|prior to)\b/i;
      assert.equal(await checker.locator('#verdict-heading').innerText(), 'Signed by a key marked compromised');
      assert.doesNotMatch(await checker.locator('main').innerText(), near, 'screen');
      for (const name of ['Download text report', 'Download Markdown report', 'Download JSON']) assert.doesNotMatch((await save(name)).toString('utf8'), near, name);
      assert.doesNotMatch(pdfWords, near, 'PDF');
      rmSync(big);
    } finally { await ctx.close(); }
  });

  await check('No request body contains the marker or source-file bytes', async () => {
    const bodies = requests.map((r) => r.postDataBuffer()).filter(Boolean);
    for (const body of bodies) for (const secret of secrets) assert.equal(body.includes(secret), false, 'file bytes in a request body');
    console.log(`requests recorded: ${requests.length}, with bodies: ${bodies.length}`);
  });

  await check('no runtime errors', async () => { assert.deepEqual(runtimeErrors, []); });
  await context.close();
} finally {
  await browser?.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(join(EVIDENCE, 'manifest-mode-report.json'), JSON.stringify({ checks, total: checks.length, passed: checks.filter((x) => x.passed).length, runtimeErrors }, null, 2));
}
if (checks.some((c) => !c.passed)) process.exitCode = 1;

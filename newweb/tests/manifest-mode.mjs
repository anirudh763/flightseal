// Seal & send, Manifest only: a real UI flow in Chrome. Seal three files, check them back with one modified, one
// missing and one extra; refuse without a trusted key; Cancel stops hashing; no request body carries file bytes;
// axe 0 violations and no horizontal scroll at 320/768/1440. Run after `npm --prefix newweb run build`.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from '../../tests/web/serve.mjs';
import { BYTES_DIFFER } from '../src/recipient-trust.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  await page.getByRole('button', { name: /Seal a flight log/ }).click();
  await page.waitForFunction(() => location.hash === '#/app/protect' && document.querySelector('.commandbar h1')?.textContent === 'Seal & send');
  let handover, sealedPath, publicKey;

  const steps = () => page.locator('.manifest-steps li').evaluateAll((lis) => lis.map((li) => [li.textContent, li.getAttribute('aria-current')]));
  const currentStep = async () => (await steps()).find(([, current]) => current === 'step')?.[0];

  await check('Small file (embedded) is the default and keeps its controls', async () => {
    assert.equal(await page.getByLabel('Small file (seal the whole file, up to 45 MiB)').isChecked(), true);
    assert.equal(await page.locator('#protect-file').count(), 1);
    assert.equal(await page.locator('#manifest-files').isVisible(), false);
  });

  await check('friendly limit errors say what to do next, before any hashing', async () => {
    await page.getByLabel('Large files (fingerprint only)').check();
    const many = Array.from({ length: 101 }, (_, i) => write(`many-${i}.txt`, Buffer.from(String(i))));
    await page.locator('#manifest-files').setInputFiles(many);
    assert.match(await page.getByRole('alert').first().textContent(), /You picked 101 files\. Choose up to 100 at a time/);
    await page.locator('#manifest-files').setInputFiles(sealPaths[2]);
    await page.locator('.manifest-options summary').click();
    await page.locator('#manifest-note-0').fill('x'.repeat(1001));
    await page.getByRole('button', { name: 'Seal', exact: true }).click();
    assert.match(await page.getByRole('alert').first().textContent(), /note exceeds 1000 UTF-8 bytes\. Shorten it under More options/);
    assert.equal(await page.locator('[id^=manifest-seal-progress-]').count(), 0, 'nothing was hashed');
    await page.locator('.manifest-options summary').click();
  });

  await check('Large files: seal three files, one record and a count=1 receipt, steps and not-a-backup notice', async () => {
    assert.equal(await page.locator('#protect-file').count(), 0);
    assert.match(await page.locator('.manifest-notice').textContent(), /This keeps a fingerprint, not a copy\. Keep your original files\./);
    await page.locator('.manifest-help summary').click();
    assert.match(await page.locator('.manifest-help').innerText(), /A manifest is not a backup\./);
    await page.locator('#manifest-files').setInputFiles([]);
    assert.equal(await currentStep(), 'Choose files');
    await page.locator('#manifest-files').setInputFiles(sealPaths);
    assert.equal(await currentStep(), 'Seal');
    await page.locator('.manifest-options summary').click();
    await page.locator('#manifest-note-0').fill('');
    await page.getByLabel('Include file names').check();
    await page.locator('#manifest-note-1').fill('Camera B, landed 14:02');
    await page.getByRole('button', { name: 'Seal', exact: true }).click();
    await page.waitForSelector('#manifest-handover-text', { timeout: 60000 });
    assert.equal(await currentStep(), 'Send');
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
    assert.equal(await page.getByLabel('Large files (fingerprint only)').isChecked(), true);
    assert.equal(await page.locator('#manifest-handover-text').inputValue(), handover);
  });

  await check('Check: modified, missing and extra files get Bytes differ / Missing / Not in manifest', async () => {
    const changed = Buffer.from(a); changed[10] ^= 1;
    const localPaths = [join(dir, 'local'), join(dir, 'local', 'a.bin'), join(dir, 'local', 'b.bin'), join(dir, 'local', 'extra.bin')];
    mkdirSync(localPaths[0], { recursive: true });
    writeFileSync(localPaths[1], changed); writeFileSync(localPaths[2], b); writeFileSync(localPaths[3], randomBytes(77));
    await page.locator('#manifest-check-file').setInputFiles(sealedPath);
    await page.locator('#manifest-check-text').fill(handover);
    await page.locator('#manifest-trusted-key').fill(publicKey);
    await page.locator('#manifest-local-files').setInputFiles(localPaths.slice(1));
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.waitForSelector('.manifest-table', { timeout: 60000 });
    const rows = await page.locator('.manifest-table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim())));
    assert.deepEqual(rows.map((r) => [r[0], r[3].split('\n')[0], r[4]]), [['1', 'Bytes differ', 'a.bin'], ['2', 'Matches', 'b.bin'], ['3', 'Missing', '—'], ['—', 'Not in manifest', 'extra.bin']]);
    assert.match(rows[0][1], /a\.bin/);
    assert.match(rows[1][1], /Operator note: Camera B, landed 14:02/);
    assert.ok(rows[0][3].includes(BYTES_DIFFER.text), rows[0][3]);
    assert.equal(await page.locator('.manifest-outcome .trust-line').innerText(), "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.");
    const chips = await page.locator('.manifest-table .status-label').evaluateAll((els) => els.map((el) => [el.textContent, el.className]));
    assert.deepEqual(chips, [['Bytes differ', 'status-label warn'], ['Matches', 'status-label ok'], ['Missing', 'status-label grey'], ['Not in manifest', 'status-label neutral']]);
    const text = await page.locator('.manifest-outcome').innerText();
    assert.match(text, /Manifest verified/);
    assert.doesNotMatch(text, /tampered(?! )/i);
    await layout(page, 'manifest checked');
  });

  await check('No or wrong trusted key: not verified and no item statuses', async () => {
    for (const key of ['', 'ab'.repeat(32)]) {
      await page.locator('#manifest-trusted-key').fill(key);
      await page.getByRole('button', { name: 'Check files' }).click();
      await page.waitForSelector('.manifest-outcome [role=alert], .manifest-outcome[role=alert]', { timeout: 30000 });
      assert.match(await page.locator('.manifest-outcome').innerText(), /Manifest not verified[\s\S]*trusted public key[\s\S]*entered the key the sender gave you separately/);
      assert.equal(await page.locator('.manifest-table').count(), 0);
    }
  });

  await check('Cancel stops hashing and the UI is usable again', async () => {
    const big = join(dir, 'big.bin'); const fd = openSync(big, 'w'); ftruncateSync(fd, 2 ** 31); closeSync(fd);
    await page.locator('#manifest-files').setInputFiles(big);
    await page.getByRole('button', { name: 'Seal', exact: true }).click();
    await page.waitForSelector('#manifest-seal-progress-0');
    await page.waitForFunction(() => Number(document.querySelector('#manifest-seal-progress-0')?.value) > 0);
    await page.waitForFunction(() => /\d+% · \d+\.\d MB\/s/.test(document.querySelector('.manifest-progress')?.textContent || ''));
    await layout(page, 'manifest hashing');
    const before = await page.locator('#manifest-seal-progress-0').evaluate((el) => el.value);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => !document.querySelector('#manifest-seal-progress-0') && [...document.querySelectorAll('[role=status]')].some((n) => n.textContent === 'Cancelled'));
    assert.ok(before < 2 ** 31, 'cancelled before the end');
    assert.equal(await page.getByRole('button', { name: 'Seal', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('#manifest-handover-text').count(), 0);
    rmSync(big);
  });

  // Trusted companies live in Settings; a second page in the same context shares this browser's local list.
  const settings = await context.newPage();
  settings.on('pageerror', (error) => runtimeErrors.push(`settings: ${error}`));
  const fingerprintOf = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
  const grouped = (hex) => hex.match(/.{4}/g).join(' ');
  const addCompany = async (name, fingerprint, source) => {
    await settings.locator('#tc-name').fill(name);
    await settings.locator('#tc-fingerprint').fill(fingerprint);
    if (source) await settings.getByLabel(source, { exact: true }).check();
    await settings.getByRole('button', { name: 'Add company' }).click();
  };
  const trustText = () => page.locator('.manifest-outcome .trust-line').innerText();
  const runCheck = async (key) => {
    await page.locator('#manifest-trusted-key').fill(key);
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.waitForSelector('.manifest-outcome', { timeout: 60000 });
  };

  await check('Settings: Trusted companies add, replace-confirm, history and compromised; axe at 320/768/1440', async () => {
    await settings.goto(`${url}#/app/settings`);
    await settings.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Settings');
    await settings.locator('.trusted-companies-details > summary').click();
    await addCompany('Acme Survey', 'ab'.repeat(32), '');
    assert.match(await settings.getByRole('alert').innerText(), /Choose where you got this fingerprint/);
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
    assert.match(list, /Added from contract or invoice/);
    await addCompany('Old Co', 'cd'.repeat(32), 'other');
    await settings.getByRole('button', { name: 'Mark as compromised: Old Co' }).click();
    await settings.locator('.confirm-box').getByRole('button', { name: 'Mark as compromised' }).click();
    assert.doesNotMatch(await settings.locator('.company-list').innerText(), /Old Co/);
    await settings.locator('.trusted-companies details > summary', { hasText: 'Key history' }).click();
    const history = await settings.locator('.company-history').innerText();
    assert.match(history, /Acme Survey[\s\S]*Replaced on \d{4}-\d{2}-\d{2}/);
    assert.match(history, /Old Co[\s\S]*Marked compromised on \d{4}-\d{2}-\d{2}/);
    await settings.locator('.trusted-companies details > summary', { hasText: 'What is this?' }).click();
    await layout(settings, 'trusted companies');
  });

  await check('Check: a fingerprint pin with an empty key field is trusted; every export carries trust, source and times', async () => {
    await runCheck('');
    assert.equal(await trustText(), 'Signed by a key you trust: Acme Survey (added from contract or invoice)');
    assert.match(await page.locator('.manifest-outcome').innerText(), /Used the key you saved for Acme Survey/);
    assert.equal(await page.locator('.manifest-table').count(), 1);
    const save = async (name) => { const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name, exact: true }).click()]); return readFileSync(await d.path()); };
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
    const [stale] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download text report', exact: true }).click()]);
    assert.match(readFileSync(await stale.path(), 'utf8'), /Key trust: Signed by a key you marked as compromised: Acme Survey/);
    await runCheck('');
    assert.match(await page.locator('.manifest-outcome').innerText(), /Manifest not verified/);
    await runCheck(publicKey);
    assert.equal(await trustText(), "Signed by a key you marked as compromised: Acme Survey. Don't rely on this proof without checking with the company.");
    await runCheck('ab'.repeat(32));
    assert.match(await page.locator('.manifest-outcome').innerText(), /Manifest not verified[\s\S]*trusted public key/);
    assert.equal(await page.locator('.manifest-table').count(), 0);
  });

  await check('Pin controls on the check form: source required, in-page rotation confirm, history kept', async () => {
    const pin = (id) => page.locator(`#manifest-trusted-key-pin-${id}`);
    const pinButton = page.getByRole('button', { name: 'Pin public key on this device' });
    await page.locator('#manifest-trusted-key').fill(publicKey);
    await pin('name').fill('Unit A');
    assert.equal(await pinButton.isEnabled(), false, 'a source is required');
    await pin('source').selectOption('phone');
    await pinButton.click();
    assert.match(await page.locator('.trusted-key-controls [role=status]').innerText(), /Saved local pin Unit A/);
    await page.locator('#manifest-trusted-key').fill('ab'.repeat(32));
    await pin('name').fill('Unit A');
    await pin('source').selectOption('phone');
    await pinButton.click();
    const box = page.locator('.trusted-key-controls .confirm-box');
    assert.match(await box.innerText(), new RegExp(`Key changed for “Unit A” \\(old fingerprint ${grouped(fingerprintOf(publicKey))}\\)`));
    await box.getByRole('button', { name: 'Keep current key' }).click();
    assert.equal(await box.count(), 0);
    await pinButton.click();
    await page.locator('.trusted-key-controls .confirm-box').getByRole('button', { name: 'Replace key' }).click();
    assert.match(await page.locator('.trusted-key-controls [role=status]').innerText(), /Saved local pin Unit A/);
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
      store.push({ name: 'Weak Co', publicKey: '', fingerprint: fp, source: 'website', addedAt: '', status: 'active' });
      localStorage.setItem('flightseal_trusted_keys_v1', JSON.stringify(store));
    }, { fp: weakFp });
    const forge = (message) => message.replace(/key=[0-9a-f]{64} sig=[0-9a-f]{128}/, `key=${weakKey} sig=${weakSig}`).replace(/Public key: [0-9a-f]{64}/, `Public key: ${weakKey}`);
    const forged = forge(handover);
    assert.notEqual(forged, handover);

    // Large files, key field empty.
    await page.locator('#manifest-check-file').setInputFiles(sealedPath);
    await page.locator('#manifest-check-text').fill(forged);
    await page.locator('#manifest-local-files').setInputFiles([]);
    await runCheck('');
    const outcome = await page.locator('.manifest-outcome').innerText();
    assert.match(outcome, /Manifest not verified/);
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
    await page.getByRole('alert').filter({ hasText: WEAK.error }).waitFor({ timeout: 30000 });
    assert.doesNotMatch(await page.locator('main').innerText(), trusted);

    // Small file: seal one, then check it with the forged message.
    const small = write('weak-check.log', Buffer.from('0\tflight\n'));
    await page.evaluate(() => { location.hash = '/app/protect'; });
    await page.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Seal & send');
    await page.getByLabel('Small file (seal the whole file, up to 45 MiB)').check();
    await page.locator('#protect-file').setInputFiles(small);
    await page.getByRole('button', { name: 'Seal this log' }).click();
    await page.waitForSelector('#handover-text', { timeout: 60000 });
    const smallHandover = await page.locator('#handover-text').inputValue();
    const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
    const smallSealed = join(dir, 'weak-check.log.fseal'); await d.saveAs(smallSealed);
    await page.locator('#check-file').setInputFiles(smallSealed);
    await page.locator('#check-text').fill(forge(smallHandover));
    await page.getByRole('button', { name: 'Check this log' }).click();
    await page.getByRole('alert').filter({ hasText: WEAK.error }).waitFor({ timeout: 30000 });
    assert.doesNotMatch(await page.locator('main').innerText(), trusted);
    await page.getByLabel('Large files (fingerprint only)').check();
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
    await page.getByRole('button', { name: 'Seal', exact: true }).click();
    await page.locator('.manifest-body [role=alert]').filter({ hasText: /Fill in “Derived from”/ }).waitFor({ timeout: 5000 }); // an empty edited-copy link is never dropped silently
    await page.locator('#manifest-derived-1').fill('item [1]');
    await page.getByRole('button', { name: 'Seal', exact: true }).click();
    await page.locator('.manifest-body [role=alert]').filter({ hasText: /can’t contain \[ or \]/ }).waitFor({ timeout: 5000 });
    await page.locator('#manifest-derived-1').fill('item 1');
    await page.getByRole('button', { name: 'Seal', exact: true }).click();
    await page.waitForSelector('#manifest-handover-text', { timeout: 60000 });
    const message = await page.locator('#manifest-handover-text').inputValue();
    assert.doesNotMatch(message, /item 1|reported-landing/, 'notes stay in the sealed file, not the message');
    const key = /Public key: ([0-9a-f]{64})/.exec(message)[1];
    assert.equal(await page.locator('.handover .fingerprint').innerText(), grouped(fingerprintOf(key)));
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed list' }).click()]);
    const sealed2 = join(EVIDENCE, 'derived.manifest.fseal'); await download.saveAs(sealed2);
    const localDir = join(dir, 'recipient'); mkdirSync(localDir, { recursive: true });
    const reencoded = join(localDir, 'flight-notes.txt');
    writeFileSync(reencoded, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\n/g, '\r\n'))]));
    const copy = join(localDir, 'flight-notes-cropped.txt'); writeFileSync(copy, readFileSync(edited));
    await page.locator('#manifest-check-file').setInputFiles(sealed2);
    await page.locator('#manifest-check-text').fill(message);
    await page.locator('#manifest-local-files').setInputFiles([reencoded, copy]);
    await runCheck(key);
    await page.waitForSelector('.manifest-table');
    const rows = await page.locator('.manifest-table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim())));
    assert.deepEqual(rows.map((r) => [r[0], r[3].split('\n')[0], r[4]]), [['1', 'Bytes differ', 'flight-notes.txt'], ['2', 'Matches', 'flight-notes-cropped.txt']]);
    assert.ok(rows[0][3].includes(BYTES_DIFFER.text));
    assert.match(rows[1][1], /Edited copy of: item 1 \(operator-entered, signed\)/);
    assert.doesNotMatch(rows[1][1], /reported-landing|derived-from/);
    assert.equal(await trustText(), "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.");
    const fields = await page.locator('.manifest-outcome .time-fields > div').evaluateAll((divs) => divs.map((d) => [d.querySelector('dt').innerText, d.querySelector('dd span').innerText, d.querySelector('dd small').innerText]));
    assert.deepEqual(fields.map((f) => f[0]), ['Reported landing time', 'Sealed on this computer at', 'Registry acceptance', 'Trusted timestamp', 'Reported landing-to-seal interval']);
    assert.equal(fields[0][2], 'operator-entered, signed, not verified');
    assert.equal(fields[1][2], "this computer's clock, not verified; from the receipt message, not signed");
    assert.match(fields[4][1], /^-1 h \d+ min \d+ s \(reported landing is after the seal time/);
    assert.doesNotMatch(fields[4][1], /verified/i, 'no verified-delay wording');
    assert.doesNotMatch(await page.locator('.manifest-outcome').innerText(), /identical|verified delay|delay verified/i);
    await layout(page, 'manifest derived');
    await page.locator('#manifest-files').setInputFiles([original]);
    assert.equal(await page.locator('#manifest-landing').inputValue(), '', 'a landing time is never carried into the next batch');
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

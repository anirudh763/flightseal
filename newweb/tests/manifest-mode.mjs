// Seal & send, Manifest only: a real UI flow in Chrome. Seal three files, check them back with one modified, one
// missing and one extra; refuse without a trusted key; Cancel stops hashing; no request body carries file bytes;
// axe 0 violations and no horizontal scroll at 320/768/1440. Run after `npm --prefix newweb run build`.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from '../../tests/web/serve.mjs';

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

  await check('Embedded file is the default and keeps its controls', async () => {
    assert.equal(await page.getByLabel('Embedded file (up to 45 MiB)').isChecked(), true);
    assert.equal(await page.locator('#protect-file').count(), 1);
    assert.equal(await page.locator('#manifest-files').count(), 0);
  });

  await check('Manifest only: seal three files, one record and a count=1 receipt, not-a-backup notice', async () => {
    await page.getByLabel('Manifest only (large or multiple files)').check();
    assert.equal(await page.locator('#protect-file').count(), 0);
    assert.match(await page.locator('.manifest-notice').textContent(), /A manifest is not a backup/);
    await page.locator('#manifest-files').setInputFiles(sealPaths);
    await page.getByText('More options').click();
    await page.getByLabel('Include file names').check();
    await page.locator('#manifest-note-1').fill('Camera B, landed 14:02');
    await page.getByRole('button', { name: 'Seal manifest' }).click();
    await page.waitForSelector('#manifest-handover-text', { timeout: 60000 });
    handover = await page.locator('#manifest-handover-text').inputValue();
    const receipts = handover.split('\n').filter((line) => line.startsWith('fseal-receipt v1 '));
    assert.equal(receipts.length, 1);
    assert.match(receipts[0], /count=1 /);
    assert.ok(!handover.includes('a.bin') && !handover.includes('Camera B'), 'no names or notes in the handover');
    publicKey = /Public key: ([0-9a-f]{64})/.exec(handover)[1];
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed manifest' }).click()]);
    assert.match(download.suggestedFilename(), /^hashwing-\d{8}-\d{6}\.manifest\.fseal$/);
    sealedPath = join(EVIDENCE, 'sealed.manifest.fseal');
    await download.saveAs(sealedPath);
    const sealed = readFileSync(sealedPath);
    assert.equal(sealed.subarray(0, 8).toString(), 'FLTSEAL1');
    assert.equal(sealed.length, 8 + 20 + sealed.readUInt32LE(8) + 36, 'exactly one record, nothing after it');
    await layout(page, 'manifest sealed');
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
    assert.deepEqual(rows.map((r) => [r[0], r[3], r[4]]), [['1', 'Bytes differ', 'a.bin'], ['2', 'Matches', 'b.bin'], ['3', 'Missing', '—'], ['—', 'Not in manifest', 'extra.bin']]);
    assert.match(rows[0][1], /a\.bin/);
    assert.match(rows[1][1], /Operator note: Camera B, landed 14:02/);
    const text = await page.locator('.manifest-outcome').innerText();
    assert.match(text, /Manifest verified/);
    assert.match(text, /Editing, re-saving, a metadata change, recompression, truncation or corruption/);
    assert.doesNotMatch(text, /tampered/i);
    await layout(page, 'manifest checked');
  });

  await check('No or wrong trusted key: not verified and no item statuses', async () => {
    for (const key of ['', 'ab'.repeat(32)]) {
      await page.locator('#manifest-trusted-key').fill(key);
      await page.getByRole('button', { name: 'Check files' }).click();
      await page.waitForSelector('.manifest-outcome [role=alert], .manifest-outcome[role=alert]', { timeout: 30000 });
      assert.match(await page.locator('.manifest-outcome').innerText(), /Manifest not verified/);
      assert.equal(await page.locator('.manifest-table').count(), 0);
    }
  });

  await check('Cancel stops hashing and the UI is usable again', async () => {
    const big = join(dir, 'big.bin'); const fd = openSync(big, 'w'); ftruncateSync(fd, 2 ** 31); closeSync(fd);
    await page.locator('#manifest-files').setInputFiles(big);
    await page.getByRole('button', { name: 'Seal manifest' }).click();
    await page.waitForSelector('#manifest-progress-bar');
    await page.waitForFunction(() => Number(document.querySelector('#manifest-progress-bar')?.value) > 0);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => !document.querySelector('#manifest-progress-bar') && [...document.querySelectorAll('[role=status]')].some((n) => n.textContent === 'Cancelled'));
    assert.equal(await page.getByRole('button', { name: 'Seal manifest' }).isEnabled(), true);
    assert.equal(await page.locator('#manifest-handover-text').count(), 0);
    rmSync(big);
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

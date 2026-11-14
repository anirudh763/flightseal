import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { serve } from '../../tests/web/serve.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EVIDENCE = process.env.REACT_CONSOLE_EVIDENCE || join(ROOT, '.test-artifacts');
mkdirSync(EVIDENCE, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { server, url: rootUrl } = await serve(0, '/flightseal');
const url = `${rootUrl}console/`;
let browser;
const checks = [];
const metrics = {};
async function waitForServer() {
  const response = await fetch(url); if (!response.ok) throw new Error(`Built console returned ${response.status}.`);
}
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: String(error.message || error) }); console.error(`FAIL ${name}: ${error.message || error}`); }
}
async function waitResult(page, text = 'Intact') {
  try { await page.waitForFunction((needle) => document.querySelector('#result-heading')?.textContent.includes(needle), text, { timeout: 30000 }); }
  catch { throw new Error(`Expected result ${text}; page state: ${(await page.locator('body').innerText()).slice(0, 1400)}`); }
}
async function loadFreshDemo(page) {
  await route(page, 'sandbox');
  await page.getByRole('button', { name: 'Load 800-record demo' }).click();
  await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('800'), null, { timeout: 30000 });
}
async function route(page, screen) {
  await page.evaluate((s) => { location.hash = `/${s}`; }, screen);
  await page.waitForFunction((s) => location.hash === `#/${s}`, screen);
  await page.waitForFunction((s) => document.querySelector('.page-heading h1')?.textContent === s[0].toUpperCase() + s.slice(1), screen);
}
async function auditAxe(page, label) {
  await page.evaluate(AXE);
  const results = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
  assert.equal(results.violations.length, 0, `${label}: ${results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary || ''}`).join('; ')}`).join(' | ')}`);
}
try {
  await waitForServer();
  const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(`${message.text()} (${message.location().url})`); });
  const initialStarted = performance.now();
  await page.goto(url);
  await waitResult(page, 'Intact');
  await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('800'));
  metrics.firstVisit800DemoMs = Math.round(performance.now() - initialStarted);

  await check('included 800-record demo verifies through native WASM with receipts', async () => {
    assert.ok(metrics.firstVisit800DemoMs < 3000, `first included demo took ${metrics.firstVisit800DemoMs}ms`);
    assert.match(await page.locator('.result-top .eyebrow').textContent(), /C\+\+ \/ OpenSSL \/ WebAssembly/);
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 8);
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('payload byte flip on a copy preserves CRC and finds the first bad link', async () => {
    await route(page, 'sandbox');
    await page.getByRole('button', { name: 'Flip one payload byte' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-link'), null, { timeout: 12000 }).catch(async () => assert.fail(`byte flip did not expose bad-link: ${(await page.locator('body').innerText()).slice(0, 800)}`));
    assert.match(await page.locator('.first-failure').textContent(), /bad-link/);
  });

  await check('middle-record deletion on a copy finds the sequence break', async () => {
    await loadFreshDemo(page);
    await page.getByRole('button', { name: 'Remove one middle record' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-seq'), null, { timeout: 12000 }).catch(async () => assert.fail(`record deletion did not expose bad-seq: ${(await page.locator('body').innerText()).slice(0, 800)}`));
    assert.match(await page.locator('.first-failure').textContent(), /bad-seq/);
  });

  await check('tail truncation on a copy distinguishes a torn record', async () => {
    await loadFreshDemo(page);
    await page.getByRole('button', { name: 'Trim seven tail bytes' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('torn-tail'), null, { timeout: 12000 }).catch(async () => assert.fail(`tail trim did not expose torn-tail: ${(await page.locator('body').innerText()).slice(0, 800)}`));
    assert.match(await page.locator('#result-heading').textContent(), /Tampered/);
  });

  await check('optional PX4 fixture verifies 2,422 records with its included receipts', async () => {
    await page.getByRole('button', { name: 'Open 2,422-record PX4 example' }).click();
    await waitResult(page, 'Intact');
    assert.match(await page.locator('.result-stat').textContent(), /2,422/);
  });

  await check('full PX4 fixture verifies 64,542 records and all 13 signed receipts on demand', async () => {
    const start = performance.now();
    await page.getByRole('button', { name: /Open full PX4 example/ }).click();
    await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('64,542'), null, { timeout: 60000 });
    metrics.fullPX4NativeAndIndexMs = Math.round(performance.now() - start);
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    assert.match(await page.locator('.hero-fact').textContent(), /28\.\d+ MiB/);
    assert.match(await page.locator('.sample-note').textContent(), /selected decoded records/);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 13);
    assert.match(await page.locator('.receipt-overview').textContent(), /64,542 records covered by a trusted receipt · 0 uncovered/);
    await route(page, 'sandbox');
  });

  await check('text and JSON downloads are bounded summaries with no payload and text matches display', async () => {
    await loadFreshDemo(page);
    await page.locator('.report-details summary').click();
    const expected = await page.locator('.report-text').textContent();
    const [textDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download text report' }).click()]);
    assert.equal(textDownload.suggestedFilename(), 'flightseal-verification-report.txt');
    const textPath = await textDownload.path(); assert.equal(readFileSync(textPath, 'utf8'), expected);
    const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON summary' }).click()]);
    const json = JSON.parse(readFileSync(await jsonDownload.path(), 'utf8'));
    assert.equal(json.nativeVerdict, 'intact'); assert.equal(json.overallVerdict, 'intact'); assert.equal(json.records, '800'); assert.equal(JSON.stringify(json).includes('payload'), false);
  });

  await check('local seal flow creates an actual log, receipts and public key then verifies them', async () => {
    await route(page, 'sandbox');
    await page.locator('#tsv-file').setInputFiles({ name: 'small-flight.tsv', mimeType: 'text/plain', buffer: Buffer.from('100\talpha\n200\tbravo\n300\tcharlie\n') });
    await page.locator('#receipt-interval').fill('2');
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact') && document.querySelector('.seal-outputs'), null, { timeout: 30000 });
    assert.equal(await page.locator('.seal-outputs button').count(), 3);
    assert.match(await page.locator('.result-stat').textContent(), /3/);
  });

  await check('oversized file selection clears any previous intact result and explains the 64 MiB guard', async () => {
    await route(page, 'verify');
    await page.evaluate(() => {
      const input = document.querySelector('#log-input');
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(64 * 1024 * 1024 + 1)], 'too-large.fseal'));
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('64 MiB'));
    assert.equal(await page.locator('#result-heading').count(), 0, 'previous verdict must not describe the oversized new selection');
  });

  await check('receipt file read rejection is visible and a successful reread recovers', async () => {
    await route(page, 'verify');
    await page.locator('#log-input').setInputFiles(resolve(ROOT, '../docs/samples/intact.fseal'));
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.locator('#trusted-key').fill(readFileSync(resolve(ROOT, '../docs/samples/pubkey.txt'), 'utf8').trim());
    await page.evaluate(() => {
      const original = File.prototype.text; let reject = true;
      File.prototype.text = function (...args) { if (reject) { reject = false; return Promise.reject(new Error('injected file read failure')); } return original.apply(this, args); };
    });
    await page.locator('#receipt-input').setInputFiles({ name: 'retry.receipts', mimeType: 'text/plain', buffer: Buffer.from('bad') });
    await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('Could not read the receipts file'), null, { timeout: 5000 });
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.getByRole('button', { name: 'Run C++ check' }).click(); await waitResult(page, 'Intact');
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('slow receipt read is ignored after a newer file selection completes', async () => {
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function (...args) {
        if (this.name === 'slow.receipts') return new Promise((_, reject) => { window.__rejectSlowReceipt = reject; });
        return original.apply(this, args);
      };
    });
    await page.locator('#receipt-input').setInputFiles({ name: 'slow.receipts', mimeType: 'text/plain', buffer: Buffer.from('delayed') });
    await page.waitForFunction(() => typeof window.__rejectSlowReceipt === 'function' && document.querySelector('.field-hint'));
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.waitForFunction(() => !document.querySelector('.field-hint'));
    await page.getByRole('button', { name: 'Run C++ check' }).click(); await waitResult(page, 'Intact');
    await page.evaluate(() => { window.__rejectSlowReceipt(new Error('stale receipt read')); window.__rejectSlowReceipt = null; });
    await page.waitForTimeout(40);
    assert.equal(await page.locator('#result-heading').textContent(), 'Intact');
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('blank trusted key is explicitly unverified and adding the key recovers', async () => {
    await page.locator('#trusted-key').fill('');
    await page.getByRole('button', { name: 'Run C++ check' }).click(); await waitResult(page, 'Unverified');
    assert.match(await page.locator('.operation-status').textContent(), /trusted public key/);
    await page.locator('.report-details summary').click();
    assert.match(await page.locator('.report-text').textContent(), /Native chain result: INTACT/);
    assert.match(await page.locator('.report-text').textContent(), /Overall evidence status: UNVERIFIED/);
    const [unverifiedDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON summary' }).click()]);
    const unverifiedReport = JSON.parse(readFileSync(await unverifiedDownload.path(), 'utf8'));
    assert.equal(unverifiedReport.nativeVerdict, 'intact');
    assert.equal(unverifiedReport.overallVerdict, 'unverified');
    assert.equal(unverifiedReport.covered, '0');
    assert.equal(unverifiedReport.receiptChecks[0].check, 'unverified');
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 8);
    assert.match(await page.locator('tbody').textContent(), /No trusted key entered/);
    await route(page, 'verify');
    await page.locator('#trusted-key').fill('0'.repeat(64));
    await page.getByRole('button', { name: 'Run C++ check' }).click(); await waitResult(page, 'Unverified');
    await route(page, 'receipts');
    assert.match(await page.locator('tbody').textContent(), /different key/);
    await route(page, 'verify');
    await page.locator('#trusted-key').fill(readFileSync(resolve(ROOT, '../docs/samples/pubkey.txt'), 'utf8').trim());
    await page.getByRole('button', { name: 'Run C++ check' }).click(); await waitResult(page, 'Intact');
  });

  await check('cancel during sample body read cannot start a stale verification', async () => {
    await route(page, 'sandbox');
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.__restoreFetch = () => { window.fetch = original; };
      window.fetch = (input, options) => {
        if (String(input).endsWith('/px4-full.fseal')) return Promise.resolve({ ok: true, blob: () => new Promise((resolve) => { window.__releaseSampleBody = resolve; }) });
        return original(input, options);
      };
    });
    await page.getByRole('button', { name: /Open full PX4 example/ }).click();
    await page.waitForFunction(() => typeof window.__releaseSampleBody === 'function');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(() => { window.__releaseSampleBody(new Blob(['cancelled sample response'])); window.__releaseSampleBody = null; window.__restoreFetch(); });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#result-heading').count(), 0);
    assert.match(await page.locator('.operation-status').textContent(), /Verification cancelled/);
  });

  await check('record detail file read failure has retry and stale rejection cannot replace a newer record', async () => {
    await route(page, 'sandbox'); await loadFreshDemo(page);
    await route(page, 'records');
    await page.evaluate(() => {
      const original = Blob.prototype.slice; window.__originalBlobSlice = original; let rejectNext = true;
      Blob.prototype.slice = function (...args) { const part = original.apply(this, args); if (rejectNext) { rejectNext = false; return { arrayBuffer: () => new Promise((_, reject) => { window.__rejectRecordRead = reject; }) }; } return part; };
    });
    await page.locator('.record-list button').nth(1).click();
    await page.waitForFunction(() => typeof window.__rejectRecordRead === 'function');
    await page.locator('.record-list button').nth(2).click();
    await page.waitForFunction(() => document.querySelector('#record-detail-heading')?.textContent === 'Record 752' && document.querySelector('.detail-grid'));
    await page.evaluate(() => { window.__rejectRecordRead(new Error('injected stale read failure')); window.__rejectRecordRead = null; });
    assert.equal(await page.locator('#record-detail-heading').textContent(), 'Record 752');
    await page.evaluate(() => {
      const original = window.__originalBlobSlice; let rejectOnce = true;
      Blob.prototype.slice = function (...args) { const part = original.apply(this, args); if (rejectOnce) { rejectOnce = false; return { arrayBuffer: () => Promise.reject(new Error('injected current read failure')) }; } return part; };
    });
    await page.locator('.record-list button').nth(3).click();
    await page.getByRole('button', { name: 'Retry' }).waitFor();
    await page.evaluate(() => { Blob.prototype.slice = window.__originalBlobSlice; });
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.waitForFunction(() => document.querySelector('.detail-grid')?.textContent.includes('Payload length'));
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('video screen reports local metadata and unknown codec honestly', async () => {
    await route(page, 'video');
    await page.locator('#video-input').setInputFiles({ name: 'local-sample.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a real video') });
    await page.waitForFunction(() => document.querySelector('.video-meta')?.textContent.includes('Codec identification is unknown'), null, { timeout: 10000 });
    assert.match(await page.locator('.video-meta').textContent(), /local-sample\.mp4/);
  });

  await check('320/768/1440 layouts have no page overflow and pass axe; keyboard skip link works', async () => {
    await route(page, 'sandbox'); await page.reload(); await waitResult(page, 'Intact');
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(80);
      const dimensions = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(dimensions.doc <= dimensions.client + 1, `${width}px overflow: ${JSON.stringify(dimensions)}`);
      await auditAxe(page, `${width}px sandbox`);
      await page.screenshot({ path: join(EVIDENCE, `react-console-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('class'), 'skip-link');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'page-sandbox');
    await page.getByRole('button', { name: 'Menu' }).click();
    assert.equal(await page.getByRole('navigation', { name: 'Console sections' }).getByRole('link', { name: /Records/ }).isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').getAttribute('class'), 'menu-toggle');
    await page.evaluate(() => { location.hash = '#/verify'; });
    await page.waitForFunction(() => document.activeElement?.id === 'page-verify' && document.title === 'Verify · FlightSeal Console');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.hash === '#/sandbox' && document.activeElement?.id === 'page-sandbox');
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => location.hash === '#/verify' && document.activeElement?.id === 'page-verify');
    await auditAxe(page, '320px routed page');
  });

  await check('offline reload serves console assets and default demo, then runs native mutation', async () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, '../docs/console/precache.json'), 'utf8'));
    assert.equal(manifest.files.some((path) => path.includes('px4-full.fseal')), false, 'large sample must not be precached');
    const required = manifest.files.filter((path) => path === 'console/' || /\.wasm$|\.js$|\.css$/.test(path)).map((path) => `/flightseal/${path}`);
    await page.waitForFunction(async (paths) => {
      if (!navigator.serviceWorker?.controller) return false;
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        if (await Promise.all(paths.map((path) => cache.match(new URL(path, location.origin)))).then((entries) => entries.every(Boolean))) return true;
      }
      return false;
    }, required, { timeout: 60000 });
    await route(page, 'sandbox');
    await context.setOffline(true);
    try {
      await page.reload(); await waitResult(page, 'Intact');
      assert.match(await page.locator('.result-stat').textContent(), /800/);
      await page.getByRole('button', { name: 'Flip one payload byte' }).click();
      await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-link'), null, { timeout: 30000 });
      assert.match(await page.locator('.first-failure').textContent(), /bad-link/);
    } finally { await context.setOffline(false); }
  });

  await check('documented modifier shortcuts navigate without altering the checked evidence', async () => {
    await page.goto(url); await waitResult(page, 'Intact');
    for (const [number, screen] of [[2, 'verify'], [3, 'records'], [4, 'receipts'], [5, 'video'], [6, 'help'], [1, 'sandbox']]) {
      await page.keyboard.press(`Alt+Shift+${number}`);
      await page.waitForFunction((screen) => document.activeElement?.id === `page-${screen}` && location.hash === `#/${screen}`, screen, { timeout: 1500 });
    }
    assert.match(await page.locator('.result-stat').textContent(), /800/);
    await page.keyboard.press('Alt+Shift+2');
    await page.locator('#trusted-key').fill('editing');
    await page.keyboard.press('Alt+Shift+3');
    assert.equal(await page.evaluate(() => location.hash), '#/verify');
    assert.equal(await page.locator('#trusted-key').inputValue(), 'editing');
  });

  await check('team pricing dialog is keyboard accessible and does not pretend to collect email or sell a plan', async () => {
    await page.getByRole('button', { name: 'Team options' }).click({ timeout: 1500 });
    const dialog = page.getByRole('dialog', { name: 'Team workflow options' });
    assert.match(await dialog.textContent(), /\$49\/month/);
    assert.match(await dialog.textContent(), /not available/);
    assert.equal(await dialog.locator('input, form').count(), 0);
    assert.match(await dialog.getByRole('link', { name: 'Share team requirements' }).getAttribute('href'), /^https:\/\/github\.com\/anirudh763\/flightseal\/issues\/new\?/);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.locator(':focus').textContent(), 'Team options');
    await auditAxe(page, '320px team pricing closed');
    await page.getByRole('button', { name: 'Team options' }).click();
    await auditAxe(page, '320px team pricing dialog');
    assert.ok(await dialog.evaluate((element) => element.getBoundingClientRect().width <= innerWidth));
    await page.keyboard.press('Escape');
  });

  await context.close();
} finally {
  await browser?.close();
  server.close();
  writeFileSync(join(EVIDENCE, 'react-console-report.json'), JSON.stringify({ checks, total: checks.length, passed: checks.filter((x) => x.passed).length, metrics }, null, 2));
}
if (checks.some((check) => !check.passed)) process.exitCode = 1;

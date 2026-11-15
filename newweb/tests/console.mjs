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
const { PDFDocument } = require('pdf-lib');
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
  const heading = ({ sandbox: 'Workbench', verify: 'Verify file', records: 'Records', receipts: 'Receipts', video: 'Video sync', help: 'Trust limits' })[screen];
  await page.waitForFunction((expected) => document.querySelector('.commandbar h1')?.textContent === expected, heading);
}
function littleEndian(value, width) {
  const bytes = Buffer.alloc(width);
  if (width === 8) bytes.writeBigUInt64LE(BigInt(value));
  else if (width === 4) bytes.writeUInt32LE(value >>> 0);
  else if (width === 2) bytes.writeUInt16LE(value);
  else bytes[0] = value;
  return bytes;
}
function testUlog() {
  const header = Buffer.concat([Buffer.from('ULog\x01\x12\x35', 'binary'), Buffer.from([1]), littleEndian(100, 8)]);
  const message = (type, payload) => Buffer.concat([littleEndian(payload.length, 2), Buffer.from(type), payload]);
  const flags = Buffer.alloc(40);
  const format = Buffer.from('vehicle_global_position:uint64_t timestamp;double lat;double lon;float alt;float vel;');
  const add = Buffer.concat([Buffer.from([0]), littleEndian(0, 2), Buffer.from('vehicle_global_position')]);
  const data = Buffer.alloc(34);
  data.writeUInt16LE(0, 0); data.writeBigUInt64LE(123456n, 2);
  data.writeDoubleLE(52.5, 10); data.writeDoubleLE(-4.125, 18);
  data.writeFloatLE(20, 26); data.writeFloatLE(2, 30);
  return Buffer.concat([header, message('B', flags), message('F', format), message('A', add), message('D', data)]);
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
    assert.match(await page.locator('.result-top .eyebrow').textContent(), /VERIFICATION RESULT/);
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    const verdictSummary = await page.locator('.result-top').innerText();
    assert.equal((verdictSummary.match(/\bIntact\b/g) || []).length, 1, verdictSummary);
    assert.match(verdictSummary, /800 records checked; 800 receipt-covered; 0 uncovered/);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 8);
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('allowlisted sample query opens the requested evidence and selected record', async () => {
    await page.goto(`${url}#/records?sample=intact&record=24`);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 24', null, { timeout: 15000 });
    assert.match(await page.locator('.record-list').textContent(), /24/);
    const selectedUrl = new URL(page.url());
    assert.equal(selectedUrl.search, '', 'sample identity is not sent as an HTTP query string');
    assert.match(selectedUrl.hash, /sample=intact/);
    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Workbench' }).click();
    await waitResult(page, 'Intact');
    await page.goto(`${url}#/sandbox?sample=tampered`);
    await page.reload();
    await waitResult(page, 'Tampered');
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
    assert.match(await page.locator('.sample-current').textContent(), /28\.\d+ MiB/);
    assert.match(await page.locator('.sample-note').textContent(), /selected decoded records/);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 13);
    assert.match(await page.locator('.receipt-overview').textContent(), /64,542 records covered by a trusted receipt · 0 uncovered/);
    await route(page, 'sandbox');
  });

  await check('text and JSON downloads are bounded summaries with no payload and text matches display', async () => {
    await loadFreshDemo(page);
    await page.getByText('Text verification report', { exact: true }).click();
    const expected = await page.locator('.report-text').textContent();
    const [textDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download text report' }).click()]);
    assert.equal(textDownload.suggestedFilename(), 'hashwing-verification-report.txt');
    const textPath = await textDownload.path(); assert.equal(readFileSync(textPath, 'utf8'), expected);
    const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
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

  await check('native ULog import drives source-bound telemetry, record selection, video alignment and PDF output', async () => {
    await page.getByRole('button', { name: 'Choose file' }).click();
    await page.locator('#workbench-file').setInputFiles({ name: 'tiny-flight.ulg', mimeType: 'application/octet-stream', buffer: testUlog() });
    await waitResult(page, 'Intact');
    await page.waitForFunction(() => !!document.querySelector('.source-metadata'));
    assert.match(await page.locator('.source-metadata').textContent(), /ULog.*SHA-256 [0-9a-f]{64}/);
    assert.match(await page.locator('.gps-plot').getAttribute('aria-label'), /GPS points plotted offline/);
    assert.match(await page.locator('.series-plots').textContent(), /Altitude/);
    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Records' }).click();
    assert.match(await page.locator('.detail-panel').textContent(), /Source payload bytes · FSRAW001/);
    await page.getByRole('button', { name: 'Clear imported session' }).click();
    await page.waitForFunction(() => !document.querySelector('#result-heading'));

    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Workbench' }).click();
    await page.getByRole('button', { name: 'Load telemetry sample' }).click();
    await waitResult(page, 'Intact');
    await page.waitForFunction(() => document.querySelector('.telemetry-panel')?.textContent.includes('256 decoded points'));
    assert.match(await page.locator('.sample-note').textContent(), /synthetic.*not flight evidence/i);
    assert.match(await page.locator('.gps-plot').getAttribute('aria-label'), /128 visually sampled GPS points/);
    assert.match(await page.locator('.series-plots').textContent(), /Battery/);
    const selectedMapPoint = page.locator('.gps-plot circle[role="button"]').nth(127);
    const selectedMapPointIndex = await selectedMapPoint.getAttribute('data-telemetry-index');
    const selectedPointLabel = await page.locator(`#telemetry-point option[value="${selectedMapPointIndex}"]`).textContent();
    await selectedMapPoint.focus();
    await selectedMapPoint.press('Enter');
    await page.waitForFunction(() => location.hash === '#/records');
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 0');
    await page.getByRole('button', { name: 'Jump to Video sync' }).click();
    await page.waitForFunction(() => location.hash === '#/video');
    assert.equal(await page.locator('#video-record-range').inputValue(), '0');
    assert.equal(await page.locator('#video-record-range').inputValue(), selectedPointLabel.match(/Record (\d+)/)[1], 'the selected telemetry point stays anchored to its source record');
    const videoControls = await page.locator('.video-sync-controls').textContent();
    const selectedTimestamp = selectedPointLabel.match(/[\d,]+ µs/)?.[0].replaceAll(',', '').replace(' µs', '');
    const videoTimestamp = videoControls.match(/telemetry from record [\d,]+ at ([\d,]+) µs/)?.[1].replaceAll(',', '');
    assert.ok(selectedTimestamp && selectedTimestamp === videoTimestamp, `selected point ${selectedPointLabel}; video selection ${videoControls}`);
    assert.match(await page.locator('.video-sync-controls').textContent(), /source byte/);
    const [pdfDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PDF' }).first().click()]);
    const report = await PDFDocument.load(readFileSync(await pdfDownload.path()), { updateMetadata: false });
    assert.equal(report.getTitle(), 'HashWing integrity report');
    assert.equal(report.getCreationDate(), undefined);
    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Workbench' }).click();
    await page.getByRole('button', { name: 'Flip one payload byte' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-link'), null, { timeout: 30000 });
    assert.equal(await page.getByRole('button', { name: 'Clear imported session' }).count(), 1, 'temporary native import stays available while derived output is open');
    await page.getByRole('button', { name: 'Inspect records' }).click();
    if (await page.getByRole('button', { name: 'Last', exact: true }).isEnabled()) await page.getByRole('button', { name: 'Last', exact: true }).click();
    const lastRecord = page.locator('.record-list button').last();
    await lastRecord.click();
    await page.waitForFunction(() => document.querySelector('.detail-grid') || document.querySelector('.detail-panel [role=alert]'));
    if (await page.getByRole('button', { name: 'First', exact: true }).isEnabled()) await page.getByRole('button', { name: 'First', exact: true }).click();
    await page.locator('.record-list button').first().click();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 0');
    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Workbench' }).click();
    const [afterMutation] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download text report' }).click()]);
    assert.match(readFileSync(await afterMutation.path(), 'utf8'), /bad-link/);
    await page.getByRole('button', { name: 'Clear imported session' }).click();
    await page.waitForFunction(() => !document.querySelector('#result-heading'));
  });

  await check('oversized file selection clears any previous intact result and explains the verifier limit', async () => {
    await route(page, 'verify');
    await page.evaluate(() => {
      const input = document.querySelector('#log-input');
      const file = new File(['x'], 'too-large.fseal');
      const transfer = new DataTransfer(); transfer.items.add(file);
      input.files = transfer.files;
      Object.defineProperty(input.files[0], 'size', { value: 1025 * 1024 * 1024 + 1 });
      if (input.files[0].size <= 1025 * 1024 * 1024) throw new Error('browser did not retain the test file size override');
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => /1,025(?:\.00)? MiB/.test(document.querySelector('[role=alert]')?.textContent || ''), null, { timeout: 5000 }).catch(async () => assert.fail(`oversize alert missing; selected size ${await page.locator('#log-input').evaluate((input) => input.files[0]?.size)}; alert ${await page.locator('[role=alert]').textContent().catch(() => '(none)')}`));
    assert.equal(await page.locator('#result-heading').count(), 0, 'previous verdict must not describe the oversized new selection');
  });

  await check('receipt file read rejection is visible and a successful reread recovers', async () => {
    await route(page, 'verify');
    await page.locator('#log-input').setInputFiles(resolve(ROOT, '../docs/samples/intact.fseal'));
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.locator('#trusted-key').fill(readFileSync(resolve(ROOT, '../docs/samples/pubkey.txt'), 'utf8').trim());
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer; let reject = true;
      File.prototype.arrayBuffer = function (...args) { if (reject) { reject = false; return Promise.reject(new Error('injected file read failure')); } return original.apply(this, args); };
    });
    await page.locator('#receipt-input').setInputFiles({ name: 'retry.receipts', mimeType: 'text/plain', buffer: Buffer.from('bad') });
    await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('Could not read the receipts file'), null, { timeout: 5000 });
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Intact');
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('slow receipt read is ignored after a newer file selection completes', async () => {
    await page.evaluate(() => {
      const original = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function (...args) {
        if (this.name === 'slow.receipts') return new Promise((_, reject) => { window.__rejectSlowReceipt = reject; });
        return original.apply(this, args);
      };
    });
    await page.locator('#receipt-input').setInputFiles({ name: 'slow.receipts', mimeType: 'text/plain', buffer: Buffer.from('delayed') });
    await page.waitForFunction(() => typeof window.__rejectSlowReceipt === 'function' && document.querySelector('.field-hint'));
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.waitForFunction(() => !document.querySelector('.field-hint'));
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Intact');
    await page.evaluate(() => { window.__rejectSlowReceipt(new Error('stale receipt read')); window.__rejectSlowReceipt = null; });
    await page.waitForTimeout(40);
    assert.equal(await page.locator('#result-heading').textContent(), 'Intact');
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('receipt loading preserves a UTF-8 BOM for native-compatible rejection', async () => {
    await route(page, 'verify');
    await page.locator('#log-input').setInputFiles(resolve(ROOT, '../docs/samples/intact.fseal'));
    const receipts = readFileSync(resolve(ROOT, '../docs/samples/flight.receipts'), 'utf8');
    await page.locator('#receipt-input').setInputFiles({ name: 'bom.receipts', mimeType: 'text/plain', buffer: Buffer.from(`\uFEFF${receipts}`) });
    await page.locator('#trusted-key').fill(readFileSync(resolve(ROOT, '../docs/samples/pubkey.txt'), 'utf8').trim());
    await page.getByRole('button', { name: 'Run check' }).click();
    await page.waitForFunction(() => /Receipts line 1 is not valid/.test(document.querySelector('[role=alert]')?.textContent || ''));
    assert.equal(await page.locator('#result-heading').count(), 0, 'BOM-prefixed receipt input must not be accepted');
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
  });

  await check('an explicitly empty receipt file requires removal before chain-only verification', async () => {
    await route(page, 'verify');
    await page.locator('#log-input').setInputFiles(resolve(ROOT, '../docs/samples/intact.fseal'));
    await page.locator('#trusted-key').fill('');
    await page.locator('#receipt-input').setInputFiles({ name: 'empty.receipts', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
    await page.waitForFunction(() => document.querySelector('#receipt-input-error')?.textContent.includes('file is empty'));
    assert.equal(await page.getByRole('button', { name: 'Run check' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Remove receipts' }).click();
    assert.equal(await page.getByRole('button', { name: 'Remove receipts' }).count(), 0);
    await page.getByRole('button', { name: 'Run check' }).click();
    await waitResult(page, 'Intact');
    await page.getByText('Text verification report', { exact: true }).click();
    assert.match(await page.locator('.report-text').textContent(), /Receipts: none supplied/);
  });

  await check('blank trusted key is explicitly unverified and adding the key recovers', async () => {
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.locator('#trusted-key').fill(readFileSync(resolve(ROOT, '../docs/samples/pubkey.txt'), 'utf8').trim());
    await page.locator('#trusted-key').fill('');
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Unverified');
    assert.match(await page.locator('.operation-status').textContent(), /trusted public key/);
    const evidenceDifference = await page.locator('.result-top').innerText();
    assert.match(evidenceDifference, /Native chain: Intact/);
    assert.match(evidenceDifference, /Application evidence: Receipt signatures unchecked: trusted key missing/);
    await page.getByText('Text verification report', { exact: true }).click();
    assert.match(await page.locator('.report-text').textContent(), /Native chain result: INTACT/);
    assert.match(await page.locator('.report-text').textContent(), /Overall evidence status: UNVERIFIED/);
    const [unverifiedDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
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
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Unverified');
    await route(page, 'receipts');
    assert.match(await page.locator('tbody').textContent(), /different key/);
    await route(page, 'verify');
    await page.locator('#trusted-key').fill(readFileSync(resolve(ROOT, '../docs/samples/pubkey.txt'), 'utf8').trim());
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Intact');
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
    await page.waitForFunction(() => document.querySelectorAll('.record-list button').length >= 50 && document.querySelector('.detail-grid'));
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer; window.__originalBlobArrayBuffer = original; let rejectNext = true;
      Blob.prototype.arrayBuffer = function (...args) { if (rejectNext) { rejectNext = false; return new Promise((_, reject) => { window.__rejectRecordRead = reject; }); } return original.apply(this, args); };
    });
    await page.locator('.record-list button').nth(1).click();
    await page.waitForFunction(() => typeof window.__rejectRecordRead === 'function');
    await page.locator('.record-list button').nth(2).click();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 752' && document.querySelector('.detail-grid'));
    await page.evaluate(() => { window.__rejectRecordRead(new Error('injected stale read failure')); window.__rejectRecordRead = null; });
    assert.equal(await page.locator('#record-detail-title').textContent(), 'Record 752');
    await page.evaluate(() => {
      const original = window.__originalBlobArrayBuffer; let rejectOnce = true;
      Blob.prototype.arrayBuffer = function (...args) { if (rejectOnce) { rejectOnce = false; return Promise.reject(new Error('injected current read failure')); } return original.apply(this, args); };
    });
    await page.locator('.record-list button').nth(3).click();
    await page.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 5000 }).catch(async () => assert.fail(`current record read did not expose retry: ${(await page.locator('.detail-panel').innerText()).slice(0, 500)}`));
    await page.evaluate(() => { Blob.prototype.arrayBuffer = window.__originalBlobArrayBuffer; });
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.waitForFunction(() => document.querySelector('.detail-grid')?.textContent.includes('Payload length'));
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('video sync decodes real H.264, preserves it across record navigation and seeks native timestamps', async () => {
    await route(page, 'sandbox'); await loadFreshDemo(page);
    await route(page, 'records');
    await page.getByRole('button', { name: 'First', exact: true }).click();
    await page.locator('.record-list button').first().click();
    await route(page, 'video');
    await page.locator('#video-input').setInputFiles(join(HERE, 'fixtures/synthetic-sync.mp4'));
    await page.waitForFunction(() => document.querySelector('video')?.duration === 10 && document.querySelector('video').videoWidth === 160);
    await page.locator('#video-offset').fill('3.5');
    await page.getByRole('button', { name: 'Sync to selected record' }).click();
    await page.waitForFunction(() => !document.querySelector('video').seeking && Math.abs(document.querySelector('video').currentTime - 3.5) < 0.01);
    assert.match(await page.locator('.video-meta').textContent(), /Codec identification is unknown/);
    await route(page, 'records');
    await page.locator('.record-list button').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 1');
    await route(page, 'video');
    await page.waitForFunction(() => document.querySelector('video')?.duration === 10 && !!document.querySelector('video').currentSrc, null, { timeout: 3000 });
    await page.getByRole('button', { name: 'Sync to selected record' }).click();
    await page.waitForFunction(() => !document.querySelector('video').seeking && Math.abs(document.querySelector('video').currentTime - 3.51) < 0.01);
    assert.match(await page.locator('.video-meta').textContent(), /positioned at 3.510 seconds for record 1/);
    await page.locator('#video-offset').fill('200');
    await page.getByRole('button', { name: 'Sync to selected record' }).click();
    assert.match(await page.locator('.video-meta').textContent(), /outside this video/);
  });

  await check('320/768/1440 layouts have no page overflow and pass axe; keyboard skip link works', async () => {
    await route(page, 'sandbox'); await page.reload(); await waitResult(page, 'Intact');
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(80);
      const dimensions = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(dimensions.doc <= dimensions.client + 1, `${width}px overflow: ${JSON.stringify(dimensions)}`);
      const targets = await page.locator('.sample-toolbar button').evaluateAll((elements) => elements.map((element) => ({ name: element.textContent, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
      assert.ok(targets.every((target) => target.width >= 44 && target.height >= 44), `${width}px sample targets: ${JSON.stringify(targets)}`);
      await auditAxe(page, `${width}px sandbox`);
      await page.screenshot({ path: join(EVIDENCE, `react-console-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('class'), 'skip-link');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'page-sandbox');
    assert.equal(await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: /Records/ }).isVisible(), true);
    await page.evaluate(() => { location.hash = '#/verify'; });
    await page.waitForFunction(() => document.activeElement?.id === 'page-verify' && document.title === 'Verify file · HashWing');
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

  await check('rail navigation updates focused route and preserves the checked evidence', async () => {
    await page.goto(url); await waitResult(page, 'Intact');
    for (const [screen, title] of [['verify', 'Verify file'], ['records', 'Records'], ['receipts', 'Receipts'], ['video', 'Video sync'], ['help', 'Trust limits'], ['sandbox', 'Workbench']]) {
      await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: title }).click();
      await page.waitForFunction((target) => document.activeElement?.id === `page-${target}`, screen, { timeout: 1500 });
    }
    assert.match(await page.locator('.result-stat').textContent(), /800/);
    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Verify file' }).click();
    await page.locator('#trusted-key').fill('editing');
    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Records' }).click();
    assert.equal(await page.evaluate(() => location.hash), '#/records');
    await page.getByRole('navigation', { name: 'Workbench sections' }).getByRole('link', { name: 'Verify file' }).click();
    assert.equal(await page.locator('#trusted-key').inputValue(), 'editing');
  });

  await check('PDF export is a valid downloadable integrity report', async () => {
    await page.goto(url); await waitResult(page, 'Intact');
    const [pdfDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PDF' }).first().click()]);
    assert.equal(pdfDownload.suggestedFilename(), 'hashwing-integrity-report.pdf');
    const pdf = await PDFDocument.load(readFileSync(await pdfDownload.path()), { updateMetadata: false });
    assert.equal(pdf.getTitle(), 'HashWing integrity report');
    assert.ok(pdf.getPageCount() >= 1);
  });

  await context.close();
} finally {
  await browser?.close();
  server.close();
  writeFileSync(join(EVIDENCE, 'react-console-report.json'), JSON.stringify({ checks, total: checks.length, passed: checks.filter((x) => x.passed).length, metrics }, null, 2));
}
if (checks.some((check) => !check.passed)) process.exitCode = 1;

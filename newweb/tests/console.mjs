import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { serve } from '../../tests/web/serve.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EVIDENCE = process.env.REACT_CONSOLE_EVIDENCE || join(ROOT, '.test-artifacts');
mkdirSync(EVIDENCE, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');
const { decodePDFRawStream } = require('pdf-lib/cjs/core/index.js');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { server, url: rootUrl } = await serve(0, '/flightseal');
const url = `${rootUrl}console/`;
let browser;
const checks = [];
const metrics = {};
const axeReviews = [];
const failedAssets = [];
const runtimeErrors = [];
const CHECK_FILTER = (process.env.HASHWING_CHECK_FILTER || '').split(',').filter(Boolean);
async function waitForServer() {
  const response = await fetch(url); if (!response.ok) throw new Error(`Built console returned ${response.status}.`);
}
async function check(name, fn) {
  if (CHECK_FILTER.length && !CHECK_FILTER.some((filter) => name.includes(filter))) { console.log(`skip ${name}`); return; }
  try { await fn(); checks.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: String(error.message || error) }); console.error(`FAIL ${name}: ${error.message || error}`); }
}
async function waitResult(page, text = 'Intact') {
  try { await page.waitForFunction((needle) => document.querySelector('#result-heading')?.textContent.includes(needle), text, { timeout: 30000 }); }
  catch { throw new Error(`Expected result ${text}; page state: ${(await page.locator('body').innerText()).slice(0, 1400)}`); }
  await page.locator('.busy-card').waitFor({ state: 'hidden', timeout: 30000 });
}
async function loadFreshDemo(page) {
  await route(page, 'sandbox');
  await page.getByRole('button', { name: 'Load 800-record demo' }).click();
  await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('800'), null, { timeout: 30000 }).catch(async () => assert.fail(`800-record demo did not finish loading: ${JSON.stringify(await page.evaluate(() => ({ hash: location.hash, result: document.querySelector('.result-stat')?.textContent || null, sample: document.querySelector('.sample-current')?.textContent || null, busy: document.querySelector('.busy-card')?.textContent || null, alert: document.querySelector('[role="alert"]')?.textContent || null, operation: document.querySelector('.operation-status')?.textContent || null })))}`));
}
async function loadLandingDemo(page) {
  await page.goto(url);
  await page.getByRole('link', { name: 'Try a sample' }).click(); // the front door opens Samples, which runs the real engine
  await waitResult(page, 'Intact');
}
// The one "Profile on this device" menu in the command bar (AC-61).
async function profileMenuAction(page, name) {
  const menu = page.locator('.profile-menu');
  if (!(await menu.evaluate((d) => d.open))) await menu.locator('summary').click();
  await menu.getByRole('button', { name, exact: true }).click();
}
// Samples, Video, Benchmarks and System sit behind the rail's "More tools" disclosure.
async function clickNav(page, name) {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  const link = nav.getByRole('link', { name, exact: true });
  if (!(await link.isVisible())) { const more = nav.locator('.nav-more'); if (!(await more.evaluate((d) => d.open))) await more.locator('summary').click(); }
  await link.click();
}
async function route(page, screen) {
  await page.evaluate((s) => { location.hash = `/app/${s}`; }, screen);
  await page.waitForFunction((s) => location.hash === `#/app/${s}`, screen);
  const heading = ({ sandbox: 'Samples', verify: 'Verify', records: 'Records', receipts: 'Receipts', video: 'Video', help: 'Trust' })[screen];
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
  // Let deferred route focus and history scroll restoration commit before measuring.
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise(requestAnimationFrame);
  });
  await page.waitForFunction(() => Math.abs(window.scrollY) < 1, null, { timeout: 3000 }).catch(async () => {
    assert.fail(`${label}: viewport did not settle: ${JSON.stringify(await page.evaluate(() => ({ scrollY, active: document.activeElement?.id, hash: location.hash })))}`);
  });
  await page.evaluate(AXE);
  const results = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
  axeReviews.push({ label, incomplete: results.incomplete.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.target) })) });
  assert.equal(results.violations.length, 0, `${label}: ${results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary || ''}`).join('; ')}`).join(' | ')}`);
}
try {
  await waitForServer();
  const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => runtimeErrors.push(String(error)));
  page.on('requestfailed', (request) => { if (['script', 'stylesheet', 'image', 'font'].includes(request.resourceType()) && !request.failure()?.errorText?.includes('ERR_ABORTED')) failedAssets.push(`${request.resourceType()} ${request.url()}: ${request.failure()?.errorText}`); });
  page.on('response', (response) => { if (response.status() >= 400 && ['script', 'stylesheet', 'image', 'font'].includes(response.request().resourceType())) failedAssets.push(`${response.status()} ${response.url()}`); });
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(`${message.text()} (${message.location().url})`); });
  const initialStarted = performance.now();
  await page.goto(url);
  assert.equal(await page.locator('#page-landing').textContent(), 'HashWing', 'first load is the front door');
  await page.getByRole('link', { name: 'Try a sample' }).click();
  await waitResult(page, 'Intact');
  await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('800'));
  assert.equal(await page.getByLabel('Choose source or sealed log').count(), 1, 'the shared upload control has a direct action name');
  assert.match(await page.locator('#session-file-name').textContent(), /Choose a source or sealed log/);
  metrics.firstVisit800DemoMs = Math.round(performance.now() - initialStarted);

  await check('included 800-record demo verifies through native WASM with receipts', async () => {
    assert.ok(metrics.firstVisit800DemoMs < 3000, `first included demo took ${metrics.firstVisit800DemoMs}ms`);
    assert.equal(await page.locator('.result-top .eyebrow').count(), 0, 'result has no redundant status caption');
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    const verdictSummary = await page.locator('.result-top').innerText();
    assert.equal((verdictSummary.match(/\bIntact\b/g) || []).length, 1, verdictSummary);
    assert.match(verdictSummary, /800 records checked; 800 receipt-covered; 0 uncovered/);
    assert.equal(await page.locator('.result-heading-live[role="status"]').count(), 1, 'the verdict has one live announcement');
    assert.equal(await page.locator('.operation-status').count(), 0, 'success has no second persistent banner');
    const fieldEdgeContrast = await page.locator('#workbench-file').evaluate((input) => {
      const luminance = (color) => color.match(/\d+/g).slice(0, 3).map((component) => Number(component) / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const border = luminance(getComputedStyle(input).borderTopColor); const surface = luminance(getComputedStyle(input).backgroundColor);
      return (Math.max(border, surface) + 0.05) / (Math.min(border, surface) + 0.05);
    });
    assert.ok(fieldEdgeContrast >= 3, `file field boundary contrast is ${fieldEdgeContrast.toFixed(2)}:1`);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 8);
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('workspace utilities preserve keyboard access without crowding the header', async () => {
    await route(page, 'verify');
    assert.equal(await page.locator('.commandbar #workbench-file').count(), 0);
    assert.equal(await page.locator('#workbench-file').count(), 1);
    const utilities = page.locator('.install-tools > summary');
    await utilities.press('Enter');
    await page.getByRole('button', { name: 'Prepare offline', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Prepare offline', exact: true }).press('Escape');
    assert.equal(await page.locator('.install-tools').getAttribute('open'), null);
    assert.equal(await utilities.evaluate((el) => el === document.activeElement), true);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.locator('.profile-menu > summary').click();
    const menu = await page.locator('.profile-menu-panel').boundingBox();
    assert.ok(menu.y >= 0 && menu.y + menu.height <= 667, JSON.stringify(menu));
    await page.locator('.profile-menu > summary').press('Escape');
    assert.equal(await page.locator('.profile-menu').getAttribute('open'), null);
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await check('allowlisted sample query opens the requested evidence and selected record', async () => {
    await page.goto(`${url}#/records?sample=intact&record=24`);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 24', null, { timeout: 15000 });
    assert.match(await page.locator('.record-list').textContent(), /24/);
    const selectedUrl = new URL(page.url());
    assert.equal(selectedUrl.search, '', 'sample identity is not sent as an HTTP query string');
    assert.match(selectedUrl.hash, /sample=intact/);
    await clickNav(page, 'Samples');
    await waitResult(page, 'Intact');
    await page.goto(`${url}#/sandbox?sample=tampered`);
    await page.reload();
    await waitResult(page, 'Tampered');
  });

  await check('verify demo mutates a sample copy and restores the original', async () => {
    await page.goto(`${url}#/verify`);
    await waitResult(page, 'Intact');
    await page.getByRole('button', { name: 'Simulate Tampering' }).click();
    await waitResult(page, 'Tampered');
    assert.match(await page.locator('.first-failure').textContent(), /bad-link/);
    assert.match(await page.locator('.sample-note').textContent(), /original sample, receipts and public key were retained unchanged/i);
    await page.getByRole('button', { name: 'Restore Original' }).click();
    await waitResult(page, 'Intact');
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    assert.match(await page.locator('.result-panel').textContent(), /800 records checked/);
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
    await page.getByRole('button', { name: 'Load PX4 sample' }).click();
    await waitResult(page, 'Intact');
    assert.match(await page.locator('.result-stat').textContent(), /2,422/);
  });

  await check('full PX4 fixture verifies 64,542 records and all 13 signed receipts on demand', async () => {
    const start = performance.now();
    await page.getByRole('button', { name: /Load full PX4 sample/ }).click();
    await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('64,542'), null, { timeout: 60000 });
    metrics.fullPX4NativeAndIndexMs = Math.round(performance.now() - start);
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    assert.match(await page.locator('.sample-current').textContent(), /28\.\d+ MiB/);
    assert.match(await page.locator('.sample-note').textContent(), /selected decoded records/);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 13);
    assert.match(await page.locator('.receipt-overview').textContent(), /64,542 records covered by a receipt signed by the key you entered · 0 uncovered/);
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
    await page.locator('#workbench-file').setInputFiles({ name: 'small-flight.tsv', mimeType: 'text/plain', buffer: Buffer.from('100\talpha\n200\tbravo\n300\tcharlie\n') });
    assert.equal(await page.locator('#workbench-file').evaluate((input) => input.files[0].name), 'small-flight.tsv');
    assert.match(await page.locator('#session-file-name').textContent(), /small-flight.tsv/);
    await page.locator('#receipt-interval').fill('2');
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact') && document.querySelector('.seal-outputs'), null, { timeout: 30000 });
    await page.locator('.busy-card').waitFor({ state: 'hidden', timeout: 30000 });
    assert.equal(await page.locator('.seal-outputs button').count(), 3);
    assert.match(await page.locator('.result-stat').textContent(), /3/);
    assert.match(await page.locator('.seal-outputs').textContent(), /Generated from small-flight\.tsv/);
    assert.equal(await page.locator('.output-ack input').isChecked(), false);
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, 'unexported generated files warn before reload');

    await page.getByRole('checkbox', { name: 'I saved these files or no longer need them' }).check();
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false, 'acknowledging output clears the reload warning');
  });

  await check('CSV is previewed and converted only after explicit field and unit mapping', async () => {
    await route(page, 'sandbox');
    await page.locator('#workbench-file').setInputFiles({ name: 'previous.tsv', mimeType: 'text/plain', buffer: Buffer.from('50\told\n') });
    assert.equal(await page.getByRole('button', { name: 'Seal and verify' }).isDisabled(), false);
    await page.locator('#workbench-file').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('timestamp_us,value\n50\n') });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Seal and verify' }).isDisabled(), true, 'a rejected new source cannot silently leave the previous source armed');
    await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
    const csv = 'epoch,lat_deg,lon_deg,height_m,speed_mps,note\n100,42,-71,12,3.5,first\n200,42.1,-71.1,13,4,second\n';
    await page.locator('#workbench-file').setInputFiles({ name: 'mapped-flight.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('heading', { name: 'Map CSV fields' }).waitFor();
    await page.getByRole('button', { name: 'Cancel mapping' }).click();
    await page.getByRole('heading', { name: 'Map CSV fields' }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Seal and verify' }).isDisabled(), true, 'cancel leaves no converted source armed');
    assert.match(await page.locator('.operation-status').textContent(), /CSV mapping canceled.*No source was converted/);
    await page.locator('#workbench-file').setInputFiles({ name: 'mapped-flight.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('heading', { name: 'Map CSV fields' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Convert mapped CSV' }).isDisabled(), true, 'conversion waits for explicit fields and units');
    assert.match(await page.locator('.csv-preview-scroll').innerText(), /epoch.*lat_deg.*note.*100.*first/s);
    const choose = async (field, value) => page.locator(`#csv-${field}`).selectOption(value);
    await choose('timestampColumn', 'epoch'); await choose('timestampUnit', 'microseconds');
    await choose('latitudeColumn', 'lat_deg'); await choose('latitudeUnit', 'degrees');
    await choose('longitudeColumn', 'lon_deg'); await choose('longitudeUnit', 'degrees');
    await choose('altitudeColumn', 'height_m'); await choose('altitudeUnit', 'meters');
    await choose('speedColumn', 'speed_mps'); await choose('speedUnit', 'meters per second');
    assert.equal(await page.getByRole('button', { name: 'Convert mapped CSV' }).isDisabled(), false);
    await page.getByRole('button', { name: 'Convert mapped CSV' }).click();
    await page.locator('.source-preview').waitFor({ timeout: 15000 });
    assert.match(await page.locator('.source-preview').innerText(), /timestamp: “epoch” \(microseconds\).*latitude: “lat_deg” \(degrees\)/);
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await waitResult(page, 'Intact');
    assert.equal(await page.locator('.gps-plot circle').count(), 2);
    assert.match(await page.locator('.series-plots').innerText(), /Altitude.*Speed/s);
    const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
    const report = JSON.parse(readFileSync(await jsonDownload.path(), 'utf8'));
    assert.equal(report.source.fieldMapping.timestampColumn, 'epoch');
    assert.equal(report.source.fieldMapping.latitudeUnit, 'degrees');
    assert.equal(report.source.recordMappings[0].sourceIdentifier, 'csv-data-row:1');
    assert.match(report.source.sha256, /^[a-f0-9]{64}$/);
    await page.getByRole('checkbox', { name: 'I saved these files or no longer need them' }).check();
  });

  await check('unacknowledged outputs stay source-bound until acknowledged before replacement', async () => {
    await route(page, 'sandbox');
    await page.locator('#workbench-file').setInputFiles({ name: 'replacement.tsv', mimeType: 'text/plain', buffer: Buffer.from('400\tdelta\n500\techo\n') });
    assert.equal(await page.locator('.seal-outputs').count(), 0, 'acknowledged outputs may be cleared when selecting a new source');
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact') && document.querySelector('.seal-outputs')?.textContent.includes('Generated from replacement.tsv'), null, { timeout: 30000 }).catch(async () => assert.fail(`replacement seal did not complete: ${(await page.locator('body').innerText()).slice(0, 900)}`));
    await page.locator('.busy-card').waitFor({ state: 'hidden', timeout: 30000 });
    assert.equal(await page.locator('.output-ack input').isChecked(), false, 'replacement output requires a fresh acknowledgement');
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, 'new outputs restore the reload warning');
    await page.getByRole('checkbox', { name: 'I saved these files or no longer need them' }).check();
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);

    await page.locator('#workbench-file').setInputFiles({ name: 'current.tsv', mimeType: 'text/plain', buffer: Buffer.from('600\tfoxtrot\n700\tgolf\n') });
    await page.waitForTimeout(50);
    await page.locator('.busy-card').waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('#session-file-name')?.textContent.includes('current.tsv') && !Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Seal and verify'))?.disabled);
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact') && document.querySelector('.seal-outputs')?.textContent.includes('Generated from current.tsv'), null, { timeout: 30000 }).catch(async () => assert.fail(`current seal did not complete: ${(await page.locator('body').innerText()).slice(0, 900)}`));
    await page.locator('.busy-card').waitFor({ state: 'hidden', timeout: 30000 });
    assert.equal(await page.locator('.output-ack input').isChecked(), false);
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
    await page.locator('#workbench-file').setInputFiles({ name: 'next.tsv', mimeType: 'text/plain', buffer: Buffer.from('800\thotel\n900\tindia\n') });
    assert.match(await page.locator('#session-file-name').textContent(), /next\.tsv/);
    assert.match(await page.locator('.seal-outputs').textContent(), /Generated from current\.tsv/);
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    assert.match(await page.getByRole('alert').textContent(), /Download the current sealed files or confirm/);
    assert.match(await page.locator('.seal-outputs').textContent(), /Generated from current\.tsv/, 'unacknowledged output cannot be overwritten');
    await page.locator('#workbench-file').setInputFiles({ name: 'tiny-flight.ulg', mimeType: 'application/octet-stream', buffer: testUlog() });
    await waitResult(page, 'Intact');
    await page.waitForFunction(() => !!document.querySelector('.clear-session'));
    await page.getByRole('button', { name: 'Clear imported session' }).click();
    await page.waitForFunction(() => !document.querySelector('#result-heading'));
    assert.match(await page.locator('.seal-outputs').textContent(), /Generated from current\.tsv/, 'clearing a temporary import keeps the generated files');
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
    await page.getByRole('checkbox', { name: 'I saved these files or no longer need them' }).check();
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
  });

  await check('cancelled Seal picker intent resets before a regular sealed-log selection', async () => {
    await route(page, 'sandbox');
    await page.locator('#workbench-file').setInputFiles({ name: 'source.tsv', mimeType: 'text/plain', buffer: Buffer.from('100\talpha\n200\tbravo\n') });
    await page.locator('#workbench-file').setInputFiles({ name: 'intact.fseal', mimeType: 'application/octet-stream', buffer: readFileSync(resolve(ROOT, '../docs/samples/intact.fseal')) });
    await page.waitForFunction(() => location.hash.startsWith('#/app/verify'), null, { timeout: 10000 }).catch(async () => assert.fail(`sealed log selection did not open Verify: ${(await page.locator('body').innerText()).slice(0, 900)}`));
    await page.evaluate(() => { location.hash = '#/app/sandbox'; });
    await page.waitForFunction(() => location.hash === '#/app/sandbox');
    const chooserReady = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Seal new log' }).click();
    const chooser = await chooserReady;
    assert.ok(chooser, 'the Seal new log action opened the shared file picker');
    await page.locator('#workbench-file').evaluate((input) => input.dispatchEvent(new Event('cancel', { bubbles: true })));
    await page.locator('#workbench-file').setInputFiles({ name: 'after-cancel.fseal', mimeType: 'application/octet-stream', buffer: readFileSync(resolve(ROOT, '../docs/samples/intact.fseal')) });
    await page.waitForFunction(() => location.hash.startsWith('#/app/verify'), null, { timeout: 10000 }).catch(async () => assert.fail(`post-cancel sealed log selection did not open Verify: ${(await page.locator('body').innerText()).slice(0, 900)}`));
    assert.equal(await page.getByRole('alert').count(), 0, 'the next normal source is not rejected as a seal source');
    await page.getByRole('button', { name: 'Run check' }).click();
    await waitResult(page, 'Intact');
  });

  await check('native ULog import drives source-bound telemetry, record selection, video alignment and PDF output', async () => {
    await page.goto(`${url}#/app/sandbox?sample=intact&record=799`);
    await waitResult(page, 'Intact');
    assert.match(await page.locator('.result-stat').textContent(), /800/);
    assert.equal(await page.locator('#workbench-file').isDisabled(), false, 'the shared source picker is enabled before ULog selection');
    await page.locator('#workbench-file').setInputFiles({ name: 'tiny-flight.ulg', mimeType: 'application/octet-stream', buffer: testUlog() });
    assert.equal(await page.locator('#workbench-file').evaluate((input) => input.files[0].name), 'tiny-flight.ulg');
    assert.match(await page.locator('#session-file-name').textContent(), /tiny-flight.ulg/);
    await page.waitForFunction(() => document.querySelector('.busy-card') || document.querySelector('.source-metadata') || document.querySelector('[role="alert"]'), null, { timeout: 5000 }).catch(async () => assert.fail(`ULog selection did not start any import state: ${(await page.locator('body').innerText()).slice(0, 1400)}`));
    await page.waitForFunction(() => !!document.querySelector('.source-metadata'), null, { timeout: 30000 }).catch(async () => assert.fail(`ULog source details missing: ${(await page.locator('body').innerText()).slice(0, 2500)}`));
    await waitResult(page, 'Intact');
    assert.equal(new URL(page.url()).hash.includes('sample='), false, 'custom ULog success removes the previously rendered bundled sample parameter');
    assert.match(await page.locator('.stats-grid').textContent(), /tiny-flight\.ulg/);
    assert.match(await page.locator('.result-stat').textContent(), /2\s*records checked/, 'custom source result remains active after navigation settles');
    assert.match(await page.locator('.source-metadata').textContent(), /ULog.*SHA-256 [0-9a-f]{64}/);
    assert.match(await page.locator('.gps-plot').getAttribute('aria-label'), /sampled recorded coordinates plotted locally/);
    assert.match(await page.locator('.series-plots').textContent(), /Altitude/);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Records' }).click();
    assert.match(await page.locator('.detail-panel').textContent(), /Source payload bytes · FSRAW001/);
    await page.getByRole('button', { name: 'Clear imported session' }).click();
    await page.waitForFunction(() => !document.querySelector('#result-heading')).catch(async () => assert.fail(`ULog clear did not finish: ${(await page.locator('body').innerText()).slice(0, 1200)}`));

    await clickNav(page, 'Samples');
    await page.getByRole('button', { name: 'Load telemetry sample' }).click();
    await waitResult(page, 'Intact');
    await page.waitForFunction(() => document.querySelector('.telemetry-panel')?.textContent.includes('256 decoded points')).catch(async () => assert.fail(`synthetic ULog telemetry preview missing: ${(await page.locator('body').innerText()).slice(0, 1600)}`));
    assert.match(await page.locator('.sample-note').textContent(), /synthetic.*not flight evidence/i);
    assert.match(await page.locator('.gps-plot').getAttribute('aria-label'), /128 sampled recorded coordinates plotted locally/);
    assert.match(await page.locator('.series-plots').textContent(), /Battery/);
    assert.equal(await page.locator('.telemetry-plot circle[role="button"][tabindex="0"]').count(), 4, 'one roving chart stop per plot');
    const firstChartPoint = page.locator('.gps-plot circle[tabindex="0"]');
    await firstChartPoint.focus();
    const firstIndex = await firstChartPoint.getAttribute('data-telemetry-index');
    await firstChartPoint.press('ArrowRight');
    await page.waitForFunction((previous) => document.querySelector('.gps-plot circle:focus')?.getAttribute('data-telemetry-index') !== previous, firstIndex).catch(async () => assert.fail(`keyboard telemetry selection did not move: ${(await page.locator('.telemetry-panel').innerText()).slice(0, 1300)}`));
    const movedPoint = page.locator('.gps-plot circle:focus');
    assert.notEqual(await movedPoint.getAttribute('data-telemetry-index'), firstIndex);
    assert.equal(await movedPoint.getAttribute('aria-pressed'), 'true');
    for (let tabs = 0; tabs < 4 && await page.evaluate(() => document.activeElement?.id !== 'telemetry-point'); tabs++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'telemetry-point', 'selector follows at most four chart stops');
    const selectedMapPoint = page.locator('.gps-plot circle[role="button"]').nth(127);
    const selectedMapPointIndex = await selectedMapPoint.getAttribute('data-telemetry-index');
    const selectedPointLabel = await page.locator(`#telemetry-point option[value="${selectedMapPointIndex}"]`).textContent();
    await selectedMapPoint.focus();
    await selectedMapPoint.press('Enter');
    await page.waitForFunction(() => location.hash.startsWith('#/app/records')).catch(async () => assert.fail(`telemetry point did not navigate to canonical Records: ${await page.evaluate(() => location.hash)}; ${(await page.locator('body').innerText()).slice(0, 900)}`));
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 0').catch(async () => assert.fail(`selected source record did not open: ${(await page.locator('.detail-panel').innerText()).slice(0, 900)}`));
    await page.getByRole('button', { name: 'Video' }).click();
    await page.waitForFunction(() => location.hash.startsWith('#/app/video')).catch(async () => assert.fail(`Video navigation failed: ${await page.evaluate(() => location.hash)}`));
    assert.equal(await page.locator('#video-record-range').inputValue(), '0');
    assert.equal(await page.locator('#video-record-range').inputValue(), selectedPointLabel.match(/Record (\d+)/)[1], 'the selected telemetry point stays anchored to its source record');
    const videoControls = await page.locator('.video-sync-controls').textContent();
    const selectedTimestamp = selectedPointLabel.match(/[\d,]+ µs/)?.[0].replaceAll(',', '').replace(' µs', '');
    const videoTimestamp = videoControls.match(/telemetry from record [\d,]+ at ([\d,]+) µs/)?.[1].replaceAll(',', '');
    assert.ok(selectedTimestamp && selectedTimestamp === videoTimestamp, `selected point ${selectedPointLabel}; video selection ${videoControls}`);
    assert.match(await page.locator('.video-sync-controls').textContent(), /source byte/);
    if (!(await page.getByRole('button', { name: 'Export PDF' }).isVisible())) await page.locator('.source-actions > summary').click();
    const [pdfDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PDF' }).first().click()]);
    const report = await PDFDocument.load(readFileSync(await pdfDownload.path()), { updateMetadata: false });
    assert.equal(report.getTitle(), 'HashWing integrity report');
    assert.equal(report.getCreationDate(), undefined);
    await clickNav(page, 'Samples');
    await page.getByRole('button', { name: 'Flip one payload byte' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-link'), null, { timeout: 30000 });
    assert.equal(await page.getByRole('button', { name: 'Clear imported session' }).count(), 1, 'temporary native import stays available while derived output is open');
    await page.getByRole('button', { name: 'Records', exact: true }).click();
    if (await page.getByRole('button', { name: 'Last', exact: true }).isEnabled()) await page.getByRole('button', { name: 'Last', exact: true }).click();
    const lastRecord = page.locator('.record-list button').last();
    await lastRecord.click();
    await page.waitForFunction(() => document.querySelector('.detail-grid') || document.querySelector('.detail-panel [role=alert]'));
    if (await page.getByRole('button', { name: 'First', exact: true }).isEnabled()) await page.getByRole('button', { name: 'First', exact: true }).click();
    await page.locator('.record-list button').first().click();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 0');
    await clickNav(page, 'Samples');
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
    await page.waitForFunction(() => typeof window.__rejectSlowReceipt === 'function' && document.querySelector('.input-grid .field-hint[role="status"]'));
    await page.locator('#receipt-input').setInputFiles(resolve(ROOT, '../docs/samples/flight.receipts'));
    await page.waitForFunction(() => !document.querySelector('.input-grid .field-hint[role="status"]'));
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
    assert.match(await page.locator('.result-top').textContent(), /trusted key missing/);
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
    await page.locator('#trusted-key').fill('1'.repeat(64));
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Unverified');
    await route(page, 'receipts');
    assert.match(await page.locator('tbody').textContent(), /different key/);
    await route(page, 'verify');
    // A weak key (here the identity point, under which any message "verifies") is refused, never shown as a verdict.
    await page.locator('#trusted-key').fill('01' + '00'.repeat(31));
    await page.getByRole('button', { name: 'Run check' }).click();
    await page.getByRole('alert').filter({ hasText: "This public key is weak and can't prove anything" }).waitFor({ timeout: 30000 });
    assert.equal(await page.locator('#result-heading').count(), 0, 'no verdict is shown for a weak key');
    await page.locator('#trusted-key').fill(readFileSync(resolve(ROOT, '../docs/samples/pubkey.txt'), 'utf8').trim());
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Intact');
  });

  await check('cancel during sample body read cannot start a stale verification', async () => {
    await route(page, 'sandbox');
    const acceptFixtureSwitch = (dialog) => dialog.accept();
    page.on('dialog', acceptFixtureSwitch);
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.__restoreFetch = () => { window.fetch = original; };
      window.fetch = (input, options) => {
        if (String(input).endsWith('/px4-full.fseal')) return Promise.resolve({ ok: true, blob: () => new Promise((resolve) => { window.__releaseSampleBody = resolve; }) });
        return original(input, options);
      };
    });
    try {
      await page.getByRole('button', { name: /Load full PX4 sample/ }).click();
      await page.waitForFunction(() => typeof window.__releaseSampleBody === 'function', null, { timeout: 30000 }).catch(async () => assert.fail(`full PX4 response was not intercepted: ${JSON.stringify(await page.evaluate(() => ({ hash: location.hash, releaseHook: typeof window.__releaseSampleBody, result: document.querySelector('#result-heading')?.textContent || null, busy: document.querySelector('.busy-card')?.textContent || null, button: [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Load full PX4'))?.disabled ?? null, fetch: window.fetch.toString().slice(0, 180) })))}`));
    } finally { page.off('dialog', acceptFixtureSwitch); }
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(() => { window.__releaseSampleBody(new Blob(['cancelled sample response'])); window.__releaseSampleBody = null; window.__restoreFetch(); });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#result-heading').count(), 0);
    assert.match(await page.locator('.operation-status').textContent(), /Verification cancelled/);
  });

  await check('record detail file read failure has retry and stale rejection cannot replace a newer record', async () => {
    await route(page, 'sandbox'); await loadFreshDemo(page);
    await route(page, 'records');
    await page.waitForFunction(() => document.querySelectorAll('.record-list button').length >= 50 && document.querySelector('.detail-grid'), null, { timeout: 30000 }).catch(async () => assert.fail(`record view did not load after sample verification: ${JSON.stringify(await page.evaluate(() => ({ hash: location.hash, sample: document.querySelector('.sample-current')?.textContent || null, result: document.querySelector('.result-stat')?.textContent || null, rows: document.querySelectorAll('.record-list button').length, detail: !!document.querySelector('.detail-grid'), alert: document.querySelector('[role="alert"]')?.textContent || null, busy: document.querySelector('.busy-card')?.textContent || null, operation: document.querySelector('.operation-status')?.textContent || null })))}`));
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer; window.__originalBlobArrayBuffer = original; let rejectNext = true;
      Blob.prototype.arrayBuffer = function (...args) { if (rejectNext) { rejectNext = false; return new Promise((_, reject) => { window.__rejectRecordRead = reject; }); } return original.apply(this, args); };
    });
    await page.locator('.record-list button').nth(1).click();
    await page.waitForFunction(() => typeof window.__rejectRecordRead === 'function', null, { timeout: 3000 }).catch(async () => assert.fail(`record read injection did not start: ${JSON.stringify(await page.evaluate(() => ({ heading: document.querySelector('#record-detail-title')?.textContent || null, detail: !!document.querySelector('.detail-grid'), alert: document.querySelector('[role="alert"]')?.textContent || null, rejectHook: typeof window.__rejectRecordRead })))}`));
    const newerRecord = (await page.locator('.record-list button').nth(2).locator('.record-index').textContent()).trim();
    await page.locator('.record-list button').nth(2).click();
    await page.waitForFunction((index) => document.querySelector('#record-detail-title')?.textContent === `Record ${index}` && document.querySelector('.detail-grid'), newerRecord, { timeout: 5000 }).catch(async () => assert.fail(`newer record did not replace delayed read: ${JSON.stringify(await page.evaluate(() => ({ heading: document.querySelector('#record-detail-title')?.textContent || null, detail: !!document.querySelector('.detail-grid'), alert: document.querySelector('[role="alert"]')?.textContent || null, rows: [...document.querySelectorAll('.record-list button')].slice(0, 4).map((row) => row.innerText) })))}`));
    await page.evaluate(() => { window.__rejectRecordRead(new Error('injected stale read failure')); window.__rejectRecordRead = null; });
    assert.equal(await page.locator('#record-detail-title').textContent(), `Record ${newerRecord}`);
    await page.evaluate(() => {
      const original = window.__originalBlobArrayBuffer; let rejectOnce = true;
      Blob.prototype.arrayBuffer = function (...args) { if (rejectOnce) { rejectOnce = false; return Promise.reject(new Error('injected current read failure')); } return original.apply(this, args); };
    });
    await page.locator('.record-list button').nth(3).click();
    await page.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 5000 }).catch(async () => assert.fail(`current record read did not expose retry: ${(await page.locator('.detail-panel').innerText()).slice(0, 500)}`));
    await page.evaluate(() => { Blob.prototype.arrayBuffer = window.__originalBlobArrayBuffer; });
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.waitForFunction(() => document.querySelector('.detail-grid')?.textContent.includes('Payload length'), null, { timeout: 5000 }).catch(async () => assert.fail(`record retry did not restore detail: ${JSON.stringify(await page.evaluate(() => ({ heading: document.querySelector('#record-detail-title')?.textContent || null, detail: document.querySelector('.detail-grid')?.textContent.slice(0, 240) || null, alert: document.querySelector('[role="alert"]')?.textContent || null, status: document.querySelector('[role="status"]')?.textContent || null })))}`));
    assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  });

  await check('video sync decodes real H.264, preserves it across record navigation and seeks native timestamps', async () => {
    await route(page, 'sandbox'); await loadFreshDemo(page);
    await route(page, 'records');
    await page.locator('.record-list button').first().click();
    await route(page, 'video');
    await page.locator('#video-input').setInputFiles(join(HERE, 'fixtures/synthetic-sync.mp4'));
    await page.waitForFunction(() => document.querySelector('video')?.duration === 10 && document.querySelector('video').videoWidth === 160);
    await page.locator('#video-offset').fill('3.5');
    await page.getByRole('button', { name: 'Sync to record' }).click();
    await page.waitForFunction(() => !document.querySelector('video').seeking && Math.abs(document.querySelector('video').currentTime - 3.5) < 0.01);
    assert.match(await page.locator('.video-meta').textContent(), /Codec identification is unknown/);
    await route(page, 'records');
    await page.locator('.record-list button').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 1');
    await route(page, 'video');
    await page.waitForFunction(() => document.querySelector('video')?.duration === 10 && !!document.querySelector('video').currentSrc, null, { timeout: 3000 });
    await page.getByRole('button', { name: 'Sync to record' }).click();
    await page.waitForFunction(() => !document.querySelector('video').seeking && Math.abs(document.querySelector('video').currentTime - 3.51) < 0.01);
    assert.match(await page.locator('.video-meta').textContent(), /positioned at 3.510 seconds for record 1/);
    await page.locator('#video-offset').fill('200');
    await page.getByRole('button', { name: 'Sync to record' }).click();
    assert.match(await page.locator('.video-meta').textContent(), /outside this video/);
  });

  await check('320/375/768/1024/1440 layouts contain result values and pass axe; keyboard skip link works', async () => {
    await route(page, 'sandbox'); await page.reload(); await loadFreshDemo(page);
    for (const [width, height] of [[320, 900], [375, 812], [768, 900], [1024, 900], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      const dimensions = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(dimensions.doc <= dimensions.client + 1, `${width}px overflow: ${JSON.stringify(dimensions)}`);
      const overflowingFacts = await page.locator('.stats-grid > div').evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map((cell) => cell.querySelector('span')?.textContent));
      assert.deepEqual(overflowingFacts, [], `${width}px result values overlap neighboring cells`);
      const targets = await page.locator('.sample-toolbar button, .quickstart-head .text-action').evaluateAll((elements) => elements.map((element) => ({ name: element.textContent, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
      assert.ok(targets.every((target) => target.width >= 44 && target.height >= 44), `${width}px sample targets: ${JSON.stringify(targets)}`);
      await auditAxe(page, `${width}px sandbox`);
      await page.screenshot({ path: join(EVIDENCE, `react-console-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await route(page, 'receipts');
    const receiptsRegion = page.getByRole('region', { name: 'Receipts' });
    assert.equal(await receiptsRegion.getAttribute('tabindex'), '0');
    assert.ok(await receiptsRegion.evaluate((region) => region.scrollWidth > region.clientWidth), 'receipt table has a local horizontal scroll area');
    await receiptsRegion.focus();
    await page.keyboard.press('ArrowRight');
    assert.ok(await receiptsRegion.evaluate((region) => region.scrollLeft > 0), 'keyboard moves the focused receipt region');
    await auditAxe(page, '375px receipts');
    for (const [width, height] of [[1440, 900], [375, 812]]) {
      await page.setViewportSize({ width, height });
      for (const screen of ['sandbox', 'verify', 'records', 'receipts', 'video', 'help']) {
        await route(page, screen);
        const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        assert.ok(dimensions.scroll <= dimensions.client + 1, `${width}x${height} ${screen}: ${JSON.stringify(dimensions)}`);
        await auditAxe(page, `${width}x${height} ${screen}`);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
    await page.setViewportSize({ width: 375, height: 812 });
    await route(page, 'sandbox');
    await page.screenshot({ path: join(EVIDENCE, 'forced-colors-375x812.png'), fullPage: true });
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { styleSheetId } = await cdp.send('CSS.createStyleSheet', { frameId: frameTree.frame.id });
    const enlargedRules = await page.evaluate(() => {
      const rules = [];
      document.querySelectorAll('body *').forEach((element, index) => {
        const current = parseFloat(getComputedStyle(element).fontSize);
        element.setAttribute('data-audit-text-size', String(index));
        rules.push(`[data-audit-text-size=\"${index}\"]{font-size:${current * 2}px!important}`);
      });
      return rules.join('\n');
    });
    await cdp.send('CSS.setStyleSheetText', { styleSheetId, text: enlargedRules });
    const enlargedLayout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(enlargedLayout.scroll <= enlargedLayout.width + 1, `200% text enlargement overflow: ${JSON.stringify(enlargedLayout)}`);
    await page.screenshot({ path: join(EVIDENCE, 'text-enlarged-375x812.png'), fullPage: true });
    await page.locator('[data-audit-text-size]').evaluateAll((elements) => elements.forEach((element) => element.removeAttribute('data-audit-text-size')));
    await cdp.send('CSS.setStyleSheetText', { styleSheetId, text: '' }); await cdp.detach();
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
    await page.setViewportSize({ width: 320, height: 900 });
    await route(page, 'sandbox');
    await page.reload();
    await loadFreshDemo(page);
    await page.locator('.brand').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator(':focus').getAttribute('class'), 'skip-link');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'main');
    assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Verify', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: 'Menu' }).click();
    assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Verify', exact: true }).isVisible(), true);
    await page.evaluate(() => { location.hash = '#/verify'; });
    await page.waitForFunction(() => document.activeElement?.id === 'page-verify' && document.title === 'Verify · HashWing').catch(async () => assert.fail(`legacy Verify route did not restore focus/title: ${location.hash}; focus=${await page.evaluate(() => document.activeElement?.id)}; title=${await page.title()}`));
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.hash.startsWith('#/app/sandbox') && document.activeElement?.id === 'page-sandbox').catch(async () => assert.fail(`browser Back did not restore Samples focus: ${await page.evaluate(() => location.hash)}; focus=${await page.evaluate(() => document.activeElement?.id)}`));
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => location.hash.startsWith('#/app/verify') && document.activeElement?.id === 'page-verify').catch(async () => assert.fail(`browser Forward did not restore Verify route/focus: ${await page.evaluate(() => location.hash)}; focus=${await page.evaluate(() => document.activeElement?.id)}`));
    await auditAxe(page, '320px routed page');
  });

  await check('offline reload serves console assets and default demo, then runs native mutation', async () => {
    const offlineContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const offlinePage = await offlineContext.newPage();
    const offlineRuntimeErrors = [], offlineFailedRequests = [];
    offlinePage.on('pageerror', (error) => offlineRuntimeErrors.push(String(error)));
    offlinePage.on('requestfailed', (request) => offlineFailedRequests.push(`${request.resourceType()} ${request.url()} ${request.failure()?.errorText}`));
    try {
    await offlinePage.goto(url);
    await route(offlinePage, 'sandbox');
    const manifest = JSON.parse(readFileSync(resolve(ROOT, '../docs/console/precache.json'), 'utf8'));
    assert.equal(manifest.files.some((path) => path.includes('px4-full.fseal')), false, 'large sample must not be precached');
    const required = manifest.files.filter((path) => path === 'console/' || /\.wasm$|\.js$|\.css$/.test(path)).map((path) => `/flightseal/${path}`);
    await offlinePage.waitForFunction(async (paths) => {
      if (!navigator.serviceWorker?.controller) return false;
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        if (await Promise.all(paths.map((path) => cache.match(new URL(path, location.origin)))).then((entries) => entries.every(Boolean))) return true;
      }
      return false;
    }, required, { timeout: 60000 });
    await offlinePage.locator('.install-tools > summary').click();
    await offlinePage.getByRole('button', { name: 'Prepare offline' }).click();
    await offlinePage.waitForFunction(() => document.querySelector('.offline-note')?.textContent.includes('ready on this device'), null, { timeout: 60000 });
    await route(offlinePage, 'sandbox');
    const offlineCdp = await offlineContext.newCDPSession(offlinePage);
    await offlineCdp.send('Network.enable');
    await offlineCdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await offlineContext.setOffline(true);
    try {
      const offlineResponse = await offlinePage.reload();
      await loadFreshDemo(offlinePage).catch(async (error) => {
        const diagnostic = await offlinePage.evaluate(() => ({ url: location.href, title: document.title, controller: navigator.serviceWorker.controller?.scriptURL || null, rootHtml: document.querySelector('#root')?.innerHTML.slice(0, 1200), scripts: [...document.scripts].map((script) => script.src) })).catch(() => null);
        assert.fail(`offline workspace/demo did not load: ${error.message}; status=${offlineResponse?.status()}; body=${(await offlinePage.locator('body').innerText()).slice(0, 1000)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${offlineRuntimeErrors.join(' | ')}; failedRequests=${offlineFailedRequests.join(' | ')}`);
      });
      assert.match(await offlinePage.locator('.result-stat').textContent(), /800/);
      await offlinePage.getByRole('button', { name: 'Flip one payload byte' }).click();
      await offlinePage.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-link'), null, { timeout: 30000 });
      assert.match(await offlinePage.locator('.first-failure').textContent(), /bad-link/);
    } finally { await offlineContext.setOffline(false); }
    } finally { await offlineContext.close(); }
  });

  await check('rail navigation updates focused route and preserves the checked evidence', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loadLandingDemo(page);
    for (const [screen, title] of [['verify', 'Verify'], ['records', 'Records'], ['receipts', 'Receipts'], ['video', 'Video'], ['help', 'Trust'], ['sandbox', 'Samples']]) {
      await clickNav(page, title);
      await page.waitForFunction((target) => document.activeElement?.id === `page-${target}`, screen, { timeout: 1500 });
    }
    assert.match(await page.locator('.result-stat').textContent(), /800/);
    const rail = page.getByRole('navigation', { name: 'Primary navigation' });
    assert.equal(await rail.locator('.nav-more').evaluate((d) => d.open), true, 'More tools stays open on a secondary page');
    assert.equal(await rail.getByRole('link', { name: 'Samples', exact: true }).getAttribute('aria-current'), 'page');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Verify' }).click();
    await page.locator('#trusted-key').fill('editing');
    await clickNav(page, 'Records');
    assert.match(await page.evaluate(() => location.hash), /^#\/app\/records\?sample=intact&record=\d+$/, 'Records keeps the sample and record in its link');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Verify' }).click();
    assert.equal(await page.locator('#trusted-key').inputValue(), 'editing');
    await page.goto(`${url}#/protect`); await page.waitForSelector('#page-protect');
    await page.waitForFunction(() => document.querySelector('.nav-more')?.open === false, null, { timeout: 3000 }).catch(() => assert.fail('More tools starts closed on a primary page'));
    // AC-04, changed on purpose: the primary links are Seal & send, Verify and Trust (Jobs joins when its page lands);
    // Records and Receipts moved under More tools with their routes kept.
    for (const name of ['Records', 'Receipts', 'Samples', 'Video', 'Benchmarks', 'System']) assert.equal(await rail.getByRole('link', { name, exact: true }).isVisible(), false, `${name} is behind More tools`);
    assert.deepEqual(await rail.locator('a:visible').allTextContents(), ['Seal & send', 'Verify', 'Trust'], 'only the primary links show, in order');
    assert.equal(await page.locator('.session-strip').isVisible(), false, 'Seal & send hides the workbench session strip');
    assert.equal(await page.locator('.source-actions').isVisible(), false, 'Seal & send hides the workbench source actions');
    await rail.locator('.nav-more summary').click();
    assert.deepEqual(await rail.locator('.nav-more a').allTextContents(), ['Records', 'Receipts', 'Samples', 'Video', 'Benchmarks', 'System'], 'More tools holds the six secondary pages, in order');
    await rail.locator('.nav-more summary').press('Escape');
    assert.equal(await rail.locator('.nav-more').evaluate((d) => d.open), false, 'Escape closes More tools');
    await page.goto(`${url}#/video`); await page.waitForSelector('#page-video');
    await page.waitForFunction(() => document.querySelector('.nav-more')?.open === true, null, { timeout: 3000 }).catch(() => assert.fail('a secondary page opens More tools by itself'));
    assert.equal(await rail.getByRole('link', { name: 'Video', exact: true }).getAttribute('aria-current'), 'page');
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${url}#/protect`); await page.waitForSelector('#page-protect');
    await page.getByRole('button', { name: 'Menu' }).click();
    await rail.locator('.nav-more summary').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#primary-nav').isVisible(), false, 'Escape on a closed More tools still closes the mobile menu');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('page shell: workbench strip only on Verify and More tools, one profile menu, full-height rail, 44px shell targets', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // AC-66
    for (const [screen, shown] of [['protect', false], ['help', false], ['verify', true], ['records', true], ['receipts', true], ['sandbox', true], ['video', true], ['benchmarks', true], ['system', true]]) {
      await page.goto(`${url}#/app/${screen}`); await page.waitForSelector(`#page-${screen}`);
      assert.equal(await page.locator('.session-strip').isVisible(), shown, `${screen}: session strip ${shown ? 'shown' : 'hidden'}`);
      assert.equal(await page.locator('.source-actions').isVisible(), shown, `${screen}: Source and report actions ${shown ? 'shown' : 'hidden'}`);
    }
    // AC-61: one menu, "Profile on this device"; company sign-in is not in the bar.
    await page.goto(`${url}#/app/protect`); await page.waitForSelector('#page-protect');
    const bar = page.locator('.commandbar');
    assert.equal(await bar.locator('.profile-menu').count(), 1);
    assert.equal(await bar.getByRole('link').count(), 0, 'the bar has no separate Log in / Create account links');
    const summary = bar.locator('.profile-menu > summary');
    assert.equal(await summary.getAttribute('aria-label'), 'Profile on this device');
    assert.match(await summary.innerText(), /Profile on this device/);
    await summary.click();
    const panel = bar.locator('.profile-menu-panel');
    assert.match(await panel.innerText(), /Profiles live in this browser\. They are not company accounts\./);
    for (const name of ['Use a local profile', 'Create a local profile']) assert.equal(await panel.getByRole('button', { name, exact: true }).isVisible(), true, `menu offers ${name}`);
    assert.equal(await panel.locator('button').first().innerText(), 'Use a local profile', 'profile entries come before the backup form');
    assert.equal(await panel.getByRole('button', { name: 'Download encrypted backup' }).count(), 0, 'no export button without an open profile');
    assert.equal(await bar.getByText(/Company registry|Sign in to the company/).count(), 0, 'no company sign-in in the bar');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.profile-menu').getAttribute('open'), null, 'Escape closes the profile menu');
    assert.equal(await summary.evaluate((el) => el === document.activeElement), true, 'focus returns to the menu summary');
    // The rail column reaches the bottom of a page taller than the window (it stopped at 900px in full-page views).
    await page.goto(`${url}#/app/help`); await page.waitForSelector('#page-help');
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    assert.ok(height > 1200, `Trust is taller than the window (${height}px)`);
    const png = await page.screenshot({ fullPage: true, clip: { x: 100, y: height - 4, width: 1, height: 1 } });
    const { inflateSync } = await import('node:zlib');
    let offset = 8, idat = [];
    while (offset < png.length) { const length = png.readUInt32BE(offset), type = png.toString('latin1', offset + 4, offset + 8); if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length)); offset += length + 12; }
    const pixel = [...inflateSync(Buffer.concat(idat)).subarray(1, 4)].map((v) => v.toString(16).padStart(2, '0')).join('');
    assert.equal(pixel, 'eaf0f7', `rail colour at the page bottom is #${pixel}`);
    // AC-13: standalone shell controls are at least 44 by 44px.
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}#/app/help`); await page.waitForSelector('#page-help');
      if (await page.locator('.rail-menu').isVisible()) await page.locator('.rail-menu').click();
      await page.locator('.install-tools > summary').click();
      const small = await page.evaluate(() => [...document.querySelectorAll('#primary-nav a, .nav-more summary, .rail-menu, .brand, .profile-menu > summary, .workspace-tools-menu summary, .install-tools > summary, .offline-control-actions .button, .offline-control-actions .text-action, .trust-footer nav a, .trust-footer nav button, .help-layout .prose p > a:only-child')]
        .filter((el) => el.getClientRects().length).map((el) => ({ name: el.textContent.trim().slice(0, 40), width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) }))
        .filter((box) => box.width < 44 || box.height < 44));
      assert.deepEqual(small, [], `${width}px: undersized shell targets ${JSON.stringify(small)}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // At 768px and below "Other apps" is part of the Menu panel, after More tools, not a row of its own under the brand.
    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${url}#/app/help`); await page.waitForSelector('#page-help');
      assert.equal(await page.locator('.workbench-rail .workspace-tools-menu:visible').count(), 0, `${width}px: Other apps is hidden while the menu is closed`);
      await page.locator('.rail-menu').click();
      assert.equal(await page.locator('#primary-nav > :last-child').evaluate((el) => el.matches('.workspace-tools-menu') && !!el.getClientRects().length && el.previousElementSibling.matches('.nav-more')), true, `${width}px: Other apps is inside the open menu, after More tools`);
      assert.equal(await page.locator('.workbench-rail .workspace-tools-menu:visible').count(), 1);
      await page.locator('.rail-menu').click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('direct routes and root hash resolve to their own current screens', async () => {
    await page.goto(`${url}#/`);
    await page.waitForSelector('#page-landing');
    assert.equal(await page.locator('#page-landing').textContent(), 'HashWing');
    const paths = [['#/sandbox', 'Samples'], ['#/verify', 'Verify'], ['#/records', 'Records'], ['#/receipts', 'Receipts'], ['#/video', 'Video'], ['#/help', 'Trust']];
    for (const [hash, title] of paths) {
      await page.goto(`${url}${hash}`);
      await page.waitForFunction((expected) => document.querySelector('.commandbar h1')?.textContent === expected, title);
    }
  });

  await check('direct unknown routes share the not-found state and recover through history', async () => {
    await page.goto(`${url}#/404-test`);
    await page.waitForFunction(() => document.querySelector('#not-found-title')?.textContent === 'Page not found');
    assert.equal(await page.locator('#not-found-title').textContent(), 'Page not found');
    await page.goto(`${url}#/404-test/details`);
    await page.waitForFunction(() => document.querySelector('#not-found-title')?.textContent === 'Page not found');
    await page.getByRole('button', { name: 'Return to samples' }).click();
    await page.waitForFunction(() => location.hash.startsWith('#/app/sandbox') && document.activeElement?.id === 'page-sandbox');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.hash === '#/404-test/details' && document.querySelector('#page-not-found'));
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => location.hash.startsWith('#/app/sandbox') && document.querySelector('#page-sandbox'));
  });

  await check('PDF export is a valid downloadable integrity report', async () => {
    await loadLandingDemo(page);
    if (!(await page.getByRole('button', { name: 'Export PDF' }).isVisible())) await page.locator('.source-actions > summary').click();
    const [pdfDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PDF' }).first().click()]);
    assert.equal(pdfDownload.suggestedFilename(), 'hashwing-integrity-report.pdf');
    const pdf = await PDFDocument.load(readFileSync(await pdfDownload.path()), { updateMetadata: false });
    assert.equal(pdf.getTitle(), 'HashWing integrity report');
    assert.ok(pdf.getPageCount() >= 1);
    assert.equal(pdf.catalog.get(PDFName.of('Lang')).decodeText(), 'en');
    assert.ok(pdf.catalog.get(PDFName.of('StructTreeRoot')), 'real export has semantic structure');
    assert.equal(pdf.catalog.lookup(PDFName.of('MarkInfo'), PDFDict).lookup(PDFName.of('Marked')).asBoolean(), true);

    await page.locator('#workbench-file').setInputFiles({ name: 'Café-東京-שלום.fseal', mimeType: 'application/octet-stream', buffer: readFileSync(resolve(ROOT, '../docs/samples/intact.fseal')) });
    await page.waitForFunction(() => location.hash.startsWith('#/app/verify'), null, { timeout: 10000 }).catch(async () => assert.fail(`PDF test file selection did not open Verify: ${(await page.locator('body').innerText()).slice(0, 900)}`));
    await page.getByRole('button', { name: 'Run check' }).click(); await waitResult(page, 'Intact');
    if (!(await page.getByRole('button', { name: 'Export PDF' }).isVisible())) await page.locator('.source-actions > summary').click();
    const [unicodePdfDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PDF' }).click()]);
    const unicodePdf = await PDFDocument.load(readFileSync(await unicodePdfDownload.path()), { updateMetadata: false });
    assert.ok(unicodePdf.catalog.get(PDFName.of('StructTreeRoot')));
    const contentRefs = unicodePdf.getPages()[0].node.Contents();
    const contentStreams = unicodePdf.context.lookup(contentRefs, PDFArray);
    const pdfContent = Array.from({ length: contentStreams.size() }, (_, index) => Buffer.from(decodePDFRawStream(unicodePdf.context.lookup(contentStreams.get(index), PDFRawStream)).decode()).toString('latin1')).join('\n');
    assert.match(pdfContent, /436166E92D5B552B363737315D5B552B344541435D2D5B552B303545395D/);
  });

  await check('local signup, encrypted export, fresh-context restore, logout and login round trip', async () => {
    const email = `backup-${Date.now()}@example.test`;
    const password = 'flightseal browser password 123';
    const backupPassphrase = 'separate backup passphrase 456';
    await page.goto(url);
    await page.getByRole('link', { name: 'Try a sample' }).click();
    await waitResult(page, 'Intact');
    await profileMenuAction(page, 'Create a local profile');
    await page.locator('#auth-email').fill(email); await page.locator('#auth-password').fill(password); await page.locator('#auth-confirm').fill(password);
    await page.getByLabel(/Import this guest session/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('backup-'));
    assert.equal(await page.locator('.profile-menu > summary').getAttribute('aria-label'), `Profile on this device: ${email}`, 'the one profile menu names the open local profile');
    assert.equal(await page.getByRole('navigation', { name: 'Account and workspace' }).count(), 0, 'the command bar has no second set of account links');
    await page.locator('.profile-menu').locator('summary').click();
    await page.locator('#backup-passphrase').fill(backupPassphrase);
    const [backupDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download encrypted backup' }).click()]);
    assert.equal(backupDownload.suggestedFilename(), 'flightseal-encrypted-profile-backup.json');
    const backupPath = await backupDownload.path();
    const backupBytes = readFileSync(backupPath);
    assert.equal(backupBytes.includes(Buffer.from(password)), false, 'plaintext profile password is not exported');

    const restoreContext = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
    const restorePage = await restoreContext.newPage();
    restorePage.on('pageerror', (error) => runtimeErrors.push(String(error)));
    restorePage.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(`${message.text()} (${message.location().url})`); });
    await restorePage.goto(url);
    await restorePage.goto(`${url}#/app/sandbox`);
    await restorePage.waitForFunction(() => document.querySelector('#page-sandbox'));
    await restorePage.locator('.profile-menu > summary').click();
    await restorePage.locator('#backup-passphrase').fill(backupPassphrase);
    await restorePage.locator('#backup-file').setInputFiles({ name: backupDownload.suggestedFilename(), mimeType: 'application/json', buffer: backupBytes });
    await restorePage.getByRole('button', { name: 'Check backup and preview' }).click();
    await restorePage.waitForFunction((expected) => document.querySelector('.profile-backup [role="status"]')?.textContent.includes(`Restore preview: local profile ${expected}`), email);
    await restorePage.getByRole('button', { name: 'Restore this profile' }).click();
    await profileMenuAction(restorePage, 'Use a local profile');
    await restorePage.locator('#auth-email').fill(email); await restorePage.locator('#auth-password').fill(password);
    await restorePage.getByRole('button', { name: 'Log in' }).click();
    await restorePage.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('backup-'));
    assert.match(restorePage.url(), /sample=intact/, 'saved included-sample view is restored without copying source files');
    await restorePage.locator('.profile-menu > summary').click();
    await restorePage.getByRole('button', { name: 'Log out' }).click();
    await restorePage.locator('footer').getByRole('link', { name: 'Use a local profile' }).click(); // logout lands on the front door
    await restorePage.locator('#auth-email').fill(email); await restorePage.locator('#auth-password').fill(password);
    await restorePage.getByRole('button', { name: 'Log in' }).click();
    await restorePage.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('backup-'));
    await restoreContext.close();
  });

  await check('a sample\'s bundled receipts and key are cleared when the user opens their own log', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loadFreshDemo(page);
    await route(page, 'verify');
    assert.notEqual(await page.locator('#trusted-key').inputValue(), '', 'the demo attaches its key');
    await page.locator('#log-input').setInputFiles({ name: 'my-flight.fseal', mimeType: 'application/octet-stream', buffer: readFileSync(resolve(ROOT, '../docs/samples/intact.fseal')) });
    await page.waitForFunction(() => document.querySelector('#trusted-key')?.value === '');
  });

  await check('Seal & send: a pilot seals a real PX4 .ulg, a witness checks it with the emailed receipt and gets the exact original back; edits and re-seals are caught', async () => {
    const ulg = resolve(ROOT, '../tests/.data/px4-sample.ulg');
    const original = readFileSync(ulg);
    const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const evidence = join(EVIDENCE, 'seal-send'); mkdirSync(evidence, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url); await page.reload();
    await page.getByRole('link', { name: 'Seal files', exact: true }).click(); // the front door's primary action
    await page.waitForFunction(() => location.hash === '#/app/protect' && document.querySelector('.commandbar h1')?.textContent === 'Seal & send');
    await page.locator('#protect-file').setInputFiles(ulg);
    const pad = (n) => String(n).padStart(2, '0');
    const landed = new Date(Math.floor((Date.now() - 3600e3) / 1000) * 1000);
    await page.locator('.protect-options summary').first().click();
    await page.locator('#protect-landing').fill(`${landed.getFullYear()}-${pad(landed.getMonth() + 1)}-${pad(landed.getDate())}T${pad(landed.getHours())}:${pad(landed.getMinutes())}:${pad(landed.getSeconds())}`.replace(/:00$/, '')); // Chrome normalises zero seconds away, and fill() rejects a value that changes
    await page.locator('#job-ref').fill('JOB-REF-7Q2X');
    await page.getByRole('button', { name: 'Seal this file' }).click();
    await page.waitForSelector('#handover-text', { timeout: 60000 });
    // R18 / AC-53: the handoff leads, its heading has focus, and Download is the one primary action until it is used.
    await page.waitForFunction(() => document.activeElement?.id === 'handoff-title');
    assert.equal(await page.locator('#handoff-title').innerText(), 'Send these to your client');
    assert.equal(await page.locator('.seal-summary').innerText(), 'Sealed · 1 file · JOB-REF-7Q2X');
    assert.deepEqual(await page.locator('.handoff-step-title').allInnerTexts(), ['Download the sealed file', 'Send the receipt message']);
    assert.deepEqual(await page.locator('.seal-panel .button.primary').allInnerTexts(), ['Download']);
    assert.equal(await page.locator('#seal-what-title').count(), 0, 'the step panel gives way to the handoff');
    assert.equal(await page.locator('.result-panel').count(), 0, 'no checker result on Seal & send (R15)');
    assert.equal(await page.locator('#check-file').count(), 0, 'the checker lives on Verify');
    const handover = await page.locator('#handover-text').inputValue();
    assert.ok(!handover.includes('JOB-REF-7Q2X'), 'the job reference is not in the receipt message');
    assert.match(handover, /open \S+#\/app\/verify and paste/, 'the message sends the recipient to Verify');
    assert.match(handover, new RegExp(`Original file: ${original.length} bytes, SHA-256 ${sha(original)}`));
    assert.equal(handover.split('\n')[2], `Reported landing time: ${landed.toISOString()} (operator-entered, not signed, not verified)`);
    const senderFingerprint = await page.locator('.handover .fingerprint').innerText();
    assert.match(senderFingerprint, /^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);
    assert.equal(await page.locator('.trust-line').count(), 0, "the sender's own seal shows no recipient trust line");
    assert.equal(handover.split('\n').filter((line) => line.startsWith('fseal-receipt v1 ')).length, 1);
    assert.match(await page.getByRole('link', { name: 'Email it' }).getAttribute('href'), /^mailto:\?subject=HashWing%20receipt/);
    const [sealedDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
    assert.equal(sealedDownload.suggestedFilename(), 'px4-sample.ulg.fseal');
    const sealedPath = join(evidence, 'sealed.fseal');
    await sealedDownload.saveAs(sealedPath);
    assert.ok(!readFileSync(sealedPath).includes(Buffer.from('JOB-REF-7Q2X')), 'the job reference is not in the sealed file');
    assert.deepEqual(await page.locator('.seal-panel .button.primary').allInnerTexts(), ['Yes, saved'], 'a Download click is not proof: the one primary action is to confirm it finished');
    await page.locator('.handoff-confirm').getByRole('button', { name: 'Yes, saved' }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Copy message');
    assert.deepEqual(await page.locator('.seal-panel .button.primary').allInnerTexts(), ['Copy message'], 'after the confirmed download, Copy message is the one primary action');
    await auditAxe(page, '1440px seal handover');
    await page.screenshot({ path: join(evidence, 'sealed-1440.png'), fullPage: true });

    // The witness, in a fresh page load on Verify, with the message quoted and wrapped as an email reply would.
    await page.reload();
    await route(page, 'verify');
    await page.locator('#check-file').setInputFiles(sealedPath);
    await page.locator('#check-text').fill(handover.split('\n').flatMap((line) => line.match(/.{1,72}/g) || ['']).map((line) => `> ${line}`).join('\n'));
    await page.getByRole('button', { name: 'Check this file' }).click();
    await waitResult(page, 'Intact');
    await page.waitForSelector('.restored', { timeout: 30000 });
    assert.match(await page.locator('.restored h3').textContent(), /Original file recovered/);
    const [originalDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download original file' }).click()]);
    assert.equal(originalDownload.suggestedFilename(), 'px4-sample.ulg');
    const restoredPath = join(evidence, 'restored.ulg');
    await originalDownload.saveAs(restoredPath);
    assert.equal(sha(readFileSync(restoredPath)), sha(original));

    // Recipient trust: not in the list until the sender's fingerprint is pinned; times say where they come from.
    const untrusted = "Valid signature, but this key isn't in your trusted list — confirm its fingerprint through a channel you already know.";
    await page.waitForFunction((text) => document.querySelector('.result-panel .trust-line')?.textContent === text, untrusted);
    const times = await page.locator('.time-fields > div').evaluateAll((divs) => divs.map((d) => [d.querySelector('dt').innerText, d.querySelector('dd span').innerText, d.querySelector('dd small').innerText]));
    assert.deepEqual(times[0], ['Reported landing time', landed.toISOString(), 'operator-entered, not signed, not verified']);
    assert.equal(times[1][0], 'Sealed on this computer at');
    assert.equal(times[1][2], "this computer's clock, not verified; from the receipt message, not signed");
    assert.deepEqual(times.slice(2, 4).map((t) => t[1]), ['Not registered', 'None']);
    assert.match(times[4][1], /^1 h \d+ min \d+ s from the reported landing to the seal$/);
    const copyPath = join(evidence, 'my-copy.ulg'); writeFileSync(copyPath, Buffer.concat([original, Buffer.from('\n')]));
    const compare = async (path, status) => {
      if (!(await page.locator('.restored .protect-options').evaluate((d) => d.open))) await page.locator('.restored .protect-options summary').click();
      await page.locator('#compare-copy').setInputFiles(path);
      await page.waitForFunction((s) => document.querySelector('.compare-result .status-label')?.textContent === s, status, { timeout: 30000 });
    };
    await compare(copyPath, 'Bytes differ');
    assert.match(await page.locator('.compare-result').innerText(), /not proof of tampering/);
    await compare(ulg, 'Matches');
    const pinPage = await page.context().newPage();
    await pinPage.goto(`${url}#/app/settings`);
    await pinPage.locator('.trusted-companies-details > summary').click();
    await pinPage.locator('#tc-name').fill('Pilot Co');
    await pinPage.locator('#tc-fingerprint').fill(senderFingerprint);
    await pinPage.getByLabel('phone call with a known contact', { exact: true }).check();
    await pinPage.getByRole('button', { name: 'Add company' }).click();
    await pinPage.waitForFunction(() => document.querySelector('.company-list')?.textContent.includes('Pilot Co'));
    await pinPage.close();
    await page.getByRole('button', { name: 'Check this file' }).click();
    await waitResult(page, 'Intact');
    await page.waitForSelector('.restored', { timeout: 30000 });
    const trusted = 'Signed by a key you trust: Pilot Co (added from phone call with a known contact)';
    await page.waitForFunction((text) => document.querySelector('.result-panel .trust-line')?.textContent === text, trusted);
    await compare(copyPath, 'Bytes differ');
    const [textReport] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download text report' }).click()]);
    const report = readFileSync(await textReport.path(), 'utf8');
    for (const line of [`Key trust: ${trusted}`, 'Key source: phone call with a known contact', `Reported landing time: ${landed.toISOString()} (operator-entered, not signed, not verified)`, 'Sealed on this computer at:', 'Registry acceptance: Not registered', 'Trusted timestamp: None', 'Reported landing-to-seal interval: 1 h ', 'Your copy my-copy.ulg: Bytes differ.', 'not proof of tampering', 'Native chain result:']) assert.ok(report.includes(line), `report: ${line}`);
    const [jsonReport] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON' }).click()]);
    const json = JSON.parse(readFileSync(await jsonReport.path(), 'utf8'));
    assert.equal(json.keyTrust.status, 'trusted');
    assert.equal(json.timeProvenance.fields.length, 5);
    assert.deepEqual(json.fileComparison.items.map((item) => [item.subject, item.status]), [['Recovered file', 'Matches'], ['Your copy', 'Bytes differ']]);
    assert.ok(json.nativeVerdict && json.report, 'older keys stay');
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: 900 });
      const dimensions = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(dimensions.doc <= dimensions.client + 1, `${width}px overflow: ${JSON.stringify(dimensions)}`);
      await auditAxe(page, `${width}px check result`);
      await page.screenshot({ path: join(evidence, `checked-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // One changed byte inside a sealed chunk: Tampered, and no original is offered.
    const sealedBytes = readFileSync(sealedPath);
    const edited = Buffer.from(sealedBytes);
    edited[8 + 20 + sealedBytes.readUInt32LE(8) + 36 + 20 + 1000] ^= 1;
    const editedPath = join(evidence, 'edited.fseal'); writeFileSync(editedPath, edited);
    await page.locator('#check-file').setInputFiles(editedPath);
    await page.locator('#check-text').fill(handover);
    await page.getByRole('button', { name: 'Check this file' }).click();
    await waitResult(page, 'Tampered');
    assert.equal(await page.locator('.restored').count(), 0);

    // The real attack: the holder changes the log and seals it again with a fresh key.
    const changed = Buffer.from(original); changed[original.length >> 1] ^= 1;
    const changedPath = join(evidence, 'px4-sample.ulg'); writeFileSync(changedPath, changed);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Seal & send' }).click();
    await page.locator('#protect-file').setInputFiles(changedPath);
    await page.getByRole('button', { name: 'Seal this file' }).click();
    await page.waitForSelector('#handover-text', { timeout: 60000 });
    const [forgedDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
    const forgedPath = join(evidence, 'forged.fseal'); await forgedDownload.saveAs(forgedPath);
    await route(page, 'verify');
    await page.locator('#check-file').setInputFiles(forgedPath);
    await page.locator('#check-text').fill(handover);
    await page.getByRole('button', { name: 'Check this file' }).click();
    await waitResult(page, 'Tampered');
    assert.equal(await page.locator('.restored').count(), 0);

    // No receipt pasted: refused with a reason rather than a weaker check.
    await page.locator('#check-text').fill('no receipt here');
    await page.getByRole('button', { name: 'Check this file' }).click();
    assert.match(await page.getByRole('alert').first().textContent(), /Paste the receipt message/);
  });

  await check('Seal & send: one task at a time — signing line, the files survive Trust, Cancel keeps them, errors sit on the field, the handoff and its N3 confirm', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${url}#/app/protect`); await page.reload(); await page.waitForSelector('#seal-what-title');
    const panel = page.locator('.seal-panel');
    // R17 / AC-52: the one-time-key signing line, one primary action, and the checker moved to Verify.
    assert.equal((await panel.locator('.signing-line').innerText()).replace(/\n+/g, '\n'), "Signing\nOne-time key for this file. Your client can't check who sealed it. Set up a company key on Trust.");
    assert.deepEqual(await panel.locator('.button.primary').allInnerTexts(), ['Seal this file']);
    assert.equal(await page.getByRole('link', { name: 'Checking files someone sent you? Go to Verify' }).count(), 1);
    assert.equal(await page.locator('#check-file').count(), 0);
    // An error is read with its field: focus moves there, and no alert is raised on top.
    await page.locator('#protect-file').setInputFiles({ name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) });
    await page.getByRole('button', { name: 'Seal this file' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'protect-file');
    assert.equal(await page.locator('#protect-file').getAttribute('aria-describedby'), 'protect-file-error');
    assert.equal(await page.locator('#protect-file-error').innerText(), 'This file is empty; there is nothing to seal.');
    assert.equal(await page.locator('main [role=alert]').count(), 0);
    // Files and job reference survive a visit to Trust, in both modes.
    const big = Buffer.alloc(12 * 1024 * 1024, 7);
    await page.locator('#protect-file').setInputFiles({ name: 'flight-12.ulg', mimeType: 'application/octet-stream', buffer: big });
    assert.equal(await panel.locator('.seal-file-list').innerText(), 'flight-12.ulg\n12,582,912 bytes');
    assert.equal(await panel.locator('.seal-total').innerText(), 'Total 1 file\n12,582,912 bytes');
    await page.locator('#job-ref').fill('Roof survey 12');
    await panel.getByRole('link', { name: 'Set up a company key on Trust' }).click();
    await page.waitForSelector('#page-help');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Seal & send' }).click();
    await page.waitForSelector('#page-protect');
    assert.equal(await panel.locator('.seal-file-list').innerText(), 'flight-12.ulg\n12,582,912 bytes', 'the chosen file is still there');
    assert.equal(await page.locator('#job-ref').inputValue(), 'Roof survey 12');
    assert.equal(await page.getByRole('button', { name: 'Seal this file' }).isEnabled(), true);
    await page.getByLabel('Large files: fingerprint only, files stay where they are').check();
    await page.locator('#manifest-files').setInputFiles([1, 2].map((n) => ({ name: `clip-${n}.mp4`, mimeType: 'video/mp4', buffer: Buffer.alloc(1000 * n, n) })));
    await route(page, 'help');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Seal & send' }).click();
    assert.equal(await panel.locator('.seal-total').innerText(), 'Total 2 files\n3,000 bytes');
    assert.deepEqual(await panel.locator('.button.primary').allInnerTexts(), ['Seal the list']);
    await page.getByLabel('Small file: seal the whole file, up to 45 MiB').check();
    // Progress is a <progress> with a text value; Cancel keeps the file and puts focus back on Seal.
    const progress = await page.evaluate(async () => {
      document.getElementById('protect-seal').click();
      for (let i = 0; i < 50 && !document.getElementById('protect-progress'); i++) await new Promise((r) => setTimeout(r, 0));
      const bar = document.getElementById('protect-progress');
      const seen = bar && { text: bar.getAttribute('aria-valuetext'), max: bar.max };
      document.querySelector('.seal-progress button')?.click();
      return seen;
    });
    assert.deepEqual(progress, { text: 'Step 1 of 4: Reading the file', max: 4 });
    await page.waitForFunction(() => document.activeElement?.id === 'protect-seal');
    assert.match(await page.locator('main').innerText(), /Sealing cancelled\. Your files are still chosen\./);
    assert.equal(await panel.locator('.seal-file-list').innerText(), 'flight-12.ulg\n12,582,912 bytes');
    assert.equal(await page.locator('#handover-text').count(), 0);

    // Oversize: the spec message on the field, and "Use Large files" moves the same file across, ready to seal.
    const huge = { name: 'huge.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(45 * 1024 * 1024 + 1, 1) };
    await page.locator('#protect-file').setInputFiles(huge);
    await page.getByRole('button', { name: 'Seal this file' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'protect-file');
    assert.equal(await page.locator('#protect-file-error').innerText(), 'This file is larger than 45 MiB. Choose Large files instead.');
    assert.deepEqual(await panel.locator('.button.primary').allInnerTexts(), ['Seal this file']);
    assert.equal(await page.getByRole('button', { name: 'Use Large files' }).getAttribute('class'), 'button secondary');
    await page.getByRole('button', { name: 'Use Large files' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'manifest-seal');
    assert.equal(await page.getByLabel('Large files: fingerprint only, files stay where they are').isChecked(), true);
    assert.equal(await panel.locator('.seal-total').innerText(), 'Total 1 file\n47,185,921 bytes', 'the file is still chosen');
    await page.getByLabel('Small file: seal the whole file, up to 45 MiB').check();
    assert.equal(await page.locator('#protect-file-error').count(), 0);
    await page.getByLabel('Large files: fingerprint only, files stay where they are').check();
    await page.locator('#manifest-files').setInputFiles([]);
    await page.getByLabel('Small file: seal the whole file, up to 45 MiB').check();

    // AC-53 N3: "Seal more files" before the download asks first, with Download focused and primary. Escape keeps the result.
    await page.locator('#protect-file').setInputFiles({ name: 'n3.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(`n3 ${Date.now()}`) });
    await page.getByRole('button', { name: 'Seal this file' }).click();
    await page.waitForSelector('#handover-text', { timeout: 60000 });
    await page.getByRole('button', { name: 'Seal more files' }).click();
    assert.equal(await page.locator('#seal-more-ask').innerText(), "You haven't downloaded n3.bin.fseal. Download it first?");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Download', 'Download has focus');
    assert.deepEqual(await page.locator('.confirm-box .button.primary').allInnerTexts(), ['Download']);
    assert.deepEqual(await panel.locator('.button.primary').allInnerTexts(), ['Download'], 'one primary on screen: the question\'s, not also the step\'s');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('seal-more-ask') && document.activeElement?.textContent === 'Seal more files');
    assert.equal(await page.locator('#handover-text').count(), 1, 'Escape kept the result');
    await page.getByRole('button', { name: 'Seal more files' }).click();
    const [n3] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    assert.equal(n3.suggestedFilename(), 'n3.bin.fseal');
    // A click is not proof the save finished: the question stays, now asking for the confirmation.
    await page.waitForFunction(() => document.getElementById('seal-more-ask')?.textContent === 'Did the download of n3.bin.fseal finish?' && document.activeElement?.textContent === 'Yes, saved');
    // The file is kept, but the receipt message is not (a one-time key cannot make another): the question turns to it.
    await page.keyboard.press('Enter'); // "Yes, saved"
    await page.waitForFunction(() => document.getElementById('seal-more-ask')?.textContent === "You haven't kept the receipt message. Copy it first?" && document.activeElement?.textContent === 'Copy message');
    assert.deepEqual(await page.locator('.confirm-box .button.primary').allInnerTexts(), ['Copy message']);
    assert.equal(await panel.locator('.button.primary').count(), 1, 'one primary on screen: the question\'s Copy message only');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('seal-more-ask') && document.activeElement?.textContent === 'Seal more files');
    assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true, 'an unkept receipt still warns before reload');
    // Download receipt is a click too: it needs its own "Yes, receipt saved" before the question stops.
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download receipt' }).click()]);
    await page.getByText('Did the receipt download finish?').waitFor();
    await page.getByRole('button', { name: 'Seal more files' }).click();
    assert.equal(await page.locator('#seal-more-ask').innerText(), "You haven't kept the receipt message. Copy it first?", 'a receipt download click alone does not count');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Yes, receipt saved' }).click();
    await page.getByRole('button', { name: 'Seal more files' }).click(); // file and receipt kept: no question
    await page.waitForFunction(() => document.activeElement?.id === 'seal-what-title');
    assert.equal(await panel.locator('.seal-file-list').count(), 0, 'the selection is cleared');
    assert.equal(await page.locator('#job-ref').inputValue(), '');

    // R79: confirming an old download after sealing something new leaves the new result unsaved.
    const sealOne = async (name) => {
      await page.locator('#protect-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(`${name} ${Date.now()}`) });
      await page.getByRole('button', { name: 'Seal this file' }).click();
      await page.waitForSelector('#handover-text', { timeout: 60000 });
    };
    // A download that was cancelled or blocked never counts: Download, no "Yes, saved", then Seal more files still asks
    // and #/login still warns (the receipt is confirmed, so only the unconfirmed file keeps it unsaved).
    await sealOne('cancelled.bin');
    await page.getByRole('button', { name: 'Download receipt' }).click();
    await page.getByRole('button', { name: 'Yes, receipt saved' }).click();
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
    await page.locator('.handoff-confirm').getByText('Did the download finish?').waitFor();
    await page.getByRole('button', { name: 'Seal more files' }).click();
    assert.equal(await page.locator('#seal-more-ask').innerText(), 'Did the download of cancelled.bin.fseal finish?', 'an unconfirmed download still asks');
    await page.keyboard.press('Escape');
    await page.goto(`${url}#/login`);
    await page.getByText('This tab has work that is not saved yet. Download it before you sign in.').waitFor({ timeout: 5000 })
      .catch(() => assert.fail('an unconfirmed download was counted as saved'));
    await page.goto(`${url}#/app/protect`); await page.waitForSelector('#handover-text');
    await page.getByRole('button', { name: 'Seal more files' }).click();
    await page.getByRole('button', { name: 'Discard it' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'seal-what-title');

    await sealOne('first.bin');
    await page.goto(`${url}#/login`);
    await page.getByText('This tab has work that is not saved yet. Download it before you sign in.').waitFor();
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download unsaved work' }).click()]);
    await page.getByText('Did the download finish?').waitFor();
    await page.goto(`${url}#/app/protect`); await page.waitForSelector('#handover-text');
    await page.getByRole('button', { name: 'Seal more files' }).click();
    await page.getByRole('button', { name: 'Discard it' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'seal-what-title');
    await sealOne('second.bin');
    await page.goto(`${url}#/login`);
    await page.getByRole('button', { name: 'Yes, saved' }).click(); // confirms the first download only
    await page.getByText('This tab has work that is not saved yet. Download it before you sign in.').waitFor({ timeout: 3000 })
      .catch(() => assert.fail('the new result was marked saved by the old download'));
    assert.equal(await page.getByRole('button', { name: 'Download unsaved work' }).count(), 1);
    await page.goto(`${url}#/app/protect`); await page.waitForSelector('#handover-text');
    assert.equal(await page.locator('.seal-summary').innerText(), 'Sealed · 1 file');
    assert.deepEqual(await page.locator('.seal-panel .button.primary').allInnerTexts(), ['Download'], 'second.bin is still not downloaded');
    await page.getByRole('button', { name: 'Seal more files' }).click();
    await page.getByRole('button', { name: 'Discard it' }).click();

    // Large-file mode: the list vs the originals that travel separately (first five, then Show all), and discarding
    // an undownloaded list removes it from the unsaved work, so it no longer blocks signing in.
    await page.getByLabel('Large files: fingerprint only, files stay where they are').check();
    await page.locator('#manifest-files').setInputFiles(Array.from({ length: 7 }, (_, i) => ({ name: `roof-${i + 1}.mp4`, mimeType: 'video/mp4', buffer: Buffer.alloc(100 + i, i) })));
    await page.getByRole('button', { name: 'Seal the list' }).click();
    await page.waitForSelector('#manifest-handover-text', { timeout: 60000 });
    await page.waitForFunction(() => document.activeElement?.id === 'manifest-handoff-title');
    assert.deepEqual(await page.locator('.handoff-step-title').allInnerTexts(), ['Download the list', 'Send the receipt message']);
    assert.deepEqual(await page.locator('.handoff-original-list li').allInnerTexts(), ['roof-1.mp4', 'roof-2.mp4', 'roof-3.mp4', 'roof-4.mp4', 'roof-5.mp4']);
    await page.getByRole('button', { name: 'Show all 7' }).click();
    assert.equal(await page.locator('.handoff-original-list li').count(), 7);
    assert.deepEqual(await page.locator('.seal-panel .button.primary').allInnerTexts(), ['Download']);
    await page.getByRole('button', { name: 'Seal more files' }).click();
    assert.match(await page.locator('#seal-more-ask').innerText(), /^You haven't downloaded hashwing-\d{8}-\d{6}\.manifest\.fseal\. Download it first\?$/);
    await page.keyboard.press('Escape');
    // A kept list with an unkept receipt message still asks, and still counts as unsaved work.
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed list' }).click()]);
    await page.locator('.handoff-confirm').getByRole('button', { name: 'Yes, saved' }).click();
    await page.getByRole('button', { name: 'Seal more files' }).click();
    assert.equal(await page.locator('#seal-more-ask').innerText(), "You haven't kept the receipt message. Copy it first?");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Copy message');
    assert.deepEqual(await panel.locator('.button.primary').allInnerTexts(), ['Copy message'], 'list: one primary while the receipt question is open');
    assert.equal(await panel.locator('.confirm-box .button.primary').count(), 1);
    assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true, 'the list\'s unkept receipt still warns before reload');
    await page.getByRole('button', { name: 'Discard it' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'seal-what-title');
    assert.equal(await page.locator('.seal-total').count(), 0);
    await page.goto(`${url}#/login`); await page.waitForSelector('#auth-email, form');
    assert.equal(await page.getByText('This tab has work that is not saved yet.').count(), 0, 'a discarded list does not block sign-in');
    await auditAxe(page, 'login after discard');
  });

  await context.close();
} finally {
  await browser?.close();
  server.close();
  writeFileSync(join(EVIDENCE, 'react-console-report.json'), JSON.stringify({ checks, total: checks.length, passed: checks.filter((x) => x.passed).length, metrics, axeReviews, failedAssets, runtimeErrors }, null, 2));
}
if (checks.some((check) => !check.passed)) process.exitCode = 1;

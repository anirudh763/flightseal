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
  await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('800'), null, { timeout: 30000 });
}
async function loadLandingDemo(page) {
  await page.goto(url);
  await page.getByRole('button', { name: /Run real verification/ }).first().click();
  await page.waitForFunction(() => document.querySelector('.hero-actual-result')?.innerText.includes('Intact'), null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Inspect records and export' }).click();
  await waitResult(page, 'Intact');
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
  // Route focus and smooth scrolling can leave a control partly behind the sticky header.
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await page.waitForFunction(() => window.scrollY === 0);
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
  assert.equal(await page.locator('#page-landing').textContent().then((text) => text.includes('Check the log.')), true, 'first load is the editorial landing page');
  await page.getByRole('button', { name: /Run real verification/ }).first().click();
  await page.waitForFunction(() => document.querySelector('.hero-actual-result')?.innerText.includes('Intact'));
  await page.getByRole('button', { name: 'Inspect records and export' }).click();
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

  await check('allowlisted sample query opens the requested evidence and selected record', async () => {
    await page.goto(`${url}#/records?sample=intact&record=24`);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 24', null, { timeout: 15000 });
    assert.match(await page.locator('.record-list').textContent(), /24/);
    const selectedUrl = new URL(page.url());
    assert.equal(selectedUrl.search, '', 'sample identity is not sent as an HTTP query string');
    assert.match(selectedUrl.hash, /sample=intact/);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Samples' }).click();
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

    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Samples' }).click();
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
    const [pdfDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PDF' }).first().click()]);
    const report = await PDFDocument.load(readFileSync(await pdfDownload.path()), { updateMetadata: false });
    assert.equal(report.getTitle(), 'HashWing integrity report');
    assert.equal(report.getCreationDate(), undefined);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Samples' }).click();
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
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Samples' }).click();
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
    await page.getByRole('button', { name: /Load full PX4 sample/ }).click();
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

  await check('320/768/1440 layouts have no page overflow and pass axe; keyboard skip link works', async () => {
    await route(page, 'sandbox'); await page.reload(); await loadFreshDemo(page);
    for (const [width, height] of [[320, 900], [375, 812], [768, 900], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(80);
      const dimensions = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(dimensions.doc <= dimensions.client + 1, `${width}px overflow: ${JSON.stringify(dimensions)}`);
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
    assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: /Records/ }).isVisible(), false);
    await page.getByRole('button', { name: 'Menu' }).click();
    assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Records' }).isVisible(), true);
    await page.evaluate(() => { location.hash = '#/verify'; });
    await page.waitForFunction(() => document.activeElement?.id === 'page-verify' && document.title === 'Verify · HashWing').catch(async () => assert.fail(`legacy Verify route did not restore focus/title: ${location.hash}; focus=${await page.evaluate(() => document.activeElement?.id)}; title=${await page.title()}`));
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.hash.startsWith('#/app/sandbox') && document.activeElement?.id === 'page-sandbox').catch(async () => assert.fail(`browser Back did not restore Samples focus: ${await page.evaluate(() => location.hash)}; focus=${await page.evaluate(() => document.activeElement?.id)}`));
    await page.evaluate(() => history.forward());
    await page.waitForFunction(() => location.hash === '#/verify' && document.activeElement?.id === 'page-verify').catch(async () => assert.fail(`browser Forward did not restore Verify focus: ${await page.evaluate(() => location.hash)}; focus=${await page.evaluate(() => document.activeElement?.id)}`));
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
      await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: title }).click();
      await page.waitForFunction((target) => document.activeElement?.id === `page-${target}`, screen, { timeout: 1500 });
    }
    assert.match(await page.locator('.result-stat').textContent(), /800/);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Verify' }).click();
    await page.locator('#trusted-key').fill('editing');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Records' }).click();
    assert.equal(await page.evaluate(() => location.hash), '#/app/records?sample=intact&record=799');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Verify' }).click();
    assert.equal(await page.locator('#trusted-key').inputValue(), 'editing');
  });

  await check('direct routes and root hash resolve to their own current screens', async () => {
    await page.goto(`${url}#/`);
    await page.waitForSelector('#page-landing');
    assert.match(await page.locator('#page-landing').textContent(), /Check the log\./);
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
    await page.getByRole('button', { name: /Run real verification/ }).first().click();
    await page.waitForFunction(() => document.querySelector('.hero-actual-result')?.innerText.includes('Intact'));
    await page.getByRole('navigation', { name: 'Account and workspace' }).getByRole('link', { name: 'Create account' }).click();
    await page.locator('#auth-email').fill(email); await page.locator('#auth-password').fill(password); await page.locator('#auth-confirm').fill(password);
    await page.getByLabel(/Import this guest session/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('backup-'));
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
    await restorePage.getByRole('navigation', { name: 'Account and workspace' }).getByRole('link', { name: 'Log in' }).click();
    await restorePage.locator('#auth-email').fill(email); await restorePage.locator('#auth-password').fill(password);
    await restorePage.getByRole('button', { name: 'Log in' }).click();
    await restorePage.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('backup-'));
    assert.match(restorePage.url(), /sample=intact/, 'saved included-sample view is restored without copying source files');
    await restorePage.locator('.profile-menu > summary').click();
    await restorePage.getByRole('button', { name: 'Log out' }).click();
    await restorePage.getByRole('navigation', { name: 'Account and workspace' }).getByRole('link', { name: 'Log in' }).click();
    await restorePage.locator('#auth-email').fill(email); await restorePage.locator('#auth-password').fill(password);
    await restorePage.getByRole('button', { name: 'Log in' }).click();
    await restorePage.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('backup-'));
    await restoreContext.close();
  });

  await context.close();
} finally {
  await browser?.close();
  server.close();
  writeFileSync(join(EVIDENCE, 'react-console-report.json'), JSON.stringify({ checks, total: checks.length, passed: checks.filter((x) => x.passed).length, metrics, axeReviews, failedAssets, runtimeErrors }, null, 2));
}
if (checks.some((check) => !check.passed)) process.exitCode = 1;

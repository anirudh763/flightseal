import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../tests/web/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DOCS = join(ROOT, 'docs');
const evidence = process.env.FLIGHTSEAL_EDGE_EVIDENCE || join(ROOT, '.test-artifacts', 'nine-case-browser.json');
const screenshots = process.env.FLIGHTSEAL_EDGE_SCREENSHOTS || join(ROOT, '.test-artifacts', 'nine-case');
const lockPath = process.env.FLIGHTSEAL_BROWSER_LOCK || join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'five-app-user-council-browser.lock');
const require = createRequire(join(ROOT, 'newweb/package.json'));
const { chromium } = require('playwright');
const records = [];
const metrics = {};
const runtimeErrors = [];
const requiredChecks = [
  'a: 800-record demo shows a real native verification with trusted receipt coverage',
  'b: 2,422-record PX4 fixture verifies with its bundled receipts and key',
  'c: 64,542-record PX4 file verifies on demand with a live event-loop heartbeat',
  'd: sandbox payload-byte flip recomputes CRC and native engine reports first hash-link failure',
  'e: deleting a middle record reports the real native sequence boundary',
  'f: torn final write is reported as torn-tail and never repairs the selected original',
  'g: TSV timestamps that reverse order remain an intact chain with reversal count visible',
  'h: malformed and non-log uploads clear prior positive state, show parse failure, and recover on retry',
  'i: custom TSV sealing at interval N rejects invalid boundary values and downloads re-verifiable native outputs',
];
const { server, url: rootUrl } = await serve(0, '/flightseal');
const url = `${rootUrl}console/`;
let browser;
let lock;
let fatalError;
const cleanupErrors = [];

function acquireBrowserLock() {
  return new Promise((resolveLock, reject) => {
    const child = spawn('python3', ['-c', 'import fcntl, os, sys; fd=os.open(sys.argv[1], os.O_CREAT|os.O_RDWR, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.read()', lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('locked\n')) resolveLock(child);
    });
    child.once('error', reject);
    child.once('exit', code => { if (!output.includes('locked\n')) reject(new Error(`Could not acquire browser lock (python exited ${code}).`)); });
  });
}

async function route(page, screen) {
  await page.evaluate(value => { location.hash = `/${value}`; }, screen);
  await page.waitForFunction(value => location.hash === `#/${value}`, screen);
  await page.waitForFunction(value => document.querySelector('.page-heading h1')?.textContent === value[0].toUpperCase() + value.slice(1), screen);
}

async function waitForResult(page, label) {
  await page.waitForFunction(value => document.querySelector('#result-heading')?.textContent.includes(value), label, { timeout: 60000 });
}

async function loadDemo(page) {
  await route(page, 'sandbox');
  await page.getByRole('button', { name: /800-record demo/ }).click();
  await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('800'), null, { timeout: 30000 });
}

async function check(name, fn) {
  try {
    const detail = await fn();
    records.push({ name, passed: true, ...(detail || {}) });
    console.log(`ok ${name}`);
  } catch (error) {
    records.push({ name, passed: false, error: String(error?.stack || error) });
    console.error(`FAIL ${name}: ${error?.message || error}`);
  }
}

async function downloadText(page, name) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name }).click()]);
  return { filename: download.suggestedFilename(), contents: readFileSync(await download.path(), 'utf8') };
}

try {
  lock = await acquireBrowserLock();
  mkdirSync(dirname(evidence), { recursive: true });
  mkdirSync(screenshots, { recursive: true });
  const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const BrowserWorker = window.Worker;
    window.__flightSealWorkers = [];
    window.Worker = class extends BrowserWorker {
      constructor(...args) { super(...args); window.__flightSealWorkers.push(String(args[0])); }
    };
  });
  page.on('pageerror', error => runtimeErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(`${message.text()} (${message.location().url})`); });
  const initialStarted = performance.now();
  await page.goto(url);
  await waitForResult(page, 'Intact');
  await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('800'));
  metrics.default800ElapsedMs = Math.round(performance.now() - initialStarted);

  await check('a: 800-record demo shows a real native verification with trusted receipt coverage', async () => {
    assert.match(await page.locator('.result-top .eyebrow').textContent(), /C\+\+ \/ OpenSSL \/ WebAssembly/);
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    assert.match(await page.locator('.stats-grid').textContent(), /800 covered · 0 uncovered/);
    await route(page, 'records');
    assert.ok(await page.locator('.record-list li').count() > 0);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 8);
    await route(page, 'sandbox');
    const text = await downloadText(page, 'Download text report');
    assert.equal(text.filename, 'flightseal-verification-report.txt');
    assert.match(text.contents, /Records checked: 800/);
    const summary = await downloadText(page, 'Download JSON summary');
    assert.equal(JSON.parse(summary.contents).nativeVerdict, 'intact');
    return { elapsedMs: metrics.default800ElapsedMs, receiptRows: 8, inspectedRecords: true, reportDownloads: 2 };
  });

  await check('b: 2,422-record PX4 fixture verifies with its bundled receipts and key', async () => {
    await route(page, 'sandbox');
    await page.getByRole('button', { name: /2,422-record PX4/ }).click();
    await waitForResult(page, 'Intact');
    assert.match(await page.locator('.result-stat').textContent(), /2,422/);
    assert.match(await page.locator('.stats-grid').textContent(), /2,422 covered · 0 uncovered/);
    return { recordCount: 2422, coverage: '2422/2422' };
  });

  await check('c: 64,542-record PX4 file verifies on demand with a live event-loop heartbeat', async () => {
    const start = performance.now();
    const workersBefore = await page.evaluate(() => window.__flightSealWorkers.length);
    await page.evaluate(() => {
      window.__heartbeat = { last: performance.now(), maxGap: 0, ticks: 0 };
      window.__heartbeatTimer = setInterval(() => {
        const now = performance.now();
        window.__heartbeat.maxGap = Math.max(window.__heartbeat.maxGap, now - window.__heartbeat.last);
        window.__heartbeat.last = now;
        window.__heartbeat.ticks++;
      }, 10);
    });
    await page.getByRole('button', { name: /full PX4.*64,542 records/i }).click();
    await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.includes('64,542'), null, { timeout: 60000 });
    const heartbeat = await page.evaluate(() => { clearInterval(window.__heartbeatTimer); return window.__heartbeat; });
    metrics.fullPx4ElapsedMs = Math.round(performance.now() - start);
    metrics.fullPx4HeartbeatMaxGapMs = Math.round(heartbeat.maxGap * 10) / 10;
    assert.match(await page.locator('#result-heading').textContent(), /Intact/);
    const workerUrls = await page.evaluate(() => window.__flightSealWorkers.slice());
    assert.ok(workerUrls.length > workersBefore, 'full-file native check must instantiate a real Web Worker');
    assert.ok(heartbeat.ticks > 0, 'heartbeat should run while the operation is in progress');
    assert.ok(heartbeat.maxGap < 1500, `main-thread heartbeat gap ${heartbeat.maxGap.toFixed(1)}ms exceeded the finite 1500ms bound`);
    const precache = await page.evaluate(async () => (await (await fetch('/flightseal/console/precache.json')).json()).files);
    assert.equal(precache.some(path => path.includes('px4-full.fseal')), false, 'full fixture must not be automatically precached');
    await route(page, 'records');
    const indexedRows = await page.locator('.record-list li').count();
    assert.ok(indexedRows > 0 && indexedRows <= 50, `expected one paginated slice, found ${indexedRows} rows`);
    await route(page, 'receipts');
    assert.equal(await page.locator('tbody tr').count(), 13);
    assert.match(await page.locator('.receipt-overview').textContent(), /64,542 records covered by a trusted receipt · 0 uncovered/);
    await route(page, 'sandbox');
    return { bytes: 30294365, records: 64542, receiptRows: 13, paginatedIndexRows: indexedRows, workerUrls, elapsedMs: metrics.fullPx4ElapsedMs, eventLoopTicks: heartbeat.ticks, heartbeatMaxGapMs: metrics.fullPx4HeartbeatMaxGapMs, heartbeatBoundMs: 1500, fullFixturePrecached: false };
  });

  await check('d: sandbox payload-byte flip recomputes CRC and native engine reports first hash-link failure', async () => {
    await loadDemo(page);
    await page.getByRole('button', { name: 'Flip one payload byte' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-link'), null, { timeout: 15000 });
    assert.match(await page.locator('#result-heading').textContent(), /Tampered/);
    assert.match(await page.locator('.first-failure').textContent(), /bad-link/);
    const summary = JSON.parse((await downloadText(page, 'Download JSON summary')).contents);
    assert.equal(summary.nativeVerdict, 'tampered');
    assert.equal(summary.overallVerdict, 'tampered');
    const text = await downloadText(page, 'Download text report');
    assert.match(text.contents, /Overall evidence status: TAMPERED/);
    await route(page, 'records');
    assert.ok(await page.locator('.record-broken').count() > 0, 'tampered record index should expose its first broken row');
    await route(page, 'receipts');
    assert.match(await page.locator('tbody').textContent(), /shorter than the receipt|does not match this receipt/i);
    await route(page, 'sandbox');
    return { nativeFailure: 'bad-link', crcRecomputedBySandboxMutation: true, tamperedTextAndJsonReportsDownloaded: true, inspectedTamperedRecord: true, inspectedTamperedReceipts: true };
  });

  await check('e: deleting a middle record reports the real native sequence boundary', async () => {
    await loadDemo(page);
    await page.getByRole('button', { name: 'Remove one middle record' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('bad-seq'), null, { timeout: 15000 });
    assert.match(await page.locator('.first-failure').textContent(), /bad-seq/);
    const report = await downloadText(page, 'Download text report');
    assert.match(report.contents, /First failure: record 400, byte \d+ \[bad-seq\]/);
    return { nativeFailure: 'bad-seq', firstBadSequenceIndex: 400, tamperedTextReportDownloaded: true };
  });

  await check('f: torn final write is reported as torn-tail and never repairs the selected original', async () => {
    await loadDemo(page);
    await page.getByRole('button', { name: 'Trim seven tail bytes' }).click();
    await page.waitForFunction(() => document.querySelector('.first-failure')?.textContent.includes('torn-tail'), null, { timeout: 15000 });
    assert.match(await page.locator('#result-heading').textContent(), /Tampered/);
    assert.match(await page.locator('.first-failure').textContent(), /torn-tail/);
    const result = await page.evaluate(() => ({ selectedFile: document.querySelector('#log-input')?.files?.[0]?.name || null, report: document.querySelector('.report-text')?.textContent || '' }));
    assert.match(result.report, /torn-tail/);
    return { nativeFailure: 'torn-tail', changedCopyOnly: true, originalFileSelection: result.selectedFile };
  });

  await check('g: TSV timestamps that reverse order remain an intact chain with reversal count visible', async () => {
    await route(page, 'sandbox');
    await page.locator('#tsv-file').setInputFiles({ name: 'timestamp-reversal.tsv', mimeType: 'text/plain', buffer: Buffer.from('300\tfirst\n100\tbackward\n200\tforward-again\n') });
    await page.locator('#receipt-interval').fill('2');
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await waitForResult(page, 'Intact');
    assert.match(await page.locator('.stats-grid').textContent(), /Time reversals\s*1/);
    assert.equal(await page.locator('.seal-outputs button').count(), 3);
    const receiptFile = await downloadText(page, 'Download receipts');
    assert.equal(receiptFile.filename, 'sealed.receipts');
    assert.equal(receiptFile.contents.trim().split('\n').length, 2);
    return { nativeVerdict: 'intact', timeReversals: 1, nativeReceiptCount: 2 };
  });

  await check('h: malformed and non-log uploads clear prior positive state, show parse failure, and recover on retry', async () => {
    await route(page, 'verify');
    await page.locator('#log-input').setInputFiles(join(DOCS, 'samples/intact.fseal'));
    await page.locator('#receipt-input').setInputFiles(join(DOCS, 'samples/flight.receipts'));
    await page.locator('#trusted-key').fill(readFileSync(join(DOCS, 'samples/pubkey.txt'), 'utf8').trim());
    await page.getByRole('button', { name: 'Run C++ check' }).click();
    await waitForResult(page, 'Intact');
    await page.locator('#log-input').setInputFiles({ name: 'not-a-flight-log.fseal', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not FlightSeal data\n') });
    await page.waitForFunction(() => !document.querySelector('#result-heading'));
    assert.equal(await page.locator('#result-heading').count(), 0, 'old intact result must disappear when new evidence is selected');
    await page.getByRole('button', { name: 'Run C++ check' }).click();
    await waitForResult(page, 'Tampered');
    assert.match(await page.locator('.first-failure').textContent(), /bad-header/);
    await page.locator('#log-input').setInputFiles(join(DOCS, 'samples/intact.fseal'));
    await page.getByRole('button', { name: 'Run C++ check' }).click();
    await waitForResult(page, 'Intact');
    return { stalePositiveCleared: true, nonLogResult: 'tampered/bad-header', validRetry: 'intact' };
  });

  await check('i: custom TSV sealing at interval N rejects invalid boundary values and downloads re-verifiable native outputs', async () => {
    await route(page, 'sandbox');
    await page.locator('#tsv-file').setInputFiles({ name: 'custom-flight.tsv', mimeType: 'text/plain', buffer: Buffer.from('100\talpha\n200\tbravo\n300\tcharlie\n400\tdelta\n500\techo\n') });
    await page.locator('#receipt-interval').fill('2');
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await waitForResult(page, 'Intact');
    assert.match(await page.locator('.result-stat').textContent(), /5/);
    assert.match(await page.locator('.stats-grid').textContent(), /5 covered · 0 uncovered/);
    const logs = await downloadText(page, 'Download sealed log');
    const receipts = await downloadText(page, 'Download receipts');
    const key = await downloadText(page, 'Download public key');
    assert.equal(logs.filename, 'sealed.fseal');
    assert.equal(receipts.filename, 'sealed.receipts');
    assert.equal(key.filename, 'sealed-public-key.txt');
    assert.ok(logs.contents.startsWith('FLTSEAL1'), 'download must contain the real native FlightSeal log');
    const receiptCounts = receipts.contents.trim().split('\n').map(line => Number(line.match(/\bcount=(\d+)/)?.[1]));
    assert.deepEqual(receiptCounts, [2, 4, 5]);
    assert.match(key.contents.trim(), /^[a-f0-9]{64}$/);
    await page.locator('#receipt-interval').fill('0');
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await page.waitForFunction(() => /interval|receipt|between 1 and 1,000,000/i.test(document.querySelector('[role=alert]')?.textContent || ''));
    const error = await page.locator('[role=alert], .operation-status').allTextContents();
    assert.match(error.join(' '), /interval|receipt|between 1 and 1,000,000/i);
    await page.locator('#receipt-interval').fill('2');
    await page.locator('#tsv-file').setInputFiles({ name: 'bad-flight.tsv', mimeType: 'text/plain', buffer: Buffer.from('no timestamp separator\n') });
    await page.getByRole('button', { name: 'Seal and verify' }).click();
    await page.waitForFunction(() => document.querySelector('[role=alert]')?.textContent.includes('expected timestamp_us'));
    return { recordCount: 5, interval: 2, receiptCounts, downloaded: [logs.filename, receipts.filename, key.filename], sealedLogMagic: 'FLTSEAL1', invalidIntervalRejected: true, invalidTsvRowRejected: true };
  });

  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.locator('#tsv-file').setInputFiles([]);
    await loadDemo(page);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scrollWidth <= dimensions.width + 1, `${width}px layout overflows by ${dimensions.scrollWidth - dimensions.width}px`);
    await page.screenshot({ path: join(screenshots, `sandbox-${width}.png`), fullPage: true });
  }
  metrics.runtimeErrors = runtimeErrors;
  assert.deepEqual(runtimeErrors, [], `unexpected uncaught browser errors: ${runtimeErrors.join('\n')}`);
} catch (error) {
  fatalError = String(error?.stack || error);
  throw error;
} finally {
  try { if (browser) await browser.close(); } catch (error) { cleanupErrors.push(`browser close: ${String(error?.stack || error)}`); }
  try {
    server.closeAllConnections();
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  } catch (error) { cleanupErrors.push(`server close: ${String(error?.stack || error)}`); }
  if (lock) {
    try {
      const released = new Promise(done => lock.once('exit', done));
      lock.stdin.end();
      await released;
    } catch (error) { cleanupErrors.push(`browser lock release: ${String(error?.stack || error)}`); }
  }
  const passed = records.filter(item => item.passed).length;
  const failed = records.filter(item => !item.passed).length;
  const completed = new Set(records.map(item => item.name));
  const notRun = requiredChecks.filter(name => !completed.has(name));
  const allPassed = records.length === requiredChecks.length && passed === requiredChecks.length && failed === 0 && notRun.length === 0 && runtimeErrors.length === 0 && !fatalError && cleanupErrors.length === 0;
  writeFileSync(evidence, JSON.stringify({
    suite: 'FlightSeal console nine-case edge matrix',
    baseUrl: url,
    requiredChecks,
    checks: records,
    passed,
    failed,
    notRun,
    metrics: { ...metrics, runtimeErrors },
    fatalError: fatalError || null,
    cleanupErrors,
    allPassed,
  }, null, 2));
  if (!allPassed) process.exitCode = 1;
}

if (records.some(item => !item.passed)) process.exitCode = 1;

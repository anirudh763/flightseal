// Canonical-console browser/native parity and hostile-input regressions.
//   FSEAL_BIN=/path/to/fseal node tests/web/e2e.mjs
// The browser lock coordinates this run with every other FlightSeal browser gate.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { acquireBrowserLock, releaseBrowserLock } from './browser-lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLES = join(ROOT, 'docs/samples');
const COUNCIL = '/Users/anirudhyadav/Downloads/active/user-council-2026-11-14/flightseal';
const WRAPPER = join(COUNCIL, 'native-browser-cli.sh');
const FSEAL = process.env.FSEAL_BIN || (existsSync(WRAPPER) ? WRAPPER : join(ROOT, 'build/fseal'));
const NATIVE_TMP = process.env.FSEAL_TEST_TMPDIR || (FSEAL === WRAPPER ? join(COUNCIL, 'native-browser-tmp') : tmpdir());
const EVIDENCE = process.env.FSEAL_WEB_EVIDENCE || (existsSync(COUNCIL) ? join(COUNCIL, 'workbench/compatibility-tests') : join(ROOT, 'build/test-artifacts/compatibility-tests'));
const require = createRequire(join(ROOT, 'newweb/package.json'));
const { chromium } = require('playwright');
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(NATIVE_TMP, { recursive: true });
const tmp = mkdtempSync(join(NATIVE_TMP, 'canonical-e2e-'));
const checks = [];
let lock;
let browser;
let server;
let rootUrl;
let url;

function record(name, passed, error = '') {
  checks.push({ name, passed, ...(error ? { error } : {}) });
  console.log(`${passed ? 'ok' : 'FAIL'} ${name}${error ? `: ${error}` : ''}`);
}

async function check(name, fn) {
  try { await fn(); record(name, true); }
  catch (error) { record(name, false, String(error?.stack || error)); }
}

function native(log, receipts, key) {
  const args = ['verify', log];
  if (receipts !== null) args.push('--receipts', receipts, '--pubkey', key);
  const result = spawnSync(FSEAL, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000 });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const verdict = output.match(/^RESULT: (INTACT|TAMPERED|INCOMPLETE|UNVERIFIED)\b/m)?.[1];
  if (!verdict && result.status !== 0) return { output, verdict: 'parse-error', problem: null };
  assert.ok(verdict, `Native CLI produced no recognized verdict (exit ${result.status}):\n${output.slice(-2500)}`);
  const problem = output.match(/first problem\s+record\s+(\d+), byte\s+(\d+):\s+([^\n]+)/i);
  return { output, verdict: verdict.toLowerCase(), problem: problem ? { record: Number(problem[1]), offset: Number(problem[2]), text: problem[3] } : null };
}

function put(name, bytes) {
  const path = join(tmp, name);
  writeFileSync(path, bytes);
  return path;
}

function sample(name, receipts, key) {
  return { name, log: join(SAMPLES, name), receipts: join(SAMPLES, receipts), key: readFileSync(join(SAMPLES, key), 'utf8').trim() };
}

function numberPattern(value) {
  return value.toLocaleString('en-US').replaceAll(',', ',?');
}

async function verifyInBrowser(context, testCase, { run = true } = {}) {
  const page = await context.newPage();
  await page.goto(`${url}#/verify`);
  await page.waitForFunction(() => document.querySelector('.commandbar h1')?.textContent === 'Verify');
  await page.locator('#log-input').setInputFiles(testCase.log);
  if (testCase.receipts !== null) await page.locator('#receipt-input').setInputFiles(testCase.receipts);
  await page.locator('#trusted-key').fill(testCase.key || '');
  if (run) await page.getByRole('button', { name: 'Run check' }).click();
  await page.waitForFunction(() => !!document.querySelector('#result-heading') || !!document.querySelector('[role="alert"]'), null, { timeout: 30000 });
  return page;
}

function browserVerdict(page) {
  return page.locator('#result-heading').count().then(async (count) => count
    ? (await page.locator('#result-heading').textContent()).trim().split(/\s+/)[0].toLowerCase()
    : 'parse-error');
}

try {
  lock = await acquireBrowserLock();
  mkdirSync(EVIDENCE, { recursive: true });
  ({ server, url: rootUrl } = await serve(0, '/flightseal'));
  url = `${rootUrl}console/`;
  const chromePath = process.env.CHROME_PATH || (existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });

  const sampleCases = [
    sample('intact.fseal', 'flight.receipts', 'pubkey.txt'),
    sample('tampered.fseal', 'flight.receipts', 'pubkey.txt'),
    sample('rewritten.fseal', 'flight.receipts', 'pubkey.txt'),
    sample('truncated.fseal', 'flight.receipts', 'pubkey.txt'),
    sample('px4-intact.fseal', 'px4-flight.receipts', 'px4-pubkey.txt'),
    sample('px4-tampered.fseal', 'px4-flight.receipts', 'px4-pubkey.txt'),
  ];
  await check('native CLI and canonical browser agree on verdict and first failure for all six included samples', async () => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
    try {
      for (const testCase of sampleCases) {
        const expected = native(testCase.log, testCase.receipts, testCase.key);
        const page = await verifyInBrowser(context, testCase);
        assert.equal(await browserVerdict(page), expected.verdict, `${testCase.name}: native=${expected.verdict}; UI=${await page.locator('#result-heading').textContent()}`);
        if (expected.problem) {
          const firstFailure = page.locator('.first-failure');
          assert.ok(await firstFailure.count(), `${testCase.name}: browser omitted the CLI first failure`);
          const displayedFailure = await firstFailure.textContent();
          assert.match(displayedFailure, new RegExp(`Record\\s+${numberPattern(expected.problem.record)}\\b`), `${testCase.name}: expected first-failure record ${expected.problem.record}, saw ${displayedFailure}`);
          assert.match(displayedFailure, new RegExp(`Offset\\s+${numberPattern(expected.problem.offset)}\\s+bytes`), `${testCase.name}: native/browser first-failure byte offset differs`);
          const token = expected.problem.text.match(/\[([a-z-]+)\]/i)?.[1];
          if (token) assert.match(await firstFailure.textContent(), new RegExp(`\\(${token}\\)`), `${testCase.name}: first-failure kind differs`);
        } else {
          assert.equal(await page.locator('.first-failure').count(), 0, `${testCase.name}: browser showed a first record failure the native CLI did not report`);
        }
        await page.close();
      }
    } finally { await context.close(); }
  });

  const intact = readFileSync(join(SAMPLES, 'intact.fseal'));
  const goodReceipts = readFileSync(join(SAMPLES, 'flight.receipts'));
  const goodKey = readFileSync(join(SAMPLES, 'pubkey.txt'), 'utf8').trim();
  const receiptCases = [
    { name: 'wrong trusted key', receipts: goodReceipts, key: readFileSync(join(SAMPLES, 'px4-pubkey.txt'), 'utf8').trim() },
    { name: 'bad signature', receipts: Buffer.from(goodReceipts.toString('utf8').replace(/sig=([0-9a-f])/, (_, n) => `sig=${n === '0' ? '1' : '0'}`)), key: goodKey },
    { name: 'UTF-8 BOM receipt file', receipts: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), goodReceipts]), key: goodKey },
    { name: 'malformed receipt text', receipts: Buffer.from('this is not a FlightSeal receipt\n'), key: goodKey },
    { name: 'empty receipt file', receipts: Buffer.alloc(0), key: goodKey },
  ];
  await check('wrong-key, bad-signature, BOM, malformed, and empty receipt inputs match the native CLI', async () => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
    const discrepancies = [];
    try {
      for (const item of receiptCases) {
        const log = put(`receipt-${item.name.replaceAll(/[^a-z0-9]+/gi, '-')}.fseal`, intact);
        const receipts = put(`receipt-${item.name.replaceAll(/[^a-z0-9]+/gi, '-')}.receipts`, item.receipts);
        const expected = native(log, receipts, item.key);
        const isEmptyReceiptFile = item.name === 'empty receipt file';
        const page = await verifyInBrowser(context, { log, receipts, key: item.key }, { run: !isEmptyReceiptFile });
        try {
          const actual = await browserVerdict(page);
          const uiSummary = actual === 'parse-error' ? await page.locator('[role="alert"]').textContent() : await page.locator('#result-heading').textContent();
          assert.equal(actual, expected.verdict, `${item.name}: native=${expected.verdict}; UI=${uiSummary}`);
          if (expected.verdict === 'parse-error') assert.match(await page.locator('[role="alert"]').textContent(), /receipt|empty|no receipts/i, `${item.name}: browser did not explain the receipt parse failure`);
          assert.equal(await page.locator('.first-failure').count(), 0, `${item.name}: receipt issue must not be presented as a record-chain failure`);
          if (isEmptyReceiptFile) {
            const runButton = page.getByRole('button', { name: 'Run check' });
            assert.match(await page.locator('[role="alert"]').textContent(), /selected receipts file is empty/i);
            assert.equal(await runButton.isDisabled(), true, 'an explicitly selected empty receipt file must block Run check');
            await page.getByRole('button', { name: /remove receipts/i }).click();
            await page.waitForFunction(() => !document.querySelector('.verify-panel button.primary')?.disabled, null, { timeout: 8000 });
            const noReceipts = native(log, null, '');
            assert.equal(noReceipts.verdict, 'intact', `chain-only CLI check should remain valid: ${noReceipts.output}`);
            await runButton.click();
            await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact'), null, { timeout: 30000 });
            assert.equal(await browserVerdict(page), noReceipts.verdict, 'removing receipts should run a chain-only verification');
            assert.match(await page.locator('.result-top').textContent(), /no receipts supplied/i);
            assert.equal(await page.locator('.first-failure').count(), 0, 'chain-only intact verification has no record failure');
          }
        } catch (error) { discrepancies.push(`${item.name}: ${error.message}`); }
        await page.close();
      }
    } finally { await context.close(); }
    assert.deepEqual(discrepancies, [], `native/browser receipt mismatches:\n${discrepancies.join('\n')}`);
  });

  await check('hostile length, non-log, and torn-tail inputs report the same native verdict and first failure', async () => {
    const hostileLength = Buffer.from(intact);
    hostileLength.writeUInt32LE(0xffffffff, 8);
    const cases = [
      { name: 'hostile length', log: put('hostile-length.fseal', hostileLength), receipts: null, key: '' },
      { name: 'non-log', log: put('non-log.fseal', Buffer.from('not a FlightSeal log\n')), receipts: null, key: '' },
      { name: 'torn tail', log: put('torn-tail.fseal', intact.subarray(0, intact.length - 7)), receipts: null, key: '' },
    ];
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
    try {
      for (const testCase of cases) {
        const expected = native(testCase.log, null, '');
        const page = await verifyInBrowser(context, testCase);
        assert.equal(await browserVerdict(page), expected.verdict, `${testCase.name}: native=${expected.verdict}; UI=${await page.locator('#result-heading').textContent()}`);
        if (expected.problem) {
          const firstFailure = page.locator('.first-failure');
          assert.ok(await firstFailure.count(), `${testCase.name}: browser omitted CLI first failure`);
          const displayedFailure = await firstFailure.textContent();
          assert.match(displayedFailure, new RegExp(`Record\\s+${numberPattern(expected.problem.record)}\\b`));
          assert.match(displayedFailure, new RegExp(`Offset\\s+${numberPattern(expected.problem.offset)}\\s+bytes`));
          const token = expected.problem.text.match(/\[([a-z-]+)\]/i)?.[1];
          if (token) assert.match(displayedFailure, new RegExp(`\\(${token}\\)`));
        }
        await page.close();
      }
    } finally { await context.close(); }
  });

  await check('selecting malformed input clears a previous positive result before retry and never leaves stale success', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector('#result-heading')?.textContent.includes('Intact'), null, { timeout: 30000 });
      await page.goto(`${url}#/verify`);
      await page.locator('#log-input').setInputFiles(put('stale-clear-nonlog.fseal', Buffer.from('bad')));
      assert.equal(await page.locator('#result-heading').count(), 0, 'old intact verdict stayed visible after selecting a new file');
      await page.getByRole('button', { name: 'Run check' }).click();
      await page.waitForFunction(() => !!document.querySelector('#result-heading') || !!document.querySelector('[role="alert"]'), null, { timeout: 30000 });
      assert.notEqual(await browserVerdict(page), 'intact', 'malformed selection inherited a stale intact verdict');
    } finally { await context.close(); }
  });

  await check('when browser Ed25519 is unavailable, native verification remains usable and the limitation is explicit', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    try {
      await context.addInitScript(() => {
        const importKey = crypto.subtle.importKey.bind(crypto.subtle);
        crypto.subtle.importKey = (format, key, algorithm, ...rest) => algorithm?.name === 'Ed25519'
          ? Promise.reject(new DOMException('Ed25519 unavailable for this browser', 'NotSupportedError'))
          : importKey(format, key, algorithm, ...rest);
      });
      const page = await verifyInBrowser(context, sample('intact.fseal', 'flight.receipts', 'pubkey.txt'));
      assert.equal(await browserVerdict(page), 'intact');
      assert.match(await page.locator('.operation-status').textContent(), /cannot check Ed25519 signatures/i);
    } finally { await context.close(); }
  });
} catch (error) {
  record('browser e2e setup', false, String(error?.stack || error));
} finally {
  await browser?.close();
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'canonical-e2e.json'), JSON.stringify({ suite: 'tests/web/e2e.mjs', checks, total: checks.length, passed: checks.filter((item) => item.passed).length, failed: checks.filter((item) => !item.passed).length, nativeCli: 'configured native verifier' }, null, 2));
  await releaseBrowserLock(lock);
}

if (checks.some((item) => !item.passed)) process.exitCode = 1;

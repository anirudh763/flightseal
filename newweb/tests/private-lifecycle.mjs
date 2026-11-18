import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { acquireBrowserLock, releaseBrowserLock } from '../../tests/web/browser-lock.mjs';
import { createLocalProfile, setLocalSession, saveWorkspaceContext, localAuthStorageKeys } from '../src/local-auth.mjs';
import { createEncryptedProfileBackup, inspectEncryptedProfileBackup } from '../src/profile-backup.mjs';
import { generateEd25519SigningKey, validateEd25519PrivateKey } from '../src/signing-keys.mjs';

const BASE = process.env.HASHWING_BASE_URL || 'http://127.0.0.1:3001';
const ONLY = process.env.HASHWING_PRIVATE_ONLY || '';
const OUT = resolve(process.env.HASHWING_LIFECYCLE_EVIDENCE || 'artifacts/verification/canonical-persistence-20261116/private-lifecycle');
mkdirSync(OUT, { recursive: true, mode: 0o700 });
class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const passphrase = 'synthetic lifecycle backup password';
const active = new MemoryStorage(), restoring = new MemoryStorage(), session = new MemoryStorage();
const profile = await createLocalProfile('lifecycle-active@example.test', 'synthetic local profile password', { storage: active, cryptoObject: webcrypto });
setLocalSession({ kind: 'account', userId: profile.id }, { storage: session, cryptoObject: webcrypto });
await saveWorkspaceContext(profile.id, { screen: 'records', sample: 'intact', record: 2 }, { storage: active });
const restoredProfile = await createLocalProfile('lifecycle-restore@example.test', 'synthetic restored profile password', { storage: restoring, cryptoObject: webcrypto });
const encrypted = await createEncryptedProfileBackup(restoredProfile.id, { storage: restoring, passphrase, cryptoObject: webcrypto });
const backupBytes = Buffer.from(await encrypted.arrayBuffer());
const signing = await generateEd25519SigningKey(webcrypto);
const results = [], pageErrors = [];
let browser;

// Delay authentic native results; no crypto, verifier, archive or provider result is fabricated.
function hooks(seed) {
  for (const [key, value] of seed.local) localStorage.setItem(key, value);
  for (const [key, value] of seed.session) sessionStorage.setItem(key, value);
  const gate = window.__privateLifecycle = { kind: '', entered: 0, completed: 0, crypto: 0, copies: 0, release: null,
    async wait(kind) {
      if (kind !== this.kind || this.entered) return;
      this.entered++;
      await new Promise(resolve => { this.release = () => { this.kind = ''; resolve(); }; });
      this.completed++;
    },
  };
  for (const method of ['generateKey', 'importKey', 'exportKey', 'deriveKey', 'digest', 'encrypt', 'decrypt']) {
    const native = crypto.subtle[method].bind(crypto.subtle);
    crypto.subtle[method] = async (...args) => {
      gate.crypto++;
      try {
        const value = await native(...args);
        const name = typeof args[0] === 'string' ? args[0] : args[0]?.name;
        if (method === 'generateKey' && name === 'Ed25519') await gate.wait('keygen');
        if (method === 'importKey' && args[0] === 'pkcs8') await gate.wait('keyimport');
        if (method === 'digest' && args[1]?.byteLength === 32) await gate.wait('digest');
        if (method === 'encrypt' && name === 'AES-GCM') await gate.wait('encrypt');
        if (method === 'decrypt' && name === 'AES-GCM') await gate.wait('decrypt');
        return value;
      } finally { gate.crypto--; }
    };
  }
  for (const method of ['text', 'arrayBuffer']) {
    const native = Blob.prototype[method];
    Blob.prototype[method] = async function (...args) {
      const value = await native.apply(this, args);
      if (method === 'text' && this.name === 'lifecycle-private.pem') await gate.wait('keyfile');
      if (method === 'text' && this.name === 'lifecycle-backup.json') await gate.wait('backupfile');
      if (method === 'arrayBuffer' && this.name === 'lifecycle-source.fseal') await gate.wait('zip');
      return value;
    };
  }
  const copy = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (...args) => { gate.copies++; return copy(...args); };
}

async function fresh({ localProfile = false, instrumentShare = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', permissions: ['clipboard-write'] });
  await context.addInitScript(hooks, { local: localProfile ? [...active.values] : [], session: localProfile ? [...session.values] : [] });
  if (instrumentShare) await context.route('**/*', async route => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch(), headers = response.headers();
    await route.fulfill({ response, headers: { ...headers, 'permissions-policy': `${headers['permissions-policy'] ? headers['permissions-policy'] + ', ' : ''}web-share=()` } });
  });
  if (instrumentShare) await context.route('**/assets/index-*.js', async route => {
    const response = await route.fetch(), source = await response.text();
    // Hold the real capability outcome before the app's existing unavailable/rejection branch.
    const target = /if\(!await ([\w$]+)\(([\w$]+)\)\)throw Error\(`Native sharing is unavailable\.`\)/g;
    const matches = [...source.matchAll(target)];
    assert.equal(matches.length, 1, 'Expected exactly one native-share outcome boundary');
    const body = 'window.__privateLifecycle.shareInstrumented=true;\n' + source.replace(target, 'if(!await $1($2).then(async value=>{await window.__privateLifecycle.wait("share");return value;},async error=>{await window.__privateLifecycle.wait("share");throw error;}))throw Error(`Native sharing is unavailable.`)');
    await route.fulfill({ response, body });
  });
  const page = await context.newPage(), downloads = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  page.on('download', download => downloads.push(download));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(BASE + '/workbench');
  await page.waitForFunction(() => window.WorkspaceStore?.state.session?.principal_id);
  return { context, page, downloads };
}
async function check(name, run, options) {
  if (ONLY && !name.includes(ONLY)) return;
  const fixture = await fresh(options);
  try { await run(fixture); results.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) {
    const detail = String(error.message).split('\n')[0].slice(0, 160), alert = (await fixture.page.locator('.error-alert p').allTextContents()).map(text => text.slice(0, 200));
    const state = await fixture.page.evaluate(() => ({ path: location.pathname, gate: { ...window.__privateLifecycle, wait: undefined, release: undefined }, feedback: [...document.querySelectorAll('#feedback-description')].map(node => ({ empty: !node.value, parent: node.parentElement.className, open: node.closest('dialog')?.open })) }));
    const site = String(error.stack).match(/private-lifecycle\.mjs:(\d+):\d+/)?.[1];
    results.push({ name, passed: false, error: error.name, detail, alert, state, site }); console.error('FAIL ' + name + ': ' + detail + ' ' + JSON.stringify({ alert, state, site }));
  }
  finally { await fixture.context.close(); }
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(100);
}
async function arm(page, kind) { await page.evaluate(kind => Object.assign(window.__privateLifecycle, { kind, entered: 0, completed: 0, release: null }), kind); }
async function held(page) { await page.waitForFunction(() => window.__privateLifecycle.entered === 1); }
async function release(page) {
  await page.evaluate(() => window.__privateLifecycle.release());
  await page.waitForFunction(() => window.__privateLifecycle.completed === 1 && window.__privateLifecycle.crypto === 0);
  await settle(page);
}
async function serverLogout(page, newOwner = false) {
  const oldOwner = await page.evaluate(async () => { const old = WorkspaceStore.state.session.principal_id; await WorkspaceStore.logout(); return old; });
  assert.equal(await page.evaluate(() => WorkspaceStore.state.session), null, 'Actual server logout must clear session');
  if (newOwner) {
    await page.evaluate(() => WorkspaceStore.init());
    assert.notEqual(await page.evaluate(() => WorkspaceStore.state.session.principal_id), oldOwner, 'A new guest must own a distinct principal');
  }
  await settle(page);
}
async function uploadVerified(page) {
  const response = await page.request.get(BASE + '/flightseal/samples/intact.fseal');
  assert.equal(response.status(), 200, 'Actual public fixture must be available');
  await page.getByLabel('Choose source or sealed log').setInputFiles({ name: 'lifecycle-source.fseal', mimeType: 'application/octet-stream', buffer: await response.body() });
  const receipts = await page.request.get(BASE + '/flightseal/samples/flight.receipts');
  const key = await page.request.get(BASE + '/flightseal/samples/pubkey.txt');
  assert.equal(receipts.status(), 200); assert.equal(key.status(), 200);
  await page.locator('#receipt-input').setInputFiles({ name: 'fixture.receipts', mimeType: 'text/plain', buffer: await receipts.body() });
  await page.locator('#trusted-key').fill((await key.text()).trim());
  await page.getByRole('button', { name: 'Run check', exact: true }).click();
  await page.locator('#result-heading').filter({ hasText: 'Intact' }).waitFor();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Workbench', exact: true }).click();
}
async function backupPanel(page) {
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByText('Browser profiles and encrypted backups', { exact: true }).click();
  const menu = page.locator('.profile-menu');
  await menu.locator('summary').click();
  await page.locator('#backup-passphrase').fill(passphrase);
}
async function stageBackup(page) {
  await backupPanel(page);
  await page.locator('#backup-file').setInputFiles({ name: 'lifecycle-backup.json', mimeType: 'application/json', buffer: backupBytes });
  await page.getByRole('button', { name: 'Check backup and preview', exact: true }).click();
  await page.getByRole('button', { name: 'Restore this profile', exact: true }).waitFor();
}
async function bytes(download) { const value = readFileSync(await download.path()); await download.delete(); return value; }
function zipEntries(buffer) {
  const files = new Map(); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, 'Expected actual uncompressed evidence ZIP');
    const size = buffer.readUInt32LE(offset + 18), length = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + length + extra;
    files.set(buffer.subarray(offset + 30, offset + 30 + length).toString(), buffer.subarray(start, start + size));
    offset = start + size;
  }
  return files;
}

const lock = await acquireBrowserLock();
try {
  const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  await check('real Ed25519 generate/import/explicit private backup happy paths', async ({ page }) => {
    await page.getByRole('button', { name: 'Generate Ed25519 key', exact: true }).click();
    await page.getByRole('button', { name: 'Download private-key backup', exact: true }).waitFor();
    const [output] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download private-key backup', exact: true }).click()]);
    assert.match(await validateEd25519PrivateKey((await bytes(output)).toString(), webcrypto), /^-----BEGIN PRIVATE KEY-----/, 'Generated key must be actual valid Ed25519 PEM');
    await page.locator('#private-key-file').setInputFiles({ name: 'lifecycle-private.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from(signing.privateKeyPem) });
    await page.getByText('Imported for this tab only · import the matching public key separately', { exact: true }).waitFor();
    assert.equal(await page.locator('#private-key-file').evaluate(input => input.files.length), 0, 'Private file input must release its FileList immediately');
    await page.getByRole('button', { name: 'Clear key', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Download private-key backup', exact: true }).count(), 0);
  });
  for (const kind of ['keygen', 'keyfile', 'keyimport']) for (const reset of ['logout', 'clear']) {
    await check(`held real ${kind} cannot restore key after ${reset}`, async ({ page }) => {
      if (reset === 'clear') { await page.getByRole('button', { name: 'Generate Ed25519 key', exact: true }).click(); await page.getByRole('button', { name: 'Clear key', exact: true }).waitFor(); }
      await arm(page, kind);
      if (kind === 'keygen') await page.getByRole('button', { name: 'Generate Ed25519 key', exact: true }).click();
      else await page.locator('#private-key-file').setInputFiles({ name: 'lifecycle-private.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from(signing.privateKeyPem) });
      await held(page);
      if (reset === 'logout') await serverLogout(page, kind === 'keygen');
      else await page.getByRole('button', { name: 'Clear key', exact: true }).click();
      await release(page);
      assert.equal(await page.getByRole('button', { name: 'Download private-key backup', exact: true }).count(), 0, 'Old private key must not reappear');
      assert.equal(await page.locator('#private-key-file').evaluate(input => input.files.length), 0);
    });
  }
  for (const operation of ['PDF', 'ZIP']) for (const reset of ['logout', 'source replacement']) {
    await check(`held real ${operation} output is discarded after ${reset}`, async ({ page, downloads }) => {
      await uploadVerified(page);
      if (operation === 'PDF') await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Reports', exact: true }).click();
      await arm(page, operation === 'PDF' ? 'digest' : 'zip');
      await page.getByRole('button', { name: operation === 'PDF' ? 'Download PDF' : 'Export bundle', exact: true }).click();
      await held(page);
      if (reset === 'logout') await serverLogout(page);
      else { if (operation === 'PDF') await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Workbench', exact: true }).click(); await page.getByLabel('Choose source or sealed log').setInputFiles({ name: 'reset-source.tsv', mimeType: 'text/plain', buffer: Buffer.from('1000\tnew source\n') }); await page.getByRole('button', { name: 'Seal and verify', exact: true }).waitFor({ state: 'visible' }); }
      await release(page);
      assert.equal(downloads.length, 0, 'Old evidence must not download');
      assert.equal(await page.locator('#result-heading').count(), 0, 'Old result must stay cleared');
    });
  }
  await check('converted JSON exports actual PDF and flat original-source ZIP bytes/hash', async ({ page }) => {
    const original = Buffer.from(JSON.stringify([{ timestamp_us: '1000', latitude_deg: 41, longitude_deg: -87 }, { timestamp_us: '2000', latitude_deg: 41.01, longitude_deg: -87 }]));
    await page.getByLabel('Choose source or sealed log').setInputFiles({ name: 'lifecycle-source.json', mimeType: 'application/json', buffer: original });
    await page.getByRole('button', { name: 'Seal and verify', exact: true }).click();
    await page.locator('#result-heading').filter({ hasText: 'Intact' }).waitFor();
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Reports', exact: true }).click();
    const [pdfDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF', exact: true }).click()]);
    const pdf = await bytes(pdfDownload); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok((await PDFDocument.load(pdf)).getPageCount() > 0);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Workbench', exact: true }).click();
    const [zipDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export bundle', exact: true }).click()]);
    const files = zipEntries(await bytes(zipDownload));
    assert.equal(files.has('verified-log.fseal'), true, 'ZIP must contain actual sealed bytes');
    assert.equal(Buffer.compare(files.get('original-source-lifecycle-source.json'), original), 0, 'Original source bytes must be preserved');
    assert.equal(JSON.parse(files.get('verification-report.json')).source.sha256, createHash('sha256').update(original).digest('hex'), 'Report must carry the actual whole-source hash');
  });
  for (const kind of ['encrypt', 'backupfile', 'decrypt']) await check(`held real backup ${kind} cannot export or stage plaintext after server logout`, async ({ page, downloads }) => {
    await backupPanel(page);
    if (kind !== 'encrypt') await page.locator('#backup-file').setInputFiles({ name: 'lifecycle-backup.json', mimeType: 'application/json', buffer: backupBytes });
    await arm(page, kind);
    await page.getByRole('button', { name: kind === 'encrypt' ? 'Download encrypted backup' : 'Check backup and preview', exact: true }).click();
    await held(page); await serverLogout(page, kind === 'decrypt'); await release(page);
    assert.equal(downloads.length, 0, 'Old backup must not download');
    assert.equal(await page.locator('#backup-passphrase').inputValue(), '', 'Backup passphrase must be cleared');
    assert.equal(await page.getByRole('button', { name: 'Restore this profile', exact: true }).count(), 0, 'Old plaintext preview must not return');
    assert.equal(await page.locator('#backup-file').evaluate(input => input.files.length), 0);
  }, { localProfile: true });
  await check('staged backup and real queued Web Lock commit are canceled by server logout', async ({ page }) => {
    await stageBackup(page);
    const before = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    await page.evaluate(() => { window.__lockHeld = false; window.__lock = navigator.locks.request('flightseal:profile-registry', () => new Promise(resolve => { window.__unlock = resolve; window.__lockHeld = true; })); });
    await page.waitForFunction(() => window.__lockHeld);
    await page.getByRole('button', { name: 'Restore this profile', exact: true }).click();
    await page.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'flightseal:profile-registry'));
    await serverLogout(page);
    await page.evaluate(async () => { window.__unlock(); await window.__lock; }); await settle(page);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage })), before, 'Canceled queued restore must not change browser storage');
    assert.equal(await page.locator('#backup-passphrase').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: 'Restore this profile', exact: true }).count(), 0);
  }, { localProfile: true });
  await check('real encrypted export/decrypt/restore happy paths remain functional', async ({ page }) => {
    await backupPanel(page);
    const [output] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download encrypted backup', exact: true }).click()]);
    const payload = await inspectEncryptedProfileBackup(new Blob([await bytes(output)]), passphrase, { cryptoObject: webcrypto });
    assert.equal(payload.profile.id, profile.id, 'Encrypted download must contain the actual selected local profile');
    await page.locator('#backup-file').setInputFiles({ name: 'lifecycle-backup.json', mimeType: 'application/json', buffer: backupBytes });
    await page.getByRole('button', { name: 'Check backup and preview', exact: true }).click();
    await page.getByRole('button', { name: 'Restore this profile', exact: true }).click();
    await page.getByText(/Restored local profile lifecycle-restore@example.test/).waitFor();
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).profiles.length, localAuthStorageKeys.profile), 2, 'Actual restore must commit exactly one new profile');
  }, { localProfile: true });
  await check('server logout clears feedback fields and CSV staged source/file inputs', async ({ page }) => {
    await page.getByLabel('Choose source or sealed log').setInputFiles({ name: 'lifecycle-source.csv', mimeType: 'text/csv', buffer: Buffer.from('timestamp_us,private_note\n1000,fixture\n') });
    await page.getByRole('button', { name: 'Cancel mapping', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Report a bug', exact: true }).first().click();
    await page.locator('#feedback-description').fill('Synthetic private feedback sentinel');
    await page.locator('#feedback-steps').fill('Synthetic private steps sentinel');
    await serverLogout(page);
    assert.equal(await page.locator('#feedback-description').inputValue(), '');
    assert.equal(await page.locator('#feedback-steps').inputValue(), '');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Cancel mapping', exact: true }).count(), 0);
    assert.equal(await page.locator('input[type=file]').evaluateAll(inputs => inputs.every(input => input.files.length === 0)), true);
  });
  await check('server logout keeps unsaved sealed output in this tab for one download, then clears it', async ({ page, downloads }) => {
    await page.getByLabel('Choose source or sealed log').setInputFiles({ name: 'kept-source.tsv', mimeType: 'text/plain', buffer: Buffer.from('1000\tkept source\n2000\tkept source\n') });
    await page.getByRole('button', { name: 'Seal and verify', exact: true }).click();
    await page.locator('.seal-outputs').waitFor();
    await serverLogout(page);
    const notice = page.locator('.rescue-notice');
    await notice.getByText('Your workspace session ended. This tab kept work that was not saved yet.').waitFor();
    assert.equal(await page.locator('.seal-outputs').count(), 0, 'the old output is cleared from the workspace');
    const before = downloads.length;
    await notice.getByRole('button', { name: 'Download unsaved work', exact: true }).click();
    await notice.getByRole('button', { name: 'I saved it', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.rescue-notice'));
    assert.equal(downloads.length, before + 1);
    assert.equal(downloads.at(-1).suggestedFilename(), 'hashwing-unsaved-work.zip');
    const zip = Buffer.from(await bytes(downloads.at(-1))).toString('latin1');
    for (const name of ['sealed.fseal', 'sealed.receipts', 'sealed-public-key.txt']) assert.ok(zip.includes(name), 'zip has ' + name);
  });
  await check('held real native-share capability outcome under denied policy cannot initiate old clipboard fallback after logout', async ({ page }) => {
    await uploadVerified(page); await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Reports', exact: true }).click(); await page.getByRole('button', { name: 'Share summary', exact: true }).first().click();
    assert.equal(await page.evaluate(() => document.featurePolicy.allowsFeature('web-share')), false, 'Controlled browser policy must deny native sharing');
    assert.equal(await page.evaluate(() => window.__privateLifecycle.shareInstrumented), true, 'Authentic native-share outcome must be instrumented');
    await arm(page, 'share'); await page.getByRole('button', { name: 'Share…', exact: true }).click();
    await held(page); await serverLogout(page); await release(page);
    assert.equal(await page.evaluate(() => window.__privateLifecycle.copies), 0, 'Rejected old share must not initiate clipboard fallback');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('#share-summary').inputValue(), '', 'Old share summary must not survive reset');
  }, { instrumentShare: true });
} finally {
  await browser?.close(); await releaseBrowserLock(lock);
  const report = { checks: results, pageErrors, passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length,
    scope: 'Real WebCrypto, Blob, Web Locks, Wasm verifier and generated PDF/ZIP outputs. Native-share outcome timing instrumented under intentionally denied web-share Permissions-Policy; related policy diagnostics are intentional, not normal-flow zero-console-error evidence. No operating-system share-sheet claim. No private fixtures, keys, passphrases or browser source contents retained in evidence.' };
  writeFileSync(resolve(OUT, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, pageErrors: pageErrors.length }));
  if (!results.length || report.failed || pageErrors.length) process.exitCode = 1;
}

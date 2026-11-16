import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../tests/web/serve.mjs';
import { acquireBrowserLock, releaseBrowserLock } from '../../tests/web/browser-lock.mjs';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EVIDENCE = process.env.HASHWING_PROFILE_EVIDENCE || join(ROOT, '.test-artifacts', 'profiles');
const ONLY = process.env.HASHWING_PROFILE_ONLY || '';
mkdirSync(EVIDENCE, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const lock = await acquireBrowserLock();
const { server, url: rootUrl } = await serve(0, '/flightseal');
const url = `${rootUrl}console/`;
const results = [];
const errors = [];
let browser;

async function check(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  try { await fn(); results.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (cause) { results.push({ name, passed: false, error: String(cause?.stack || cause) }); console.error(`FAIL ${name}: ${cause?.message || cause}`); }
}
async function waitResult(page) {
  try { await page.waitForFunction(() => document.querySelector('.result-stat')?.textContent.replaceAll(',', '').includes('800') || document.querySelector('.session-result-name')?.textContent.includes('800-record included demo'), null, { timeout: 30000 }); }
  catch { throw new Error(`expected included sample result; hash=${await page.evaluate(() => location.hash)}; ${(await page.locator('body').innerText()).slice(0, 1200)}`); }
}
async function login(page, email, password = 'pilot password safe 42') {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}
async function signup(page, email, password = 'pilot password safe 42', importGuest = false) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  const importBox = page.getByLabel(/Import this guest session/);
  if (await importBox.count()) await importBox.setChecked(importGuest);
  await page.getByRole('button', { name: 'Create account' }).last().click();
}
async function logout(page) {
  const menu = page.locator('.profile-menu');
  if (!(await menu.locator('summary').evaluate((node) => node.parentElement.open))) await menu.locator('summary').click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/');
}
async function assertNoOverflow(page, label) {
  const { viewport, document } = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(document <= viewport, `${label} horizontal overflow: ${document} > ${viewport}`);
}
async function axe(page, label) {
  await page.evaluate(AXE);
  const result = await page.evaluate(() => window.axe.run(document));
  results.push({ name: `axe ${label}`, passed: result.violations.length === 0, violations: result.violations.map((item) => ({ id: item.id, impact: item.impact, targets: item.nodes.map((node) => node.target) })), incomplete: result.incomplete.map((item) => item.id) });
  assert.equal(result.violations.length, 0, `${label}: ${result.violations.map((item) => `${item.id} ${item.impact}`).join(', ')}`);
}

try {
  const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (cause) => errors.push(`pageerror ${cause}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console ${message.text()}`); });
  page.on('requestfailed', (request) => { if (['script', 'stylesheet', 'image', 'font'].includes(request.resourceType()) && !request.failure()?.errorText?.includes('ERR_ABORTED')) errors.push(`asset ${request.url()}`); });

  await check('landing menus, live preview controls, reduced motion and mobile navigation', async () => {
    await page.goto(url);
    assert.match(await page.locator('#page-landing').innerText(), /Check the log/);
    assert.equal(await page.getByRole('link', { name: 'Pricing' }).count(), 0);
    await assertNoOverflow(page, 'landing desktop');
    await axe(page, 'landing 1440x900');
    const initialPreview = await page.locator('.preview-controls [aria-pressed="true"]').innerText();
    await page.waitForFunction((before) => document.querySelector('.preview-controls [aria-pressed="true"]')?.textContent !== before, initialPreview, { timeout: 7500 });
    const features = page.getByRole('button', { name: 'Features' });
    await features.click();
    const panel = page.locator('#mega-features');
    await panel.getByRole('link', { name: /Verify a log/ }).hover();
    assert.equal(await panel.isVisible(), true, 'pointer movement into menu keeps it open');
    await page.keyboard.press('Escape');
    assert.equal(await features.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Features');
    await features.focus(); await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.textContent.includes('Verify a log'));
    assert.match(await page.evaluate(() => document.activeElement.innerText), /Verify a log/);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show First failure preview' }).click();
    await page.getByRole('button', { name: 'Pause previews' }).click();
    await page.locator('.landing-hero-copy h1').click();
    await page.mouse.move(10, 850);
    await assert.rejects(page.waitForFunction(() => document.querySelector('.preview-controls [aria-pressed="true"]')?.textContent !== 'First failure', null, { timeout: 6500 }), /Timeout/);
    assert.equal(await page.getByRole('button', { name: 'Show First failure preview' }).getAttribute('aria-pressed'), 'true');
    await page.screenshot({ path: join(EVIDENCE, 'landing-1440x900.png'), fullPage: true });
    const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    const mobile = await mobileContext.newPage(); await mobile.goto(url);
    await assertNoOverflow(mobile, 'landing mobile'); await axe(mobile, 'landing 375x812');
    assert.equal(await mobile.getByRole('button', { name: 'Autoplay disabled by reduced motion' }).isDisabled(), true);
    await mobile.getByRole('button', { name: 'Menu' }).click();
    await mobile.getByRole('button', { name: 'Trust / Docs' }).click();
    assert.equal(await mobile.getByRole('link', { name: /Trust boundaries/ }).isVisible(), true);
    await mobile.screenshot({ path: join(EVIDENCE, 'landing-375x812.png'), fullPage: true });
    await mobileContext.close();
  });

  await check('guest import is explicit and profile A restores only its own saved view', async () => {
    await page.goto(url);
    await page.getByRole('button', { name: /Try Live Demo/ }).last().click(); await waitResult(page);
    await page.locator('.profile-menu summary').click();
    await page.getByRole('button', { name: 'Create local account' }).click();
    const importBox = page.getByLabel(/Import this guest session/);
    assert.equal(await importBox.isChecked(), false);
    await signup(page, 'pilot@example.test', 'pilot password safe 42', true); await waitResult(page);
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Records' }).click();
    await page.locator('.pagination').getByRole('button', { name: 'First' }).click();
    await page.locator('.record-list li').nth(24).getByRole('button').click();
    await page.locator('.profile-menu summary').click();
    await page.getByRole('button', { name: 'Save included-sample view' }).click();
    await page.waitForFunction(() => document.querySelector('.profile-menu-message')?.textContent.includes('saved'));
    const storage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));
    const savedKey = Object.keys(storage).find((key) => key.startsWith('flightseal_user_') && key.endsWith('_workspace_v1'));
    assert.ok(savedKey);
    const saved = JSON.parse(storage[savedKey]);
    assert.deepEqual({ screen: saved.screen, sample: saved.sample, record: saved.record }, { screen: 'records', sample: 'intact', record: 24 });
    assert.equal(JSON.stringify(storage).includes('flight.fseal'), false);
    assert.equal(JSON.stringify(storage).includes('public-key.txt'), false);
    assert.equal(JSON.stringify(storage).includes('pilot password safe 42'), false);
    await logout(page);
    await page.locator('.landing-navigation').getByRole('link', { name: 'Log in' }).click(); await login(page, 'pilot@example.test');
    await page.waitForFunction(() => location.hash === '#/app/records?sample=intact&record=24', null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 24', null, { timeout: 30000 });
    await waitResult(page);
    await logout(page);
    await page.locator('.landing-navigation').getByRole('link', { name: 'Log in' }).click(); await login(page, 'pilot@example.test', 'wrong password 1234');
    assert.match(await page.getByRole('alert').innerText(), /does not match/);
    await page.getByRole('link', { name: 'Create account' }).click();
    await signup(page, 'pilot@example.test');
    assert.match(await page.getByRole('alert').innerText(), /already uses/);
    await page.getByLabel('Email').fill('reviewer@example.test');
    await page.getByLabel('Password', { exact: true }).fill('reviewer password safe 42');
    await page.getByLabel('Confirm password').fill('reviewer password safe 42');
    await page.getByRole('button', { name: 'Create account' }).last().click();
    await page.waitForFunction(() => location.hash.startsWith('#/app/sandbox'));
    await page.locator('.profile-menu summary').click();
    assert.equal(await page.getByRole('button', { name: /Restore saved view/ }).isDisabled(), true, 'profile B has no access to profile A view');
    const registry = await page.evaluate(() => localStorage.getItem('flightseal_profiles_v1'));
    assert.equal(registry.includes('pilot password safe 42'), false);
    assert.equal(registry.includes('reviewer password safe 42'), false);
    await logout(page);
    await page.locator('.landing-navigation').getByRole('link', { name: 'Log in' }).click(); await login(page, 'pilot@example.test');
    await page.waitForFunction(() => location.hash === '#/app/records?sample=intact&record=24');
    await page.waitForFunction(() => document.querySelector('#record-detail-title')?.textContent === 'Record 24', null, { timeout: 30000 });
    await page.screenshot({ path: join(EVIDENCE, 'saved-view-restored-1440x900.png'), fullPage: true });
  });

  await check('legacy routes, malicious return destination, browser storage failure, malformed registry and mobile auth', async () => {
    await page.goto(`${url}#/receipts?sample=intact&record=19`);
    await page.waitForSelector('.receipt-overview');
    assert.equal(await page.locator('.commandbar h1').innerText(), 'Receipts');
    assert.equal(new URL(page.url()).search, ''); assert.match(await page.evaluate(() => location.hash), /sample=intact&record=19/); await assertNoOverflow(page, 'legacy receipts route');
    await page.goto(url); await page.locator('.landing-navigation').getByRole('link', { name: 'Create account' }).click();
    await signup(page, 'route@example.test', 'route password safe 42');
    await page.waitForFunction(() => location.hash.startsWith('#/app/sandbox'));
    await logout(page);
    await page.goto(`${url}#/login?returnTo=${encodeURIComponent('https://evil.example')}`);
    await login(page, 'route@example.test', 'route password safe 42');
    await page.waitForFunction(() => location.hash === '#/app/sandbox');
    await logout(page);
    await page.goto(`${url}#/signup`);
    await page.evaluate(() => { window.__setItemDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem'); Object.defineProperty(Storage.prototype, 'setItem', { ...window.__setItemDescriptor, value() { throw new DOMException('quota', 'QuotaExceededError'); } }); });
    await signup(page, 'quota@example.test', 'quota password safe 42');
    assert.match(await page.getByRole('alert').innerText(), /could not save the local profile/i);
    await page.evaluate(() => { Object.defineProperty(Storage.prototype, 'setItem', window.__setItemDescriptor); delete window.__setItemDescriptor; localStorage.setItem('flightseal_profiles_v1', '{broken'); });
    await page.goto(`${url}#/login`); await login(page, 'pilot@example.test');
    assert.match(await page.getByRole('alert').innerText(), /unreadable/);
    const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    const mobile = await mobileContext.newPage(); await mobile.goto(`${url}#/signup`);
    await assertNoOverflow(mobile, 'signup mobile'); await axe(mobile, 'signup 375x812');
    await mobile.screenshot({ path: join(EVIDENCE, 'signup-375x812.png'), fullPage: true });
    await mobileContext.close();
  });

  await check('cross-tab logout clears active profile state', async () => {
    const cancelContext = await browser.newContext({ serviceWorkers: 'block' });
    const pendingPage = await cancelContext.newPage();
    await pendingPage.goto(url); await pendingPage.locator('.landing-navigation').getByRole('link', { name: 'Create account' }).click();
    await signup(pendingPage, 'tabs@example.test', 'tabs password safe 42');
    await pendingPage.waitForFunction(() => location.hash.startsWith('#/app/sandbox'));
    const secondTab = await cancelContext.newPage(); await secondTab.goto(`${url}#/login`); await login(secondTab, 'tabs@example.test', 'tabs password safe 42');
    await secondTab.waitForFunction(() => location.hash.startsWith('#/app/sandbox'));
    await pendingPage.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Samples' }).click();
    let releaseFull;
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const delayed = new Promise((resolve) => { releaseFull = resolve; });
    await pendingPage.route('**/flightseal/samples/px4-full.fseal', async (request) => { console.log('cross-tab test intercepted full sample request'); startedResolve(); await delayed; try { await request.continue(); } catch {} });
    await pendingPage.getByRole('button', { name: /Load full PX4 sample/ }).click();
    let timeout;
    try {
      await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The service-worker-free cancellation test did not intercept the full-sample request within 30 seconds.')), 30000); })]);
    } finally { clearTimeout(timeout); }
    await logout(secondTab);
    console.log('cross-tab test logged out the other tab while loading');
    releaseFull();
    await pendingPage.waitForFunction(() => location.hash === '#/');
    assert.equal(await secondTab.locator('.profile-menu').count(), 0);
    assert.equal(await pendingPage.locator('#result-heading').count(), 0, 'logout invalidates pending full-sample verification');
    await secondTab.close();
    await cancelContext.close();
  });

  if (errors.length) results.push({ name: 'unexpected browser errors', passed: false, errors });
  else results.push({ name: 'zero browser runtime and asset errors', passed: true });
  const report = { url, viewports: [[1440, 900], [375, 812]], results, errors };
  writeFileSync(join(EVIDENCE, 'profile-browser.json'), JSON.stringify(report, null, 2));
  console.log(`\n${results.filter((result) => result.passed).length}/${results.length} profile browser checks passed; ${errors.length} browser errors`);
  if (results.some((result) => !result.passed) || errors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await releaseBrowserLock(lock);
}

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.HASHWING_BASE_URL || 'http://127.0.0.1:3001';
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
after(() => browser.close());
const result = (page, verdict) => page.locator('#result-heading').filter({ hasText: verdict }).waitFor();

test('keyboard mutations restore their control without overriding an intentional focus move', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    for (const [width, action] of [[320, 'Flip one payload byte'], [768, 'Remove one middle record'], [1440, 'Trim seven tail bytes']]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(base + '/workbench?sample=intact');
      await result(page, 'Intact');
      const control = page.getByRole('button', { name: action, exact: true });
      await control.focus();
      await page.keyboard.press('Space');
      await result(page, 'Tampered');
      await page.waitForTimeout(700);
      assert.equal(await control.evaluate((button) => document.activeElement === button), true, `${action}: focus must return after the real mutation`);
    }
    await page.goto(base + '/workbench?sample=intact');
    await result(page, 'Intact');
    // Delay loading the real native worker so keyboard navigation can happen during verification.
    await page.route('**/assets/worker-*.js', async (request) => { await new Promise((resolve) => setTimeout(resolve, 500)); await request.continue(); });
    const control = page.getByRole('button', { name: 'Flip one payload byte', exact: true });
    await control.focus();
    await page.keyboard.press('Space');
    await page.locator('.busy-card').waitFor();
    const other = page.getByRole('navigation', {name:'Primary navigation'}).getByRole('link', {name:'Reports',exact:true});
    await other.focus();
    await result(page, 'Tampered');
    await page.waitForTimeout(700);
    assert.equal(await other.evaluate((button) => document.activeElement === button), true, 'Verification must not steal focus back from another control');
    await page.unroute('**/assets/worker-*.js');
    await page.goto(base + '/workbench?sample=intact');
    await result(page, 'Intact');
    await page.route('**/assets/worker-*.js', (request) => request.abort('failed'));
    await control.focus();
    await page.keyboard.press('Space');
    await page.getByRole('alert').filter({ hasText: 'WebAssembly worker could not run' }).waitFor();
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'page-sandbox', 'A failed check must focus the existing page heading when its initiating control stays disabled');
  } finally { await context.close(); }
});

test('root-hosted offline preparation serves all exact routes and the real sample without HTML API fallback', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const messages = [];
  const failedAssets = [];
  page.on('requestfailed', (request) => { if (['font', 'script', 'stylesheet', 'image'].includes(request.resourceType())) failedAssets.push(new URL(request.url()).pathname); });
  await page.exposeFunction('recordWorkerMessage', (data) => messages.push(data));
  await page.addInitScript(() => navigator.serviceWorker.addEventListener('message', (event) => window.recordWorkerMessage(event.data)));
  try {
    await page.goto(base + '/workbench?sample=intact');
    await result(page, 'Intact');
    await page.goto(base + '/settings');
    await page.locator('.install-tools > summary').click();
    await page.waitForFunction(() => /ready on this device|could not|unavailable|incomplete/.test(document.querySelector('.offline-note')?.textContent || ''), null, { timeout: 30000 });
    assert.match(await page.locator('.offline-note').innerText(), /ready on this device/, JSON.stringify(messages));
    assert.equal(await page.evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).pathname), '/sw.js');
    await page.getByRole('button', { name: 'Prepare offline', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.offline-note')?.textContent.includes('ready on this device'), null, { timeout: 30000 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await context.setOffline(true);
    for (const [path, title] of [['/overview','Overview'], ['/workbench?sample=intact','Workbench'], ['/reports','Reports'], ['/settings','Settings']]) {
      await page.goto(base + path);
      await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
      await page.reload();
      await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (path.includes('sample=')) await result(page, 'Intact');
    }
    await page.goto(base + '/workbench?sample=intact');
    await result(page, 'Intact');
    await page.getByRole('button', { name: 'Flip one payload byte', exact: true }).click();
    await result(page, 'Tampered');
    const unknown = await page.evaluate(async () => {
      try { const response = await fetch('/api/missing'); return { type: response.headers.get('content-type'), status: response.status }; }
      catch { return { failed: true }; }
    });
    assert.deepEqual(unknown, { failed: true }, 'Unknown offline APIs must remain failures, never the app HTML');
    assert.deepEqual(failedAssets, [], 'Prepared public interface assets must remain available offline');
  } finally { await context.setOffline(false); await context.close(); }
});

test('root-hosted waiting update respects unacknowledged native output before activation', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(base + '/workbench?sample=intact');
    await result(page, 'Intact');
    await page.goto(base + '/settings');
    await page.locator('.install-tools > summary').click();
    await page.waitForFunction(() => document.querySelector('.offline-note')?.textContent.includes('ready on this device'), null, { timeout: 30000 });
    await page.goto(base + '/workbench');
    await page.getByLabel('Choose source or sealed log').setInputFiles({ name: 'update-fixture.tsv', mimeType: 'text/plain', buffer: Buffer.from('1\tfirst\n2\tsecond\n') });
    await page.getByRole('button', { name: 'Seal and verify', exact: true }).click();
    await result(page, 'Intact');
    const acknowledgement = page.getByRole('checkbox', { name: 'I saved these files or no longer need them' });
    await acknowledgement.waitFor();
    assert.equal(await acknowledgement.isChecked(), false);
    // A distinct script URL installs the real worker as a waiting revision without changing its policy.
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js?waiting-regression=1', { scope: '/' }));
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.waiting, null, { timeout: 30000 });
    await page.getByRole('navigation',{name:'Primary navigation'}).getByRole('link',{name:'Settings',exact:true}).click();
    await page.locator('.install-tools > summary').click();
    await page.getByRole('button', { name: 'Apply safe update', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.offline-note')?.textContent.includes('Update deferred'), null, { timeout: 10000 }).catch(async () => {
      assert.fail(JSON.stringify(await page.evaluate(async () => ({
        waiting: !!(await navigator.serviceWorker.getRegistration('/'))?.waiting,
        controller: navigator.serviceWorker.controller?.scriptURL,
        acknowledged: document.querySelector('.output-ack input')?.checked,
        status: document.querySelector('.offline-note')?.textContent,
      }))));
    });
    await page.getByRole('navigation',{name:'Primary navigation'}).getByRole('link',{name:'Workbench',exact:true}).click();
    assert.equal(await acknowledgement.isChecked(), false);
    await acknowledgement.check();
    await page.getByRole('navigation',{name:'Primary navigation'}).getByRole('link',{name:'Settings',exact:true}).click();
    await page.locator('.install-tools > summary').click();
    await page.getByRole('button', { name: 'Apply safe update', exact: true }).click();
    await page.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration('/'))?.waiting, null, { timeout: 10000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('waiting-regression=1'), null, { timeout: 10000 });
    await page.getByRole('button', { name: 'Apply safe update', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('navigation',{name:'Primary navigation'}).getByRole('link',{name:'Workbench',exact:true}).click();
    await page.getByRole('button', { name: 'Download sealed file', exact: true }).waitFor();
  } finally { await context.close(); }
});

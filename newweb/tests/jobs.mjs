// Jobs and "Sealed on this device" on the flag-off (Pages) console, in Chrome against the built docs/console:
// seal a small file and a large-file set, find them on Jobs, search and page through them with the URL and Back,
// Resume (bytes held, and not held behind the one question), Export (metadata and receipt only), Remove (Keep it
// focused), empty and no-match states, owner scoping across a profile switch (AC-57), no registry request or outbox
// database (AC-02, AC-60), memory-only storage, one primary per step, axe and no horizontal scroll at 320/390/768/1440.
// Run after `npm --prefix newweb run build`.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, openSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from '../../tests/web/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(process.env.REACT_CONSOLE_EVIDENCE || join(ROOT, '.test-artifacts'), 'jobs');
mkdirSync(EVIDENCE, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { server, url: rootUrl } = await serve(0, '/flightseal');
const url = `${rootUrl}console/`;
const origin = new URL(url).origin;
const checks = [];
const runtimeErrors = [];
const foreign = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
const frame = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
async function layout(page, label, widths = [320, 390, 768, 1440]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await frame(page);
    const d = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(d.doc <= d.client + 1, `${label} ${width}px horizontal scroll: ${JSON.stringify(d)}`);
    await page.evaluate(AXE);
    const results = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
    assert.equal(results.violations.length, 0, `${label} ${width}px: ${results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`).join(' | ')}`);
    await page.screenshot({ path: join(EVIDENCE, `${label.replace(/\W+/g, '-')}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const go = async (page, screen, query = '') => {
  await page.evaluate(([s, q]) => { location.hash = `/app/${s}${q}`; }, [screen, query]);
  await page.locator(`#page-${screen}`).waitFor();
};
const smallFile = { name: 'flight-12.ulg', mimeType: 'application/octet-stream', buffer: Buffer.concat([Buffer.from('SMALL-FILE-MARKER-'), randomBytes(4000)]) };
async function sealSmall(page, ref) {
  await go(page, 'protect');
  await page.getByLabel(/^Small file/).check();
  await page.locator('#job-ref').fill(ref);
  await page.locator('#protect-file').setInputFiles(smallFile);
  await page.getByRole('button', { name: 'Seal this file' }).click();
  await page.locator('#handover-text').waitFor({ timeout: 60000 });
}
async function sealLarge(page, ref) {
  await go(page, 'protect');
  await page.getByLabel(/^Large files/).check();
  await page.locator('#job-ref').fill(ref);
  await page.locator('#manifest-files').setInputFiles([{ name: 'roof-1.mp4', mimeType: 'video/mp4', buffer: randomBytes(20000) }, { name: 'roof-2.mp4', mimeType: 'video/mp4', buffer: randomBytes(30000) }]);
  await page.getByRole('button', { name: 'Seal the list' }).click();
  await page.locator('#manifest-handover-text').waitFor({ timeout: 60000 });
}
const primaries = (page) => page.locator('#main .button.primary:visible').allInnerTexts();
const tableNames = (page) => page.locator('.jobs-table tbody .jobs-name').allInnerTexts();
const dbNames = (page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
// Seed rows straight into this browser's guest jobs database, as the app would have written them.
async function seed(page, n) {
  await page.evaluate(async (count) => {
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('guest')))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const db = await new Promise((ok, no) => { const r = indexedDB.open(`hashwing-jobs-v1-${hex}`, 1); r.onupgradeneeded = () => r.result.createObjectStore('jobs', { keyPath: 'id' }); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const tx = db.transaction('jobs', 'readwrite');
    for (let i = 0; i < count; i++) tx.objectStore('jobs').put({ id: `seed-${i}`, jobRef: `S-${String(i).padStart(3, '0')}`, name: `seeded-${i}.ulg.fseal`, mode: 'small', items: 1, bytes: 100 + i, receipt: 'HashWing receipt\nfseal-receipt v1\n', sealedAt: Date.UTC(2026, 0, 1) + i * 60000 });
    await new Promise((ok) => { tx.oncomplete = ok; });
    db.close();
  }, n);
}

let browser;
try {
  const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  context.on('request', (r) => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(origin)) foreign.push(u); });
  const page = await context.newPage();
  page.on('pageerror', (e) => runtimeErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') runtimeErrors.push(m.text()); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });

  await check('nav: Seal & send, Verify, Jobs, Trust; Jobs empty state and the compact list\'s empty state', async () => {
    await page.goto(`${url}#/app/jobs`);
    await page.locator('#page-jobs').waitFor();
    assert.equal(await page.locator('#page-jobs').innerText(), 'Jobs');
    const rail = page.getByRole('navigation', { name: 'Primary navigation' });
    assert.deepEqual(await rail.locator('a:visible').allTextContents(), ['Seal & send', 'Verify', 'Jobs', 'Trust']);
    assert.equal(await rail.getByRole('link', { name: 'Jobs', exact: true }).getAttribute('aria-current'), 'page');
    const main = await page.locator('#main').innerText();
    for (const s of ['Saved in this browser only. Not a cloud copy.', "Kept until you remove it or clear this browser's data.", 'Nothing sealed in this browser yet.']) assert.ok(main.includes(s), s);
    assert.equal(await page.locator('.session-strip').isVisible(), false, 'no workbench strip on Jobs');
    assert.deepEqual(await primaries(page), [], 'Jobs is a list screen: no primary button');
    await layout(page, 'jobs empty', [320, 1440]);
    await page.locator('.jobs-empty').getByRole('link', { name: 'Seal files' }).click();
    await page.locator('#page-protect').waitFor();
    assert.match(await page.locator('.jobs-recent').innerText(), /Sealed on this device[\s\S]*Nothing sealed on this device yet\.[\s\S]*All jobs/);
  });

  let exported;
  await check('sealing a small file and a large-file set adds rows to the compact list and to Jobs', async () => {
    await sealSmall(page, 'J-1042');
    const recent = page.locator('.jobs-recent');
    await recent.getByText('flight-12.ulg.fseal').waitFor();
    assert.match(await recent.innerText(), /flight-12\.ulg\.fseal\s*Sealed locally/);
    assert.deepEqual(await primaries(page), ['Download'], 'one primary after sealing');
    await page.getByRole('button', { name: 'Seal more files' }).click();
    await page.locator('.confirm-box').getByRole('button', { name: 'Discard it' }).click();
    await sealLarge(page, ''); // no job reference: the 320px check below needs an empty job-ref cell
    await recent.locator('li').nth(1).waitFor();
    const names = await recent.locator('.jobs-name').allInnerTexts();
    assert.equal(names.length, 2);
    assert.match(names[0], /^hashwing-\d{8}-\d{6}\.manifest\.fseal$/, 'newest first');
    assert.equal(names[1], 'flight-12.ulg.fseal');
    await layout(page, 'protect after sealing with list', [320, 1440]);
    await recent.getByRole('link', { name: 'All jobs' }).click();
    await page.locator('#page-jobs').waitFor();
    assert.equal((await tableNames(page)).length, 2);
    assert.equal(await page.locator('.jobs-table caption').innerText(), 'Showing 1–2 of 2');
    assert.deepEqual(await page.locator('.jobs-table thead th').allInnerTexts(), ['Job ref', 'Package', 'Status', 'Sealed', 'Actions']);
    assert.deepEqual(await page.locator('.jobs-table tbody td:nth-child(3)').allInnerTexts(), ['Sealed locally', 'Sealed locally'], 'flag off: Sealed locally only');
    assert.equal(await page.getByLabel(/Status/).count(), 0, 'flag off: no status filter');
    await layout(page, 'jobs list', [320, 390, 768, 1440]);
    await page.setViewportSize({ width: 320, height: 900 }); await frame(page);
    const orders = await page.locator('.jobs-table tbody tr').evaluateAll((trs) => trs.map((tr) => ['.jobs-name', '.jobs-ref', '.jobs-status', '.jobs-when', '.jobs-actions'].map((c) => tr.querySelector(c)).filter((el) => !el.classList.contains('jobs-ref-empty')).map((el) => el.getBoundingClientRect().top)));
    assert.ok(orders.some((o) => o.length === 5), 'at least one row has a job reference');
    for (const order of orders) assert.deepEqual([...order].sort((x, y) => x - y), order, `320px, every row: package, job ref, status, time, actions (${order})`);
    const empty = page.locator('.jobs-table .jobs-ref-empty');
    assert.ok(await empty.count(), 'the list has a job without a job reference');
    assert.deepEqual(await empty.evaluateAll((cells) => cells.map((c) => [getComputedStyle(c).display !== 'none', c.getBoundingClientRect().height <= 1, c.parentElement.cells.length])), (await empty.evaluateAll((c) => c.map(() => [true, true, 5]))), '320px: an empty job ref is hidden visually but stays a cell, so screen readers keep five cells under five headers');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('Export downloads the metadata and receipt message only', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export flight-12.ulg.fseal' }).click()]);
    assert.equal(dl.suggestedFilename(), 'hashwing-job-J-1042.json');
    const text = readFileSync(await dl.path(), 'utf8');
    exported = JSON.parse(text);
    assert.deepEqual(Object.keys(exported), ['format', 'jobRef', 'package', 'mode', 'items', 'bytes', 'sealedAt', 'receiptMessage']);
    assert.equal(exported.package, 'flight-12.ulg.fseal');
    assert.equal(exported.mode, 'small');
    assert.equal(exported.bytes, smallFile.buffer.length);
    assert.match(exported.receiptMessage, /fseal-receipt v1/);
    assert.ok(!text.includes('SMALL-FILE-MARKER') && !text.includes(smallFile.buffer.subarray(18, 60).toString('base64').slice(0, 40)), 'no file bytes');
    assert.ok(!/PRIVATE KEY/.test(text));
  });

  await check('Resume: the held list downloads; another job asks the one question first, then says the file was not kept', async () => {
    await page.getByRole('button', { name: /^Resume hashwing-/ }).click();
    await page.locator('#manifest-handover-text').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Download sealed list' }).count(), 1, 'held: Download is offered');
    await page.waitForFunction(() => document.activeElement?.id === 'manifest-handoff-title');
    await go(page, 'jobs');
    await page.getByRole('button', { name: 'Resume flight-12.ulg.fseal' }).click();
    await page.locator('#seal-more-ask').waitFor();
    assert.match(await page.locator('#seal-more-ask').innerText(), /^You haven't downloaded hashwing-\d{8}-\d{6}\.manifest\.fseal\. Download it first\?/);
    await page.waitForFunction(() => document.activeElement?.id === 'seal-more-ask-action');
    assert.deepEqual(await primaries(page), ['Download'], 'one primary while the question is open');
    await page.locator('.confirm-box').getByRole('button', { name: 'Keep it' }).click();
    assert.equal(await page.locator('#manifest-handover-text').count(), 1, 'Keep it keeps the list');
    await go(page, 'jobs');
    await page.getByRole('button', { name: 'Resume flight-12.ulg.fseal' }).click();
    await page.locator('.confirm-box').getByRole('button', { name: 'Discard it' }).click();
    await page.locator('#resumed-handover-text').waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'resumed-handoff-title');
    assert.equal(await page.locator('.jobs-not-held').innerText(), "HashWing didn't keep a copy of flight-12.ulg.fseal. Use the copy you downloaded when you sealed it.");
    assert.equal(await page.getByText('It holds your original file, byte for byte.').count(), 0, 'no claim about a file that is not here');
    assert.equal(await page.getByRole('button', { name: 'Download sealed file' }).count(), 0, 'not held: no Download');
    assert.equal(await page.locator('#resumed-handover-text').inputValue(), exported.receiptMessage);
    assert.match(await page.locator('.seal-summary').innerText(), /^Sealed · 1 file · J-1042$/);
    assert.deepEqual(await primaries(page), ['Copy message']);
    await page.getByRole('button', { name: 'Copy message' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exported.receiptMessage);
    await layout(page, 'resumed not held', [320, 1440]);
    await page.getByRole('button', { name: 'Seal more files' }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'seal-what-title');
  });

  await check('Remove asks first with Keep it focused; Escape keeps the job; Remove removes only it', async () => {
    await go(page, 'jobs');
    const remove = page.getByRole('button', { name: 'Remove flight-12.ulg.fseal' });
    await remove.click();
    const dialog = page.getByRole('dialog', { name: 'Remove this job from this browser?' });
    await dialog.waitFor();
    assert.equal(await dialog.locator('p').innerText(), 'The sealed file and anything you sent are not affected.');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep it');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Remove flight-12.ulg.fseal', 'focus returns to Remove');
    assert.equal((await tableNames(page)).length, 2);
    await remove.click();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.jobs-table tbody tr').length === 1);
    await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some((n) => n.textContent === 'Job removed'));
    await page.waitForFunction(() => document.activeElement?.id === 'page-jobs' || document.activeElement?.id?.startsWith('job-resume-'));
  });

  await check('search as you type, 25 per page, page and search in the URL, Back and Forward, no match and Clear search', async () => {
    await seed(page, 60);
    await page.evaluate(async () => { // rows the app never wrote: a numeric ref, an extra field, a 5 MB name. They are skipped, not shown.
      const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('guest')))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const db = await new Promise((ok) => { const r = indexedDB.open(`hashwing-jobs-v1-${hex}`, 1); r.onsuccess = () => ok(r.result); });
      const tx = db.transaction('jobs', 'readwrite');
      const base = { mode: 'small', items: 1, bytes: 1, receipt: 'fseal-receipt v1', sealedAt: 1 };
      tx.objectStore('jobs').put({ ...base, id: 'bad-1', jobRef: 42, name: 'numeric-ref.fseal' });
      tx.objectStore('jobs').put({ ...base, id: 'bad-2', jobRef: '', name: 'extra-field.fseal', log: 'bytes' });
      tx.objectStore('jobs').put({ ...base, id: 'bad-3', jobRef: '', name: 'x'.repeat(5_000_000) });
      await new Promise((ok) => { tx.oncomplete = ok; }); db.close();
    });
    await page.reload(); await page.locator('#page-jobs').waitFor();
    await page.locator('.jobs-table caption').waitFor();
    assert.equal(await page.locator('.jobs-table caption').innerText(), 'Showing 1–25 of 61');
    assert.equal((await tableNames(page)).length, 25);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === 'Showing 26–50 of 61');
    assert.equal(new URL(page.url()).hash, '#/app/jobs?page=2');
    await page.waitForFunction(() => document.activeElement?.tagName === 'CAPTION', null, { timeout: 3000 });
    assert.ok(!(await page.locator('[role=status]').allInnerTexts()).includes('Showing 26–50 of 61'), 'a page change is read once, from the focused caption');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === 'Showing 51–61 of 61');
    assert.equal(await page.getByRole('button', { name: 'Next' }).isDisabled(), true);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === 'Showing 26–50 of 61');
    await page.goForward();
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === 'Showing 51–61 of 61');
    const search = page.getByLabel('Search job reference or file name');
    await search.pressSequentially('4');
    await page.waitForFunction(() => /jobs? match/.test(document.querySelector('.jobs-table caption')?.textContent || ''));
    assert.ok(!(await page.locator('#main').innerText()).includes('numeric-ref'), 'a bad row is not shown, and searching does not crash');
    await search.fill('');
    await page.goBack(); await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === 'Showing 51–61 of 61');
    await search.pressSequentially('s-05');
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === '10 jobs match');
    assert.equal(new URL(page.url()).hash, '#/app/jobs?q=s-05');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'jobs-search', 'typing keeps focus in the field');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some((n) => n.textContent === '10 jobs match'));
    await page.goBack(); // one step leaves the whole search
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === 'Showing 51–61 of 61');
    await page.goto(`${url}#/app/jobs?page=9`); // out of range: settles on the last page, replacing the URL
    await page.waitForFunction(() => location.hash === '#/app/jobs?page=3');
    assert.equal(await page.locator('.jobs-table caption').innerText(), 'Showing 51–61 of 61');
    await page.goto(`${url}#/app/jobs?q=manifest`);
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === '1 job matches');
    await search.fill('zzz');
    await page.getByText('No jobs match "zzz".').waitFor();
    await layout(page, 'jobs no match', [320, 1440]);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.waitForFunction(() => document.querySelector('.jobs-table caption')?.textContent === 'Showing 1–25 of 61');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'jobs-search');
  });

  await check('a seal in progress: Resume is disabled with the reason, and the running seal keeps its progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hashwing-jobs-'));
    const big = join(dir, 'big.mp4'); const fd = openSync(big, 'w'); ftruncateSync(fd, 2 * 1024 ** 3); closeSync(fd);
    try {
      await go(page, 'protect');
      await page.getByLabel(/^Large files/).check();
      await page.locator('#manifest-files').setInputFiles(big);
      await page.getByRole('button', { name: 'Seal the list' }).click();
      await page.locator('#manifest-seal-progress').waitFor();
      await go(page, 'jobs');
      const resume = page.getByRole('button', { name: /^Resume / }).first();
      assert.equal(await resume.isDisabled(), true);
      assert.equal(await page.locator('#jobs-resume-blocked').innerText(), 'Finish or cancel the seal in progress first.');
      await go(page, 'protect');
      assert.equal(await page.locator('#manifest-seal-progress').isVisible(), true, 'the running seal is still shown');
      await page.locator('.seal-progress').getByRole('button', { name: 'Cancel' }).click();
      await page.getByText('Sealing cancelled. Your files are still chosen.').first().waitFor();
      await go(page, 'jobs');
      assert.equal(await page.getByRole('button', { name: /^Resume / }).first().isDisabled(), false);
      assert.equal(await page.locator('#jobs-resume-blocked').count(), 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await check('owner scoping (AC-57): a profile sees none of the guest\'s rows, logout hides its rows, signing back in shows them', async () => {
    const email = `jobs-${Date.now()}@example.test`, password = 'jobs browser password 123';
    await go(page, 'jobs');
    await page.locator('.profile-menu > summary').click();
    await page.locator('.profile-menu').getByRole('button', { name: 'Create a local profile', exact: true }).click();
    await page.locator('#auth-email').fill(email); await page.locator('#auth-password').fill(password); await page.locator('#auth-confirm').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('jobs-'));
    await go(page, 'jobs');
    await page.getByText('Nothing sealed in this browser yet.').waitFor();
    await sealSmall(page, 'P-1');
    await page.getByRole('button', { name: 'Copy message' }).click();
    await page.getByRole('button', { name: 'Download sealed file' }).click();
    await page.getByRole('button', { name: 'Seal more files' }).click();
    await page.locator('.confirm-box').getByRole('button', { name: 'I saved it' }).click();
    await go(page, 'jobs');
    assert.deepEqual(await page.locator('.jobs-table tbody .jobs-ref').allInnerTexts(), ['P-1']);
    await page.locator('.profile-menu > summary').click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.waitForFunction(() => location.hash === '#/');
    await go(page, 'jobs'); // a guest again: the guest's rows, never the profile's
    await page.locator('.jobs-table caption').waitFor();
    assert.ok(!(await page.locator('#main').innerText()).includes('P-1'), 'the profile\'s row is hidden after logout');
    assert.equal(await page.locator('.jobs-table caption').innerText(), 'Showing 1–25 of 61');
    await page.locator('.profile-menu > summary').click();
    await page.locator('.profile-menu').getByRole('button', { name: 'Use a local profile', exact: true }).click();
    await page.locator('#auth-email').fill(email); await page.locator('#auth-password').fill(password);
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('jobs-'));
    await go(page, 'jobs');
    await page.locator('.jobs-table').waitFor();
    assert.deepEqual(await page.locator('.jobs-table tbody .jobs-ref').allInnerTexts(), ['P-1'], 'signing back in shows them again');
  });

  await check('removing a local profile deletes its jobs database and keeps the guest\'s', async () => {
    const scopeDb = (scope) => page.evaluate(async (s) => `hashwing-jobs-v1-${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`, scope);
    const userId = await page.evaluate(() => Object.values(sessionStorage).map((v) => { try { return JSON.parse(v); } catch { return null; } }).find((v) => v?.kind === 'account')?.userId);
    assert.ok(userId, 'the signed-in profile id');
    const profileDb = await scopeDb(`profile:${userId}`), guestDb = await scopeDb('guest');
    assert.ok((await dbNames(page)).includes(profileDb), 'the profile has a jobs database before removal');
    page.once('dialog', (d) => d.accept());
    await page.locator('.profile-menu > summary').click();
    await page.getByRole('button', { name: 'Remove local profile, saved view and jobs', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.profile-menu > summary')?.textContent.includes('jobs-'));
    let names = await dbNames(page);
    for (let i = 0; i < 50 && names.includes(profileDb); i += 1) { await page.waitForTimeout(100); names = await dbNames(page); }
    assert.ok(!names.includes(profileDb), `the profile's jobs database is gone: ${names.join()}`);
    assert.ok(names.includes(guestDb), 'the guest\'s jobs database remains');
    await go(page, 'jobs');
    await page.locator('.jobs-table caption').waitFor();
    assert.equal(await page.locator('.jobs-table caption').innerText(), 'Showing 1–25 of 61', 'the guest\'s jobs are untouched');
  });

  await check('a small seal that finishes while its profile is being removed does not bring back that profile\'s jobs database', async () => {
    const email = `race-${Date.now()}@example.test`, password = 'jobs browser password 123';
    await go(page, 'jobs');
    await page.locator('.profile-menu > summary').click();
    await page.locator('.profile-menu').getByRole('button', { name: 'Create a local profile', exact: true }).click();
    await page.locator('#auth-email').fill(email); await page.locator('#auth-password').fill(password); await page.locator('#auth-confirm').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForFunction(() => document.querySelector('.profile-menu > summary')?.textContent.includes('race-'));
    const userId = await page.evaluate(() => Object.values(sessionStorage).map((v) => { try { return JSON.parse(v); } catch { return null; } }).find((v) => v?.kind === 'account')?.userId);
    const profileDb = await page.evaluate(async (s) => `hashwing-jobs-v1-${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`, `profile:${userId}`);
    await go(page, 'protect');
    await page.getByLabel(/^Small file/).check();
    await page.locator('#job-ref').fill('RACE-1');
    await page.locator('#protect-file').setInputFiles(smallFile);
    // Hold the app between "jobs database deleted" and its logout, the window where a finishing seal used to recreate it.
    await page.evaluate(() => {
      const real = IDBFactory.prototype.deleteDatabase;
      window.__released = new Promise((ok) => { window.__release = ok; });
      IDBFactory.prototype.deleteDatabase = function (name) {
        const held = {}; const r = real.call(this, name);
        r.onsuccess = r.onerror = r.onblocked = () => { window.__deleted = true; window.__released.then(() => held.onsuccess?.()); };
        return held;
      };
    });
    page.once('dialog', (d) => d.accept());
    await page.locator('.profile-menu > summary').click();
    await page.getByRole('button', { name: 'Remove local profile, saved view and jobs', exact: true }).click();
    await page.waitForFunction(() => window.__deleted === true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Seal this file' }).click();
    await page.locator('#handover-text').waitFor({ timeout: 60000 });
    await page.waitForTimeout(500); // the seal's job write, if any, lands now
    await page.evaluate(() => window.__release());
    await page.waitForFunction(() => !document.querySelector('.profile-menu > summary')?.textContent.includes('race-'));
    await page.waitForTimeout(500);
    assert.ok(!(await dbNames(page)).includes(profileDb), 'the removed profile\'s jobs database stays gone');
    await page.reload(); // drop the deleteDatabase hold
    await page.locator('#main').waitFor();
  });

  await check('flag off (AC-02, AC-60): no registry request, no outbox or pending database; jobs live in their own database', async () => {
    const names = await dbNames(page);
    assert.ok(names.some((n) => /^hashwing-jobs-v1-[0-9a-f]{64}$/.test(n)), names.join());
    assert.ok(!names.some((n) => n.startsWith('hashwing-outbox') || n.startsWith('hashwing-pending')), names.join());
    assert.deepEqual(foreign, [], 'no request left this origin');
  });

  await check('storage unavailable: Jobs says it is not keeping jobs, and sealing still lists the job for this tab', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => runtimeErrors.push(`memory: ${e}`));
    await p.goto(`${url}#/app/jobs`); await p.locator('#page-jobs').waitFor();
    await p.getByText("This browser isn't keeping jobs (private window or storage blocked). Jobs you seal now will be gone when you close it.").waitFor();
    await sealSmall(p, 'M-1');
    await p.locator('.jobs-recent').getByText('flight-12.ulg.fseal').waitFor();
    await layout(p, 'jobs memory', [320]);
    await ctx.close();
  });
  await check('a full job list and a failed job write each say so; the seal itself still finishes', async () => {
    const full = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    const p = await full.newPage();
    p.on('pageerror', (e) => runtimeErrors.push(`full: ${e}`));
    await p.goto(`${url}#/app/jobs`); await p.locator('#page-jobs').waitFor();
    await seed(p, 1000);
    await sealSmall(p, 'F-1');
    await p.getByText("This browser's job list is full (1,000 jobs). Remove old jobs on Jobs to keep new ones.").waitFor();
    await full.close();
    const broken = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    await broken.addInitScript(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...a) { if (this.name === 'jobs') throw new DOMException('refused', 'DataError'); return put.apply(this, a); }; });
    const b = await broken.newPage();
    b.on('pageerror', (e) => runtimeErrors.push(`broken: ${e}`));
    await b.goto(`${url}#/app/protect`); await b.locator('#page-protect').waitFor();
    await sealSmall(b, 'E-1');
    await b.getByText("Couldn't add this to Jobs. The sealed file and receipt message above are not affected.").waitFor();
    assert.equal(await b.locator('#handover-text').isVisible(), true);
    await broken.close();
  });
  await context.close();
} finally {
  await browser?.close();
  server.close();
}
if (runtimeErrors.length) { console.error(`runtime errors:\n${runtimeErrors.join('\n')}`); process.exitCode = 1; }
const passed = checks.filter((c) => c.passed).length;
console.log(`${passed}/${checks.length} jobs checks passed`);
if (passed !== checks.length) process.exitCode = 1;

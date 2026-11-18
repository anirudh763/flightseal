// Registry wiring in the console (VITE_REGISTRY_URL), against the DEV ONLY registry/devserver/server.py.
// 1. The flag-off bundle in docs/console carries no registry code, and the flag-off console makes no registry request.
// 2. A flag-on console built into .test-artifacts/registry-wiring/build drives sign-in, the outbox list, shares,
//    delete and the recipient view in Playwright Chromium. Run `npm --prefix newweb run build` first (flag off).
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from '../../tests/web/serve.mjs';
import { acquireBrowserLock, releaseBrowserLock } from '../../tests/web/browser-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOCS = resolve(ROOT, '../docs');
const OUT = join(ROOT, '.test-artifacts', 'registry-wiring');
const BUILD = join(OUT, 'build');
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const FORBIDDEN = ['Company registry', 'Test sign-in', 'Sealed on this device', 'hashwing-outbox', '/v1/envelopes', '/v1/shares', 'registry-test-secret', 'dev-hs256'];
const LINK_DEAD = "This link doesn't open. It may have been withdrawn or expired, or it was copied incompletely. Ask the sender for a new link.";
const SEED_A_PEM = `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from([...Array(32).keys()])]).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const errors = [];
let base, devServer, lock, browser, flagOff, flagOn;
let offline = false; // while a check holds the context offline, no-SW static loads (the icon) fail too

async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
const dev = async (path) => (await fetch(`${base}/__dev/${path}`)).json();
const tokenFor = async (sub, role = 'pilot', ttl = 3600) => (await dev(`token?org=orgA&sub=${sub}&role=${role}&ttl=${ttl}`)).token;
const registerLog = async (sub) => (await dev('log')).log.filter((e) => e.route === 'register' && (!sub || e.sub === sub));

// Console and page errors fail the run. The only exception: Chromium's "Failed to load resource" line for a registry
// response that a check asks for on purpose (403 key_not_enrolled, 404 share, 429 quota, offline or aborted requests).
function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const where = msg.location()?.url || '';
    if (where.startsWith(`${base}/`) && msg.text().startsWith('Failed to load resource')) return;
    if (offline && msg.text() === 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED') return;
    errors.push(`${label} console: ${msg.text()} (${where})`);
  });
  return page;
}
async function newContext(width = 1440) {
  return browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width, height: 900 } });
}
async function go(page, screen) {
  await page.evaluate((s) => { location.hash = `/app/${s}`; }, screen);
  await page.locator(`#page-${screen}`).waitFor();
}
const rowOf = (page, name) => page.locator('.registry-row').filter({ has: page.locator('.registry-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
async function chipIs(page, name, text, timeout = 30000) {
  const chip = rowOf(page, name).locator(':scope > summary .status-label');
  try { await page.waitForFunction(([el, t]) => el?.textContent === t, [await chip.elementHandle({ timeout }), text], { timeout }); }
  catch { assert.fail(`${name}: chip ${JSON.stringify(await chip.textContent().catch(() => null))}, wanted ${text}; list: ${await page.locator('.registry-list').innerText().catch(() => '')}`); }
}
async function openRow(page, name) {
  const row = rowOf(page, name);
  if (!(await row.evaluate((d) => d.open))) await row.locator(':scope > summary').click();
  return row;
}
async function sealSmall(page, name, body = `${name} ${Date.now()} ${Math.random()}`) {
  await go(page, 'protect');
  const small = page.getByLabel('Small file (seal the whole file, up to 45 MiB)');
  if (!(await small.isChecked())) await small.check();
  await page.locator('#protect-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(body) });
  await page.getByRole('button', { name: 'Seal this log' }).click();
  await page.waitForSelector('#handover-text', { timeout: 60000 });
}
async function signIn(page, sub, role, ttl) {
  await go(page, 'help');
  await page.locator('#registry-token').fill(await tokenFor(sub, role, ttl));
  await page.locator('#company-registry').getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#company-registry').getByText(`Signed in to the company registry as ${sub} · orgA · ${role === 'admin' ? 'Admin' : 'Member'}`).waitFor();
}
async function importSeedA(page) {
  await go(page, 'help');
  await page.locator('#private-key-file').setInputFiles({ name: 'seed-a.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from(SEED_A_PEM) });
  await page.getByRole('button', { name: 'Clear key', exact: true }).waitFor();
}
async function axe(page, label) {
  await page.evaluate(AXE);
  const results = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
  assert.equal(results.violations.length, 0, `${label}: ${results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`).join(' | ')}`);
}
function walk(dir) { return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; }); }

// /flightseal/console/* from the flag-on build, everything else from docs/ (the wasm engine, samples).
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
function serveFlagOn() {
  const server = createServer(async (req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return res.writeHead(400).end(); }
    if (!path.startsWith('/flightseal/')) return res.writeHead(404).end();
    const [root, rest] = path.startsWith('/flightseal/console/') ? [BUILD, path.slice('/flightseal/console'.length)] : [DOCS, path.slice('/flightseal'.length)];
    const file = normalize(join(root, rest.endsWith('/') ? `${rest}index.html` : rest));
    if (!file.startsWith(root + sep)) return res.writeHead(403).end();
    try { res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(await readFile(file)); }
    catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/flightseal/console/` })));
}

try {
  await check('flag-off bundle (docs/console) carries no registry strings', async () => {
    const hits = [];
    for (const file of walk(join(DOCS, 'console'))) {
      const text = readFileSync(file, 'latin1');
      for (const s of FORBIDDEN) if (text.includes(s)) hits.push(`${file}: ${s}`);
    }
    assert.deepEqual(hits, []);
  });

  if (process.env.REGISTRY_DEV_URL) base = process.env.REGISTRY_DEV_URL.replace(/\/+$/, '');
  else {
    devServer = spawn(process.env.PYTHON || 'python3', [resolve(ROOT, '../registry/devserver/server.py'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    base = await new Promise((ok, reject) => {
      let out = '';
      devServer.stdout.on('data', (c) => { out += c; const m = /READY (\S+)/.exec(out); if (m) ok(m[1]); });
      devServer.once('exit', (code) => reject(new Error(`dev server exited ${code}`)));
    });
  }
  await dev('reset');
  const built = spawnSync(join(ROOT, 'node_modules/.bin/vite'), ['build', '--outDir', BUILD, '--emptyOutDir'], { cwd: ROOT, env: { ...process.env, VITE_REGISTRY_URL: base }, encoding: 'utf8' });
  assert.equal(built.status, 0, `flag-on build failed: ${built.stderr}`);
  flagOff = await serve(0, '/flightseal');
  flagOn = await serveFlagOn();
  lock = await acquireBrowserLock();
  const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });

  await check('flag off: no registry UI, request or outbox database; Trust has trusted companies and the signing key; "Not registered" stays', async () => {
    const ctx = await newContext();
    const page = watch(await ctx.newPage(), 'flag-off');
    const origin = new URL(flagOff.url).origin;
    const foreign = [];
    page.on('request', (r) => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(origin)) foreign.push(u); });
    await page.goto(`${flagOff.url}console/#/app/protect`);
    await page.locator('#page-protect').waitFor();
    assert.match(await page.locator('main').innerText(), /under Trust/);
    await sealSmall(page, 'off-flight.ulg');
    const handover = await page.locator('#handover-text').inputValue();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
    const sealedPath = join(OUT, 'off-flight.fseal'); await download.saveAs(sealedPath);
    await page.locator('#check-file').setInputFiles(sealedPath);
    await page.locator('#check-text').fill(handover);
    await page.getByRole('button', { name: 'Check this log' }).click();
    await page.getByText('no registry was used').first().waitFor({ timeout: 30000 });
    const body = await page.locator('body').innerText();
    assert.match(body, /Registry acceptance/);
    assert.match(body, /Not registered/);
    for (const screen of ['protect', 'verify', 'help']) {
      await go(page, screen);
      const text = await page.locator('body').innerText();
      for (const s of ['Company registry', 'Sealed on this device', 'Test sign-in', 'Sign in to the company registry', "The registry's record"]) assert.ok(!text.includes(s), `${screen} shows ${s}`);
    }
    await page.goto(`${flagOff.url}console/#/app/verify?share=${'A'.repeat(43)}`);
    await page.locator('#page-verify').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes("The registry's record"));
    await go(page, 'protect');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Trust', exact: true }).click();
    await page.locator('#page-help').waitFor();
    await page.getByRole('heading', { name: 'Trusted companies' }).waitFor();
    await page.getByRole('heading', { name: 'Your signing key' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Company registry' }).count(), 0);
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    assert.ok(!dbs.some((n) => n.startsWith('hashwing-outbox')), dbs.join());
    assert.deepEqual(foreign, []);
    await ctx.close();
  });

  const ctx = await newContext();
  const page = watch(await ctx.newPage(), 'flag-on');
  await page.goto(`${flagOn.url}#/app/protect`);
  await page.locator('#page-protect').waitFor();
  let shareUrl;

  await check('signed out: a seal shows "Sealed locally" and the list notice "Sign in to the company registry to send these.", whose Sign in opens Trust', async () => {
    await page.getByRole('heading', { name: 'Sealed on this device' }).waitFor();
    await page.getByText('Nothing sealed on this device yet.').waitFor();
    await sealSmall(page, 'local-flight.ulg');
    await chipIs(page, 'local-flight.ulg', 'Sealed locally');
    const row = await openRow(page, 'local-flight.ulg');
    await row.getByText('Sealed on this device. Not sent to the registry yet.').waitFor();
    assert.match(await page.locator('.registry-summary').innerText(), /^0 registered · 1 not yet registered$/);
    const notice = page.locator('.registry-list .registry-notice', { hasText: 'Sign in to the company registry to send these.' });
    await notice.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#page-help').waitFor();
    await page.getByRole('heading', { name: 'Company registry' }).waitFor();
    await page.getByRole('heading', { name: 'Test sign-in (local only)' }).waitFor();
    assert.equal(await page.locator('#registry-token').getAttribute('type'), 'password');
  });

  await check('sign in: the pending ephemeral-key receipt is sent and needs attention (key not enrolled), with Try again', async () => {
    await signIn(page, 'pilot-1', 'pilot');
    assert.ok(await page.evaluate(() => sessionStorage.getItem('hashwing-registry-token')));
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => /registry/.test(k)).length), 0);
    await go(page, 'protect');
    await chipIs(page, 'local-flight.ulg', 'Needs attention');
    const row = await openRow(page, 'local-flight.ulg');
    await row.getByText("This signing key isn't enrolled for your company yet. Ask your admin to enroll it on the Trust page, then try again.").waitFor();
    await row.getByRole('button', { name: 'Try again' }).waitFor();
    await row.locator('.registry-tech summary').click();
    await row.getByText('Technical details: key_not_enrolled').waitFor();
    assert.ok(!(await page.locator('.registry-list').innerText()).includes('Not registered'));
  });

  await check('export pending proofs downloads a hashwing-outbox-export v1 file', async () => {
    await page.locator('.registry-more > summary').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export pending proofs' }).click()]);
    assert.equal(download.suggestedFilename(), 'hashwing-pending-proofs.json');
    const doc = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(doc.format, 'hashwing-outbox-export');
    assert.equal(doc.version, 1);
    assert.equal(doc.receipts.length, 1);
    await page.getByText('Exported 1 proofs. Keep this file until they show Registered.').waitFor();
    await page.locator('.registry-more > summary').click();
  });

  await check('import pending proofs: an export file is queued and registers; another file is refused in plain words', async () => {
    const { receipt } = await dev('receipt?count=7&seed=A');
    await page.locator('.registry-more > summary').click();
    const input = page.locator('#registry-import');
    await input.setInputFiles({ name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await page.getByText("This file isn't a HashWing pending-proofs export.").waitFor();
    const file = JSON.stringify({ format: 'hashwing-outbox-export', version: 1, receipts: [receipt] });
    await input.setInputFiles({ name: 'proofs.json', mimeType: 'application/json', buffer: Buffer.from(file) });
    await page.getByText('Added 1 proofs to send.').waitFor();
    await page.locator('.registry-more > summary').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.registry-row .status-label')].filter((c) => c.textContent === 'Registered').length === 1, null, { timeout: 30000 });
  });

  await check('enrolled key (SEED_A): a small-file seal registers; the change is announced once; counts stay separate', async () => {
    await importSeedA(page);
    await sealSmall(page, 'flight-a.ulg');
    await chipIs(page, 'flight-a.ulg', 'Registered');
    await page.waitForFunction(() => document.querySelector('.registry-announce')?.textContent.includes('flight-a.ulg: Registered'));
    const row = await openRow(page, 'flight-a.ulg');
    assert.match(await row.locator('.registry-detail').innerText(), /^Registered at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\. This is the registry's statement, not proof of the files\./);
    assert.match(await page.locator('.registry-summary').innerText(), /^2 registered · 1 not yet registered$/);
    assert.equal(await row.getByRole('button', { name: 'Delete hosted record' }).count(), 0, 'members see no delete');
  });

  await check('large files: a two-file manifest seal registers as "2 files"', async () => {
    await go(page, 'protect');
    await page.getByLabel('Large files (fingerprint only)').check();
    await page.locator('#manifest-files').setInputFiles([{ name: 'v1.mp4', mimeType: 'video/mp4', buffer: Buffer.from(`one ${Date.now()}`) }, { name: 'v2.mp4', mimeType: 'video/mp4', buffer: Buffer.from(`two ${Date.now()}`) }]);
    await page.getByRole('button', { name: 'Seal', exact: true }).click();
    await chipIs(page, '2 files', 'Registered', 60000);
    await page.getByLabel('Small file (seal the whole file, up to 45 MiB)').check();
  });

  await check('share link: made in the fragment only; a fresh context opens the record without sign-in', async () => {
    await go(page, 'protect');
    const row = await openRow(page, 'flight-a.ulg');
    await row.getByRole('button', { name: 'Make a share link' }).click();
    const field = row.getByLabel('Share link');
    await field.waitFor();
    shareUrl = await field.inputValue();
    assert.match(shareUrl, new RegExp(`^${new URL(flagOn.url).origin}/flightseal/console/#/app/verify\\?share=[A-Za-z0-9_-]{43}$`));
    const token = shareUrl.split('share=')[1];
    await row.getByText(/This link stops working on /).waitFor();
    await row.getByRole('button', { name: 'Copy link' }).click();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    assert.ok(!stored.includes(token), 'the share token is never stored');
    const fresh = await newContext();
    const reviewer = watch(await fresh.newPage(), 'reviewer');
    await reviewer.goto(shareUrl);
    const panel = reviewer.locator('.registry-record');
    await panel.getByText('Received by the registry').waitFor();
    const text = await panel.innerText();
    assert.match(text, /The registry's record/);
    assert.match(text, /Chain head\s+[0-9a-f]{64}/);
    assert.match(text, /Records\s+[1-9]\d*/);
    assert.match(text, /Key fingerprint\s+([0-9a-f]{4} ){15}[0-9a-f]{4}/);
    assert.match(text, /the registry's clock; the registry's statement, not proof of the files/);
    assert.match(text, /It did not check who the company is\. Compare the fingerprint with one you got from the company yourself\./);
    assert.match(text, /This record is not a check of your files\./);
    assert.ok(!/verified|matches/i.test(text), 'the record panel never says verified or matches');
    const body = await reviewer.locator('body').innerText();
    for (const s of ['Test sign-in', 'Company registry', 'Sealed on this device']) assert.ok(!body.includes(s), `reviewer sees ${s}`);
    await reviewer.locator('#log-input').waitFor(); // file checking stays available below
    for (const width of [320, 768, 1440]) {
      await reviewer.setViewportSize({ width, height: 900 });
      const overflow = await reviewer.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 0, `share view@${width}: horizontal scroll ${overflow}px`);
      await axe(reviewer, `share view@${width}`);
      await reviewer.screenshot({ path: join(OUT, `share-view-${width}.png`), fullPage: true });
    }
    await reviewer.setViewportSize({ width: 1440, height: 900 });
    await reviewer.goto(shareUrl.split('?')[0].replace('/verify', '/help'));
    await reviewer.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Verify', exact: true }).click();
    await reviewer.locator('#log-input').waitFor();
    assert.equal(await reviewer.locator('.registry-record').count(), 0, 'Verify without a link shows no old record');
    await fresh.close();
  });

  await check('axe 0 violations and no horizontal scroll on protect (list) and help (registry panel) at 320/768/1440; screenshots', async () => {
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const screen of ['protect', 'help']) {
        await go(page, screen);
        if (screen === 'protect') await openRow(page, 'flight-a.ulg');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(overflow <= 0, `${screen}@${width}: horizontal scroll ${overflow}px`);
        await axe(page, `${screen}@${width}`);
        const target = page.locator(screen === 'protect' ? '.registry-list' : '#company-registry');
        await target.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(OUT, `${screen}-${width}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('withdraw after visiting other pages: inline confirmation, the link is gone, and a fresh context gets the one generic message', async () => {
    await go(page, 'protect');
    const row = await openRow(page, 'flight-a.ulg');
    await row.getByRole('button', { name: 'Withdraw link' }).click();
    await row.getByText("Link withdrawn. It no longer opens. Copies of the receipt someone already has aren't affected.").waitFor();
    assert.equal(await row.getByLabel('Share link').count(), 0);
    const fresh = await newContext();
    const reviewer = watch(await fresh.newPage(), 'reviewer-withdrawn');
    for (const url of [shareUrl, shareUrl.replace(/share=.*/, 'share=abc'), shareUrl.replace(/share=.*/, `share=${'B'.repeat(43)}`)]) {
      await reviewer.goto('about:blank');
      await reviewer.goto(url);
      await reviewer.locator('.registry-record').getByText(LINK_DEAD).waitFor();
    }
    await fresh.close();
  });

  await check('quota (429 quota_exceeded): needs attention with the outbox message, Export pending proofs, Try again under More options, no automatic retry', async () => {
    let posts = 0;
    const quota = (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts += 1;
      return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': new URL(flagOn.url).origin, vary: 'Origin' }, body: JSON.stringify({ error: 'quota_exceeded' }) });
    };
    await page.route(`${base}/v1/registrations`, quota);
    try {
      await sealSmall(page, 'flight-q.ulg');
      await chipIs(page, 'flight-q.ulg', 'Needs attention');
      const row = await openRow(page, 'flight-q.ulg');
      await row.getByText("Your company's monthly registration limit is reached; this proof is saved and can be exported", { exact: true }).waitFor();
      await row.locator('.registry-detail > .actions-row').getByRole('button', { name: 'Export pending proofs' }).waitFor();
      assert.equal(await row.getByRole('button', { name: 'Try again' }).isVisible(), false, 'Try again is tucked under More options');
      await row.locator('.registry-tech summary').click();
      await row.getByRole('button', { name: 'Try again' }).waitFor();
      const seen = posts;
      await sleep(2500);
      assert.equal(posts, seen, 'no automatic retry');
    } finally { await page.unroute(`${base}/v1/registrations`, quota); }
  });

  await check('offline: a seal queued while offline shows "Waiting for connection" and the notice, then registers on reconnect without any action', async () => {
    // Service workers are blocked here, so the engine can't load offline: seal signed out (the receipt waits in memory),
    // go offline, then sign in, which queues it in the outbox while the device is offline.
    await go(page, 'help');
    await page.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
    await sealSmall(page, 'flight-off.ulg');
    await chipIs(page, 'flight-off.ulg', 'Sealed locally');
    const sends = (await registerLog('pilot-1')).length;
    await ctx.setOffline(true); offline = true;
    try {
      await signIn(page, 'pilot-1', 'pilot');
      await go(page, 'protect');
      await chipIs(page, 'flight-off.ulg', 'Waiting for connection');
      await page.getByText("You're offline. Sealing and checking still work. Registrations will send when you reconnect.").waitFor();
      const row = await openRow(page, 'flight-off.ulg');
      await row.getByText("Saved on this device. It will register when you're back online. You can close this tab.").waitFor();
      await sleep(500);
      assert.equal((await registerLog('pilot-1')).length, sends, 'nothing is sent while offline');
    } finally { await ctx.setOffline(false); offline = false; }
    await chipIs(page, 'flight-off.ulg', 'Registered');
    assert.equal(await page.getByText("You're offline.", { exact: false }).count(), 0);
  });

  await check('ended sign-in (401): the list asks to sign in again; a fresh token from Trust sends the waiting row', async () => {
    await go(page, 'help');
    await page.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, 'pilot-1', 'pilot', 60);
    await dev('advance?s=120'); // the token has expired on the registry's clock
    await sealSmall(page, 'flight-401.ulg');
    const notice = page.locator('.registry-list .registry-notice', { hasText: 'Sign in to the company registry to send these.' });
    await notice.waitFor({ timeout: 30000 });
    assert.notEqual(await rowOf(page, 'flight-401.ulg').locator(':scope > summary .status-label').textContent(), 'Registered');
    await notice.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#page-help').waitFor();
    await page.locator('#registry-token').fill(await tokenFor('pilot-1'));
    await page.locator('#company-registry').getByRole('button', { name: 'Sign in' }).click();
    await go(page, 'protect');
    await chipIs(page, 'flight-401.ulg', 'Registered');
    assert.equal(await notice.count(), 0);
  });

  await check('reload while queued: the row is still listed after the tab signs back in from sessionStorage', async () => {
    const block = (route) => route.abort('internetdisconnected');
    const isRegistry = (url) => url.href.startsWith(`${base}/v1/`);
    await page.route(isRegistry, block);
    try {
      await sealSmall(page, 'flight-r.ulg');
      await chipIs(page, 'flight-r.ulg', 'Waiting for connection');
      const before = await page.locator('.registry-row').count();
      await page.reload();
      await page.locator('#page-protect').waitFor();
      await page.waitForFunction((n) => document.querySelectorAll('.registry-row').length === n, before);
      assert.ok(await page.locator('.registry-row .status-label', { hasText: 'Waiting for connection' }).count() >= 1);
    } finally { await page.unroute(isRegistry, block); }
    // the outbox's own backoff timer sends it once the registry is reachable again
    await page.waitForFunction(() => ![...document.querySelectorAll('.registry-row .status-label')].some((c) => c.textContent === 'Waiting for connection'), null, { timeout: 30000 });
  });

  // Manual, local only (wall-clock token bucket; not a CI gate): REGISTRY_THROTTLE=1 node newweb/tests/registry-wiring.mjs.
  // Record the measured run in docs/aws/COVERAGE.md.
  if (process.env.REGISTRY_THROTTLE === '1') await check('throttled registry (gateway 429s, no quota code, 2 requests/s, burst 5): 30 queued proofs all end Registered', async () => {
    const started = Date.now();
    // The devserver has no throttle, so a token bucket in front of it answers like API Gateway's stage throttle.
    let tokens = 5, last = Date.now(), throttled = 0;
    const take = () => { const t = Date.now(); tokens = Math.min(5, tokens + (t - last) / 500); last = t; if (tokens >= 1) { tokens -= 1; return true; } return false; };
    const gate = (route) => {
      if (route.request().method() === 'OPTIONS' || take()) return route.fallback();
      throttled += 1;
      return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': new URL(flagOn.url).origin, vary: 'Origin' }, body: JSON.stringify({ message: 'Too Many Requests' }) });
    };
    const isRegistry = (u) => u.href.startsWith(`${base}/v1/`);
    const registeredNow = () => page.evaluate(() => [...document.querySelectorAll('.registry-row .status-label')].filter((c) => c.textContent === 'Registered').length);
    const before = await registeredNow();
    const attention = () => page.locator('.registry-row .status-label', { hasText: 'Needs attention' }).count();
    const attentionBefore = await attention();
    const receipts = [];
    for (let n = 101; n <= 130; n++) receipts.push((await dev(`receipt?count=${n}&seed=A`)).receipt);
    await page.route(isRegistry, gate);
    try {
      await page.locator('.registry-more > summary').click();
      await page.locator('#registry-import').setInputFiles({ name: 'thirty.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'hashwing-outbox-export', version: 1, receipts })) });
      await page.getByText('Added 30 proofs to send.').waitFor();
      await page.locator('.registry-more > summary').click();
      await page.waitForFunction((n) => [...document.querySelectorAll('.registry-row .status-label')].filter((c) => c.textContent === 'Registered').length >= n, before + 30, { timeout: 180000 });
      assert.equal(await attention(), attentionBefore, 'no throttled proof ended in Needs attention');
      assert.ok(throttled > 0, 'the gateway throttle actually refused some requests');
      const regs = (await dev('registrations?org=orgA')).registrations.length;
      assert.ok(regs >= 30, `registry holds ${regs} registrations`);
      console.log(`throttle run: 30 proofs Registered in ${((Date.now() - started) / 1000).toFixed(1)} s; ${throttled} requests answered 429`);
    } finally { await page.unroute(isRegistry, gate); }
  });

  await check('sign out stops dispatch: a waiting row is not sent after sign-out, and is sent after signing back in', async () => {
    const block = (route) => route.abort('internetdisconnected');
    const isRegistry = (u) => u.href.startsWith(`${base}/v1/`);
    await page.route(isRegistry, block);
    let blocked = true;
    try {
      await importSeedA(page); // the reload check above dropped the tab-memory signing key
      await sealSmall(page, 'flight-so.ulg');
      await chipIs(page, 'flight-so.ulg', 'Waiting for connection');
      const sends = (await registerLog('pilot-1')).length;
      const requests = (await dev('log')).log.length;
      await go(page, 'help');
      await page.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
      await page.unroute(isRegistry, block); blocked = false;
      await sleep(5000); // longer than the first backoff (1-2 s) and the sign-in recheck would allow
      assert.equal((await registerLog('pilot-1')).length, sends, 'no registration after sign-out');
      assert.equal((await dev('log')).log.length, requests, 'no registry request at all after sign-out');
      await signIn(page, 'pilot-1', 'pilot');
      await go(page, 'protect');
      await chipIs(page, 'flight-so.ulg', 'Registered');
    } finally { if (blocked) await page.unroute(isRegistry, block); }
  });

  await check('sign out, then sign in as an admin: the pilot\'s rows are hidden and never sent; delete uses a dialog with "Keep it" focused', async () => {
    const pilotSends = (await registerLog('pilot-1')).length;
    await go(page, 'help');
    await page.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, 'admin-1', 'admin');
    await go(page, 'protect');
    assert.equal(await page.locator('.registry-row').count(), 0, 'another owner\'s rows are not shown');
    await importSeedA(page);
    await sealSmall(page, 'flight-admin.ulg');
    await chipIs(page, 'flight-admin.ulg', 'Registered');
    const row = await openRow(page, 'flight-admin.ulg');
    const trigger = row.getByRole('button', { name: 'Delete hosted record' });
    await trigger.click();
    const dialog = row.locator('dialog');
    await dialog.getByRole('heading', { name: 'Delete the hosted record?' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep it');
    await axe(page, 'delete dialog open');
    await page.screenshot({ path: join(OUT, 'delete-dialog-1440.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.registry-row dialog[open]'));
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Delete hosted record', 'focus returns to the trigger');
    await trigger.click();
    await dialog.getByRole('button', { name: 'Delete hosted record' }).click();
    await chipIs(page, 'flight-admin.ulg', 'Registered, later deleted');
    await row.getByText("The registry's record of this receipt was deleted. Links to it no longer open.").waitFor();
    assert.ok(!(await row.locator('.registry-detail').innerText()).includes('Registered at'));
    await sleep(500);
    assert.equal((await registerLog('pilot-1')).length, pilotSends, 'no registration from the previous owner after the switch');
  });

  await check('sign out: the token is cleared, later seals stay local, and export works from the in-memory list', async () => {
    const adminSends = (await registerLog('admin-1')).length;
    await go(page, 'help');
    await page.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
    await page.locator('#registry-token').waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('hashwing-registry-token')), null);
    await sealSmall(page, 'flight-after.ulg');
    await chipIs(page, 'flight-after.ulg', 'Sealed locally');
    assert.equal(await page.locator('.registry-row').count(), 1, 'the signed-out list shows only this tab\'s unsent seal');
    await page.locator('.registry-more > summary').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export pending proofs' }).click()]);
    const doc = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(doc.format, 'hashwing-outbox-export');
    assert.equal(doc.receipts.length, 1);
    await sleep(500);
    assert.equal((await registerLog('admin-1')).length, adminSends, 'nothing is sent after sign-out');
  });

  await ctx.close();
  await check('no console or page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser?.close();
  await releaseBrowserLock(lock);
  flagOff?.server.close();
  flagOn?.server.close();
  devServer?.kill();
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ checks, total: checks.length, passed: checks.filter((c) => c.passed).length, errors }, null, 2));
}
console.log(`${checks.filter((c) => c.passed).length}/${checks.length} checks passed`);
if (!checks.length || checks.some((c) => !c.passed)) process.exitCode = 1;

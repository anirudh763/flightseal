// Registry wiring in the console (VITE_REGISTRY_URL), against the DEV ONLY registry/devserver/server.py.
// 1. The flag-off bundle in docs/console carries no registry code, and the flag-off console makes no registry request.
// 2. A flag-on console built into .test-artifacts/registry-wiring/build drives sign-in, the outbox list, shares,
//    delete and the recipient view in Playwright Chromium, then Jobs (5 checks). Run `npm --prefix newweb run build` first (flag off).
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
import { pdfText } from './pdf-text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOCS = resolve(ROOT, '../docs');
const OUT = join(ROOT, '.test-artifacts', 'registry-wiring');
const BUILD = join(OUT, 'build');
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
// "Sealed on this device" ships in every build now (AC-60), so the registry list is caught by its own strings instead.
const FORBIDDEN = ['Company registry', 'Test sign-in', 'Export pending proofs', 'Not sent to the registry yet', 'hashwing-outbox', 'hashwing-pending', 'hashwing-registry-signouts', '/v1/envelopes', '/v1/shares', 'registry-test-secret', 'dev-hs256',
  'REGISTRY_URL', 'execute-api', 'amazonaws.com', '__dev/token', 'Your company\'s keys', '/v1/keys', 'hashwing-key-enroll'];
const JWT = /eyJ[\w-]+\.eyJ[\w-]+\./; // any signed token (a pasted dev token is an HS256 JWT)
const LINK_DEAD = "This link doesn't open. It may have been withdrawn or expired, or it was copied incompletely. Ask the sender for a new link.";
const SEED_A_PEM = `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from([...Array(32).keys()])]).toString('base64')}\n-----END PRIVATE KEY-----\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const errors = [];
let base, devServer, lock, browser, flagOff, flagOn;
let flightA = null; // the registered small-file seal and its receipt message, for the client's check
let offline = false; // while a check holds the context offline, no-SW static loads (the icon) fail too

async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`ok ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.stack || error}`); }
}
const dev = async (path) => (await fetch(`${base}/__dev/${path}`)).json();
const tokenFor = async (sub, role = 'pilot', ttl = 3600, org = 'orgA') => (await dev(`token?org=${org}&sub=${sub}&role=${role}&ttl=${ttl}`)).token;
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
// One task at a time (R15): a result on screen gives way through "Seal more files" (and "Discard it" if not downloaded).
async function sealMore(page) {
  await go(page, 'protect');
  const more = page.getByRole('button', { name: 'Seal more files' });
  if (!(await more.count())) return;
  await more.click();
  if (await page.locator('#seal-more-ask').count()) await page.getByRole('button', { name: 'Discard it' }).click();
  await page.locator('#seal-what-title').waitFor();
}
async function sealSmall(page, name, body = `${name} ${Date.now()} ${Math.random()}`, { jobRef = '' } = {}) {
  await sealMore(page);
  const small = page.getByLabel('Small file: seal the whole file, up to 45 MiB');
  if (!(await small.isChecked())) await small.check();
  await page.locator('#protect-file').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(body) });
  if (jobRef) await page.locator('#job-ref').fill(jobRef);
  await page.getByRole('button', { name: 'Seal this file' }).click();
  await page.waitForSelector('#handover-text', { timeout: 60000 });
}
// An unassigned proof (sealed while signed out) is sent only after an explicit "Assign to <org>".
async function assignRow(page, name, org = 'orgA') {
  const row = await openRow(page, name);
  await row.getByRole('button', { name: `Assign to ${org}` }).click();
  await row.getByText("Sealed while signed out, so it isn't assigned to a company yet.").waitFor({ state: 'detached' }).catch(() => {});
  // Assign binds the row at once; wait until the outbox row (not the pending one) is the only row of that name.
  await page.waitForFunction((n) => { const rows = [...document.querySelectorAll('.registry-row')].filter((r) => r.querySelector('.registry-name')?.textContent === n); return rows.length === 1 && rows[0].querySelector(':scope > summary .status-label')?.textContent !== 'Sealed locally'; }, name, { timeout: 30000 });
}
async function signIn(page, sub, role, ttl, org = 'orgA') {
  await go(page, 'help');
  await page.locator('#registry-token').fill(await tokenFor(sub, role, ttl, org));
  await page.locator('#company-registry').getByRole('button', { name: 'Sign in' }).click();
  await page.locator('#company-registry').getByText(`Signed in to the company registry as ${sub} · ${org} · ${role === 'admin' ? 'Admin' : 'Member'}`).waitFor();
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
const CLIENT_BASIS = "not needed to check files from a share link";
const REGISTERED_BASIS = "the registry's clock; the registry's statement, not proof of the files";
// A downloaded export, with no registry token, JWT or share token in it.
async function exportOf(page, button, token, scope = page.locator('main')) {
  await scope.locator('.verdict-downloads').evaluateAll((menus) => menus.forEach((menu) => { menu.open = true; })); // reports sit behind "Download report"
  const [download] = await Promise.all([page.waitForEvent('download'), scope.getByRole('button', { name: button, exact: true }).locator('visible=true').first().click()]);
  const path = await download.path();
  const text = button.includes('PDF') ? await pdfText(path) : readFileSync(path, 'utf8');
  assert.ok(!JWT.test(text) && !text.includes(token), `${button}: carries a token`);
  return text;
}
// Check the last small-file seal against its own receipt message; returns the "Registry acceptance" [value, basis].
async function registryLineOfLastSeal(page, file, want) {
  const handover = await page.locator('#handover-text').inputValue();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
  const sealedPath = join(OUT, file); await download.saveAs(sealedPath);
  await go(page, 'verify'); // the checker lives on Verify (R15)
  await page.locator('#check-file').setInputFiles(sealedPath);
  await page.locator('#check-text').fill(handover);
  await page.getByRole('button', { name: 'Check files' }).click();
  const timeRow = page.locator('[aria-labelledby="check-title"] .time-fields > div', { has: page.locator('dt', { hasText: 'Registry acceptance' }) });
  // Query afresh each poll: a new result re-renders the time fields, so a handle taken earlier can go stale.
  await page.waitForFunction(([src, flags]) => [...document.querySelectorAll('[aria-labelledby="check-title"] .time-fields > div')].some((d) => d.querySelector('dt')?.textContent === 'Registry acceptance' && new RegExp(src, flags).test(d.querySelector('dd span')?.textContent || '')), [want.source, want.flags], { timeout: 30000 })
    .catch(async () => assert.fail(`time row: ${await timeRow.innerText({ timeout: 1000 }).catch(() => '(none)')}`));
  const main = await page.locator('main').innerText();
  for (const s of ['Not registered', 'no registry was used']) assert.ok(!main.includes(s), `screen shows ${s}`);
  return [await timeRow.locator('dd span').innerText(), await timeRow.locator('dd small').innerText()];
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
  await check('flag-off bundle (docs/console) carries no registry strings, URL, dev token or HS256 secret: the build and the committed files', async () => {
    const hits = [];
    const scan = (label, text) => {
      for (const s of FORBIDDEN) if (text.includes(s)) hits.push(`${label}: ${s}`);
      if (JWT.test(text)) hits.push(`${label}: a JWT`);
    };
    for (const file of walk(join(DOCS, 'console'))) scan(file, readFileSync(file, 'latin1'));
    // What GitHub Pages serves is the committed tree, which can differ from a fresh build.
    const git = (...args) => spawnSync('git', args, { cwd: DOCS, maxBuffer: 1 << 28, encoding: 'latin1' });
    const files = git('ls-tree', '-r', '--name-only', 'HEAD', 'console').stdout.split('\n').filter(Boolean);
    assert.ok(files.length > 10, `committed docs/console files: ${files.length}`);
    for (const file of files) scan(`HEAD:docs/${file}`, git('show', `HEAD:docs/${file}`).stdout);
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
    assert.match(await page.locator('.signing-line').innerText(), /One-time key for this file\. Your client can't check who sealed it\. Set up a company key on Trust\./);
    assert.ok(!(await page.locator('.signing-line').innerText()).includes('Registering for'));
    await sealSmall(page, 'off-flight.ulg');
    const handover = await page.locator('#handover-text').inputValue();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed file' }).click()]);
    const sealedPath = join(OUT, 'off-flight.fseal'); await download.saveAs(sealedPath);
    assert.equal(await page.locator('.handoff details').count(), 1, 'flag off: no share-link disclosure, only "What is this?"');
    await go(page, 'verify');
    await page.locator('#check-file').setInputFiles(sealedPath);
    await page.locator('#check-text').fill(handover);
    await page.getByRole('button', { name: 'Check files' }).click();
    await page.getByText('no registry was used').first().waitFor({ timeout: 30000 });
    const body = await page.locator('body').innerText();
    assert.match(body, /Registry acceptance/);
    assert.match(body, /Not registered/);
    for (const screen of ['protect', 'verify', 'help']) {
      await go(page, screen);
      const text = await page.locator('body').innerText();
      for (const s of ['Company registry', "Your company's keys", 'Export pending proofs', 'Test sign-in', 'Sign in to the company registry', "The registry's record"]) assert.ok(!text.includes(s), `${screen} shows ${s}`);
    }
    // AC-60: the job list sits under the sealing result and Jobs works, with no registry chip, request or database.
    await go(page, 'protect');
    await page.locator('.jobs-recent').getByText('off-flight.ulg.fseal').waitFor();
    assert.equal(await page.locator('.jobs-recent .jobs-status').first().innerText(), 'Sealed locally');
    await go(page, 'jobs');
    assert.deepEqual(await page.locator('.jobs-table tbody .jobs-name').allInnerTexts(), ['off-flight.ulg.fseal']);
    await page.goto(`${flagOff.url}console/#/app/verify?share=${'A'.repeat(43)}`);
    await page.locator('#page-verify').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes("The registry's record"));
    // AC-65: no link choice on this build; the files form, with one notice for a share link it can't open.
    assert.equal(await page.locator('.verify-chooser').count(), 0);
    assert.equal(await page.locator('.inline-notice').innerText(), "This copy of HashWing can't open HashWing share links. Check the files instead.");
    assert.equal(await page.locator('#check-file').isVisible(), true);
    await go(page, 'protect');
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Trust', exact: true }).click();
    await page.locator('#page-help').waitFor();
    await page.getByRole('heading', { name: 'Trusted companies' }).waitFor();
    await page.getByRole('heading', { name: 'Your signing key' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Company registry' }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: "Your company's keys" }).count(), 0);
    assert.deepEqual(await page.locator('main .help-layout .panel-head h2').allInnerTexts(), ['Trusted companies', 'Your signing key', 'Trust and limits', 'Limits'], 'flag off: neither registry section');
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    assert.ok(!dbs.some((n) => n.startsWith('hashwing-outbox')), dbs.join());
    assert.deepEqual(foreign, []);
    await ctx.close();
  });

  const ctx = await newContext();
  const page = watch(await ctx.newPage(), 'flag-on');
  await page.goto(`${flagOn.url}#/app/protect`);
  await page.locator('#page-protect').waitFor();
  let shareUrl, localFingerprint;

  await check('signed out: a seal shows "Sealed locally" and the list notice "Sign in to the company registry to send these.", whose Sign in opens Trust', async () => {
    await page.getByRole('heading', { name: 'Sealed on this device' }).waitFor();
    await page.getByText('Nothing sealed on this device yet.').waitFor();
    await sealSmall(page, 'local-flight.ulg');
    assert.equal(await page.locator('.handover .fingerprint').count(), 0, 'a one-time key has no fingerprint to hand out');
    localFingerprint = (await page.evaluate(async (hex) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16))))].map((b) => b.toString(16).padStart(2, '0')).join(''), /Public key:\s*([0-9a-f]{64})/.exec(await page.locator('#handover-text').inputValue())[1])).match(/.{4}/g).join(' ');
    await chipIs(page, 'local-flight.ulg', 'Sealed locally');
    const row = await openRow(page, 'local-flight.ulg');
    await row.getByText("Sealed while signed out, so it isn't assigned to a company yet. Sign in to the company registry to assign it, or export it.").waitFor();
    assert.match(await page.locator('.registry-summary').innerText(), /^0 registered · 1 not yet registered$/);
    const notice = page.locator('.registry-list .registry-notice', { hasText: 'Sign in to the company registry to send these.' });
    await notice.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#page-help').waitFor();
    await page.getByRole('heading', { name: 'Company registry' }).waitFor();
    await page.getByRole('heading', { name: 'Test sign-in (local only)' }).waitFor();
    assert.equal(await page.locator('#registry-token').getAttribute('type'), 'password');
  });

  await check('sign in: the signed-out seal stays unassigned until "Assign to orgA"; then it is sent and needs attention (key not enrolled), with Try again', async () => {
    const before = (await registerLog('pilot-1')).length;
    await signIn(page, 'pilot-1', 'pilot');
    assert.ok(await page.evaluate(() => sessionStorage.getItem('hashwing-registry-token')));
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => /registry/.test(k)).length), 0);
    await go(page, 'protect');
    const unassigned = await openRow(page, 'local-flight.ulg');
    await unassigned.getByText("Sealed while signed out, so it isn't assigned to a company yet.").waitFor();
    await sleep(1500);
    assert.equal((await registerLog('pilot-1')).length, before, 'never sent by itself under whoever signs in');
    await assignRow(page, 'local-flight.ulg');
    await chipIs(page, 'local-flight.ulg', 'Needs attention');
    const row = await openRow(page, 'local-flight.ulg');
    await row.getByText("This signing key isn't enrolled for your company yet. Ask your company's registry admin to enroll this key's fingerprint, then try again.").waitFor();
    assert.ok(!(await row.innerText()).includes('Trust page'), 'the REASONS copy is unchanged: it asks the admin to enroll the fingerprint without naming a page');
    assert.equal(await row.locator('.registry-fingerprint .fingerprint').innerText(), localFingerprint, "the row shows this key's fingerprint for the admin");
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
    await sealMore(page);
    const line = page.locator('.signing-line');
    await line.locator('.fingerprint').waitFor();
    assert.match(await line.innerText(), /Signing as the key from seed-a\.pem/);
    assert.match(await line.innerText(), /Registering for orgA as pilot-1/);
    const signingFingerprint = await line.locator('.fingerprint').innerText();
    assert.match(signingFingerprint, /^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);
    const bodies = []; const onRequest = (r) => { const b = r.postData(); if (b) bodies.push(b); };
    page.on('request', onRequest);
    await sealSmall(page, 'flight-a.ulg', undefined, { jobRef: 'JOBREF-MARKER-91' });
    assert.equal(await page.locator('.handover .fingerprint').first().innerText(), signingFingerprint, 'the signing line named the key that signed');
    assert.match(await page.locator('.handoff details summary', { hasText: 'Share link' }).innerText(), /Share link/);
    await chipIs(page, 'flight-a.ulg', 'Registered');
    page.off('request', onRequest);
    assert.ok(bodies.length > 0 && bodies.every((b) => !b.includes('JOBREF-MARKER-91')), 'the job reference is never sent');
    await page.waitForFunction(() => document.querySelector('.registry-announce')?.textContent.includes('flight-a.ulg: Registered'));
    const row = await openRow(page, 'flight-a.ulg');
    assert.match(await row.locator('.registry-detail').innerText(), /^Registered at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\. This is the registry's statement, not proof of the files\./);
    assert.match(await page.locator('.registry-summary').innerText(), /^2 registered · 1 not yet registered$/);
    assert.equal(await row.getByRole('button', { name: 'Delete hosted record' }).count(), 0, 'members see no delete');
  });


  await check('AC-25/AC-26: checking the registered receipt shows "Registered at <received_at>" on screen and in the text, Markdown, JSON and PDF reports', async () => {
    const row = await openRow(page, 'flight-a.ulg');
    const receivedAt = /Registered at (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC/.exec(await row.locator('.registry-detail').innerText()).slice(1).join('T') + 'Z';
    const value = `Registered at ${receivedAt}`;
    assert.deepEqual(await registryLineOfLastSeal(page, 'flight-a.fseal', new RegExp(`^${value}$`)), [value, REGISTERED_BASIS]);
    flightA = { path: join(OUT, 'flight-a.fseal'), handover: await page.locator('#check-text').inputValue() };
    const token = await page.evaluate(() => sessionStorage.getItem('hashwing-registry-token'));
    const line = `Registry acceptance: ${value} (${REGISTERED_BASIS})`;
    const outs = { text: await exportOf(page, 'Download text report', token), markdown: await exportOf(page, 'Download Markdown report', token) };
    const json = JSON.parse(await exportOf(page, 'Download JSON', token));
    assert.deepEqual(json.timeProvenance.fields.find((f) => f.label === 'Registry acceptance'), { label: 'Registry acceptance', value, basis: REGISTERED_BASIS });
    outs.json = JSON.stringify(json);
    await go(page, 'reports');
    outs.pdf = await exportOf(page, 'Download PDF', token);
    for (const [name, out] of Object.entries(outs)) {
      if (name !== 'json') assert.ok(out.replace(/\s+/g, ' ').includes(line), `${name}: ${out.slice(0, 3000)}`); // the PDF wraps long lines
      for (const s of ['Not registered', 'no registry was used']) assert.ok(!out.includes(s), `${name} says ${s}`);
    }
    await go(page, 'protect');
  });

  await check('large files: a two-file manifest seal registers as "2 files"; checking it reads Registered on screen and in its text, Markdown, JSON and PDF reports', async () => {
    await sealMore(page);
    await page.getByLabel('Large files: fingerprint only, files stay where they are').check();
    await page.locator('#manifest-files').setInputFiles([{ name: 'v1.mp4', mimeType: 'video/mp4', buffer: Buffer.from(`one ${Date.now()}`) }, { name: 'v2.mp4', mimeType: 'video/mp4', buffer: Buffer.from(`two ${Date.now()}`) }]);
    await page.getByRole('button', { name: 'Seal the list', exact: true }).click();
    await chipIs(page, '2 files', 'Registered', 60000);
    // AC-25/AC-26 on the manifest check: the same receipt reads Registered on screen and in its text report.
    const handover = await page.locator('#manifest-handover-text').inputValue();
    const publicKey = /Public key: ([0-9a-f]{64})/.exec(handover)[1];
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed list' }).click()]);
    const sealedPath = join(OUT, 'two-files.manifest.fseal'); await download.saveAs(sealedPath);
    await go(page, 'verify');
    await page.locator('#check-file').setInputFiles(sealedPath);
    await page.locator('#check-text').fill(handover);
    await page.locator('#check-originals').waitFor({ state: 'attached' });
    await page.locator('.check-options summary').click();
    await page.locator('#check-key').fill(publicKey);
    await page.getByRole('button', { name: 'Check files' }).click();
    const timeRow = page.locator('.manifest-outcome .time-fields > div', { has: page.locator('dt', { hasText: 'Registry acceptance' }) });
    await page.waitForFunction((el) => /^Registered at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(el?.querySelector('dd span')?.textContent || ''), await timeRow.elementHandle({ timeout: 30000 }), { timeout: 30000 })
      .catch(async () => assert.fail(`manifest time row: ${await timeRow.innerText().catch(() => '')}`));
    assert.equal(await timeRow.locator('dd small').innerText(), REGISTERED_BASIS);
    const token = await page.evaluate(() => sessionStorage.getItem('hashwing-registry-token'));
    const value = await timeRow.locator('dd span').innerText();
    const outcome = page.locator('.manifest-outcome');
    for (const button of ['Download text report', 'Download Markdown report', 'Download PDF']) {
      const out = (await exportOf(page, button, token, outcome)).replace(/\s+/g, ' ');
      assert.ok(out.includes(`Registry acceptance: ${value} (${REGISTERED_BASIS})`), `${button}: ${out.slice(0, 1500)}`);
      assert.ok(!out.includes('Not registered') && !out.includes('no registry was used'), button);
    }
    const json = JSON.parse(await exportOf(page, 'Download JSON', token, outcome));
    assert.deepEqual(json.timeProvenance.fields[2], { label: 'Registry acceptance', value, basis: REGISTERED_BASIS });
    await sealMore(page); // the list was downloaded, so no question
    await page.getByLabel('Small file: seal the whole file, up to 45 MiB').check();
  });

  await check('share link: made in the fragment only; a fresh context opens the record without sign-in', async () => {
    await go(page, 'protect');
    const row = await openRow(page, 'flight-a.ulg');
    assert.deepEqual(await row.locator('select[id$="-days"] option').evaluateAll((o) => o.map((x) => x.value)), ['7', '30'], 'share links offer 7 or 30 days only');
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
    // AC-54: a share link lands on "I have a HashWing link", opened, and no file is marked as matching.
    assert.equal(await reviewer.getByLabel('I have a HashWing link').isChecked(), true);
    assert.equal(await reviewer.locator('#verify-link').inputValue(), shareUrl);
    assert.match(await reviewer.locator('.verify-link').innerText(), /Files not checked yet\./);
    assert.equal(await reviewer.locator('.status-label.ok, #verdict-heading').count(), 0, 'a link never marks files verified');
    assert.equal(new URL(reviewer.url()).hash.includes('mode=') ? 'x' : '', '', 'no mode written until the choice changes');
    // AC-67: arrowing through the choice keeps focus on the radio and adds no history entry.
    const historyLength = await reviewer.evaluate(() => history.length);
    await reviewer.getByLabel('I have a HashWing link').focus();
    await reviewer.keyboard.press('ArrowRight');
    assert.equal(await reviewer.getByLabel('I have files').isChecked(), true);
    assert.equal(await reviewer.evaluate(() => document.activeElement?.value), 'files');
    assert.equal(await reviewer.evaluate(() => history.length), historyLength);
    assert.match(reviewer.url(), /[?&]mode=files/);
    // Forced colours: the chosen tab's words keep a visible system colour and its check mark shows (no Highlight fill
    // under HighlightText that the browser repaints to Canvas).
    await reviewer.emulateMedia({ forcedColors: 'active' });
    const chosen = await reviewer.locator('.choice-button:has(input:checked)').evaluate((label) => {
      const style = getComputedStyle(label); const mark = getComputedStyle(label.querySelector('.choice-mark'));
      return { color: style.color, background: style.backgroundColor, mark: mark.color, markShown: mark.visibility, border: parseFloat(style.borderTopWidth) };
    });
    assert.notEqual(chosen.color, chosen.background, `forced colours: chosen label text is visible ${JSON.stringify(chosen)}`);
    assert.notEqual(chosen.mark, chosen.background, `forced colours: check mark visible ${JSON.stringify(chosen)}`);
    assert.equal(chosen.markShown, 'visible');
    assert.ok(chosen.border >= 3, `forced colours: a thick border marks the choice ${JSON.stringify(chosen)}`);
    await reviewer.screenshot({ path: join(OUT, 'chooser-forced-colors.png') });
    await reviewer.emulateMedia({ forcedColors: 'none' });
    await reviewer.getByLabel('I have a HashWing link').check();
    await reviewer.getByRole('button', { name: 'Check the files' }).click(); // the link's record stays for comparison
    await reviewer.waitForFunction(() => document.activeElement?.id === 'check-file');
    await reviewer.getByText('Link record kept for comparison').waitFor();
    assert.equal(await reviewer.locator('.registry-record').count(), 1);
    await reviewer.locator('#check-file').waitFor(); // file checking stays available
    // The client has no account: the result's registry line says so calmly, on its own line; the verdict ignores it.
    await reviewer.locator('#check-file').setInputFiles(flightA.path);
    await reviewer.locator('#check-text').fill(flightA.handover);
    await reviewer.getByRole('button', { name: 'Check files' }).click();
    await reviewer.waitForFunction(() => document.querySelector('#verdict-heading')?.textContent === 'Files match · signer not confirmed', null, { timeout: 60000 });
    await reviewer.waitForFunction(() => /Registry\s+No account needed/.test(document.querySelector('.verdict-lines')?.innerText || ''), null, { timeout: 30000 })
      .catch(async () => assert.fail(`verdict lines: ${await reviewer.locator('.verdict-lines').innerText()}`));
    const clientTime = reviewer.locator('[aria-labelledby="check-title"] .time-fields > div', { has: reviewer.locator('dt', { hasText: 'Registry acceptance' }) });
    assert.deepEqual([await clientTime.locator('dd span').innerText(), await clientTime.locator('dd small').innerText()], ['No account needed', CLIENT_BASIS]);
    assert.ok(!(await reviewer.locator('main').innerText()).includes('Not signed in'), 'the client never reads "Not signed in"');
    for (const width of [320, 1440]) {
      await reviewer.setViewportSize({ width, height: 900 });
      await reviewer.locator('.verdict').screenshot({ path: join(OUT, `client-result-${width}.png`) });
    }
    await reviewer.setViewportSize({ width: 1440, height: 900 });
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
    await reviewer.locator('#check-file').waitFor(); // owner decision 2 (provisional): Verify opens on "I have files"
    assert.equal(await reviewer.getByLabel('I have files').isChecked(), true);
    assert.equal(await reviewer.locator('.registry-record').count(), 0, 'Verify without a link shows no old record');
    await fresh.close();
  });

  await check('share view: a malformed record or a 429 shows the one "temporarily unavailable" message, and the app keeps rendering', async () => {
    const UNAVAILABLE = 'The registry is temporarily unavailable. Try the link again in a few minutes.';
    const good = { head: 'a'.repeat(64), count: 3, key_fingerprint: 'b'.repeat(64), received_at: '2026-11-17T10:00:00Z' };
    const answers = [
      [200, { ...good, count: { a: 1 } }], [200, { ...good, count: -1 }], [200, { ...good, count: '3' }], [200, { ...good, head: '<img src=x>' }],
      [200, { ...good, head: 'A'.repeat(64) }], [200, { ...good, key_fingerprint: ['x'] }], [200, { ...good, received_at: { t: 1 } }], [200, { ...good, received_at: 'yesterday' }],
      [429, { message: 'Too Many Requests' }],
    ];
    const fresh = await newContext();
    const reviewer = watch(await fresh.newPage(), 'reviewer-malformed');
    try {
      for (const [status, body] of answers) {
        const answer = (route) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
        await reviewer.route(`${base}/v1/shares/**`, answer);
        await reviewer.goto('about:blank');
        await reviewer.goto(shareUrl);
        await reviewer.locator('.registry-record').getByText(UNAVAILABLE).waitFor({ timeout: 15000 })
          .catch(async () => assert.fail(`${status} ${JSON.stringify(body)}: ${await reviewer.locator('#root').innerText().catch(() => '(no root)')}`.slice(0, 600)));
        await reviewer.locator('#verify-link').waitFor(); // the rest of the app still renders
        assert.equal(await reviewer.locator('.registry-record dl').count(), 0);
        await reviewer.unroute(`${base}/v1/shares/**`, answer);
      }
    } finally { await fresh.close(); }
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
      assert.deepEqual(await registryLineOfLastSeal(page, 'flight-q.fseal', /^Needs attention$/), ['Needs attention', "Your company's monthly registration limit is reached; this proof is saved and can be exported"]);
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
      await assignRow(page, 'flight-off.ulg');
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
    assert.equal(await page.locator('.registry-announce').textContent(), '', 'the previous owner\'s announcement is cleared');
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
    assert.deepEqual(await registryLineOfLastSeal(page, 'flight-admin.fseal', /^Registered, later deleted$/), ['Registered, later deleted', "the registry's statement, not proof of the files; its hosted record was deleted"]);
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
    assert.deepEqual(await registryLineOfLastSeal(page, 'flight-after.fseal', /^Not yet registered$/), ['Not yet registered', "this device's list: Sealed locally"]);
    await go(page, 'protect'); // the list stays on Seal & send; the check ran on Verify
    await page.locator('.registry-more > summary').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export pending proofs' }).click()]);
    const doc = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(doc.format, 'hashwing-outbox-export');
    assert.equal(doc.receipts.length, 1);
    await sleep(500);
    assert.equal((await registerLog('admin-1')).length, adminSends, 'nothing is sent after sign-out');
  });

  await ctx.close();
  await check('registry sign-out in one tab signs out a duplicated tab of the same owner, which then sends nothing', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'tab-a');
      await a.goto(`${flagOn.url}#/app/help`);
      await signIn(a, 'tab-pilot', 'pilot');
      const [b] = await Promise.all([c.waitForEvent('page'), a.evaluate((u) => { window.open(u); }, `${flagOn.url}#/app/help`)]);
      watch(b, 'tab-b');
      await b.locator('#company-registry').getByText('Signed in to the company registry as tab-pilot').waitFor({ timeout: 30000 });
      await a.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
      await b.locator('#registry-token').waitFor({ timeout: 10000 });
      assert.equal(await b.evaluate(() => sessionStorage.getItem('hashwing-registry-token')), null, 'tab B dropped its token');
      const sends = (await registerLog('tab-pilot')).length;
      await sealSmall(b, 'tab-b.ulg');
      await chipIs(b, 'tab-b.ulg', 'Sealed locally');
      await sleep(3000);
      assert.equal((await registerLog('tab-pilot')).length, sends, 'tab B sent nothing after the sign-out in tab A');
    } finally { await c.close(); }
  });


  // Lost work. A local profile in two tabs of one browser shares localStorage; each tab has its own session.
  const profileIn = async (page, email, mode = 'signup') => {
    await page.goto(`${flagOn.url}#/${mode}`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('lost work password 42');
    if (mode === 'signup') await page.getByLabel('Confirm password').fill('lost work password 42');
    await page.locator('#auth-main').getByRole('button', { name: mode === 'signup' ? 'Create account' : 'Log in', exact: true }).click();
    await page.waitForFunction(() => location.hash.startsWith('#/app/'));
  };
  const appLogout = async (page) => {
    const menu = page.locator('.profile-menu');
    if (!(await menu.evaluate((d) => d.open))) await menu.locator('summary').click();
    await menu.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.waitForFunction(() => location.hash === '#/');
  };
  const reloadWarns = (page) => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });

  await check('reload: an unsaved Seal & send result or an unsent proof warns first; once saved and exported, no warning', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'reload');
      await a.goto(`${flagOn.url}#/app/protect`);
      await sealSmall(a, 'reload-flight.ulg');
      assert.equal(await reloadWarns(a), true, 'a fresh seal warns before reload');
      await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: 'Download receipt' }).click()]);
      await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: 'Download sealed file' }).click()]);
      assert.equal(await reloadWarns(a), true, 'a Download click is not proof the save finished');
      // No question after a download; the sign-in gate is where the user says it saved, without downloading again.
      await a.evaluate(() => { location.hash = '/login'; });
      await a.locator('#auth-main').getByText('You started a download of reload-flight.ulg.fseal and reload-flight.ulg.receipt.txt. Did they save?').waitFor();
      await a.locator('#auth-main').getByRole('button', { name: 'I saved both' }).click();
      await a.waitForFunction(() => !document.querySelector('.auth-output-warning'));
      await a.evaluate(() => { location.hash = '/app/protect'; });
      await a.locator('#handover-text').waitFor();
      assert.equal(await reloadWarns(a), false, 'the unsent proof is saved on this device, so nothing is left to lose');
      await a.reload();
      await a.locator('#page-protect').waitFor();
      await chipIs(a, 'Sealed item', 'Sealed locally'); // the file name is memory only; the proof is kept
      await a.getByText('This tab was reloaded, so the files you had chosen are no longer selected. Choose them again.').waitFor();
    } finally { await c.close(); }
  });

  await check('another tab logs this profile out: this tab keeps its unsaved result and unsent proof for one download', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'lost-a'), b = watch(await c.newPage(), 'lost-b');
      await profileIn(a, 'lost-a@example.test');
      await sealSmall(a, 'kept-flight.ulg');
      await profileIn(b, 'lost-a@example.test', 'login');
      await appLogout(b);
      await a.waitForFunction(() => location.hash === '#/');
      const notice = a.locator('.rescue-notice');
      await notice.getByText('You were logged out in another tab. This tab kept work that was not saved yet.').waitFor();
      for (const width of [320, 1440]) {
        await a.setViewportSize({ width, height: 900 });
        await axe(a, `rescue notice ${width}`);
        assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${width}`);
      }
      // A cancelled or blocked download never clears the only copy: the notice stays until the user says it finished.
      const [cancelled] = await Promise.all([a.waitForEvent('download'), notice.getByRole('button', { name: 'Download unsaved work' }).click()]);
      await cancelled.cancel();
      await notice.getByText('Download started: hashwing-unsaved-work.zip. Check your Downloads folder. Did it save?').waitFor();
      assert.equal(await notice.count(), 1, 'the kept work is still here after a cancelled download');
      assert.equal(await reloadWarns(a), true, 'and reload still warns');
      await notice.getByRole('button', { name: 'Discard' }).click();
      await notice.getByText('This deletes the only copy of this work.').waitFor();
      await notice.getByRole('button', { name: 'Keep it' }).click();
      const [download] = await Promise.all([a.waitForEvent('download'), notice.getByRole('button', { name: 'Download again' }).click()]);
      assert.equal(download.suggestedFilename(), 'hashwing-unsaved-work.zip');
      const zip = readFileSync(await download.path()).toString('latin1');
      for (const name of ['kept-flight.ulg.fseal', 'kept-flight.ulg.receipt.txt']) assert.ok(zip.includes(name), `zip has ${name}`);
      await notice.getByRole('button', { name: 'I saved it' }).click();
      await notice.waitFor({ state: 'detached' });
      assert.equal(await reloadWarns(a), false);
      assert.equal(await a.evaluate(() => sessionStorage.getItem('hashwing-registry-token')), null);
      await profileIn(a, 'lost-a@example.test', 'login'); // the unsent proof was saved for this profile, not thrown away
      await a.evaluate(() => { location.hash = '/app/protect'; });
      await chipIs(a, 'Sealed item', 'Sealed locally');
    } finally { await c.close(); }
  });

  await check('another profile signing in, starting the demo or logging out leaves this tab\'s unsent proof and sign-in alone', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'other-a'), b = watch(await c.newPage(), 'other-b'), d = watch(await c.newPage(), 'other-d');
      await profileIn(a, 'keep-a@example.test');
      await sealSmall(a, 'other-flight.ulg');
      await chipIs(a, 'other-flight.ulg', 'Sealed locally');
      await profileIn(d, 'keep-a@example.test', 'login'); // the same profile, signed in to the registry in another tab
      await signIn(d, 'keep-pilot', 'pilot');
      await profileIn(b, 'keep-b@example.test'); // app sign-in
      await appLogout(b); // logout of another profile
      await b.locator('#main').getByRole('link', { name: 'Try a sample' }).click(); // demo entry from the front door
      await b.locator('#page-sandbox').waitFor();
      await profileIn(b, 'keep-b@example.test', 'login'); // account switch from the demo
      await sleep(500);
      assert.ok((await a.evaluate(() => location.hash)).startsWith('#/app/protect'), 'tab A is still in its workspace');
      await chipIs(a, 'other-flight.ulg', 'Sealed locally');
      assert.equal(await a.locator('#handover-text').count(), 1, 'the Seal & send result is still on screen');
      assert.ok(await d.evaluate(() => sessionStorage.getItem('hashwing-registry-token')), 'the registry sign-in in tab D is kept');
      await d.locator('#company-registry').getByText('Signed in to the company registry as keep-pilot').waitFor();
      // AC-61, flag on: the command bar names the signed-in company as a link to Trust; sign-in itself stays on Trust.
      const barLink = d.locator('.commandbar .registry-bar-link');
      await barLink.waitFor();
      assert.equal(await barLink.innerText(), 'Company registry');
      assert.match(await barLink.getAttribute('aria-label'), /^Company registry \(.+\)$/, 'the org id stays in the accessible name');
      assert.equal(await d.locator('.commandbar .registry-signin, .commandbar #company-registry').count(), 0, 'no company sign-in controls in the bar');
      // At 320px the whole label fits (it wraps, never cut off), the profile menu stays on screen, and the page doesn't scroll sideways.
      for (const width of [320, 768, 1440]) {
        await d.setViewportSize({ width, height: 900 });
        const fit = await barLink.evaluate((a) => { const r = a.getBoundingClientRect(), m = document.querySelector('.commandbar .profile-menu > summary')?.getBoundingClientRect();
          // Sub-pixel exact (scrollWidth rounds a 0.3px overflow away while the ellipsis still shows): every line of the label fits its box.
          const cs = getComputedStyle(a), box = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          a.style.textOverflow = 'clip'; const words = document.createRange(); words.selectNodeContents(a);
          const cut = Math.max(...[...words.getClientRects()].map((line) => line.width)) - box; a.style.textOverflow = '';
          return { cut, height: r.height, menuRight: m ? m.right : 0, page: document.documentElement.scrollWidth - innerWidth }; });
        assert.ok(fit.cut <= 0.01, `bar link cut off at ${width}: ${JSON.stringify(fit)}`);
        assert.ok(fit.height >= 44, `bar link target at ${width}: ${JSON.stringify(fit)}`);
        assert.ok(fit.menuRight <= width && fit.page <= 0, `bar at ${width}: ${JSON.stringify(fit)}`);
        await d.locator('.commandbar').screenshot({ path: join(OUT, `bar-link-${width}.png`) });
      }
      await d.setViewportSize({ width: 1440, height: 900 });
    } finally { await c.close(); }
  });

  await check('local logout with unsaved work is held until it is downloaded', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'held');
      await profileIn(a, 'held@example.test');
      await sealSmall(a, 'held-flight.ulg');
      const menu = a.locator('.profile-menu');
      await menu.locator('summary').click();
      assert.equal(await menu.getByRole('button', { name: 'Log out', exact: true }).isDisabled(), true);
      const [started] = await Promise.all([a.waitForEvent('download'), menu.getByRole('button', { name: 'Download unsaved work' }).click()]);
      await started.cancel();
      assert.equal(await menu.getByRole('button', { name: 'Log out', exact: true }).isDisabled(), true, 'a started download alone does not unlock Log out');
      await menu.getByRole('button', { name: 'I saved it' }).click();
      await a.waitForFunction(() => document.activeElement?.classList.contains('profile-logout')); // focus moves on to Log out
      await menu.getByRole('button', { name: 'Log out', exact: true }).click();
      await a.waitForFunction(() => location.hash === '#/');
      await a.goto(`${flagOn.url}#/app/protect`);
      assert.equal(await a.locator('#handover-text').count(), 0, 'the next session does not see the last one\'s result');
    } finally { await c.close(); }
  });


  await check('zip fails: downloading one result\'s files saves only that result; the other stays unsaved and Log out stays locked', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'per-file');
      await a.addInitScript(() => { // force the per-file path: the one-zip download cannot start
        const make = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { if (blob?.type === 'application/zip') throw new Error('blocked in this test'); return make(blob); };
      });
      await profileIn(a, 'per-file@example.test');
      await sealSmall(a, 'part-a.ulg'); // part 1: Seal & send (sealed file + receipt message)
      // Part 2: Seal & send holds one result at a time (R15), so the second unsaved result comes from the Samples sealer.
      await go(a, 'sandbox');
      await a.locator('#workbench-file').setInputFiles({ name: 'part-b.tsv', mimeType: 'text/plain', buffer: Buffer.from(`600\tp ${Date.now()}\n700\tq\n`) });
      await a.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Seal and verify'))?.disabled);
      await a.getByRole('button', { name: 'Seal and verify' }).click();
      await a.waitForFunction(() => document.querySelector('.seal-outputs')?.textContent.includes('Generated from part-b.tsv'), null, { timeout: 30000 });
      const menu = a.locator('.profile-menu');
      await menu.locator('summary').click();
      await menu.getByRole('button', { name: 'Download unsaved work' }).click();
      await menu.getByText(/Couldn't make one download \(blocked in this test\)/).waitFor();
      await Promise.all([a.waitForEvent('download'), menu.getByRole('button', { name: 'part-a.ulg.fseal', exact: true }).click()]);
      await menu.getByText('Download started for 1 of 5 files. Download the rest.').waitFor();
      assert.equal(await menu.getByRole('button', { name: 'I saved these' }).count(), 0, 'no part is complete yet');
      await Promise.all([a.waitForEvent('download'), menu.getByRole('button', { name: 'part-a.ulg.receipt.txt', exact: true }).click()]);
      await menu.getByText('Download started for 2 of 5 files. Download the rest.').waitFor();
      await menu.getByRole('button', { name: 'I saved these' }).click();
      assert.equal(await menu.getByRole('button', { name: 'Log out', exact: true }).isDisabled(), true, 'the Samples result was never downloaded');
      assert.equal(await reloadWarns(a), true);
      await menu.getByRole('button', { name: 'Download unsaved work' }).click();
      await menu.getByRole('button', { name: 'sealed.fseal', exact: true }).waitFor();
      const names = await menu.locator('.unsaved-download .actions-row button').allTextContents();
      assert.deepEqual(names, ['sealed.fseal', 'sealed.receipts', 'sealed-public-key.txt'], 'only the Samples result is left');
    } finally { await c.close(); }
  });

  await check('a large-file result that is not saved warns on reload, survives leaving its page, blocks sign-in until downloaded', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'manifest-kept');
      await a.goto(`${flagOn.url}#/app/protect`);
      await a.locator('#page-protect').waitFor();
      await a.getByLabel('Large files: fingerprint only, files stay where they are').check();
      await a.locator('#manifest-files').setInputFiles([{ name: 'k1.mp4', mimeType: 'video/mp4', buffer: Buffer.from(`k1 ${Date.now()}`) }]);
      await a.getByRole('button', { name: 'Seal the list', exact: true }).click();
      await a.locator('#manifest-handover-text').waitFor({ timeout: 60000 });
      assert.equal(await reloadWarns(a), true, 'an unsaved sealed list warns before reload');
      await a.evaluate(() => { location.hash = '/login'; }); // the panel unmounts; the result must not be dropped with it
      await a.locator('#auth-main').waitFor();
      assert.equal(await a.locator('#auth-main').getByRole('button', { name: 'Log in', exact: true }).isDisabled(), true, 'sign-in waits');
      const [download] = await Promise.all([a.waitForEvent('download'), a.locator('#auth-main').getByRole('button', { name: 'Download unsaved work' }).click()]);
      const zip = readFileSync(await download.path()).toString('latin1');
      assert.match(zip, /hashwing-\d{8}-\d{6}\.manifest\.fseal/, 'the zip holds the sealed list');
      assert.match(zip, /hashwing-\d{8}-\d{6}\.receipt\.txt/, 'and its receipt message');
      await a.locator('#auth-main').getByRole('button', { name: 'I saved it' }).click();
      await a.waitForFunction(() => !document.querySelector('.auth-output-warning'));
      assert.equal(await reloadWarns(a), false);
    } finally { await c.close(); }
  });

  await check('zip fails on #/login: a large-file result downloads file by file, then "I saved" unlocks Log in', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'login-per-file');
      await a.addInitScript(() => { // force the per-file path: the one-zip download cannot start
        const make = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { if (blob?.type === 'application/zip') throw new Error('blocked in this test'); return make(blob); };
      });
      await a.goto(`${flagOn.url}#/app/protect`);
      await a.locator('#page-protect').waitFor();
      await a.getByLabel('Large files: fingerprint only, files stay where they are').check();
      await a.locator('#manifest-files').setInputFiles([{ name: 'z1.mp4', mimeType: 'video/mp4', buffer: Buffer.from(`z1 ${Date.now()}`) }]);
      await a.getByRole('button', { name: 'Seal the list', exact: true }).click();
      await a.locator('#manifest-handover-text').waitFor({ timeout: 60000 });
      await a.evaluate(() => { location.hash = '/login'; });
      const auth = a.locator('#auth-main');
      await auth.waitFor();
      assert.equal(await auth.getByRole('button', { name: 'Log in', exact: true }).isDisabled(), true, 'sign-in waits');
      await auth.getByRole('button', { name: 'Download unsaved work' }).click();
      await auth.getByText(/Couldn't make one download \(blocked in this test\)\. Your work is still here, so download each file on its own\./).waitFor();
      const names = await auth.locator('.unsaved-download .actions-row button').allTextContents();
      assert.ok(names.some((n) => /^hashwing-\d{8}-\d{6}\.manifest\.fseal$/.test(n)) && names.some((n) => /^hashwing-\d{8}-\d{6}\.receipt\.txt$/.test(n)), `per-file buttons: ${names}`);
      for (const [i, name] of names.entries()) {
        await Promise.all([a.waitForEvent('download'), auth.getByRole('button', { name, exact: true }).click()]);
        if (i < names.length - 1) await auth.getByText(`Download started for ${i + 1} of ${names.length} files. Download the rest.`).waitFor();
      }
      await auth.getByText(`Download started for ${names.length} of ${names.length} files. Did they save?`).waitFor();
      assert.equal(await auth.getByRole('button', { name: 'Log in', exact: true }).isDisabled(), true, 'a started download alone does not unlock Log in');
      await auth.getByRole('button', { name: names.length > 2 ? 'I saved them' : 'I saved both' }).click();
      await a.waitForFunction(() => !document.querySelector('.auth-output-warning'));
      assert.equal(await auth.getByRole('button', { name: 'Log in', exact: true }).isDisabled(), false, 'Log in is unlocked');
      assert.equal(await reloadWarns(a), false);
    } finally { await c.close(); }
  });

  await check('a frozen tab that missed the sign-out, and a restored tab with an older saved token, stay signed out', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'freeze-a');
      await a.goto(`${flagOn.url}#/app/help`);
      await signIn(a, 'freeze-pilot', 'pilot');
      const tok = await a.evaluate(() => sessionStorage.getItem('hashwing-registry-token'));
      const [b] = await Promise.all([c.waitForEvent('page'), a.evaluate((u) => { window.open(u); }, `${flagOn.url}#/app/help`)]);
      watch(b, 'freeze-b');
      await b.locator('#company-registry').getByText('Signed in to the company registry as freeze-pilot').waitFor({ timeout: 30000 });
      const cdp = await c.newCDPSession(b);
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      await a.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
      await sleep(500);
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await b.bringToFront();
      await b.locator('#registry-token').waitFor({ timeout: 10000 });
      assert.equal(await b.evaluate(() => sessionStorage.getItem('hashwing-registry-token')), null, 'the frozen tab signed out on waking');
      const d = watch(await c.newPage(), 'restored');
      await d.addInitScript((t) => { sessionStorage.setItem('hashwing-registry-token', t); sessionStorage.setItem('hashwing-registry-token-at', '1'); }, tok);
      await d.goto(`${flagOn.url}#/app/help`);
      await d.locator('#registry-token').waitFor({ timeout: 10000 });
      await sleep(500);
      assert.equal(await d.locator('#company-registry').getByText('Signed in to the company registry').count(), 0, 'an older saved token is not used after a sign-out');
    } finally { await c.close(); }
  });

  await check('a restored tab of a logged-out profile stays logged out and signed out of the registry (simulated discard)', async () => {
    const c = await newContext();
    try {
      const a = watch(await c.newPage(), 'discard-a'), b = watch(await c.newPage(), 'discard-b');
      await profileIn(a, 'discard@example.test');
      await profileIn(b, 'discard@example.test', 'login');
      await signIn(b, 'discard-pilot', 'pilot');
      const snapshot = await b.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]))));
      assert.ok(JSON.parse(snapshot)['hashwing-registry-token'], 'the snapshot holds the registry sign-in');
      await b.close(); // discarded
      await appLogout(a);
      const d = watch(await c.newPage(), 'discard-d');
      await d.addInitScript((saved) => { // the browser restores the discarded tab's sessionStorage, once
        if (sessionStorage.getItem('__restored')) return;
        for (const [k, v] of Object.entries(JSON.parse(saved))) sessionStorage.setItem(k, v);
        sessionStorage.setItem('__restored', '1');
      }, snapshot);
      await d.goto(`${flagOn.url}#/`);
      await d.locator('#main').waitFor();
      await sleep(500);
      assert.equal(await d.evaluate(() => location.hash), '#/', 'the front door');
      assert.equal(await d.evaluate(() => sessionStorage.getItem('flightseal_session_v1')), null, 'no active profile');
      assert.equal(await d.evaluate(() => sessionStorage.getItem('hashwing-registry-token')), null, 'no registry token');
      await go(d, 'help');
      await d.locator('#registry-token').waitFor({ timeout: 10000 });
      assert.equal(await d.locator('#company-registry').getByText('Signed in to the company registry').count(), 0, 'no registry sign-in');
      // Control: logging in again later, and signing in to the registry, survive a reload.
      await profileIn(d, 'discard@example.test', 'login');
      await signIn(d, 'discard-pilot', 'pilot');
      await d.reload();
      await d.locator('#page-help').waitFor();
      await d.locator('#company-registry').getByText('Signed in to the company registry as discard-pilot').waitFor({ timeout: 10000 });
      assert.equal(await d.evaluate(() => JSON.parse(sessionStorage.getItem('flightseal_session_v1') || 'null')?.kind), 'account', 'still logged in');
      // A tab that missed the logout message (frozen, or hidden) logs out when it is shown again: only the shared mark is
      // written here, with no storage event or broadcast reaching this tab, then the tab gets focus.
      await d.evaluate(() => {
        const { userId } = JSON.parse(sessionStorage.getItem('flightseal_session_v1'));
        localStorage.setItem('flightseal_logouts_v1', JSON.stringify({ [userId]: Date.now() + 1 }));
      });
      await sleep(10);
      await d.evaluate(() => window.dispatchEvent(new Event('focus')));
      await d.waitForFunction(() => location.hash === '#/', null, { timeout: 10000 });
      assert.equal(await d.evaluate(() => sessionStorage.getItem('flightseal_session_v1')), null, 'woken tab: logged out');
      assert.equal(await d.evaluate(() => sessionStorage.getItem('hashwing-registry-token')), null, 'woken tab: registry token dropped');
    } finally { await c.close(); }
  });

  // Jobs with the flag on (R22, R26; AC-56..AC-58): each row's status from this device's registry list (no request),
  // the URL-backed status filter and the row detail. Its own context and owner.
  {
    const jctx = await newContext();
    await jctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(flagOn.url).origin });
    const jp = watch(await jctx.newPage(), 'jobs-flag-on');
    const REG = 'jobs-reg.ulg', ATT = 'jobs-att.ulg', LOC = 'jobs-loc.ulg', ALL = [REG, ATT, LOC];
    const jobRow = (name) => jp.locator('.jobs-table tbody tr:not(.jobs-detail-row)').filter({ has: jp.locator('.jobs-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}\\.fseal$`) }) });
    const jobChip = (name) => jobRow(name).locator('.jobs-status').innerText();
    const shownJobs = async () => (await jp.locator('.jobs-table tbody tr:not(.jobs-detail-row) .jobs-name').allInnerTexts()).sort();
    const statusParam = () => jp.evaluate(() => new URLSearchParams(location.hash.split('?')[1] || '').get('status'));
    const pick = async (label, value) => {
      await jp.locator('#jobs-status-filter').selectOption({ label });
      await jp.waitForFunction((v) => new URLSearchParams(location.hash.split('?')[1] || '').get('status') === v, value);
    };
    const sent = []; // every request to the registry origin from the moment Jobs opens
    let logBefore = 0;
    try {
      await check('Jobs (flag on): each row reads the label "Sealed on this device" shows for that file (Registered, Needs attention, Sealed locally); no "Verified"', async () => {
        await jp.goto(`${flagOn.url}#/app/protect`);
        await jp.locator('#page-protect').waitFor();
        await sealSmall(jp, LOC); // signed out: an unassigned pending proof
        await chipIs(jp, LOC, 'Sealed locally');
        await signIn(jp, 'jobs-pilot', 'pilot');
        await importSeedA(jp);
        await sealSmall(jp, REG);
        await chipIs(jp, REG, 'Registered');
        await go(jp, 'help');
        await jp.getByRole('button', { name: 'Clear key', exact: true }).click();
        await sealSmall(jp, ATT, undefined, { jobRef: 'JOBS-ATT-1' }); // the one-time key: key_not_enrolled
        await chipIs(jp, ATT, 'Needs attention');
        await chipIs(jp, LOC, 'Sealed locally');
        const listed = {};
        for (const n of ALL) listed[n] = await rowOf(jp, n).locator(':scope > summary .status-label').textContent();
        assert.deepEqual(listed, { [REG]: 'Registered', [ATT]: 'Needs attention', [LOC]: 'Sealed locally' });
        await sleep(500);
        logBefore = (await dev('log')).log.length;
        jp.on('request', (r) => { if (r.url().startsWith(base)) sent.push(r.url()); });
        await go(jp, 'jobs');
        await jp.locator('.jobs-table caption').waitFor();
        await jp.waitForFunction(() => document.querySelectorAll('.jobs-status.ok').length === 1, null, { timeout: 10000 });
        for (const n of ALL) assert.equal(await jobChip(n), listed[n], `${n} on Jobs`);
        assert.match(await jobRow(REG).locator('.jobs-status').getAttribute('class'), /\bok\b/);
        assert.match(await jobRow(ATT).locator('.jobs-status').getAttribute('class'), /\bwarn\b/);
        assert.ok(!(await jp.locator('main').innerText()).includes('Verified'), 'Jobs never says Verified');
      });

      await check('Jobs (flag on): the Status filter shows only matching rows, keeps status in the URL across a search, Back restores the previous filter', async () => {
        await pick('Registered', 'registered');
        assert.deepEqual(await shownJobs(), [`${REG}.fseal`]);
        await pick('Needs attention', 'problems');
        assert.deepEqual(await shownJobs(), [`${ATT}.fseal`]);
        await pick('Waiting to send', 'waiting');
        assert.deepEqual(await shownJobs(), [`${LOC}.fseal`]);
        await pick('All', null);
        assert.deepEqual(await shownJobs(), ALL.map((n) => `${n}.fseal`).sort());
        await pick('Registered', 'registered');
        await jp.locator('#jobs-search').fill('jobs-');
        await jp.waitForFunction(() => location.hash === '#/app/jobs?q=jobs-&status=registered');
        assert.deepEqual(await shownJobs(), [`${REG}.fseal`]);
        await jp.goBack();
        await jp.waitForFunction(() => location.hash === '#/app/jobs?status=registered');
        await jp.goBack();
        await jp.waitForFunction(() => location.hash === '#/app/jobs');
        assert.equal(await jp.locator('#jobs-status-filter').inputValue(), '', 'Back restores All');
        assert.equal((await shownJobs()).length, 3);
        await pick('Registered', 'registered');
        await jp.locator('#jobs-search').fill('no-such-job');
        await jp.getByRole('button', { name: 'Clear search' }).click();
        await jp.waitForFunction(() => location.hash === '#/app/jobs?status=registered');
        assert.deepEqual(await shownJobs(), [`${REG}.fseal`], 'Clear search keeps the status');
        await jp.evaluate(() => { location.hash = '/app/jobs?status=bogus'; });
        await jp.locator('.jobs-table caption').waitFor();
        assert.equal(await jp.locator('#jobs-status-filter').inputValue(), '', 'an unknown status reads as All');
        assert.equal((await shownJobs()).length, 3);
      });

      await check('Jobs (flag on): Details opens from the keyboard with job ref, package, items, sealed time, the registry line and its time, and Copy receipt message; no registry request from Jobs', async () => {
        await go(jp, 'jobs');
        assert.equal(await jobChip(REG), 'Registered');
        await jobRow(REG).getByRole('button', { name: `Remove ${REG}.fseal` }).focus();
        await jp.keyboard.press('Tab');
        const details = jobRow(REG).getByRole('button', { name: `Details for ${REG}.fseal` });
        assert.equal(await jp.evaluate(() => document.activeElement?.getAttribute('aria-label')), `Details for ${REG}.fseal`);
        assert.equal(await details.getAttribute('aria-expanded'), 'false');
        await jp.keyboard.press('Enter');
        assert.equal(await details.getAttribute('aria-expanded'), 'true');
        const detail = jp.locator(`#${await details.getAttribute('aria-controls')}`);
        const facts = Object.fromEntries(await detail.locator('dt').evaluateAll((dts) => dts.map((dt) => [dt.textContent, dt.nextElementSibling.textContent])));
        assert.equal(facts['Job ref'], 'None');
        assert.equal(facts.Package, `${REG}.fseal`);
        assert.match(facts.Items, /^1 item · [\d,]+ bytes$/);
        assert.ok(facts.Sealed, 'sealed time');
        assert.match(facts['Registry status'], /^Registered at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\. This is the registry's statement, not proof of the files\.$/, 'the registry\'s time only');
        await detail.getByRole('button', { name: 'Copy receipt message' }).click();
        await jp.getByText('Receipt message copied.').waitFor();
        assert.match(await jp.evaluate(() => navigator.clipboard.readText()), /fseal-receipt v1 count=/);
        await details.focus();
        await jp.keyboard.press('Enter');
        assert.equal(await details.getAttribute('aria-expanded'), 'false');
        assert.equal(await jp.locator('.jobs-detail-row').count(), 0, 'pressing Details again collapses it');
        await jobRow(ATT).getByRole('button', { name: `Details for ${ATT}.fseal` }).click();
        const att = jp.locator('.jobs-detail-row');
        assert.match(await att.innerText(), /JOBS-ATT-1/);
        assert.match(await att.innerText(), /This signing key isn't enrolled for your company yet\..*Updated /s);
        assert.ok(!(await jp.locator('main').innerText()).includes('Verified'));
        await sleep(500);
        assert.deepEqual(sent, [], 'no registry request while Jobs was opened, filtered and expanded');
        assert.equal((await dev('log')).log.length, logBefore, 'the registry saw no request from Jobs');
        await jp.evaluate(() => { location.hash = '/app/jobs?status=registered'; });
        await jp.reload(); // the filter waits for this device's list after the sign-in resumes
        await jp.locator('.jobs-status.ok').waitFor({ timeout: 30000 });
        assert.deepEqual(await shownJobs(), [`${REG}.fseal`]);
        assert.equal(await statusParam(), 'registered');
      });

      await check('Jobs (flag on): axe 0 violations and no horizontal scroll at 320/768/1440 with a filter and an expanded detail; screenshots', async () => {
        await jp.evaluate(() => { location.hash = '/app/jobs?status=waiting'; });
        await jp.locator('.jobs-table caption').waitFor();
        for (const width of [320, 768, 1440]) {
          await jp.setViewportSize({ width, height: 900 });
          const details = jobRow(LOC).getByRole('button', { name: `Details for ${LOC}.fseal` });
          if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
          await jp.locator('.jobs-detail-row').waitFor();
          const overflow = await jp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          assert.ok(overflow <= 0, `jobs@${width}: horizontal scroll ${overflow}px`);
          await axe(jp, `jobs@${width}`);
          await jp.screenshot({ path: join(OUT, `jobs-${width}.png`), fullPage: true });
        }
        await jp.setViewportSize({ width: 1440, height: 900 });
      });

      await check('Jobs (flag on): after registry sign-out the rows stay, the registered one reads "Sealed locally" with the sign-in line; an empty filter offers "Show all jobs"', async () => {
        await go(jp, 'help');
        await jp.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
        await jp.locator('#registry-token').waitFor();
        await go(jp, 'jobs');
        await jp.locator('.jobs-table caption').waitFor();
        assert.equal(await statusParam(), null);
        assert.equal((await shownJobs()).length, 3, 'the local rows are still listed');
        for (const n of ALL) assert.equal(await jobChip(n), 'Sealed locally', `${n} signed out`);
        assert.equal(await jp.locator('.jobs-status.ok, .jobs-status.warn').count(), 0, 'no stale Registered or Needs attention');
        await jobRow(REG).getByRole('button', { name: `Details for ${REG}.fseal` }).click();
        await jp.locator('.jobs-detail-row').getByText("Sign in to the company registry to see this job's registry status.").waitFor();
        await pick('Registered', 'registered');
        await jp.getByText('No jobs with this status.').waitFor();
        await jp.getByRole('button', { name: 'Show all jobs' }).click();
        await jp.waitForFunction(() => location.hash === '#/app/jobs');
        assert.equal((await shownJobs()).length, 3);
        assert.equal(await jp.evaluate(() => document.activeElement?.id), 'jobs-status-filter');
      });
    } finally { await jctx.close(); }
  }

  // Trust: "Your company's keys" (AC-38..AC-40, AC-59), in org orgK so orgA's enrolled SEED_A stays as the checks above need it.
  {
    const kctx = await newContext();
    const kp = watch(await kctx.newPage(), 'company-keys');
    const panel = kp.locator('#company-keys');
    const DAY = String.raw`\d{4}-\d\d-\d\d`;
    const keyRows = () => panel.locator('.company-keys > li');
    const rowsText = async () => (await keyRows().allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
    const waitRows = async (pred, what) => { // polled here: the console's CSP has no 'unsafe-eval'
      for (const end = Date.now() + 15000; Date.now() < end; await sleep(100)) if (pred(await rowsText())) return;
      assert.fail(`${what}: ${JSON.stringify(await rowsText())} / ${await panel.innerText()}`);
    };
    const generate = async () => {
      await go(kp, 'help');
      const before = await kp.locator('.signing-key-controls [role="status"]').innerText().catch(() => '');
      await kp.getByRole('button', { name: 'Generate Ed25519 key' }).click();
      await kp.waitForFunction((b) => { const t = document.querySelector('.signing-key-controls [role="status"]')?.textContent || ''; return /public key [0-9a-f]{64}/.test(t) && t !== b; }, before);
    };
    const shownButtons = async () => panel.locator('button').evaluateAll((bs) => bs.filter((b) => b.offsetParent !== null && !b.closest('dialog')).map((b) => b.textContent));
    const keyPosts = [];
    kp.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/v1/keys') keyPosts.push(JSON.parse(r.postData() || '{}')); });
    try {
      await check('AC-59 (flag on): Trust shows Trusted companies, Your signing key, Company registry, Your company\'s keys, then Trust and limits; signed out, the keys section asks to sign in', async () => {
        await kp.goto(`${flagOn.url}#/app/help`);
        await kp.locator('#page-help').waitFor();
        assert.deepEqual(await kp.locator('main .help-layout .panel-head h2').allInnerTexts(), ['Trusted companies', 'Your signing key', 'Company registry', "Your company's keys", 'Trust and limits', 'Limits']);
        await panel.getByText("Sign in under Company registry to see your company's keys.").waitFor();
        assert.deepEqual(await shownButtons(), []);
      });

      await check('admin, no key loaded: Enroll this key is disabled with the reason; with a generated key, a seal needs attention (key_not_enrolled), Enroll this key makes it Active "by you", and Try again registers it', async () => {
        await signIn(kp, 'keys-admin', 'admin', 3600, 'orgK');
        await panel.getByText('No company key enrolled yet.').waitFor();
        const enrollButton = panel.getByRole('button', { name: 'Enroll this key' });
        assert.equal(await enrollButton.isDisabled(), true);
        await panel.getByText("Load your company's signing key under Your signing key first.").waitFor();
        assert.equal(await enrollButton.getAttribute('aria-describedby'), 'company-keys-load-hint');
        await generate();
        await sealSmall(kp, 'keys-flight.ulg');
        await chipIs(kp, 'keys-flight.ulg', 'Needs attention');
        assert.match(await (await openRow(kp, 'keys-flight.ulg')).innerText(), /This signing key isn't enrolled for your company yet/);
        await go(kp, 'help');
        await enrollButton.waitFor();
        assert.equal(await enrollButton.isDisabled(), false);
        assert.equal(await panel.locator('.button.primary').count(), 1, 'one primary button: Enroll this key');
        await enrollButton.click();
        await waitRows((rows) => rows.length === 1 && new RegExp(`Active Enrolled ${DAY} by you`).test(rows[0]), 'enrolled row');
        await panel.getByText("This key is now your company's active key.").waitFor();
        assert.equal(keyPosts.length, 1);
        assert.deepEqual(Object.keys(keyPosts[0]).sort(), ['nonce', 'public_key', 'signature'], 'only the public key, the nonce and the signature leave the device');
        assert.equal(await panel.getByRole('button', { name: /^(Enroll|Replace) / }).count(), 0, 'the active key has no enroll button');
        await panel.getByText("Only the company computer holds this key. Pilots on other devices seal with a one-time key, which reads 'signer not confirmed'.").waitFor();
        await go(kp, 'protect');
        const row = await openRow(kp, 'keys-flight.ulg');
        await row.getByRole('button', { name: 'Try again' }).click();
        await chipIs(kp, 'keys-flight.ulg', 'Registered');
      });

      await check('replace: the dialog focuses "Keep the current key" and Escape cancels; confirming marks the old row "Replaced on {date}", and "rotated" is nowhere in the page', async () => {
        await generate();
        const replace = panel.getByRole('button', { name: 'Replace with this key' });
        await replace.click();
        const dialog = panel.locator('dialog[open]');
        await dialog.waitFor();
        assert.equal(await kp.evaluate(() => document.activeElement?.textContent), 'Keep the current key');
        await kp.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await kp.evaluate(() => document.activeElement?.textContent), 'Replace with this key', 'focus returns to the button');
        assert.equal(keyPosts.length, 1, 'Escape sent nothing');
        await replace.click();
        await dialog.getByRole('button', { name: 'Replace key' }).click();
        await waitRows((rows) => rows.length === 2 && rows.some((r) => /Active Enrolled .* by you/.test(r)) && rows.some((r) => new RegExp(`Replaced on ${DAY}`).test(r)), 'replaced rows');
        assert.equal(keyPosts[1].confirm_replace, true);
        // the Replace button is gone once its key is active, so focus goes to the section heading, not <body>
        await kp.waitForFunction(() => document.activeElement?.id === 'company-keys-title', null, { timeout: 5000 });
        const html = await kp.evaluate(() => ({ text: document.body.innerText, html: document.documentElement.outerHTML }));
        assert.ok(!/rotated/i.test(html.text) && !/rotated/i.test(html.html), '"rotated" never reaches the page');
      });

      await check('lost response: an enroll whose answer is lost reads as success on the next press (409 key_exists, the loaded key is the active key)', async () => {
        await panel.getByText("This key is now your company's active key.").waitFor();
        await generate();
        assert.equal(await panel.getByText("This key is now your company's active key.").count(), 0, 'the last key\'s message is cleared when another key is loaded');
        const isPost = (url) => new URL(url).pathname === '/v1/keys';
        let dropped = 0;
        const drop = async (route) => {
          if (route.request().method() !== 'POST' || dropped) return route.continue();
          dropped += 1;
          await route.fetch(); // the registry commits it
          await route.abort(); // the browser never sees the answer
        };
        await kp.route(isPost, drop);
        try {
          await panel.getByRole('button', { name: 'Replace with this key' }).click();
          await panel.locator('dialog[open]').getByRole('button', { name: 'Replace key' }).click();
          await panel.getByText("Couldn't reach the company registry. Try again in a few minutes.").waitFor();
        } finally { await kp.unroute(isPost, drop); }
        assert.equal(dropped, 1);
        await panel.getByRole('button', { name: 'Replace with this key' }).click();
        await panel.locator('dialog[open]').getByRole('button', { name: 'Replace key' }).click();
        await panel.getByText("This key is now your company's active key.").waitFor();
        await waitRows((rows) => rows.length === 3 && rows.filter((r) => /Active/.test(r)).length === 1 && rows.filter((r) => /Replaced on/.test(r)).length === 2, 'after the lost response');
        const log = (await dev('log')).log.filter((e) => e.route === 'enroll' && e.org === 'orgK');
        assert.deepEqual(log.map((e) => e.status), [201, 201, 201, 409], 'the second press got key_exists');
        assert.equal(await panel.getByRole('button', { name: /^(Enroll|Replace) / }).count(), 0);
      });

      await check('mark compromised: the dialog focuses "Keep it" and Escape cancels; confirming reads "Marked compromised on {date}"', async () => {
        const replaced = keyRows().filter({ hasText: 'Replaced on' }).first();
        const fp = await replaced.locator('.fingerprint').innerText();
        const trigger = replaced.getByRole('button', { name: 'Mark compromised' });
        await trigger.click();
        const dialog = panel.locator('dialog[open]');
        await dialog.getByText('New receipts signed with it will be refused. Older proofs from it show a warning once the people who check them mark it compromised too.').waitFor();
        assert.equal(await kp.evaluate(() => document.activeElement?.textContent), 'Keep it');
        await axe(kp, 'compromise dialog open');
        await kp.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await kp.evaluate(() => document.activeElement?.textContent), 'Mark compromised');
        await trigger.click();
        await dialog.getByRole('button', { name: 'Mark compromised' }).click();
        const row = keyRows().filter({ hasText: fp });
        await row.getByText(new RegExp(`^Marked compromised on ${DAY}$`)).waitFor();
        await kp.waitForFunction(() => document.activeElement?.id === 'company-keys-title', null, { timeout: 5000 }); // its trigger is gone
        assert.equal(await row.getByRole('button', { name: 'Mark compromised' }).count(), 0, 'no second mark');
      });

      await check('member (pilot, orgK): the list is shown read-only, with no button but Copy', async () => {
        await kp.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
        await panel.getByText("Sign in under Company registry to see your company's keys.").waitFor();
        await signIn(kp, 'keys-pilot', 'pilot', 3600, 'orgK');
        await waitRows((rows) => rows.length === 3, 'member list');
        assert.ok(!(await panel.innerText()).includes('by you'), "the admin's rows aren't the member's");
        const buttons = await shownButtons();
        assert.deepEqual([...new Set(buttons)], ['Copy'], JSON.stringify(buttons));
        assert.equal(buttons.length, 3);
        await kctx.setOffline(true); offline = true;
        try { await panel.getByText("You're offline. Key changes need a connection.").waitFor(); } // members get the reason too
        finally { await kctx.setOffline(false); offline = false; }
      });

      await check('offline: key actions are disabled and the reason is shown', async () => {
        await kp.locator('#company-registry').getByRole('button', { name: 'Sign out' }).click();
        await signIn(kp, 'keys-admin', 'admin', 3600, 'orgK');
        await waitRows((rows) => rows.length === 3 && rows.some((r) => /by you/.test(r)), 'admin list');
        await generate();
        await panel.getByRole('button', { name: 'Replace with this key' }).waitFor();
        await kctx.setOffline(true); offline = true;
        try {
          await panel.getByText("You're offline. Key changes need a connection.").waitFor();
          assert.equal(await panel.getByRole('button', { name: 'Replace with this key' }).isDisabled(), true);
          const marks = panel.getByRole('button', { name: 'Mark compromised' });
          assert.ok((await marks.count()) > 0);
          for (const b of await marks.all()) assert.equal(await b.isDisabled(), true);
        } finally { await kctx.setOffline(false); offline = false; }
        await panel.getByText("You're offline.", { exact: false }).waitFor({ state: 'detached' });
      });

      await check('registry down: the list says it couldn\'t reach the registry, and Try again loads it', async () => {
        const isList = (url) => new URL(url).pathname === '/v1/keys';
        const abort = (route) => (route.request().method() === 'GET' ? route.abort() : route.continue());
        await kp.route(isList, abort);
        try {
          await kp.reload();
          await kp.locator('#page-help').waitFor();
          await panel.getByText("Couldn't reach the company registry. Try again in a few minutes.").waitFor({ timeout: 15000 });
          assert.equal(await panel.getByRole('button', { name: /^(Enroll|Replace) / }).count(), 0, 'no key action without the list');
        } finally { await kp.unroute(isList, abort); }
        await panel.getByRole('button', { name: 'Try again' }).click();
        await waitRows((rows) => rows.length === 3, 'reloaded list');
      });

      await check('company keys: axe 0 violations, no horizontal scroll and 44px buttons at 320/768/1440 with the list shown; Tab reaches the primary button; screenshots', async () => {
        await generate();
        const primary = panel.getByRole('button', { name: 'Replace with this key' });
        await primary.waitFor();
        for (const width of [320, 768, 1440]) {
          await kp.setViewportSize({ width, height: 900 });
          const overflow = await kp.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          assert.ok(overflow <= 0, `company keys@${width}: horizontal scroll ${overflow}px`);
          const small = await panel.locator('button').evaluateAll((bs) => bs.filter((b) => b.offsetParent !== null).map((b) => [b.textContent, b.getBoundingClientRect().height]).filter(([, h]) => h < 44));
          assert.deepEqual(small, [], `company keys@${width}: buttons under 44px`);
          await kp.mouse.move(0, 0); await sleep(300); // nothing hovered while axe reads colours
          await axe(kp, `company keys@${width}`);
          await panel.scrollIntoViewIfNeeded();
          await kp.screenshot({ path: join(OUT, `company-keys-${width}.png`), fullPage: true });
        }
        await kp.setViewportSize({ width: 1440, height: 900 });
        assert.equal(await panel.locator('.button.primary').count(), 1, 'one primary button in the section');
        await primary.hover(); await sleep(300);
        await axe(kp, 'company keys, primary hovered');
        await kp.mouse.move(0, 0);
        await panel.getByRole('button', { name: 'Copy' }).first().focus();
        let reached = false;
        for (let i = 0; i < 12 && !reached; i++) {
          await kp.keyboard.press('Tab');
          reached = await kp.evaluate(() => document.activeElement?.textContent === 'Replace with this key');
        }
        assert.ok(reached, 'Tab reaches Replace with this key');
      });
    } finally { await kctx.close(); }
  }

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

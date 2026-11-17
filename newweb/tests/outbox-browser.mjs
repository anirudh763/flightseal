// Outbox against the real registry App (registry/devserver/server.py over MemoryTable) in Playwright Chromium.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { acquireBrowserLock, releaseBrowserLock } from '../../tests/web/browser-lock.mjs';

const SERVER = fileURLToPath(new URL('../../registry/devserver/server.py', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex');
let base, server, lock, browser;

before(async () => {
  server = spawn(process.env.PYTHON || 'python3', [SERVER, '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  base = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (c) => { out += c; const m = /READY (\S+)/.exec(out); if (m) resolve(m[1]); });
    server.once('exit', (code) => reject(new Error(`dev server exited ${code}`)));
  });
  lock = await acquireBrowserLock();
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
});
after(async () => {
  await browser?.close();
  await releaseBrowserLock(lock);
  server?.kill();
});
beforeEach(() => dev('reset'));

async function dev(path) { return (await fetch(`${base}/__dev/${path}`)).json(); }
const tokenFor = async (org, sub = 'pilot-1') => (await dev(`token?org=${org}&sub=${sub}`)).token;
const receiptFor = async (count, seed = 'A') => (await dev(`receipt?count=${count}&seed=${seed}`)).receipt;
const regs = async (org = 'orgA') => (await dev(`registrations?org=${org}`)).registrations;
const registerLog = async () => (await dev('log')).log.filter((e) => e.route === 'register');

async function harness(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${base}/harness.html`);
  await page.locator('#ready', { hasText: 'ready' }).waitFor();
  return page;
}
async function until(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const rows = (page) => page.evaluate(() => hw.list());
const firstIn = (page, state) => until(async () => { const [r] = await rows(page); return r?.state === state && r; }, state);

test('offline enqueue survives a page close; the reopened outbox registers once when the connection returns', async () => {
  const ctx = await browser.newContext();
  try {
    const [tok, r] = [await tokenFor('orgA'), await receiptFor(1)];
    let page = await harness(ctx);
    await ctx.setOffline(true);
    await page.evaluate(async ([t, line]) => { hw.setToken(t); await hw.open(); await hw.enqueue(line); }, [tok, r]);
    assert.equal((await rows(page))[0].state, 'sealed_local');
    await page.close();
    await ctx.setOffline(false);
    page = await harness(ctx);
    await ctx.setOffline(true);
    await page.evaluate(async (t) => { hw.setToken(t); await hw.open(); }, tok);
    await sleep(300);
    assert.equal((await rows(page))[0].state, 'sealed_local', 'started offline: still queued');
    assert.equal((await registerLog()).length, 0);
    await ctx.setOffline(false);
    const row = await firstIn(page, 'registered');
    const server = await regs();
    assert.equal(server.length, 1);
    assert.equal(row.received_at, server[0].received_at);
    assert.equal((await registerLog()).length, 1);
    await page.reload();
    await page.locator('#ready', { hasText: 'ready' }).waitFor();
    await page.evaluate(async (t) => { hw.setToken(t); await hw.open(); }, tok);
    const [again] = await rows(page);
    assert.equal(again.state, 'registered');
    assert.equal(again.received_at, server[0].received_at);
  } finally { await ctx.close(); }
});

test('commit then dropped connection: retryNow 60 s later keeps the first received_at and one registration', async () => {
  const ctx = await browser.newContext();
  try {
    const [tok, r] = [await tokenFor('orgA'), await receiptFor(2)];
    const page = await harness(ctx);
    await page.evaluate(async (t) => { hw.setToken(t); await hw.open(); }, tok);
    await dev('drop');
    await page.evaluate((line) => hw.enqueue(line), r);
    const waiting = await firstIn(page, 'waiting_for_connection');
    assert.equal(waiting.attempts, 1);
    const [first] = await regs();
    assert.ok(first.received_at);
    await dev('advance?s=60');
    await page.evaluate(() => hw.retryNow());
    const row = await firstIn(page, 'registered');
    assert.equal(row.received_at, first.received_at);
    assert.equal((await regs()).length, 1);
    const log = await registerLog();
    assert.equal(new Set(log.map((e) => e.receipt)).size, 1);
    assert.equal(log[0].dropped, true);
  } finally { await ctx.close(); }
});

test('two tabs of one owner retrying at once make one registration and both list it as registered', async () => {
  const ctx = await browser.newContext();
  try {
    const [tok, r] = [await tokenFor('orgA'), await receiptFor(3)];
    const [a, b] = [await harness(ctx), await harness(ctx)];
    for (const p of [a, b]) await p.evaluate(async (t) => { hw.setToken(t); await hw.open({ manualOnline: true }); }, tok);
    await a.evaluate((line) => hw.enqueue(line), r);
    assert.equal((await rows(b))[0].state, 'sealed_local', 'tab B sees the queued row');
    await Promise.all([a.evaluate(() => hw.retryNow()), b.evaluate(() => hw.retryNow())]);
    await firstIn(a, 'registered');
    await firstIn(b, 'registered');
    assert.equal((await regs()).length, 1);
    assert.equal((await registerLog()).length, 1, 'the Web Lock let only one tab send');
  } finally { await ctx.close(); }
});

test('switching owner mid-registration never sends A\'s receipt with B\'s token, and B sees nothing of A', async () => {
  const ctx = await browser.newContext();
  try {
    const [tokA, tokB, r] = [await tokenFor('orgA'), await tokenFor('orgB', 'pilot-2'), await receiptFor(4)];
    const page = await harness(ctx);
    await page.evaluate(async (t) => { hw.setToken(t); await hw.open(); }, tokA);
    await dev('hold?ms=1500');
    await page.evaluate((line) => hw.enqueue(line), r);
    await firstIn(page, 'registering');
    const status = await page.evaluate(async (t) => { hw.close(); hw.setToken(t); return hw.open(); }, tokB);
    assert.equal(status.storage, 'indexeddb');
    assert.deepEqual(await rows(page), []);
    await sleep(2000); // the held request finishes on the server
    const log = await registerLog();
    assert.equal(log.filter((e) => e.org === 'orgB').length, 0, 'no registration with B\'s token');
    assert.equal(log.filter((e) => e.org === 'orgA' && e.receipt === sha(r)).length, 1);
    assert.deepEqual(await rows(page), []);
    assert.equal((await regs('orgB')).length, 0);
  } finally { await ctx.close(); }
});

test('IndexedDB open throws: export is offered and holds the receipt line', async () => {
  const ctx = await browser.newContext();
  try {
    const [tok, r] = [await tokenFor('orgA'), await receiptFor(5)];
    const page = await harness(ctx);
    await ctx.setOffline(true);
    const status = await page.evaluate(async ([t, line]) => { hw.setToken(t); await hw.open({ brokenIdb: true }); await hw.enqueue(line); return hw.status(); }, [tok, r]);
    assert.equal(status.storage, 'memory');
    assert.equal(status.exportOffered, true);
    const out = await page.evaluate(() => hw.exportPending());
    assert.equal(out.ok, true);
    assert.ok(JSON.parse(out.text).receipts.includes(r));
  } finally { await ctx.close(); }
});

test('a withdrawn share stays withdrawn when a fresh profile re-registers the same receipt', async () => {
  const one = await browser.newContext();
  const two = await browser.newContext();
  try {
    const [tok, r] = [await tokenFor('orgA'), await receiptFor(6)];
    const p1 = await harness(one);
    await p1.evaluate(async ([t, line]) => { hw.setToken(t); await hw.open(); await hw.enqueue(line); }, [tok, r]);
    const first = await firstIn(p1, 'registered');
    const share = await p1.evaluate((rid) => hw.client.createShare(rid, 30), first.registration_id);
    assert.equal(share.ok, true);
    const link = `${base}/v1/shares/${share.data.token}`;
    assert.equal((await fetch(link)).status, 200);
    assert.equal((await p1.evaluate((t) => hw.client.withdrawShare(t), share.data.token)).ok, true);
    assert.equal((await fetch(link)).status, 404);

    await dev('advance?s=120');
    const p2 = await harness(two);
    await p2.evaluate(async ([t, line]) => { hw.setToken(t); await hw.open(); await hw.enqueue(line); }, [await tokenFor('orgA'), r]);
    const again = await firstIn(p2, 'registered');
    assert.equal(again.received_at, first.received_at);
    assert.equal(again.registration_id, first.registration_id);
    assert.equal((await fetch(link)).status, 404);
    const server = await regs();
    assert.equal(server.length, 1);
    assert.equal(server[0].shares, 1, 'no new share was created');
    assert.equal((await dev('log')).log.filter((e) => e.route === 'create_share').length, 1);
  } finally { await one.close(); await two.close(); }
});

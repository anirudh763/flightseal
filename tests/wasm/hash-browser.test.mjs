// hashFile() in real Chrome: the Web Worker streams File.slice() reads through OpenSSL SHA-256 in WebAssembly.
// Parity with `openssl dgst -sha256`, cancellation and read failure. FSEAL_LARGE_HASH=1 adds a sparse file larger
// than 2 GiB and prints throughput and memory as JSON (RSS summed over the launched browser's process tree).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile, open, truncate } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, extname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = resolve(new URL('../../docs', import.meta.url).pathname);
const MiB = 1024 * 1024, CHUNK = 4 * MiB;
const dir = await mkdtemp(join(tmpdir(), 'fseal-hash-browser-'));
test.after(() => rm(dir, { recursive: true, force: true }));
const openssl = (path) => execFileSync('openssl', ['dgst', '-sha256', '-r', path], { encoding: 'utf8' }).split(' ')[0];

async function withPage(callback) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname === '/blank') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Hash worker test</title><input id="f" type="file" multiple>');
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + '/')) return res.writeHead(403).end();
    try {
      const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let browser;
  try {
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined);
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}), ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/blank`);
    await callback(page, browser);
  } finally {
    await browser?.close();
    server.closeAllConnections(); await new Promise((done) => server.close(done));
  }
}

test('worker digests equal openssl for the matrix sizes', async () => {
  const paths = [];
  for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 46 * MiB]) {
    const path = join(dir, `m-${size}.bin`); await writeFile(path, randomBytes(size)); paths.push(path);
  }
  await withPage(async (page) => {
    await page.setInputFiles('#f', paths);
    const got = await page.evaluate(async () => {
      const { hashFile } = await import('/wasm/client.mjs');
      const out = [];
      for (const file of document.getElementById('f').files) {
        const progress = [];
        const r = await hashFile(file, { onProgress: (done) => progress.push(done) });
        out.push({ ...r, progress });
      }
      return out;
    });
    got.forEach((r, i) => {
      assert.equal(r.sha256, openssl(paths[i]), paths[i]);
      const size = Number(paths[i].match(/m-(\d+)/)[1]);
      assert.equal(r.bytes, size);
      assert.equal(r.progress.length, Math.ceil(size / CHUNK));
      if (size) assert.equal(r.progress.at(-1), size);
    });
  });
});

test('Cancel after the first progress event rejects AbortError, terminates the worker, and stops progress', async () => {
  const path = join(dir, 'cancel.bin'); await writeFile(path, randomBytes(64 * MiB));
  await withPage(async (page) => {
    await page.setInputFiles('#f', path);
    const r = await page.evaluate(async () => {
      const { hashFile } = await import('/wasm/client.mjs');
      let terminated = 0;
      const terminate = Worker.prototype.terminate;
      Worker.prototype.terminate = function () { terminated++; return terminate.call(this); };
      const controller = new AbortController();
      let progress = 0, afterAbort = 0, error;
      try {
        await hashFile(document.getElementById('f').files[0], { signal: controller.signal, onProgress: () => { if (controller.signal.aborted) afterAbort++; progress++; controller.abort(); } });
      } catch (e) { error = e.name; }
      await new Promise((done) => setTimeout(done, 750));
      return { error, progress, afterAbort, terminated };
    });
    assert.deepEqual(r, { error: 'AbortError', progress: 1, afterAbort: 0, terminated: 1 });
  });
});

test('a file changed on disk after selection rejects with a readable error', async () => {
  const path = join(dir, 'changing.bin'); await writeFile(path, randomBytes(12 * MiB));
  await withPage(async (page) => {
    await page.setInputFiles('#f', path);
    await truncate(path, 5 * MiB);
    const r = await page.evaluate(async () => {
      const { hashFile } = await import('/wasm/client.mjs');
      try { return { ok: await hashFile(document.getElementById('f').files[0]) }; } catch (e) { return { name: e.name, message: e.message }; }
    });
    console.log('read failure as Chrome reports it:', JSON.stringify(r));
    assert.equal(r.ok, undefined, 'no digest is produced');
    assert.equal(r.name, 'Error');
    assert.match(r.message, /^changing\.bin: The requested file could not be read/);
  });
});

test('sparse file larger than 2 GiB: parity, throughput and memory', { skip: process.env.FSEAL_LARGE_HASH !== '1' && 'set FSEAL_LARGE_HASH=1' }, async () => {
  const size = 2 ** 31 + 5 * MiB + 7, path = join(dir, 'large.bin');
  const handle = await open(path, 'w');
  await handle.truncate(size);
  for (const at of [2 ** 31 - 1, 2 ** 31, size - 1]) await handle.write(Buffer.from([0x5a]), 0, 1, at);
  await handle.close();
  const expected = openssl(path);
  await withPage(async (page) => {
    // Playwright's driver runs in this Node process and spawns the browser as its direct child.
    const psRows = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n')
      .map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l); return [Number(m[1]), Number(m[2]), Number(m[3]), m[4]]; });
    const roots = psRows().filter(([, ppid, , comm]) => ppid === process.pid && /chrom/i.test(comm));
    assert.equal(roots.length, 1, `one browser child of this test process: ${JSON.stringify(roots)}`);
    const rootPid = roots[0][0];
    const treeRssKiB = () => {
      const rows = psRows();
      const tree = new Set([rootPid]);
      for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
      return { kib: rows.filter(([pid]) => tree.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0), processes: tree.size };
    };
    await page.setInputFiles('#f', path);
    await page.evaluate(() => import('/wasm/client.mjs'));
    await new Promise((done) => setTimeout(done, 1000));
    const idle = treeRssKiB();
    let peak = idle.kib;
    const timer = setInterval(() => { peak = Math.max(peak, treeRssKiB().kib); }, 250);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    let jsHeapPeak = 0;
    const heapTimer = setInterval(async () => {
      try { const { metrics } = await cdp.send('Performance.getMetrics'); jsHeapPeak = Math.max(jsHeapPeak, metrics.find((m) => m.name === 'JSHeapUsedSize')?.value || 0); } catch {}
    }, 250);
    const start = performance.now();
    let r;
    try { r = await page.evaluate(async () => (await import('/wasm/client.mjs')).hashFile(document.getElementById('f').files[0])); }
    finally { clearInterval(timer); clearInterval(heapTimer); }
    const seconds = (performance.now() - start) / 1000;
    assert.equal(r.sha256, expected);
    assert.equal(r.bytes, size);
    const report = { bytes: size, seconds: +seconds.toFixed(2), MiBps: +(size / MiB / seconds).toFixed(1), idleRssMiB: +(idle.kib / 1024).toFixed(1), peakRssMiB: +(peak / 1024).toFixed(1), deltaRssMiB: +((peak - idle.kib) / 1024).toFixed(1), wasmHeapBytes: r.wasmHeapBytes, jsHeapUsedMiB: +(jsHeapPeak / MiB).toFixed(1), browserProcesses: idle.processes };
    console.log(JSON.stringify(report));
  });
});

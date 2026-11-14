import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = resolve(new URL('../../docs', import.meta.url).pathname);

async function withPage(callback) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname === '/blank') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Native bridge test</title>');
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(root + '/')) return res.writeHead(403).end();
    try {
      const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let browser;
  try {
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined);
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/blank`);
    await callback(page);
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

test('browser WORKERFS verifies all sample attacks and produces a native sealed download', async () => {
  await withPage(async page => {
    const results = await page.evaluate(async () => {
      const { verifyFile, sealFile } = await import('/wasm/client.mjs');
      const receipts = await (await fetch('/samples/flight.receipts')).text();
      const key = (await (await fetch('/samples/pubkey.txt')).text()).trim();
      const verdicts = [];
      for (const name of ['intact', 'tampered', 'rewritten', 'truncated']) {
        const file = await (await fetch(`/samples/${name}.fseal`)).blob();
        verdicts.push((await verifyFile(file, receipts, key)).verdict);
      }
      const sealed = await sealFile(new Blob(['100\tGPS A\n200\tGPS B\n']), { every: 1 });
      const result = await verifyFile(sealed.log, sealed.receipts, sealed.publicKey);
      return { verdicts, records: sealed.records, sealedVerdict: result.verdict, covered: result.covered };
    });
    assert.deepEqual(results, { verdicts: ['intact', 'tampered', 'tampered', 'tampered'], records: 2, sealedVerdict: 'intact', covered: 2 });
  });
});

test('browser cancellation terminates an active operation and accepts a subsequent verification', async () => {
  await withPage(async page => {
    const result = await page.evaluate(async () => {
      const { verifyFile } = await import('/wasm/client.mjs');
      const file = await (await fetch('/samples/intact.fseal')).blob();
      const controller = new AbortController();
      const operation = verifyFile(file, '', '', { signal: controller.signal });
      controller.abort();
      let cancelled;
      try { await operation; } catch (error) { cancelled = error.name; }
      return { cancelled, verdict: (await verifyFile(file)).verdict };
    });
    assert.deepEqual(result, { cancelled: 'AbortError', verdict: 'intact' });
  });
});

test('500 MiB browser file stays within 64 MiB native heap and can be cancelled in flight', { skip: !process.env.FSEAL_LARGE_PROBE }, async () => {
  await withPage(async page => {
    await page.setContent('<input type="file" aria-label="probe file">');
    await page.locator('input').setInputFiles(process.env.FSEAL_LARGE_PROBE);
    const proof = await page.evaluate(async () => {
      const { verifyFile } = await import('/wasm/client.mjs');
      const file = document.querySelector('input').files[0];
      const started = performance.now();
      const result = await verifyFile(file);
      const controller = new AbortController();
      const operation = verifyFile(file, '', '', { signal: controller.signal });
      setTimeout(() => controller.abort(), 250);
      let cancelled;
      try { await operation; } catch (error) { cancelled = error.name; }
      return { bytes: file.size, records: result.records, verdict: result.verdict, heapBytes: result.nativeHeapBytes, elapsedMs: performance.now() - started, cancelled };
    });
    assert.equal(proof.bytes, 500 * 1024 * 1024);
    assert.equal(proof.records, 500);
    assert.equal(proof.verdict, 'intact');
    assert.ok(proof.heapBytes <= 64 * 1024 * 1024);
    assert.equal(proof.cancelled, 'AbortError');
    console.log(JSON.stringify(proof));
  });
});

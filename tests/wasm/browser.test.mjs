import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  let browser, context, profile;
  try {
    const channel = process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'darwin' ? 'chrome' : undefined);
    const options = { headless: true, ...(channel ? { channel } : {}), ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) };
    if (process.env.FSEAL_PERSISTENT_BROWSER === '1') {
      profile = await mkdtemp(resolve(tmpdir(), 'hashwing-browser-'));
      context = await chromium.launchPersistentContext(profile, options);
    } else {
      browser = await chromium.launch(options);
      context = await browser.newContext();
    }
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/blank`);
    await callback(page);
  } finally {
    await context?.close(); await browser?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
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

test('large browser file stays within 64 MiB native heap and can be cancelled in flight', { skip: !process.env.FSEAL_LARGE_PROBE }, async () => {
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
    assert.equal(proof.bytes, (await stat(process.env.FSEAL_LARGE_PROBE)).size);
    assert.equal(proof.records, Number(process.env.FSEAL_LARGE_RECORDS || 500));
    assert.equal(proof.verdict, 'intact');
    assert.ok(proof.heapBytes <= 64 * 1024 * 1024);
    assert.equal(proof.cancelled, 'AbortError');
    console.log(JSON.stringify(proof));
  });
});

test('native ULog browser import uses private storage, verifies, decodes real fields and disposes only its output', async () => {
  await withPage(async page => {
    const result = await page.evaluate(async () => {
      const { importFile, verifyFile } = await import('/wasm/client.mjs');
      const source = await (await fetch('/samples/telemetry-demo.ulg')).blob();
      const imported = await importFile(source, { every: 1 });
      const check = await verifyFile(imported.log, imported.receipts, imported.publicKey);
      const originalBytes = await source.arrayBuffer();
      const sourceSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', originalBytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const samples = imported.telemetry;
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('flightseal-imports-v1');
      await directory.getFileHandle(imported.temporaryOutputName);
      await imported.dispose();
      let gone = false;
      try { await directory.getFileHandle(imported.temporaryOutputName); } catch (error) { gone = error.name === 'NotFoundError'; }
      return { source: imported.source, sourceSha, verdict: check.verdict, covered: check.covered, records: imported.records,
        storage: imported.temporaryStorage, heap: imported.nativeHeapBytes, count: samples.length,
        gps: samples.filter(p => p.latitudeDeg != null && p.longitudeDeg != null).length,
        battery: samples.filter(p => p.batteryV != null).length, gone };
    });
    assert.equal(result.storage, 'browser-private');
    assert.equal(result.verdict, 'intact');
    assert.equal(result.records, result.covered);
    assert.equal(result.source.sha256, result.sourceSha);
    assert.equal(result.source.bytes, (await readFile(new URL('../../docs/samples/telemetry-demo.ulg', import.meta.url))).length);
    assert.equal(result.count, 256);
    assert.equal(result.gps, 128); assert.equal(result.battery, 128);
    assert.equal(result.gone, true);
    assert.ok(result.heap <= 64 * 1024 * 1024);
  });
});

test('malformed native import reports failure and clears its own temporary output', async () => {
  await withPage(async page => {
    const result = await page.evaluate(async () => {
      const { importFile } = await import('/wasm/client.mjs');
      let message = '';
      try { await importFile(new Blob(['not a ULog file at all'])); } catch (error) { message = error.message; }
      const root = await navigator.storage.getDirectory();
      let remaining = 0;
      try { const dir = await root.getDirectoryHandle('flightseal-imports-v1'); for await (const entry of dir.values()) remaining++; } catch (error) { if (error.name !== 'NotFoundError') throw error; }
      return { message, remaining };
    });
    assert.match(result.message, /ULog/);
    assert.equal(result.remaining, 0);
  });
});

test('temporary-output ownership protects active tabs and recovers files after the owner closes', async () => {
  await withPage(async page => {
    const name = await page.evaluate(async () => {
      const { importFile } = await import('/wasm/client.mjs');
      window.ownedImport = await importFile(await (await fetch('/samples/telemetry-demo.ulg')).blob());
      return window.ownedImport.temporaryOutputName;
    });
    const second = await page.context().newPage();
    await second.goto(page.url());
    const active = await second.evaluate(async (name) => {
      const { recoverTemporaryOutputs } = await import('/wasm/client.mjs');
      const removed = await recoverTemporaryOutputs();
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('flightseal-imports-v1');
      return { removed, exists: !!(await directory.getFileHandle(name)) };
    }, name);
    assert.deepEqual(active, { removed: 0, exists: true });
    await page.close();
    // Closing a renderer and releasing its browser-process locks are asynchronous.
    await second.waitForFunction(async name => {
      const { held } = await navigator.locks.query();
      return !held.some(lock => lock.name === `flightseal-output:${name}`);
    }, name, { timeout: 5000 });
    const recovered = await second.evaluate(async () => {
      const { recoverTemporaryOutputs } = await import('/wasm/client.mjs');
      return recoverTemporaryOutputs();
    });
    assert.equal(recovered, 1);
    await second.close();
  });
});

test('one-GiB raw ULog import streams to browser storage, verifies and cleans up', { skip: !process.env.FSEAL_LARGE_ULOG }, async () => {
  await withPage(async page => {
    await page.setContent('<input type="file" aria-label="raw ULog">');
    await page.locator('input').setInputFiles(process.env.FSEAL_LARGE_ULOG);
    const proof = await page.evaluate(async () => {
      const { importFile, verifyFile } = await import('/wasm/client.mjs');
      const file = document.querySelector('input').files[0];
      let lastTick = performance.now(), maxGap = 0, ticks = 0;
      const heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - lastTick); lastTick = now; ticks++; }, 20);
      const start = performance.now();
      const imported = await importFile(file, { every: 64 });
      const sealedBytes = imported.log.size;
      const result = await verifyFile(imported.log, imported.receipts, imported.publicKey);
      await imported.dispose();
      clearInterval(heartbeat);
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('flightseal-imports-v1');
      let remaining = 0; for await (const entry of directory.values()) remaining++;
      return { source: imported.source, sealedBytes, storage: imported.temporaryStorage,
        heapBytes: imported.nativeHeapBytes, verifyHeapBytes: result.nativeHeapBytes, verdict: result.verdict,
        covered: result.covered, records: result.records, elapsedMs: performance.now() - start,
        maxHeartbeatGapMs: maxGap, heartbeatTicks: ticks, remaining, browser: navigator.userAgent };
    });
    const expected = JSON.parse(await readFile(process.env.FSEAL_LARGE_ULOG.replace(/\.ulg$/, '.json'), 'utf8'));
    assert.equal(proof.source.bytes, expected.bytes);
    assert.equal(proof.source.sha256, expected.sha256);
    assert.equal(proof.storage, 'browser-private');
    assert.equal(proof.verdict, 'intact'); assert.equal(proof.covered, proof.records);
    assert.ok(proof.sealedBytes > expected.bytes);
    assert.ok(proof.heapBytes <= 64 * 1024 * 1024); assert.ok(proof.verifyHeapBytes <= 64 * 1024 * 1024);
    assert.ok(proof.heartbeatTicks > 10);
    assert.ok(proof.maxHeartbeatGapMs < 250, `Main-thread heartbeat delayed ${proof.maxHeartbeatGapMs}ms`);
    assert.equal(proof.remaining, 0);
    console.log(JSON.stringify(proof));
  });
});

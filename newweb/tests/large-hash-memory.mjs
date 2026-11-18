// Manual, local only: memory while the built console hashes a sparse file larger than 2 GiB, on both Large-files
// paths (Seal, then Check files). Run after `npm --prefix newweb run build`:
//   node newweb/tests/large-hash-memory.mjs [runs=3]
// Baseline: the console page loaded with the SHA-256 worker already created and idle (the page's next
// `new Worker(hash-worker)` is handed that worker). Then RSS of every process in the launched Chrome's tree is sampled
// every 100 ms while hashing. A dedicated worker is a thread of the page's renderer, so its memory is inside the
// renderer's RSS; Chrome has no separate worker process to measure.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, ftruncateSync, writeSync, closeSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { serve } from '../../tests/web/serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright');
const MiB = 1024 * 1024, RUNS = Number(process.argv[2] || 3), TARGET_MiB = 128;
const workerAsset = readdirSync(join(ROOT, '../docs/console/assets')).find((f) => /^hash-worker-.*\.js$/.test(f));
assert.ok(workerAsset, 'build the console first');

const dir = mkdtempSync(join(tmpdir(), 'hashwing-large-hash-'));
const size = 2 ** 31 + 5 * MiB + 7, path = join(dir, 'large.bin');
const fd = openSync(path, 'w');
ftruncateSync(fd, size);
for (const at of [2 ** 31 - 1, 2 ** 31, size - 1]) writeSync(fd, Buffer.from([0x5a]), 0, 1, at);
closeSync(fd);
const expected = execFileSync('openssl', ['dgst', '-sha256', '-r', path], { encoding: 'utf8' }).split(' ')[0];

const ps = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n')
  .map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l); return { pid: +m[1], ppid: +m[2], kib: +m[3], cmd: m[4] }; });
const kind = (cmd) => {
  const type = /--type=([\w-]+)/.exec(cmd)?.[1];
  if (!type) return 'browser';
  return type === 'utility' ? (/--utility-sub-type=([\w.]+)/.exec(cmd)?.[1] || 'utility').replace(/\.mojom\./, ' ') : type;
};

async function measure(page, rootPid, start, done) {
  const sample = () => {
    const rows = ps(), tree = new Set([rootPid]);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) { tree.add(r.pid); grew = true; } }
    return Object.fromEntries(rows.filter((r) => tree.has(r.pid)).map((r) => [`${kind(r.cmd)} ${r.pid}`, r.kib]));
  };
  const sum = (s) => Object.values(s).reduce((a, b) => a + b, 0);
  await page.evaluate((u) => window.__prewarmHashWorker(u), new URL(`assets/${workerAsset}`, page.url()).href);
  await page.waitForTimeout(3000);
  const base = sample(), peak = { ...base };
  let treePeak = sum(base);
  const timer = setInterval(() => { const s = sample(); treePeak = Math.max(treePeak, sum(s)); for (const [k, v] of Object.entries(s)) peak[k] = Math.max(peak[k] || 0, v); }, 100);
  await page.evaluate(() => { window.__lag = 0; let last = performance.now(); window.__lagTimer = setInterval(() => { const now = performance.now(); window.__lag = Math.max(window.__lag, now - last - 50); last = now; }, 50); });
  const t0 = performance.now();
  try { await start(); await done(); } finally { clearInterval(timer); }
  const seconds = (performance.now() - t0) / 1000;
  const lag = await page.evaluate(() => { clearInterval(window.__lagTimer); return window.__lag; });
  const r1 = (k) => +(k / 1024).toFixed(1);
  const processes = Object.keys(peak).map((k) => ({ process: k, idleMiB: r1(base[k] || 0), peakMiB: r1(peak[k]), deltaMiB: r1(peak[k] - (base[k] || 0)) }));
  return { seconds: +seconds.toFixed(2), MiBps: +(size / MiB / seconds).toFixed(1), treeIdleMiB: r1(sum(base)), treePeakMiB: r1(treePeak), treeDeltaMiB: r1(treePeak - sum(base)), sumOfProcessDeltasMiB: r1(Object.keys(peak).reduce((a, k) => a + Math.max(0, peak[k] - (base[k] || 0)), 0)), mainThreadMaxTimerLagMs: Math.round(lag), processes };
}

const { server, url: rootUrl } = await serve(0, '/flightseal');
const results = [];
try {
  for (let run = 1; run <= RUNS; run++) {
    const chromePath = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
    const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
    try {
      const roots = ps().filter((r) => r.ppid === process.pid && /chrom/i.test(r.cmd));
      assert.equal(roots.length, 1, 'one browser child of this process');
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => {
        const Native = window.Worker;
        let warm = null;
        window.__prewarmHashWorker = (u) => { warm = new Native(u, { type: 'module' }); };
        window.Worker = function Worker(u, options) {
          if (warm && String(u).includes('hash-worker')) { const w = warm; warm = null; return w; }
          return new Native(u, options);
        };
        window.Worker.prototype = Native.prototype;
      });
      const page = await context.newPage();
      await page.goto(`${rootUrl}console/#/app/protect`);
      await page.getByLabel('Large files (fingerprint only)').check();
      await page.locator('#manifest-files').setInputFiles(path);
      await page.locator('.manifest-options summary').click();
      await page.getByLabel('Include file names').check();
      const seal = await measure(page, roots[0].pid,
        () => page.getByRole('button', { name: 'Seal', exact: true }).click(),
        () => page.waitForSelector('#manifest-handover-text', { timeout: 600000 }));
      const handover = await page.locator('#manifest-handover-text').inputValue();
      const publicKey = /Public key: ([0-9a-f]{64})/.exec(handover)[1];
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download sealed list' }).click()]);
      const sealedPath = join(dir, `sealed-${run}.manifest.fseal`);
      await download.saveAs(sealedPath);
      const item = /item=1,(\d+),([0-9a-f]{64}),/.exec(readFileSync(sealedPath, 'latin1'));
      assert.deepEqual([Number(item?.[1]), item?.[2]], [size, expected], 'sealed digest equals openssl dgst -sha256');

      await page.locator('#manifest-check-file').setInputFiles(sealedPath);
      await page.locator('#manifest-check-text').fill(handover);
      await page.locator('#manifest-trusted-key').fill(publicKey);
      await page.locator('#manifest-local-files').setInputFiles(path);
      const check = await measure(page, roots[0].pid,
        () => page.getByRole('button', { name: 'Check files' }).click(),
        () => page.waitForSelector('.manifest-table', { timeout: 600000 }));
      const row = await page.locator('.manifest-table tbody tr').first().evaluate((tr) => [...tr.cells].map((td) => td.innerText.trim()));
      assert.equal(row[3].split('\n')[0], 'Matches', `check row: ${JSON.stringify(row)}`);
      results.push({ run, seal, check });
      console.log(JSON.stringify({ run, seal, check }));
    } finally { await browser.close(); }
  }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
// Gate value: each process's own peak minus its own idle, summed. This is never below the same-instant tree delta, so
// another process shrinking (memory compression on a busy machine) cannot hide growth in the renderer.
const worst = Math.max(...results.flatMap((r) => [r.seal.sumOfProcessDeltasMiB, r.check.sumOfProcessDeltasMiB]));
console.log(JSON.stringify({ bytes: size, opensslSha256: expected, runs: results.length, worstSumOfProcessDeltasMiB: worst, targetMiB: TARGET_MiB, gate: worst <= TARGET_MiB ? 'pass' : 'fail' }));
if (worst > TARGET_MiB) process.exitCode = 1;

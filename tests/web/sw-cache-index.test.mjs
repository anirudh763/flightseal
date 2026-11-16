import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../../docs/sw-paths.js', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../../docs/sw.js', import.meta.url), 'utf8');
const scope = 'https://example.test/flightseal/';
const optionalPaths = ['samples/intact.fseal', 'wasm/flightseal.wasm'];
function assetPaths(requiredPaths, optional = optionalPaths) {
  const context = { self: {}, URL };
  vm.runInNewContext(script, context);
  return context.self.flightsealAssetPathSet(requiredPaths, optional, scope);
}

test('service-worker cache index rehydrates relative paths as absolute fetch pathnames', () => {
  assert.match(workerSource, /importScripts\('\.\/sw-paths\.js'\)/);
  assert.match(workerSource, /'redirect\.mjs', 'sw-paths\.js'/, 'the path normalizer is also included in the staged offline shell');
  const requiredPaths = ['console/', 'console/index.html', 'console/assets/index-a1.js', 'console/assets/site-b2.css'];
  const staged = assetPaths(requiredPaths);
  assert.ok(staged.has('/flightseal/console/assets/index-a1.js'));
  assert.ok(staged.has('/flightseal/samples/intact.fseal'));

  // The cache index intentionally stores relative names so it remains scoped.
  const persisted = JSON.stringify({ requiredPaths });
  const restartedWorkerIndex = JSON.parse(persisted);
  const restored = assetPaths(restartedWorkerIndex.requiredPaths);
  for (const path of requiredPaths) assert.ok(restored.has(new URL(path, scope).pathname), `restored required asset ${path}`);
  for (const path of optionalPaths) assert.ok(restored.has(new URL(path, scope).pathname), `restored optional asset ${path}`);
  assert.equal(restored.has('/console/assets/index-a1.js'), false, 'assets outside /flightseal/ are not indexed');
});

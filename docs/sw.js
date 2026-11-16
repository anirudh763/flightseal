// One FlightSeal worker serves the namespaced site or the standalone HashWing host.
// Bump VERSION whenever this policy changes. A waiting revision is activated only after every
// open console tab confirms that it has no active task or unacknowledged output.
const VERSION = '0.4.0-flightseal-console-7';
const ROOT_HOSTING = new URL(self.registration.scope).pathname === '/';
const ASSET_SCOPE = ROOT_HOSTING ? new URL('flightseal/', self.registration.scope).href : self.registration.scope;
const PRODUCT_ROUTES = ['/', '/verify', '/benchmarks', '/system'];
const CACHE_PREFIX = 'flightseal-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const STATUS_URL = new URL('__flightseal_offline_status__', self.registration.scope);
const SHELL_FILES = [
  ...(ROOT_HOSTING ? [] : ['./']), 'index.html', 'redirect.mjs', 'sw-paths.js',
  'console/', 'console/index.html',
  'console/hashwing-icon.svg', 'console/icons/hashwing-192.png', 'console/icons/hashwing-512.png',
  'console/icons/hashwing-512-maskable.png', 'console/icons/apple-touch-icon.png',
  'console/fonts/space-grotesk-latin.woff2', 'console/fonts/JetBrainsMonoVF.woff2',
  'samples/intact.fseal', 'samples/flight.receipts', 'samples/pubkey.txt',
];
importScripts('./sw-paths.js');
const OPTIONAL_FILES = [
  'verifier.js', 'records.mjs', 'wasm/client.mjs', 'wasm/worker.mjs', 'wasm/opfs.mjs',
  'wasm/flightseal.mjs', 'wasm/flightseal.wasm', 'atkinson-hyperlegible-latin-400-normal.woff2',
  'atkinson-hyperlegible-latin-700-normal.woff2', 'OFL-atkinson-hyperlegible.txt', 'favicon.svg',
  'icon-192.png', 'icon-512.png', 'manifest.webmanifest',
  'samples/tampered.fseal', 'samples/rewritten.fseal', 'samples/truncated.fseal',
  'samples/telemetry-demo.ulg', 'samples/telemetry-demo.md', 'samples/px4-intact.fseal',
  'samples/px4-tampered.fseal', 'samples/px4-flight.receipts', 'samples/px4-pubkey.txt',
  'samples/LICENSE-pyulog.txt',
];

function expectedContentType(path) {
  if (/\.wasm$/.test(path)) return 'application/wasm';
  if (/\.(m?js)$/.test(path)) return 'javascript';
  if (/\.css$/.test(path)) return 'text/css';
  if (/\.webmanifest$/.test(path)) return 'manifest';
  if (/\.woff2$/.test(path)) return 'font/woff2';
  if (/\.png$/.test(path)) return 'image/png';
  if (/\.svg$/.test(path)) return 'image/svg+xml';
  if (/\.html$/.test(path) || path.endsWith('/')) return 'text/html';
  if (/\.(txt|md)$/.test(path)) return 'text/plain';
  if (/\.fseal$/.test(path)) return 'application/octet-stream';
  return '';
}

function contentTypeMatches(path, value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase();
  const expected = expectedContentType(path);
  if (expected === 'javascript') return type === 'text/javascript' || type === 'application/javascript';
  if (expected === 'manifest') return type === 'application/manifest+json' || type === 'application/json';
  return !expected || type === expected;
}

function hex(bytes) { return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }

async function fetchChecked(url, expectedHash = '') {
  const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
  if (!response.ok || response.type !== 'basic') throw new Error(`Required offline asset returned HTTP ${response.status}: ${url.pathname}`);
  if (!contentTypeMatches(url.pathname, response.headers.get('content-type'))) throw new Error(`Unexpected content type for required offline asset: ${url.pathname}`);
  if (expectedHash) {
    const actual = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer())));
    if (actual !== expectedHash) throw new Error(`Required offline asset did not match its build manifest: ${url.pathname}`);
  }
  return response;
}

function manifestPath(path) {
  return typeof path === 'string' && /^console\/[A-Za-z0-9_./-]*$/.test(path) && !path.includes('..');
}

async function readBuildManifest() {
  const url = new URL('console/precache.json', ASSET_SCOPE);
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok || response.type !== 'basic' || !contentTypeMatches(url.pathname, response.headers.get('content-type'))) {
    throw new Error('The console build manifest could not be loaded with the expected type.');
  }
  const manifest = await response.json();
  if (!Array.isArray(manifest.files) || manifest.files.some((file) => !manifestPath(file)) ||
      !manifest.sha256 || typeof manifest.sha256 !== 'object') throw new Error('The console build manifest is invalid.');
  for (const file of manifest.files) {
    if (file === 'console/' || file === 'console/index.html') continue;
    if (!/^[a-f0-9]{64}$/.test(manifest.sha256[file] || '')) throw new Error(`The build manifest is missing a valid digest for ${file}.`);
  }
  return manifest;
}

function cacheKey(path) { return new URL(path, ASSET_SCOPE); }

async function checkRequiredAssets(cache) {
  const misses = [];
  for (const path of requiredPaths) if (!(await cache.match(cacheKey(path)))) misses.push(path);
  return { ready: misses.length === 0, misses, version: VERSION };
}

let requiredPaths = [...SHELL_FILES];
let knownAssetPaths = new Set(SHELL_FILES.map((path) => cacheKey(path).pathname));
let cacheIndexPromise;

async function prepareVersionedCache() {
  const manifest = await readBuildManifest();
  const consoleAssets = manifest.files;
  requiredPaths = [...new Set([...SHELL_FILES, ...consoleAssets])];
  knownAssetPaths = self.flightsealAssetPathSet(requiredPaths, OPTIONAL_FILES, ASSET_SCOPE);
  const cache = await caches.open(CACHE);
  for (const path of requiredPaths) {
    const url = cacheKey(path);
    const response = await fetchChecked(url, manifest.sha256[path] || '');
    await cache.put(url, response);
  }
  const optionalMisses = [];
  for (const path of OPTIONAL_FILES) {
    const url = cacheKey(path);
    try { await cache.put(url, await fetchChecked(url)); }
    catch { optionalMisses.push(path); }
  }
  await cache.put(STATUS_URL, new Response(JSON.stringify({ version: VERSION, requiredPaths, optionalMisses }), {
    headers: { 'content-type': 'application/json' },
  }));
  const status = await checkRequiredAssets(cache);
  if (!status.ready) throw new Error(`Offline shell is incomplete: ${status.misses.join(', ')}`);
  return { cache, status, optionalMisses };
}

async function loadCacheIndex(cache) {
  const details = await cache.match(STATUS_URL).then((response) => response?.json()).catch(() => null);
  if (Array.isArray(details?.requiredPaths) && details.requiredPaths.every((path) => typeof path === 'string')) {
    requiredPaths = details.requiredPaths;
    knownAssetPaths = self.flightsealAssetPathSet(requiredPaths, OPTIONAL_FILES, ASSET_SCOPE);
  }
  return details;
}

function ensureCacheIndex(cache) {
  cacheIndexPromise ||= loadCacheIndex(cache);
  return cacheIndexPromise;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      await prepareVersionedCache();
      // No skipWaiting here. First install activates normally; updates remain waiting for consent.
    } catch (error) {
      await caches.delete(CACHE);
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach((client) => client.postMessage({ type: 'flightseal-cache-warning', reason: error?.message || 'Offline preparation failed.' }));
      throw error;
    }
  })());
});

function isConsoleClient(client) {
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin && ((ROOT_HOSTING && PRODUCT_ROUTES.includes(url.pathname)) || url.pathname.startsWith(new URL('console/', ASSET_SCOPE).pathname));
  } catch { return false; }
}

async function askClientBeforeActivation(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 2500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data?.type === 'UPDATE_SAFE' && event.data.safe === true);
    };
    try { client.postMessage({ type: 'UPDATE_CAN_ACTIVATE', version: VERSION }, [channel.port2]); }
    catch { clearTimeout(timer); channel.port1.close(); resolve(false); }
  });
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'GET_OFFLINE_STATUS' || message.type === 'PREPARE_OFFLINE') {
    event.waitUntil((async () => {
      try {
        if (message.type === 'PREPARE_OFFLINE') await prepareVersionedCache();
        const cache = await caches.open(CACHE);
        const details = await loadCacheIndex(cache);
        const status = await checkRequiredAssets(cache);
        const result = { type: 'OFFLINE_STATUS', ...status, optionalMisses: details?.optionalMisses || [] };
        event.ports?.[0]?.postMessage(result);
        event.source?.postMessage(result);
      } catch (error) {
        const result = { type: 'OFFLINE_STATUS', version: VERSION, ready: false, misses: ['cache unavailable'], optionalMisses: [], error: error?.message || 'Offline preparation failed.' };
        event.ports?.[0]?.postMessage(result);
        event.source?.postMessage(result);
      }
    })());
  }
  if (message.type === 'CLEAR_FLIGHTSEAL_CACHES') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      const removed = await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)));
      event.source?.postMessage({ type: 'FLIGHTSEAL_CACHES_CLEARED', removed: removed.filter(Boolean).length });
    })());
  }
  if (message.type === 'ACTIVATE_UPDATE') {
    event.waitUntil((async () => {
      // A waiting worker does not yet control the previous revision's tabs.
      const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(isConsoleClient);
      const answers = await Promise.all(clients.map(askClientBeforeActivation));
      if (answers.some((safe) => !safe)) {
        clients.forEach((client) => client.postMessage({ type: 'UPDATE_DEFERRED', version: VERSION }));
        event.source?.postMessage({ type: 'UPDATE_DEFERRED', version: VERSION });
        return;
      }
      clients.forEach((client) => client.postMessage({ type: 'UPDATE_ACTIVATING', version: VERSION }));
      await self.skipWaiting();
    })());
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await loadCacheIndex(await caches.open(CACHE)); } catch { /* Status requests report unavailable data. */ }
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.filter(isConsoleClient).forEach((client) => client.postMessage({ type: 'CONTROLLER_ACTIVE', version: VERSION }));
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    await ensureCacheIndex(cache);
    const isKnown = knownAssetPaths.has(url.pathname);
    if (isKnown && request.mode !== 'navigate') {
      const key = new URL(url.pathname, self.location.origin);
      const cached = await cache.match(key);
      if (cached) return cached;
      try { return await fetch(request); }
      catch { return Response.error(); }
    }

    if (request.mode === 'navigate') {
      const consolePath = new URL('console/', ASSET_SCOPE).pathname;
      const productRoute = ROOT_HOSTING && PRODUCT_ROUTES.includes(url.pathname);
      const consoleRoute = url.pathname === consolePath || url.pathname === `${consolePath}index.html`;
      const legacyRoute = url.pathname === new URL('./', ASSET_SCOPE).pathname || url.pathname === cacheKey('index.html').pathname;
      if (!productRoute && !consoleRoute && !legacyRoute) {
        try { return await fetch(request); } catch { return Response.error(); }
      }
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch { /* use the version-consistent app shell below */ }
      const fallback = productRoute || consoleRoute ? 'console/index.html' : 'index.html';
      return (await cache.match(cacheKey(fallback))) || Response.error();
    }

    // Unknown requests, report exports, arbitrary fetch URLs and user data stay network-only.
    try { return await fetch(request); }
    catch { return Response.error(); }
  })());
});

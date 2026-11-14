// FlightSeal verifier service worker: keeps the page, its scripts and the samples so the verifier opens offline
// after one visit. Network first, so a new version is used as soon as it is online; the cache is the fallback.
// Files dropped on the page are never sent anywhere and never cached. Bump VERSION when a cached file or the list changes.
const VERSION = "0.2.0-native-console-1";
const CACHE = `flightseal-${VERSION}`;
const FILES = [
  "./", "index.html", "ui.css", "app.css", "theme.js", "app.js", "verifier.js", "scan-worker.js",
  "atkinson-hyperlegible-latin-400-normal.woff2", "atkinson-hyperlegible-latin-700-normal.woff2",
  "OFL-atkinson-hyperlegible.txt", "favicon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest",
  "samples/intact.fseal", "samples/tampered.fseal", "samples/rewritten.fseal", "samples/truncated.fseal",
  "samples/flight.receipts", "samples/pubkey.txt",
  "samples/px4-intact.fseal", "samples/px4-tampered.fseal", "samples/px4-flight.receipts", "samples/px4-pubkey.txt",
  "samples/LICENSE-pyulog.txt",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const response = await fetch("console/precache.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Console cache manifest could not be loaded");
    const manifest = await response.json();
    if (!Array.isArray(manifest.files) || manifest.files.some((file) =>
      typeof file !== "string" || !/^console\/[A-Za-z0-9_./-]*$/.test(file) || file.includes(".."))) {
      throw new Error("Invalid console cache manifest");
    }
    const cache = await caches.open(CACHE);
    await cache.addAll([...FILES, ...manifest.files].map((file) => new Request(file, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("flightseal-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(async (res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          try {
            const cache = await caches.open(CACHE);
            await cache.put(req, copy);
          } catch {
            const clients = await self.clients.matchAll({ type: "window" });
            clients.forEach((client) => client.postMessage({ type: "flightseal-cache-warning" }));
          }
        }
        return res;
      })
      .catch(async () => {
        const c = await caches.open(CACHE);
        // A shared link (#/records/N?sample=..., or an old ?sample=...&record=N) opens the cached page.
        const hit = (await c.match(req, { ignoreSearch: req.mode === "navigate" })) || (req.mode === "navigate" && (await c.match("./")));
        return hit || Response.error();
      }),
  );
});

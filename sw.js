// Yadrcha service worker — makes the app installable and able to open
// offline. Strategy:
//   * everything same-origin: network-first, cached copy when offline
//     (catalog.json also falls back when the network is slow)
// Audio and cover art stream straight from JioSaavn's CDN, uncached.
const VERSION = 'yadrcha-v4';
const SHELL = [
  './', 'index.html', 'assets/app.css', 'assets/icon.svg', 'manifest.webmanifest',
  'src/app.js', 'src/catalog.js', 'src/engine.js', 'src/library.js', 'src/lyrics.js',
  'src/player.js', 'src/util.js', 'src/ui/components.js', 'src/ui/nowplaying.js',
  'src/ui/overlay.js', 'src/ui/pages.js',
  'assets/fonts/symbols.woff2', 'assets/fonts/jakarta-latin.woff2', 'assets/fonts/jakarta-latin-ext.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network-first everywhere, so app code, catalogue and lyrics are always
// current when online. Only catalog.json gets a timeout (a slow network
// shouldn't hold the app on the splash); code falls back to the cache only
// when the network actually fails, so a deploy never mixes old and new
// modules.
function networkFirst(req, timeoutMs) {
  const fromCache = () => caches.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  });
  const safeNet = net.catch(() => fromCache().then((r) => r || Response.error()));
  if (!timeoutMs) return safeNet;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    setTimeout(() => fromCache().then(finish), timeoutMs);
    safeNet.then((r) => { if (!done) { done = true; resolve(r); } });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(networkFirst(e.request, url.pathname.endsWith('catalog.json') ? 4000 : 0));
});

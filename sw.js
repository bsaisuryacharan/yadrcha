// Yadrcha service worker — makes the app open instantly and work as an
// installed PWA. Strategy:
//   * app shell + catalog: network-first (always fresh when online, cached
//     copy when offline or the network is slow)
//   * lyrics shards: cache-first (immutable per song)
// Audio and cover art stream straight from JioSaavn's CDN, uncached.
const VERSION = 'yadrcha-v3';
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

function networkFirst(req, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fromCache = () => caches.match(req, { ignoreSearch: true }).then((r) => r);
    const timer = setTimeout(() => {
      fromCache().then((r) => { if (r && !done) { done = true; resolve(r); } });
    }, timeoutMs);
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      clearTimeout(timer);
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then((r) => { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/lyrics/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  const isCatalog = url.pathname.endsWith('catalog.json');
  e.respondWith(networkFirst(e.request, isCatalog ? 4000 : 2500));
});

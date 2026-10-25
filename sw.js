// Offline support: app shell and food data are cached; Open Food Facts requests always go to the network.
const VERSION = 'kalorit-v1.0.0';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'lib/calc.js',
  'lib/db.js',
  'lib/match.js',
  'lib/off.js',
  'vendor/dexie.min.js',
  'vendor/chart.umd.js',
  'vendor/html5-qrcode.min.js',
  'data/tzameret.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // cache first, then refresh the cache in the background
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((res) => { if (res.ok) cache.put(event.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

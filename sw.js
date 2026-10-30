// Offline support: app shell and food data are cached; Open Food Facts and Supabase requests always go to the network.
const VERSION = 'kalorit-app-v1.4.0';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'lib/calc.js',
  'lib/db.js',
  'lib/store.js',
  'lib/sync.js',
  'lib/remote.js',
  'lib/match.js',
  'lib/off.js',
  'vendor/dexie.min.js',
  'vendor/chart.umd.js',
  'vendor/html5-qrcode.min.js',
  'data/tzameret.json',
  'kalorit.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // only our own old caches: other apps on this origin (hey-usa, nesiya) keep theirs
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kalorit-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Pages and the manifest: network first, so an update reaches the phone on the very next open.
// Everything else (code, food data, icons): cache first, refreshed in the background.
const NETWORK_FIRST = (req, url) => req.mode === 'navigate' || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('/sw.js');

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (NETWORK_FIRST(event.request, url)) {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then(async (res) => {
          if (res.ok) {
            const cache = await caches.open(VERSION);
            await cache.put(event.request.mode === 'navigate' ? 'index.html' : event.request, res.clone());
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(VERSION);
          return (await cache.match(event.request, { ignoreSearch: true }))
            || (await cache.match('index.html'))
            || Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const network = fetch(event.request)
        .then((res) => { if (res.ok) cache.put(event.request, res.clone()); return res; })
        .catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});

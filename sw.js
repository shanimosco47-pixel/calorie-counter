// Offline support: app shell and food data are cached per build; Open Food Facts, Supabase and Claude API requests always go to the network.
const VERSION = 'kalorit-app-v1.11.0';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'build-info.js',
  'lib/calc.js',
  'lib/db.js',
  'lib/store.js',
  'lib/sync.js',
  'lib/remote.js',
  'lib/match.js',
  'lib/off.js',
  'lib/vision.js',
  'lib/update.js',
  'vendor/dexie.min.js',
  'vendor/chart.umd.js',
  'vendor/html5-qrcode.min.js',
  'data/tzameret.json',
  'kalorit.webmanifest',
  'icons/food-192.png',
  'icons/food-512.png',
];

self.addEventListener('install', (event) => {
  // a failed install leaves no half-filled cache behind (the updater would take it for installed)
  event.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .catch(async (err) => { await caches.delete(VERSION); throw err; })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // only our own old caches: other apps on this origin (hey-usa, nesiya) keep theirs
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('kalorit-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page and its code always come from the same build: the page from this build's cache (network
// only if missing), so a newer deploy's markup never runs with this build's code. New versions arrive
// through the app's updater (version.json -> new worker -> reload), not file by file.
// The manifest and the worker script itself: network first, so the browser sees updates.
const NETWORK_FIRST = (req, url) => url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('/sw.js');

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return;   // update check: always straight to the server

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => (await cache.match('index.html')) || fetch(event.request))
        .catch(() => Response.error()),
    );
    return;
  }

  if (NETWORK_FIRST(event.request, url)) {
    // a slow network must not hang the app: after 3 s the cached copy is used instead
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
    event.respondWith(
      Promise.race([fetch(event.request, { cache: 'no-cache' }), timeout(3000)])
        .catch(async () => (await (await caches.open(VERSION)).match(event.request, { ignoreSearch: true })) || Response.error()),
    );
    return;
  }

  // Code, data and icons: this build's own cache only. They were all stored together at install, so
  // the running build never mixes in files of a newer deploy; the network is used only for a file the
  // cache lacks. Updates come as a whole new build (new worker, new cache), never file by file.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    }).catch(() => Response.error()),
  );
});

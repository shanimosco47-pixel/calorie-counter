// Retires the service worker that used to control the whole /calorie-counter/ folder.
// The app now lives in app/ with its own worker; this one clears the old caches and unregisters.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => /^kalorit-v\d/.test(k)).map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.navigate(c.url);
  })());
});

/* Production-only worker. Build replaces these two constants with emitted assets. */
const CACHE = '__READER_CACHE__';
const SHELL = __READER_SHELL__;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  // Updates wait for all old windows to close; no skipWaiting during playback.
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    // No skipWaiting: activation follows closure of all older controlled windows.
    for (const key of await caches.keys()) if (key.startsWith('reader-shell-') && key !== CACHE) await caches.delete(key);
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match('/index.html')).then((response) => response || fetch(event.request)));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(url.pathname)).then((response) => response || fetch(event.request)));
  }
});

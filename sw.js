/* Chessy service worker.
 *
 * Update strategy (reliable updates, still fully offline):
 * - Navigations are network-first: online visits always get the newest app
 *   shell; offline falls back to the cached copy.
 * - Assets are stale-while-revalidate: served instantly from cache, refreshed
 *   in the background so the next load is current even if the cache name
 *   wasn't bumped.
 * - The page auto-reloads once when a new service worker takes over (see
 *   index.html); game state survives via localStorage.
 */
const CACHE = 'chessy-v17';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/engine.js',
  './js/ai.js',
  './js/ai-worker.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Delete only our own old caches — the github.io origin is shared with
      // sibling GitHub Pages apps whose caches we must not touch.
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('chessy-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // Every waitUntil() below is called SYNCHRONOUSLY inside this handler:
  // async calls from promise continuations are spec-legal while the event
  // is still extended, but older Safari threw InvalidStateError on them,
  // which would reject respondWith() and break cached loads.

  // Navigations: network-first so an online visit always gets the newest
  // HTML (which also triggers the service-worker update check). Only the app
  // shell itself may be stored as — or served instead of — index.html: a
  // successful navigation to some other same-scope document (README.md,
  // LICENSE, …) must never become the offline fallback.
  if (event.request.mode === 'navigate') {
    const path = new URL(event.request.url).pathname;
    const scope = new URL('./', self.location).pathname;
    const isShell = path === scope || path === scope + 'index.html';
    const network = fetch(event.request);
    // Never cache error pages — they would poison the offline shell.
    const store = network
      .then((response) => (response.ok && isShell
        ? caches.open(CACHE).then((cache) => cache.put('./index.html', response.clone()))
        : undefined))
      .catch(() => undefined);
    event.waitUntil(store);
    event.respondWith(
      network.catch(() => (isShell ? caches.match('./index.html') : caches.match(event.request)))
    );
    return;
  }

  if (new URL(event.request.url).origin !== self.location.origin) return;

  // Assets: stale-while-revalidate — instant from cache, refreshed in the
  // background; falls back to network when not cached, to cache when offline.
  const cachedPromise = caches.match(event.request, { ignoreSearch: true });
  const refresh = cachedPromise.then((cached) =>
    fetch(event.request)
      .then((response) => {
        if (!response.ok) return response;
        return caches.open(CACHE)
          .then((cache) => cache.put(event.request, response.clone()))
          .then(() => response);
      })
      .catch(() => cached));
  // Keep the SW alive until the background refresh (incl. cache write) settles.
  event.waitUntil(refresh.then(() => undefined, () => undefined));
  event.respondWith(cachedPromise.then((cached) => cached || refresh));
});

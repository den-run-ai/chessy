/* Chessy service worker.
 *
 * Update strategy (reliable updates, still fully offline):
 * - RELEASE UNITS (#37): index.html references every executable asset with
 *   this release's ?r= token, and those versioned URLs are cached as
 *   distinct, IMMUTABLE entries (cache-first, never revalidated — GitHub
 *   Pages ignores the query string, so revalidating ?r=rN after a later
 *   deploy would store the newer file under the old release's key). A page
 *   therefore always executes the scripts of its own release — the mixed
 *   state (new HTML + old cached scripts, or the reverse) cannot occur,
 *   with or without an update in flight. The token here and in index.html
 *   must agree; test/browser/sw-update.test.js fails the build if they
 *   drift.
 * - The executables live under assets/ — a ONE-TIME path migration: the
 *   previously deployed worker matches its cache with ignoreSearch, so it
 *   would have served its old js/ and css/ entries for any query-tokened
 *   URL at those paths during the first upgrade. It has no cache entries
 *   for assets/*, so the first new shell's requests fall through to the
 *   network and the very first upgrade is coherent too.
 * - Navigations are network-first: online visits always get the newest app
 *   shell; offline falls back to the cached copy (which then requests its
 *   own release's cached assets).
 * - Unversioned assets (manifest, icons) are stale-while-revalidate.
 * - The page auto-reloads once when a new service worker takes over (see
 *   index.html); game state survives via localStorage.
 */
const RELEASE = 'r51';
const CACHE = 'chessy-' + RELEASE;
const ASSETS = [
  './',
  './index.html',
  './assets/style.css?r=' + RELEASE,
  './assets/engine.js?r=' + RELEASE,
  './assets/ai.js?r=' + RELEASE,
  './assets/ai-worker.js?r=' + RELEASE,
  './assets/analysis-worker.js?r=' + RELEASE,
  './assets/store.js?r=' + RELEASE,
  './assets/app.js?r=' + RELEASE,
  './assets/archive.js?r=' + RELEASE,
  './assets/mini-board.js?r=' + RELEASE,
  './assets/review.js?r=' + RELEASE,
  './assets/analysis-core.js?r=' + RELEASE,
  './assets/analysis-service.js?r=' + RELEASE,
  './assets/analysis-result.js?r=' + RELEASE,
  './assets/moment-selector.js?r=' + RELEASE,
  './assets/moment-scan.js?r=' + RELEASE,
  './assets/pgn.js?r=' + RELEASE,
  './assets/import.js?r=' + RELEASE,
  './assets/data-controls.js?r=' + RELEASE,
  './assets/reflection.js?r=' + RELEASE,
  './assets/train.js?r=' + RELEASE,
  './assets/progress.js?r=' + RELEASE,
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
    // The cached shell also covers HTTP errors, not just rejected fetches:
    // a transient 5xx from the host must not replace a working offline app
    // with an error page. Non-shell documents keep their real status.
    event.respondWith(
      network
        .then((response) => (isShell && !response.ok
          ? caches.match('./index.html').then((cached) => cached || response)
          : response))
        .catch(() => (isShell ? caches.match('./index.html') : caches.match(event.request)))
    );
    return;
  }

  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  // Versioned assets are IMMUTABLE: exact-match from cache (never
  // ignoreSearch — the ?r= token is what keeps releases distinct), and
  // NEVER revalidated. The host ignores the query string, so refreshing
  // ?r=rN after a later release deploys would store the newer file under
  // the old release's key — poisoning the isolation the token exists for.
  // A cache miss consults the request's token (tokens are rN, ordered):
  //   - strictly NEWER release → an update is in flight through this
  //     older worker and the network currently serves exactly those
  //     bytes, so fetch and fill;
  //   - own or OLDER release → the miss FAILS (503). An older release's
  //     cache was deleted by this worker's activation; and even an OWN
  //     token miss (evicted entry) cannot trust the network — a newer
  //     deployment may already be live, and the host ignores the token,
  //     so the fetch could return newer bytes under this release's URL.
  //     Either refill would hand a page mixed code — the exact thing
  //     this design exists to prevent. The app degrades (e.g. its AI
  //     worker falls back to the synchronous path) until the page next
  //     navigates into a coherent release.
  if (reqUrl.searchParams.has('r')) {
    const reqNum = Number((/^r(\d+)$/.exec(reqUrl.searchParams.get('r')) || [])[1]);
    const ownNum = Number((/^r(\d+)$/.exec(RELEASE) || [])[1]);
    const fill = caches.match(event.request).then((cached) => {
      if (cached) return cached;
      if (!(reqNum > ownNum)) {
        return new Response('unavailable release', { status: 503, statusText: 'Service Unavailable' });
      }
      return fetch(event.request).then((response) => {
        if (!response.ok) return response;
        return caches.open(CACHE)
          .then((cache) => cache.put(event.request, response.clone()))
          .catch(() => undefined)
          .then(() => response);
      });
    });
    event.waitUntil(fill.then(() => undefined, () => undefined));
    event.respondWith(fill);
    return;
  }

  // Unversioned assets (manifest, icons): stale-while-revalidate — instant
  // from cache, refreshed in the background; falls back to network when
  // not cached, to cache when offline.
  const cachedPromise = caches.match(event.request);
  const refresh = cachedPromise.then((cached) =>
    fetch(event.request)
      .then((response) => {
        if (!response.ok) return response;
        return caches.open(CACHE)
          .then((cache) => cache.put(event.request, response.clone()))
          // A failed cache write (quota, unavailable storage) must not lose
          // the good network response — only network failures fall back.
          .catch(() => undefined)
          .then(() => response);
      })
      .catch(() => cached));
  // Keep the SW alive until the background refresh (incl. cache write) settles.
  event.waitUntil(refresh.then(() => undefined, () => undefined));
  event.respondWith(cachedPromise.then((cached) => cached || refresh));
});

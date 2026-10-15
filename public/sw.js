/* FinTrack service worker — offline app shell + a safety net for API reads. */
const VERSION = 'v3';
const SHELL_CACHE = `fintrack-shell-${VERSION}`;
const DATA_CACHE = `fintrack-data-${VERSION}`;

const SHELL = [
  '/', '/index.html', '/css/styles.css',
  '/js/app.js', '/js/api.js', '/js/ui.js', '/js/charts.js', '/js/state.js', '/js/offline.js',
  '/js/views/auth.js', '/js/views/dashboard.js', '/js/views/expenses.js', '/js/views/budgets.js',
  '/js/views/goals.js', '/js/views/subscriptions.js', '/js/views/split.js', '/js/views/lab.js',
  '/js/views/settings.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll fails the whole install if any single file 404s, so add leniently.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isApi = (url) => url.pathname.startsWith('/api/');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;            // writes go through the outbox, never the cache
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network, fall back to the cached shell so a cold
  // offline launch still opens the app rather than the browser error page.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  if (isApi(url)) {
    // Never serve a stale answer to an auth or health probe.
    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/health') return;
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(DATA_CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match(request);
        if (cached) {
          // Mark it so the UI can say the figures are from the last sync.
          const body = await cached.blob();
          const headers = new Headers(cached.headers);
          headers.set('x-fintrack-stale', '1');
          return new Response(body, { status: 200, headers });
        }
        return new Response(JSON.stringify({ error: { code: 'OFFLINE', message: 'You are offline and this data has not been loaded before.' } }),
          { status: 503, headers: { 'content-type': 'application/json' } });
      }
    })());
    return;
  }

  // Static assets: cache first, refresh in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      fetch(request).then((fresh) => {
        if (fresh.ok) caches.open(SHELL_CACHE).then((c) => c.put(request, fresh));
      }).catch(() => {});
      return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh.ok) (await caches.open(SHELL_CACHE)).put(request, fresh.clone());
      return fresh;
    } catch {
      return Response.error();
    }
  })());
});

// The page asks the worker to step aside when the user accepts an update.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/* BunkerWatch Service Worker */
const APP_CACHE_PREFIX = 'bunkerwatch-app-';
const APP_VERSION = (self && self.registration && self.registration.scope) ? 'v1' : 'v1';
const CACHE_NAME = `${APP_CACHE_PREFIX}${APP_VERSION}`;

// Core assets to cache (app shell). Keep minimal; runtime will fill more via default requests
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/bunkerwatch-logo.svg',
  '/bunkerwatch-logo-static.svg',
  '/bunkerwatch-logo-white.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(CORE_ASSETS);
    } catch (e) {
      // Ignore failures for optional assets; SW should still install
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(APP_CACHE_PREFIX) && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Network-first for HTML; cache-first for others
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Network-first for navigations
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match('/index.html');
        return cached || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Cache-first for static assets
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      // Only cache successful GETs
      if (request.method === 'GET' && fresh.status === 200) {
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      return cached || Response.error();
    }
  })());
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});



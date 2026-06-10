const CACHE_VERSION = 'radio-bg-v2';
const APP_SHELL = [
  '/',
  '/logo.png',
  '/favicon.png',
  '/favicon.svg',
  '/logo.svg',
  '/manifest.json',
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API/audio, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Network-first for API calls, audio streams, and non-GET requests
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api') ||
    request.url.includes('stream') ||
    request.headers.get('accept')?.includes('audio') ||
    url.protocol === 'icy:' ||
    url.pathname.endsWith('.mp3') ||
    url.pathname.endsWith('.aac') ||
    url.pathname.endsWith('.ogg')
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // Network-first for page navigations so deploys reach users immediately;
  // fall back to the cached copy when offline.
  const isNavigation =
    request.mode === 'navigate' ||
    request.headers.get('accept')?.includes('text/html');
  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && url.origin === self.location.origin) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request).then((response) => {
        // Only cache successful same-origin responses
        if (
          response.ok &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

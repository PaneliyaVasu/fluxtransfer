// FluxTransfer Service Worker
// Version: 3.0.0 — Offline-capable PWA shell cache

const CACHE_NAME = 'fluxtransfer-v3';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/p2p-engine.js',
  '/webrtc-engine.js',
  '/icon.svg',
  '/logo-icon.svg',
  '/logo-icon.png',
  '/zen-icon.png',
  '/site.webmanifest',
  '/zen/zen.js',
  '/zen/zen.css',
  '/zen/games.js',
  '/zen/facts.js',
  '/zen/visuals.js',
  '/download/',
  '/download/index.html',
  '/docs/',
  '/docs/index.html',
  '/security/',
  '/security/index.html',
  '/faq/',
  '/faq/index.html',
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS).catch((err) => {
        console.warn('[SW] Some assets failed to pre-cache:', err);
      });
    })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: Network-first for dynamic requests, Cache-first for static assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Skip WebSocket, signaling, and data-channel traffic
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/signal')) {
    return;
  }

  event.respondWith(
    // Cache-first for static assets (js, css, svg, png, etc.)
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
        }
        return networkResponse;
      }).catch(() => cached);

      // Return cache immediately if we have it, else wait for network
      return cached || fetchPromise;
    })
  );
});

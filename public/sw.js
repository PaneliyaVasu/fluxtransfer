/**
 * FluxTransfer — Offline-First Service Worker
 *
 * Strategy:
 *   • install  → Pre-cache the app shell (HTML, CSS, JS, images, workers)
 *   • fetch    → Cache-first for static assets, network-first for API/WS
 *   • activate → Purge stale cache versions
 *
 * WebSocket (/ws) and API (/api) requests are NEVER cached — they always
 * go to the network so signaling and pairing work correctly.
 */

const CACHE_VERSION = 'flux-v1';

// App-shell assets to pre-cache on install.
// Vite hashed filenames are discovered at runtime via the fetch handler,
// so we only list the known static paths here.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/crypto-worker.js',
  '/hash-worker.js',
  '/opfs-writer-worker.js',
  '/assets/glass-cloud-hero.png',
  '/assets/glass-cloud-hero-dark.png',
  '/assets/liquid-bg-dark.png',
  '/assets/liquid-bg.png',
  '/assets/logo-icon-dark.png',
  '/assets/logo-icon-light.png',
  '/assets/logo-dark-clean.png',
  '/assets/logo-light-clean.png',
  '/assets/logo-dark-transparent.png',
  '/assets/logo-light-transparent.png'
];

// ─── Install ────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  // Skip waiting so the new SW activates immediately on update
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // addAll will fail if any request 404s, so we use individual add()
      // with catch to be resilient to missing optional assets.
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[SW] Failed to pre-cache ${url}:`, err.message);
          })
        )
      );
    })
  );
});

// ─── Activate ───────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ──────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Never intercept WebSocket upgrades
  if (request.headers.get('upgrade') === 'websocket') return;

  // 2. Never cache signaling, API, or WebSocket paths
  if (
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/api') ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:'
  ) {
    return;
  }

  // 3. Only handle GET requests (POST/PUT etc. go to network)
  if (request.method !== 'GET') return;

  // 4. Skip cross-origin requests except Google Fonts
  const isGoogleFont =
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';

  if (url.origin !== self.location.origin && !isGoogleFont) return;

  // 5. Cache-first strategy: serve from cache, fall back to network
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(request)
        .then((networkResponse) => {
          // Only cache successful responses
          if (
            !networkResponse ||
            networkResponse.status !== 200 ||
            networkResponse.type === 'opaque'
          ) {
            return networkResponse;
          }

          // Clone and store in cache for next time
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(request, responseToCache);
          });

          return networkResponse;
        })
        .catch(() => {
          // Offline fallback: if it's a navigation request, serve cached index.html
          if (request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          // Otherwise just fail
          return new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        });
    })
  );
});

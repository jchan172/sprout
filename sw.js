/* Sprout PWA service worker.
   App shell files (HTML/JS/CSS) are network-first so releases reach the phone
   on the next launch; big immutable files stay cache-first. Offline falls back
   to the cache either way. Bump CACHE when this file changes. */
const CACHE = 'sprout-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './who-data.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.indexOf('/api/') === 0) return; // sync API: always hit the network
  // Files that change with releases: revalidate on every launch, cache as fallback.
  const networkFirst = url.pathname === '/' || url.pathname === '/index.html' ||
    url.pathname === '/app.js' || url.pathname === '/styles.css';
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      function network() {
        return fetch(e.request).then(function (res) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return res;
        });
      }
      if (networkFirst) return network().catch(function () { return hit || caches.match('./index.html'); });
      if (hit) return hit; // immutable assets: cache-first
      return network().catch(function () { return caches.match('./index.html'); });
    })
  );
});

const SHELL_CACHE = 'musix-shell-v50';
const AUDIO_CACHE = 'musix-audio-v50';
const COVER_CACHE = 'musix-covers-v50';

const SHELL_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL_ASSETS);
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k !== SHELL_CACHE && k !== AUDIO_CACHE && k !== COVER_CACHE) {
            return caches.delete(k);
          }
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);

  // Never intercept /api/ requests or audio streams so native <audio> follows 302 Drive redirects cleanly
  if (url.pathname.indexOf('/api/') === 0) {
    return;
  }

  if (url.pathname.indexOf('/covers/') === 0 || url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith((async function () {
      const cCache = await caches.open(COVER_CACHE);
      const cached = await cCache.match(e.request);
      if (cached && cached.status === 200) return cached;
      try {
        const netRes = await fetch(e.request);
        if (netRes && netRes.status === 200) {
          cCache.put(e.request, netRes.clone());
        }
        return netRes;
      } catch (err) {
        return cached || caches.match('/icon-512.png');
      }
    })());
    return;
  }

  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request).then(function (netRes) {
        const copy = netRes.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(e.request, copy); });
        return netRes;
      }).catch(function () {
        return caches.match(e.request) || caches.match('/');
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request);
    })
  );
});

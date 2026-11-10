const SHELL_CACHE = 'musix-shell-v9';
const AUDIO_CACHE = 'musix-offline-audio-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k !== SHELL_CACHE && k !== AUDIO_CACHE) {
            return caches.delete(k);
          }
          return null;
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);

  // Serve downloaded songs from Offline Audio Cache first
  if (url.pathname.indexOf('/api/stream/') === 0) {
    e.respondWith(
      caches.open(AUDIO_CACHE).then(function (cache) {
        return cache.match(url.pathname).then(function (cachedRes) {
          if (cachedRes) return cachedRes;
          return fetch(e.request);
        });
      })
    );
    return;
  }

  // Cache song list API for offline startup
  if (url.pathname === '/api/songs') {
    e.respondWith(
      fetch(e.request)
        .then(function (res) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then(function (cache) {
            cache.put('/api/songs', clone);
          });
          return res;
        })
        .catch(function () {
          return caches.match('/api/songs');
        })
    );
    return;
  }

  if (url.pathname.indexOf('/api/') === 0) return;

  e.respondWith(
    fetch(e.request)
      .then(function (res) {
        const clone = res.clone();
        caches.open(SHELL_CACHE).then(function (cache) {
          cache.put(e.request, clone);
        });
        return res;
      })
      .catch(function () {
        return caches.match(e.request);
      })
  );
});

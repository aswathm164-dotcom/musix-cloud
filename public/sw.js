const SHELL_CACHE = 'musix-shell-v23';
const AUDIO_CACHE = 'musix-offline-audio-v1';
const RECENT_AUDIO_CACHE = 'musix-recent-audio-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/fonts/inter-black.woff2',
  '/fonts/poppins-medium.woff2'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.allSettled(ASSETS.map(function (u) { return cache.add(u); }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) {
          if (k !== SHELL_CACHE && k !== AUDIO_CACHE && k !== RECENT_AUDIO_CACHE) {
            return caches.delete(k);
          }
          return null;
        })
      );
    })
  );
  self.clients.claim();
});

async function serveAudioWithRange(request, cachedResponse) {
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return cachedResponse;

  const arrayBuffer = await cachedResponse.arrayBuffer();
  const bytes = /^bytes=(\d+)-(\d+)?$/i.exec(rangeHeader);
  if (!bytes) return cachedResponse;

  const start = parseInt(bytes[1], 10);
  const end = bytes[2] ? parseInt(bytes[2], 10) : arrayBuffer.byteLength - 1;
  const sliced = arrayBuffer.slice(start, end + 1);

  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + arrayBuffer.byteLength,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(sliced.byteLength)
    }
  });
}

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);

  if (url.pathname.indexOf('/api/stream/') === 0) {
    e.respondWith((async function () {
      const offCache = await caches.open(AUDIO_CACHE);
      const offMatch = await offCache.match(url.pathname);
      if (offMatch) return serveAudioWithRange(e.request, offMatch);

      const recCache = await caches.open(RECENT_AUDIO_CACHE);
      const recMatch = await recCache.match(url.pathname);
      if (recMatch) return serveAudioWithRange(e.request, recMatch);

      const netRes = await fetch(e.request);
      if (netRes && netRes.status === 200 && url.searchParams.get('warm') === '1') {
        const clone = netRes.clone();
        recCache.put(url.pathname, clone).catch(function () {});
      }
      return netRes;
    })());
    return;
  }

  if (url.pathname === '/api/songs') {
    e.respondWith(
      fetch(e.request)
        .then(function (res) {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(function (cache) {
              cache.put('/api/songs', clone);
            });
          }
          return res;
        })
        .catch(function () {
          return caches.match('/api/songs');
        })
    );
    return;
  }

  if (url.pathname.indexOf('/api/') === 0) return;

  if (url.pathname.indexOf('/fonts/') === 0) {
    e.respondWith(
      caches.match(e.request).then(function (cached) {
        return cached || fetch(e.request).then(function (res) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(e.request, clone); });
          return res;
        });
      })
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(function (res) {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then(function (cache) {
            cache.put(e.request, clone);
          });
        }
        return res;
      })
      .catch(function () {
        return caches.match(e.request);
      })
  );
});

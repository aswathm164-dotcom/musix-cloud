const SHELL_CACHE = 'musix-shell-v47';
const AUDIO_CACHE = 'musix-audio-v47';
const COVER_CACHE = 'musix-covers-v47';

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

async function serveAudioWithRange(request, cachedResponse) {
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return cachedResponse;
  const buf = await cachedResponse.arrayBuffer();
  const total = buf.byteLength;
  const parts = rangeHeader.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10) || 0;
  const end = parts[1] ? Math.min(parseInt(parts[1], 10), total - 1) : total - 1;
  const sliced = buf.slice(start, end + 1);
  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': String(sliced.byteLength),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);

  if (url.pathname.indexOf('/api/stream/') === 0) {
    e.respondWith((async function () {
      try {
        const offCache = await caches.open(AUDIO_CACHE);
        const offMatch = await offCache.match(url.pathname);
        if (offMatch && offMatch.status === 200) {
          return serveAudioWithRange(e.request, offMatch);
        }
      } catch (err) {}
      return fetch(e.request);
    })());
    return;
  }

  if (url.pathname.indexOf('/api/cover/') === 0 || url.pathname.indexOf('/covers/') === 0) {
    e.respondWith((async function () {
      const cCache = await caches.open(COVER_CACHE);
      const cached = await cCache.match(e.request);
      if (cached && cached.status === 200) return cached;
      try {
        const netRes = await fetch(e.request);
        const ct = (netRes && netRes.headers && netRes.headers.get('content-type')) || '';
        if (netRes && netRes.status === 200 && ct.indexOf('svg') === -1) {
          cCache.put(e.request, netRes.clone());
        }
        return netRes;
      } catch (err) {
        return cached || caches.match('/icon-512.png');
      }
    })());
    return;
  }

  if (url.pathname.indexOf('/api/') === 0) {
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

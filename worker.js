let cachedToken = '';
let cachedExpiry = 0;
let metaFileId = null;

async function getAccessToken(env) {
  if (cachedToken && Date.now() < cachedExpiry - 60000) return cachedToken;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + 50 * 60 * 1000;
  return cachedToken;
}

async function loadCloudDb(token, folderId) {
  const q = "'" + folderId + "' in parents and name = 'musix-metadata.json' and trashed = false";
  const searchRes = await fetch(
    'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name)&pageSize=1',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const searchData = await searchRes.json();
  const file = searchData.files && searchData.files[0];
  if (!file) return { version: 2, updatedAt: Date.now(), records: {}, overrides: {} };
  metaFileId = file.id;
  const contentRes = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + file.id + '?alt=media',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const db = await contentRes.json();
  return {
    version: 2,
    updatedAt: db.updatedAt || Date.now(),
    records: db.records || {},
    overrides: db.overrides || {}
  };
}

async function saveCloudDb(token, folderId, db) {
  db.updatedAt = Date.now();
  db.overrides = db.overrides || {};
  Object.keys(db.records || {}).forEach(id => {
    if (db.records[id] && db.records[id].language) db.overrides[id] = db.records[id].language;
  });
  if (metaFileId) {
    await fetch('https://www.googleapis.com/upload/drive/v3/files/' + metaFileId + '?uploadType=media', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(db)
    });
  } else {
    const boundary = '-------MusixMetaBoundary';
    const meta = JSON.stringify({ name: 'musix-metadata.json', parents: [folderId], mimeType: 'application/json' });
    const body = '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + meta +
                 '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(db) +
                 '\r\n--' + boundary + '--';
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    });
    const created = await res.json();
    if (created.id) metaFileId = created.id;
  }
  return db;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

    if (url.pathname === '/api/ping') {
      return new Response(JSON.stringify({ status: 'awake' }), { headers: jsonHeaders });
    }

    if (url.pathname === '/api/events') {
      return new Response('data: {"type":"connected"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
      });
    }

    if (url.pathname === '/api/artist-image') {
      const name = (url.searchParams.get('name') || '').trim();
      if (!name || name === 'Cloud Artist') return new Response(JSON.stringify({ image: '' }), { headers: jsonHeaders });
      try {
        const dzRes = await fetch('https://api.deezer.com/search/artist?q=' + encodeURIComponent(name) + '&limit=1');
        const dzData = await dzRes.json();
        const pic = dzData.data && dzData.data[0] && (dzData.data[0].picture_big || dzData.data[0].picture_medium);
        if (pic && !pic.includes('/images/artist//')) {
          return new Response(JSON.stringify({ image: pic }), { headers: jsonHeaders });
        }
      } catch (e) {}
      return new Response(JSON.stringify({ image: '' }), { headers: jsonHeaders });
    }

    if (url.pathname === '/api/trending') {
      const lang = (url.searchParams.get('lang') || 'malayalam').toLowerCase();
      const queries = {
        malayalam: 'malayalam songs 2025 2026 sushin shyam jakes bejoy',
        tamil: 'tamil songs 2025 2026 anirudh ravichander',
        hindi: 'hindi songs 2025 2026 arijit singh pritam',
        english: 'top pop hits 2025 2026 the weeknd bruno mars'
      };
      const term = queries[lang] || queries.malayalam;
      const country = lang === 'english' ? 'us' : 'in';
      const itRes = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&country=' + country + '&media=music&entity=song&limit=50');
      const itData = await itRes.json();
      const songs = (itData.results || []).map((item, idx) => ({
        rank: idx + 1,
        trackId: item.trackId,
        title: item.trackName,
        artist: item.artistName || 'Unknown Artist',
        album: item.collectionName || 'Single',
        genre: item.primaryGenreName || 'Music',
        explicit: item.trackExplicitness === 'explicit',
        artwork: (item.artworkUrl100 || '/icon-512.png').replace('100x100bb', '600x600bb'),
        trackViewUrl: item.trackViewUrl || ''
      }));
      return new Response(JSON.stringify({ songs }), { headers: jsonHeaders });
    }

    try {
      const token = await getAccessToken(env);
      const folderId = env.DRIVE_FOLDER_ID;

      if (url.pathname === '/api/drive-token') {
        return new Response(JSON.stringify({ token, folderId }), { headers: jsonHeaders });
      }

      if (url.pathname.startsWith('/api/stream/')) {
        const fileId = url.pathname.replace('/api/stream/', '');
        const directUrl = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media&access_token=' + encodeURIComponent(token);
        return Response.redirect(directUrl, 302);
      }

      if (url.pathname === '/api/songs') {
        const q = "'" + folderId + "' in parents and trashed = false";
        const [filesRes, db] = await Promise.all([
          fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,size,mimeType,createdTime,modifiedTime,appProperties)&orderBy=createdTime desc&pageSize=500', {
            headers: { Authorization: 'Bearer ' + token }
          }),
          loadCloudDb(token, folderId)
        ]);
        const filesData = await filesRes.json();
        const songs = (filesData.files || [])
          .filter(f => f.name !== 'musix-metadata.json')
          .map(f => {
            const rec = db.records[f.id] || {};
            const appProps = f.appProperties || {};
            const lang = rec.language || db.overrides[f.id] || appProps.manualLang || appProps.tagLang || '';
            f.cloudLang = lang;
            f.cloudMeta = Object.assign({ id: f.id, language: lang }, rec);
            return f;
          });
        return new Response(JSON.stringify(songs), { headers: jsonHeaders });
      }

      if (url.pathname === '/api/sync-metadata' && request.method === 'POST') {
        const body = await request.json();
        const db = await loadCloudDb(token, folderId);
        const overrides = body.overrides || {};
        const records = body.records || {};
        Object.keys(overrides).forEach(id => {
          db.records[id] = Object.assign({}, db.records[id], { id, language: overrides[id], updatedAt: Date.now() });
        });
        Object.keys(records).forEach(id => {
          db.records[id] = Object.assign({}, db.records[id], records[id], { id, updatedAt: Date.now() });
        });
        await saveCloudDb(token, folderId, db);
        return new Response(JSON.stringify({ ok: true, overrides: db.overrides, records: db.records }), { headers: jsonHeaders });
      }

      if (url.pathname.match(/^\/api\/songs\/[^/]+\/(language|metadata)$/) && request.method === 'POST') {
        const parts = url.pathname.split('/');
        const fileId = decodeURIComponent(parts[3]);
        const body = await request.json();
        const db = await loadCloudDb(token, folderId);
        db.records[fileId] = Object.assign({}, db.records[fileId], body, { id: fileId, updatedAt: Date.now() });
        await saveCloudDb(token, folderId, db);
        return new Response(JSON.stringify({ ok: true, id: fileId, record: db.records[fileId], overrides: db.overrides, records: db.records }), { headers: jsonHeaders });
      }

      return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
    }
  }
};

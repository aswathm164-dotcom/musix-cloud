const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { Readable } = require('stream');

module.exports = function registerMusixV46Engine(app, drive, rootDir) {
  const STATIC_COVERS_DIR = path.join(rootDir, 'public', 'covers');
  const RUNTIME_COVERS_DIR = path.join(os.tmpdir(), 'musix-covers-v46');
  [STATIC_COVERS_DIR, RUNTIME_COVERS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  });

  global.musixFileMetaCache = global.musixFileMetaCache || {};

  let prebuiltManifest = {};
  let prebuiltSnapshot = [];
  const manifestPath = path.join(STATIC_COVERS_DIR, 'index.json');
  const snapshotPath = path.join(STATIC_COVERS_DIR, 'songs-snapshot.json');

  function reloadPrebuiltFiles() {
    try {
      if (fs.existsSync(manifestPath)) {
        prebuiltManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || {};
      }
    } catch (e) {}
    try {
      if (fs.existsSync(snapshotPath)) {
        prebuiltSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) || [];
      }
    } catch (e) {}
  }
  reloadPrebuiltFiles();

  const songRegistry = {};
  const coverMemoryCache = {};
  const coverInFlight = {};

  const CLEAN_VINYL_FALLBACK_SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">' +
      '<defs>' +
        '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">' +
          '<stop offset="0%" stop-color="#1e1b2e"/>' +
          '<stop offset="50%" stop-color="#151320"/>' +
          '<stop offset="100%" stop-color="#0c0b12"/>' +
        '</linearGradient>' +
        '<radialGradient id="disc" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" stop-color="#2a273f"/>' +
          '<stop offset="65%" stop-color="#14121d"/>' +
          '<stop offset="100%" stop-color="#09080d"/>' +
        '</radialGradient>' +
        '<linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">' +
          '<stop offset="0%" stop-color="#ff2d55"/>' +
          '<stop offset="100%" stop-color="#7928ca"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<rect width="600" height="600" fill="url(#bg)"/>' +
      '<circle cx="300" cy="300" r="220" fill="url(#disc)" stroke="rgba(255,255,255,0.08)" stroke-width="3"/>' +
      '<circle cx="300" cy="300" r="185" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="2"/>' +
      '<circle cx="300" cy="300" r="150" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="2"/>' +
      '<circle cx="300" cy="300" r="115" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="2"/>' +
      '<circle cx="300" cy="300" r="72" fill="url(#accent)"/>' +
      '<circle cx="300" cy="300" r="22" fill="#0f0e17"/>' +
    '</svg>',
    'utf8'
  );

  function parseCleanFilename(rawFilename) {
    const withoutExt = String(rawFilename || '')
      .replace(/\.(mp3|m4a|flac|wav|ogg|aac)$/i, '')
      .replace(/^\d+\s*[\-.]\s*/, '')
      .trim();

    let title = withoutExt;
    let artist = 'Cloud Artist';
    let album = 'Single';

    const dashParts = withoutExt.split(/\s+-\s+/);
    if (dashParts.length >= 2) {
      title = dashParts[0].trim();
      artist = dashParts.slice(1).join(', ').trim();
    } else {
      const featTail = withoutExt.match(/^(.*?\((?:feat|ft|with)[^)]+\))\s+(.+)$/i);
      if (featTail) {
        title = featTail[1].trim();
        artist = featTail[2].trim();
      } else if (/\s+KALEO$/i.test(withoutExt)) {
        title = withoutExt.replace(/\s+KALEO$/i, '').trim();
        artist = 'KALEO';
      }
    }

    const fromMatch = title.match(/^(.*?)\s+From\s+(.+)$/i);
    if (fromMatch) {
      title = fromMatch[1].trim();
      album = fromMatch[2].trim();
    }

    return { title, artist, album };
  }

  function enrichSongList(list) {
    if (!Array.isArray(list)) return [];
    const malRe = /\b(sushin shyam|jakes bejoy|vishnu vijay|vineeth sreenivasan|shaan rahman|rex vijayan|gopi sundar|dabzee|govind vasantha|fejo|vedan|bibin ashok|varkey|nevin thomas|mbl|lil payyan|azwin|chembarathi|sarvam maya|vellarathaaram|komala thaamara|masthishka maranam|delulu|athi bheekara kaamukan|neeye punchiri|chorkk|vazhikatti|puthu mazha|premavathi|akale)\b/i;
    const futureTs = Date.now() + 604800000;

    list.forEach(f => {
      if (!f || !f.id) return;
      if (f.size) {
        global.musixFileMetaCache[f.id] = {
          size: parseInt(f.size, 10),
          mimeType: f.mimeType || 'audio/mpeg'
        };
      }

      f.cloudMeta = f.cloudMeta || {};
      const pre = prebuiltManifest[f.id] || {};
      const fromFile = parseCleanFilename(f.name || pre.title || '');

      const title = pre.title || fromFile.title || f.cloudMeta.title || f.name || 'Unknown';
      const artist = (pre.artist && pre.artist !== 'Cloud Artist')
        ? pre.artist
        : (fromFile.artist !== 'Cloud Artist' ? fromFile.artist : (f.cloudMeta.artist || 'Cloud Artist'));
      const album = (pre.album && pre.album !== 'Single' && pre.album !== 'Cloud Drive')
        ? pre.album
        : (fromFile.album !== 'Single' ? fromFile.album : ((f.cloudMeta.album && f.cloudMeta.album !== 'Cloud Drive') ? f.cloudMeta.album : 'Single'));

      songRegistry[f.id] = { id: f.id, name: f.name || (title + ' - ' + artist + '.mp3'), title, artist, album };

      if (pre.language) {
        f.cloudLang = pre.language;
        f.cloudMeta.language = pre.language;
      } else if (malRe.test((f.name || '') + ' ' + title + ' ' + artist + ' ' + album)) {
        f.cloudLang = 'Malayalam';
        f.cloudMeta.language = 'Malayalam';
      }

      const hasStatic = fs.existsSync(path.join(STATIC_COVERS_DIR, f.id + '.jpg'));
      const coverUrl = hasStatic
        ? ('/covers/' + encodeURIComponent(f.id) + '.jpg?v=46')
        : ('/api/cover/' + encodeURIComponent(f.id) + '?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist) + '&v=46');

      f.cloudMeta.title = title;
      f.cloudMeta.artist = artist;
      f.cloudMeta.album = album;
      f.cloudMeta.coverArt = coverUrl;
      f.cloudMeta.artwork = coverUrl;
      f.cloudMeta.updatedAt = futureTs;
      f.coverArt = coverUrl;
      f.artwork = coverUrl;
    });
    return list;
  }

  // Pre-seed songRegistry from snapshot on boot
  if (prebuiltSnapshot.length > 0) {
    enrichSongList(prebuiltSnapshot);
  }

  // 1. TOP-PRIORITY MIDDLEWARE (Runs BEFORE express.static and BEFORE app.get('/api/songs'))
  let liveDriveSongsCache = null;
  let backgroundSyncInFlight = false;

  app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js') {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }

    if (req.path === '/api/songs') {
      const origJson = res.json.bind(res);
      res.json = function (data) {
        if (Array.isArray(data) && data.length > 0) {
          const enriched = enrichSongList(data);
          liveDriveSongsCache = enriched;
          try {
            fs.writeFileSync(snapshotPath, JSON.stringify(enriched), 'utf8');
            prebuiltSnapshot = enriched;
          } catch (e) {}
          return origJson(enriched);
        }
        return origJson(data);
      };

      // Instant cold-start response: if live cache isn't ready yet and we have a snapshot, serve it in 1ms!
      if (req.query.refresh !== '1' && !liveDriveSongsCache && prebuiltSnapshot.length > 0) {
        if (!backgroundSyncInFlight) {
          backgroundSyncInFlight = true;
          const localPort = process.env.PORT || 3000;
          setTimeout(() => {
            axios.get('http://127.0.0.1:' + localPort + '/api/songs?refresh=1', { timeout: 25000 })
              .catch(() => {})
              .finally(() => { backgroundSyncInFlight = false; });
          }, 100);
        }
        return res.json(prebuiltSnapshot);
      }
    }
    next();
  });

  // Fast static snapshot endpoint for instant client boot
  app.get('/api/songs-instant', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    if (liveDriveSongsCache && liveDriveSongsCache.length > 0) {
      return res.json(liveDriveSongsCache);
    }
    if (prebuiltSnapshot && prebuiltSnapshot.length > 0) {
      return res.json(prebuiltSnapshot);
    }
    const fromManifest = Object.values(prebuiltManifest).map(item => ({
      id: item.id,
      name: (item.title || 'Track') + ' - ' + (item.artist || 'Artist') + '.mp3',
      mimeType: 'audio/mpeg',
      cloudMeta: item
    }));
    return res.json(enrichSongList(fromManifest));
  });

  function rawScanBufferForEmbeddedArt(b) {
    if (!b || b.length < 512) return null;
    const markers = ['APIC', 'covr', 'PICTURE'];
    for (const mk of markers) {
      let idx = b.indexOf(Buffer.from(mk));
      while (idx !== -1) {
        const winEnd = Math.min(b.length, idx + 512);
        for (let i = idx + mk.length; i < winEnd - 4; i++) {
          if (b[i] === 0xFF && b[i + 1] === 0xD8 && b[i + 2] === 0xFF) {
            let endPos = b.length;
            for (let j = b.length - 2; j > i + 1024; j--) {
              if (b[j] === 0xFF && b[j + 1] === 0xD9) {
                endPos = j + 2;
                break;
              }
            }
            const slice = b.subarray(i, endPos);
            if (slice.length > 1024) return { mime: 'image/jpeg', buf: Buffer.from(slice) };
          }
          if (b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4E && b[i + 3] === 0x47) {
            const iend = b.indexOf(Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]), i);
            const endPos = iend !== -1 ? iend + 8 : b.length;
            const slice = b.subarray(i, endPos);
            if (slice.length > 1024) return { mime: 'image/png', buf: Buffer.from(slice) };
          }
        }
        idx = b.indexOf(Buffer.from(mk), idx + 4);
      }
    }
    return null;
  }

  const JUNK_ART_RE = /\b(nursery rhyme|nursery rhymes|for kids|kids songs|kidz bop|kids bop|lullaby|karaoke|tribute|ringtone|8-bit)\b/i;

  function cacheCoverInRam(id, item) {
    const keys = Object.keys(coverMemoryCache);
    if (keys.length >= 25) delete coverMemoryCache[keys[0]];
    coverMemoryCache[id] = item;
  }

  async function resolveGuaranteedCover(fileId, queryTitle, queryArtist) {
    const cleanId = String(fileId || '').replace(/\.(jpg|png|jpeg|webp)$/i, '');
    if (coverMemoryCache[cleanId]) return coverMemoryCache[cleanId];

    const staticPath = path.join(STATIC_COVERS_DIR, cleanId + '.jpg');
    const runtimePath = path.join(RUNTIME_COVERS_DIR, cleanId + '.bin');
    for (const p of [staticPath, runtimePath]) {
      if (fs.existsSync(p)) {
        try {
          const b = fs.readFileSync(p);
          if (b.length > 1024) {
            const mime = (b[0] === 0x89 && b[1] === 0x50) ? 'image/png' : 'image/jpeg';
            const item = { mime, buf: b };
            cacheCoverInRam(cleanId, item);
            return item;
          }
        } catch (e) {}
      }
    }

    if (coverInFlight[cleanId]) return coverInFlight[cleanId];

    coverInFlight[cleanId] = (async () => {
      try {
        try {
          const r1 = await drive.files.get(
            { fileId: cleanId, alt: 'media' },
            { responseType: 'arraybuffer', headers: { Range: 'bytes=0-1048575' } }
          );
          let buf = Buffer.from(r1.data);
          if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
            const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
            const totalTag = Math.min(10 + tagSize + 4096, 6 * 1024 * 1024);
            if (totalTag > buf.length) {
              const r2 = await drive.files.get(
                { fileId: cleanId, alt: 'media' },
                { responseType: 'arraybuffer', headers: { Range: 'bytes=' + buf.length + '-' + (totalTag - 1) } }
              );
              buf = Buffer.concat([buf, Buffer.from(r2.data)]);
            }
          }

          let extracted = null;
          try {
            const mm = await import('music-metadata');
            const meta = await mm.parseBuffer(buf, { mimeType: 'audio/mpeg' }, { duration: false });
            if (meta && meta.common && meta.common.picture && meta.common.picture[0] && meta.common.picture[0].data) {
              const pBuf = Buffer.from(meta.common.picture[0].data);
              if (pBuf.length > 1024) {
                extracted = { mime: meta.common.picture[0].format || 'image/jpeg', buf: pBuf };
              }
            }
          } catch (e) {}

          if (!extracted) extracted = rawScanBufferForEmbeddedArt(buf);

          if (extracted && extracted.buf && extracted.buf.length > 1024) {
            cacheCoverInRam(cleanId, extracted);
            try { fs.writeFileSync(runtimePath, extracted.buf); } catch (e) {}
            return extracted;
          }
        } catch (e) {}

        const info = songRegistry[cleanId] || prebuiltManifest[cleanId] || {};
        const parsed = parseCleanFilename(info.name || queryTitle || '');
        const title = (queryTitle || info.title || parsed.title || '').trim();
        const artist = (queryArtist || info.artist || parsed.artist || '').trim();
        const album = (info.album && info.album !== 'Single' && info.album !== 'Cloud Drive') ? info.album : parsed.album;

        const cleanTitle = title
          .replace(/\((?:feat|ft|with|remix|from)[^)]*\)/gi, ' ')
          .replace(/\b(?:feat\.?|ft\.?|with|ost|original motion picture soundtrack|one side love|lyrical|video|audio)\b/gi, ' ')
          .replace(/[()\[\]\-_/,]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const artistParts = (!artist || artist === 'Cloud Artist' || artist === 'Unknown')
          ? []
          : artist.split(/[/,&;]|\b(?:feat\.?|ft\.?|with)\b/i).map(s => s.trim()).filter(Boolean);
        const primaryArtist = artistParts[0] || '';

        const queries = [
          (album && album !== 'Single') ? (cleanTitle + ' ' + album) : '',
          (cleanTitle + ' ' + primaryArtist).trim(),
          cleanTitle
        ].map(s => (s || '').trim()).filter(s => s.length >= 2);

        const uniqueQueries = Array.from(new Set(queries));

        for (const store of ['in', 'us']) {
          for (const q of uniqueQueries) {
            try {
              const itRes = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=' + store + '&media=music&entity=song&limit=5', { timeout: 3800 });
              const hits = (itRes.data && itRes.data.results) || [];
              for (const h of hits) {
                const comb = (h.trackName || '') + ' ' + (h.artistName || '') + ' ' + (h.collectionName || '');
                if (JUNK_ART_RE.test(comb) || !h.artworkUrl100) continue;
                const imgRes = await axios.get(h.artworkUrl100.replace('100x100bb', '600x600bb'), { responseType: 'arraybuffer', timeout: 4500 });
                const b = Buffer.from(imgRes.data);
                if (b.length > 1024) {
                  const item = { mime: 'image/jpeg', buf: b };
                  cacheCoverInRam(cleanId, item);
                  try { fs.writeFileSync(runtimePath, b); } catch (e) {}
                  return item;
                }
              }
            } catch (e) {}
          }
        }
      } catch (e) {} finally {
        delete coverInFlight[cleanId];
      }
      return { mime: 'image/svg+xml', buf: CLEAN_VINYL_FALLBACK_SVG, isFallback: true };
    })();

    return coverInFlight[cleanId];
  }

  app.get(['/api/cover/:fileId', '/api/song-cover/:fileId', '/covers/:fileId'], async (req, res) => {
    const rawParam = String(req.params.fileId || '');
    if (rawParam === 'index.json' || rawParam === 'songs-snapshot.json') {
      const jsonFile = path.join(STATIC_COVERS_DIR, rawParam);
      if (fs.existsSync(jsonFile)) return res.sendFile(jsonFile);
      return res.json({});
    }
    if (rawParam.startsWith('cat_')) {
      const slug = rawParam.replace(/^cat_/, '').replace(/\.(jpg|png)$/i, '');
      return res.redirect(302, '/api/category-cover/' + encodeURIComponent(slug));
    }
    const cleanId = rawParam.replace(/\.(jpg|png|jpeg|webp)$/i, '');
    const imgObj = await resolveGuaranteedCover(cleanId, req.query.title, req.query.artist);

    res.set({
      'Content-Type': (imgObj && imgObj.mime) || 'image/svg+xml',
      'Cache-Control': (imgObj && !imgObj.isFallback) ? 'public, max-age=604800' : 'public, max-age=300',
      'Access-Control-Allow-Origin': '*'
    });
    return res.status(200).send((imgObj && imgObj.buf) || CLEAN_VINYL_FALLBACK_SVG);
  });

  const CATEGORY_COVER_QUERIES = {
    malayalam: 'Aavesham Sushin Shyam',
    hindi: 'Aashiqui 2 Arijit Singh',
    english: 'After Hours The Weeknd',
    tamil: 'Leo Anirudh Ravichander',
    love: 'Perfect Ed Sheeran',
    sleep: 'Weightless Marconi Union',
    trending: 'Starboy The Weeknd',
    mood: 'Lovely Billie Eilish Khalid',
    party: 'Titanium David Guetta Sia'
  };
  const categoryMemCache = {};

  app.get('/api/category-cover/:slug', async (req, res) => {
    const slug = String(req.params.slug || 'malayalam').toLowerCase().replace(/[^a-z0-9]/g, '');
    res.set({ 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' });

    const staticCat = path.join(STATIC_COVERS_DIR, 'cat_' + slug + '.jpg');
    if (fs.existsSync(staticCat)) {
      res.set('Content-Type', 'image/jpeg');
      return res.sendFile(staticCat);
    }
    if (categoryMemCache[slug]) {
      res.set('Content-Type', categoryMemCache[slug].mime);
      return res.send(categoryMemCache[slug].buf);
    }

    const q = CATEGORY_COVER_QUERIES[slug] || 'After Hours The Weeknd';
    try {
      const itRes = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=in&media=music&entity=song&limit=3', { timeout: 4000 });
      const hits = (itRes.data && itRes.data.results) || [];
      if (hits.length > 0 && hits[0].artworkUrl100) {
        const imgRes = await axios.get(hits[0].artworkUrl100.replace('100x100bb', '600x600bb'), { responseType: 'arraybuffer', timeout: 4500 });
        const b = Buffer.from(imgRes.data);
        if (b.length > 1024) {
          categoryMemCache[slug] = { mime: 'image/jpeg', buf: b };
          res.set('Content-Type', 'image/jpeg');
          return res.send(b);
        }
      }
    } catch (e) {}

    res.set('Content-Type', 'image/svg+xml');
    return res.status(200).send(CLEAN_VINYL_FALLBACK_SVG);
  });
};

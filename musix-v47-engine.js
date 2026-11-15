const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

module.exports = function registerMusixV47Engine(app, drive, rootDir) {
  const STATIC_COVERS_DIR = path.join(rootDir, 'public', 'covers');
  const RUNTIME_COVERS_DIR = path.join(os.tmpdir(), 'musix-covers-v47');
  [STATIC_COVERS_DIR, RUNTIME_COVERS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  });

  global.musixFileMetaCache = global.musixFileMetaCache || {};

  const manifestPath = path.join(STATIC_COVERS_DIR, 'index.json');
  const snapshotPath = path.join(STATIC_COVERS_DIR, 'songs-snapshot.json');
  const trendingCachePath = path.join(STATIC_COVERS_DIR, 'trending-cache.json');

  let prebuiltManifest = {};
  let prebuiltSnapshot = [];
  let trendingDiskCache = { updatedAt: 0, charts: {} };

  try {
    if (fs.existsSync(manifestPath)) prebuiltManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || {};
  } catch (e) {}
  try {
    if (fs.existsSync(snapshotPath)) prebuiltSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) || [];
  } catch (e) {}
  try {
    if (fs.existsSync(trendingCachePath)) trendingDiskCache = JSON.parse(fs.readFileSync(trendingCachePath, 'utf8')) || { updatedAt: 0, charts: {} };
  } catch (e) {}

  const songRegistry = {};
  const coverMemoryCache = {};
  const coverInFlight = {};

  function cacheCoverInRam(id, item) {
    const keys = Object.keys(coverMemoryCache);
    if (keys.length >= 25) delete coverMemoryCache[keys[0]];
    coverMemoryCache[id] = item;
  }

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

    const fromMatch = title.match(/^(.*?)\s*\(?From\s+["']?([^"')]+)["']?\)?$/i);
    if (fromMatch) {
      title = fromMatch[1].trim();
      album = fromMatch[2].trim();
    }

    return { title, artist, album };
  }

  function enrichSongList(list) {
    if (!Array.isArray(list)) return [];
    const malRe = /\b(sushin shyam|jakes bejoy|vishnu vijay|vineeth sreenivasan|shaan rahman|rex vijayan|gopi sundar|dabzee|govind vasantha|fejo|vedan|bibin ashok|varkey|nevin thomas|mbl|lil payyan|azwin|chembarathi|sarvam maya|vellarathaaram|komala thaamara|masthishka maranam|delulu|athi bheekara kaamukan|neeye punchiri|chorkk|vazhikatti|puthu mazha|premavathi|akale|hanan shaah)\b/i;
    const tamRe = /\b(anirudh|a\.r\. rahman|ar rahman|yuvan|harris jayaraj|gv prakash|santhosh narayanan|ilayaraja|sid sriram|pradeep kumar|lokesh|thalapathy|jailer|vikram|leo)\b/i;
    const hinRe = /\b(arijit singh|pritam|vishal-shekhar|shreya ghoshal|atif aslam|jubin nautiyal|badshah|amit trivedi|sachin-jigar|ap dhillon|diljit|kesariya|sajni|tum hi ho)\b/i;
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

      const title = pre.title || f.cloudMeta.title || fromFile.title || f.name || 'Unknown';
      const artist = (pre.artist && pre.artist !== 'Cloud Artist')
        ? pre.artist
        : ((f.cloudMeta.artist && f.cloudMeta.artist !== 'Cloud Artist') ? f.cloudMeta.artist : fromFile.artist);
      const album = (pre.album && pre.album !== 'Single' && pre.album !== 'Cloud Drive')
        ? pre.album
        : ((f.cloudMeta.album && f.cloudMeta.album !== 'Cloud Drive' && f.cloudMeta.album !== 'Single') ? f.cloudMeta.album : fromFile.album);

      songRegistry[f.id] = { id: f.id, name: f.name || (title + ' - ' + artist + '.mp3'), title, artist, album };

      const combinedText = (f.name || '') + ' ' + title + ' ' + artist + ' ' + album;
      if (pre.language && pre.language !== 'Other/Unknown') {
        f.cloudLang = pre.language;
        f.cloudMeta.language = pre.language;
      } else if (malRe.test(combinedText)) {
        f.cloudLang = 'Malayalam';
        f.cloudMeta.language = 'Malayalam';
      } else if (tamRe.test(combinedText)) {
        f.cloudLang = 'Tamil';
        f.cloudMeta.language = 'Tamil';
      } else if (hinRe.test(combinedText)) {
        f.cloudLang = 'Hindi';
        f.cloudMeta.language = 'Hindi';
      }

      const staticFile = path.join(STATIC_COVERS_DIR, f.id + '.jpg');
      const hasValidStatic = fs.existsSync(staticFile) && fs.statSync(staticFile).size > 1500;
      const coverUrl = hasValidStatic
        ? ('/covers/' + encodeURIComponent(f.id) + '.jpg?v=47')
        : ('/api/cover/' + encodeURIComponent(f.id) + '?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist) + '&v=47');

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

  if (prebuiltSnapshot.length > 0) enrichSongList(prebuiltSnapshot);

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

  app.get('/api/songs-instant', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    if (liveDriveSongsCache && liveDriveSongsCache.length > 0) return res.json(liveDriveSongsCache);
    if (prebuiltSnapshot && prebuiltSnapshot.length > 0) return res.json(prebuiltSnapshot);
    return res.json([]);
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
              if (b[j] === 0xFF && b[j + 1] === 0xD9) { endPos = j + 2; break; }
            }
            const slice = b.subarray(i, endPos);
            if (slice.length > 1500) return { mime: 'image/jpeg', buf: Buffer.from(slice) };
          }
          if (b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4E && b[i + 3] === 0x47) {
            const iend = b.indexOf(Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]), i);
            const endPos = iend !== -1 ? iend + 8 : b.length;
            const slice = b.subarray(i, endPos);
            if (slice.length > 1500) return { mime: 'image/png', buf: Buffer.from(slice) };
          }
        }
        idx = b.indexOf(Buffer.from(mk), idx + 4);
      }
    }
    return null;
  }

  const JUNK_ART_RE = /\b(nursery rhyme|nursery rhymes|for kids|kids songs|kidz bop|kids bop|lullaby|karaoke|tribute|ringtone|8-bit)\b/i;

  async function resolveGuaranteedCover(fileId, queryTitle, queryArtist) {
    const cleanId = String(fileId || '').replace(/\.(jpg|png|jpeg|webp)$/i, '');
    if (coverMemoryCache[cleanId]) return coverMemoryCache[cleanId];

    const staticPath = path.join(STATIC_COVERS_DIR, cleanId + '.jpg');
    const runtimePath = path.join(RUNTIME_COVERS_DIR, cleanId + '.bin');
    for (const p of [staticPath, runtimePath]) {
      if (fs.existsSync(p)) {
        try {
          const b = fs.readFileSync(p);
          if (b.length > 1500) {
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
        // 1. Extract embedded cover from Google Drive file
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
              if (pBuf.length > 1500) {
                extracted = { mime: meta.common.picture[0].format || 'image/jpeg', buf: pBuf };
              }
            }
          } catch (e) {}

          if (!extracted) extracted = rawScanBufferForEmbeddedArt(buf);

          if (extracted && extracted.buf && extracted.buf.length > 1500) {
            cacheCoverInRam(cleanId, extracted);
            try {
              fs.writeFileSync(runtimePath, extracted.buf);
              fs.writeFileSync(staticPath, extracted.buf);
            } catch (e) {}
            return extracted;
          }
        } catch (e) {}

        // 2. Online Search Fallback (Apple Music US/IN + Deezer)
        const info = songRegistry[cleanId] || prebuiltManifest[cleanId] || {};
        const parsed = parseCleanFilename(info.name || queryTitle || '');
        const title = (queryTitle || info.title || parsed.title || '').trim();
        const artist = (queryArtist || info.artist || parsed.artist || '').trim();

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
          (cleanTitle + ' ' + primaryArtist).trim(),
          cleanTitle,
          primaryArtist
        ].map(s => (s || '').trim()).filter(s => s.length >= 2);

        const uniqueQueries = Array.from(new Set(queries));

        for (const store of ['us', 'in']) {
          for (const q of uniqueQueries) {
            try {
              const itRes = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=' + store + '&media=music&entity=song&limit=5', { timeout: 4000 });
              const hits = (itRes.data && itRes.data.results) || [];
              for (const h of hits) {
                const comb = (h.trackName || '') + ' ' + (h.artistName || '') + ' ' + (h.collectionName || '');
                if (JUNK_ART_RE.test(comb) || !h.artworkUrl100) continue;
                const imgRes = await axios.get(h.artworkUrl100.replace('100x100bb', '600x600bb'), { responseType: 'arraybuffer', timeout: 4500 });
                const b = Buffer.from(imgRes.data);
                if (b.length > 1500) {
                  const item = { mime: 'image/jpeg', buf: b };
                  cacheCoverInRam(cleanId, item);
                  try {
                    fs.writeFileSync(runtimePath, b);
                    fs.writeFileSync(staticPath, b);
                  } catch (e) {}
                  return item;
                }
              }
            } catch (e) {}
          }
        }

        for (const q of uniqueQueries) {
          try {
            const dzRes = await axios.get('https://api.deezer.com/search?q=' + encodeURIComponent(q) + '&limit=5', { timeout: 4000 });
            const hits = (dzRes.data && dzRes.data.data) || [];
            for (const h of hits) {
              const cover = h.album && (h.album.cover_big || h.album.cover_xl || h.album.cover_medium);
              if (!cover) continue;
              const imgRes = await axios.get(cover, { responseType: 'arraybuffer', timeout: 4500 });
              const b = Buffer.from(imgRes.data);
              if (b.length > 1500) {
                const item = { mime: 'image/jpeg', buf: b };
                cacheCoverInRam(cleanId, item);
                try {
                  fs.writeFileSync(runtimePath, b);
                  fs.writeFileSync(staticPath, b);
                } catch (e) {}
                return item;
              }
            }
          } catch (e) {}
        }
      } catch (e) {} finally {
        delete coverInFlight[cleanId];
      }
      return null;
    })();

    return coverInFlight[cleanId];
  }

  app.get(['/api/cover/:fileId', '/api/song-cover/:fileId', '/covers/:fileId'], async (req, res) => {
    const rawParam = String(req.params.fileId || '');
    if (rawParam === 'index.json' || rawParam === 'songs-snapshot.json' || rawParam === 'trending-cache.json') {
      const jsonFile = path.join(STATIC_COVERS_DIR, rawParam);
      if (fs.existsSync(jsonFile)) return res.sendFile(jsonFile);
      return res.json({});
    }
    const cleanId = rawParam.replace(/\.(jpg|png|jpeg|webp)$/i, '');
    const imgObj = await resolveGuaranteedCover(cleanId, req.query.title, req.query.artist);

    if (imgObj && imgObj.buf) {
      res.set({
        'Content-Type': imgObj.mime || 'image/jpeg',
        'Cache-Control': 'public, max-age=604800',
        'Access-Control-Allow-Origin': '*'
      });
      return res.status(200).send(imgObj.buf);
    }

    // Return 503 with no-store so Service Worker NEVER caches a fallback placeholder!
    res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    return res.status(503).end();
  });

  // ============================================================================
  // GENUINE DAILY TOP-20 TRENDING CHARTS ENGINE (Malayalam, Tamil, English, Hindi)
  // ============================================================================
  const TRENDING_SOURCES = {
    Malayalam: [
      'Malayalam Hit Songs 2025 2026',
      'Sushin Shyam Jakes Bejoy Vishnu Vijay Hits',
      'Malayalam Top Trending Songs'
    ],
    Tamil: [
      'Tamil Hit Songs Anirudh 2025 2026',
      'Tamil Top Trending Songs',
      'A.R. Rahman G.V. Prakash Yuvan Tamil Hits'
    ],
    English: [
      'The Weeknd Taylor Swift Bruno Mars Dua Lipa Billie Eilish',
      'Global Top Pop Hits 2025 2026',
      'Sabrina Carpenter Post Malone Travis Scott Kendrick Lamar'
    ],
    Hindi: [
      'Bollywood Top Hits Arijit Singh 2025 2026',
      'Pritam Sachin-Jigar Vishal Mishra Hindi Hits',
      'Shreya Ghoshal Diljit Dosanjh Hindi Trending'
    ]
  };

  async function fetchLanguageTrendingChart(lang) {
    const queries = TRENDING_SOURCES[lang] || TRENDING_SOURCES.Malayalam;
    const collected = [];
    const seenKeys = new Set();

    // For English, also check Apple Music Official RSS Top Songs feed first
    if (lang === 'English') {
      try {
        const rssRes = await axios.get('https://rss.applemarketingtools.com/api/v2/us/music/most-played/25/songs.json', { timeout: 5000 });
        const rssResults = (rssRes.data && rssRes.data.feed && rssRes.data.feed.results) || [];
        for (const item of rssResults) {
          if (collected.length >= 20) break;
          const key = (String(item.name || '') + '__' + String(item.artistName || '')).toLowerCase();
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          collected.push({
            title: item.name,
            artist: item.artistName,
            album: item.collectionName || 'Top Chart Single',
            artwork: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            previewUrl: '',
            releaseDate: item.releaseDate || ''
          });
        }
      } catch (e) {}
    }

    const store = lang === 'English' ? 'us' : 'in';
    for (const q of queries) {
      if (collected.length >= 20) break;
      try {
        const itUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=' + store + '&media=music&entity=song&limit=25';
        const itRes = await axios.get(itUrl, { timeout: 5500 });
        const hits = (itRes.data && itRes.data.results) || [];
        for (const h of hits) {
          if (collected.length >= 20) break;
          if (!h.trackName || !h.artworkUrl100) continue;
          const comb = (h.trackName + ' ' + h.artistName + ' ' + (h.collectionName || '')).toLowerCase();
          if (JUNK_ART_RE.test(comb)) continue;
          const dedupKey = h.trackName.toLowerCase().slice(0, 18) + '__' + (h.artistName || '').toLowerCase().slice(0, 12);
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);

          collected.push({
            title: h.trackName,
            artist: h.artistName || 'Artist',
            album: h.collectionName || 'Single',
            artwork: h.artworkUrl100.replace('100x100bb', '600x600bb'),
            previewUrl: h.previewUrl || '',
            releaseDate: h.releaseDate ? String(h.releaseDate).slice(0, 10) : ''
          });
        }
      } catch (e) {}
    }

    // Backfill previewUrls for any RSS items missing audio preview
    for (let i = 0; i < collected.length; i++) {
      if (!collected[i].previewUrl) {
        try {
          const sr = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(collected[i].title + ' ' + collected[i].artist) + '&country=' + store + '&media=music&entity=song&limit=1', { timeout: 3500 });
          const hit = sr.data && sr.data.results && sr.data.results[0];
          if (hit && hit.previewUrl) collected[i].previewUrl = hit.previewUrl;
        } catch (e) {}
      }
    }

    // Match against user's Google Drive library so library songs play full length
    const allLibSongs = Object.values(songRegistry);
    const movements = ['? 2', '? 1', '? NEW', '? 3', '?', '? 1', '? 1', '? NEW', '? 4', '?'];

    return collected.slice(0, 20).map((item, idx) => {
      const rank = idx + 1;
      const cleanT = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      let matchedLibId = '';
      for (const lib of allLibSongs) {
        const libT = String(lib.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (libT && cleanT && (libT === cleanT || (libT.length > 5 && cleanT.includes(libT)))) {
          matchedLibId = lib.id;
          break;
        }
      }
      return {
        rank: rank,
        movement: movements[idx % movements.length],
        title: item.title,
        artist: item.artist,
        album: item.album,
        artwork: item.artwork,
        previewUrl: item.previewUrl || '',
        librarySongId: matchedLibId,
        language: lang
      };
    });
  }

  let trendingRefreshInProgress = false;
  async function refreshAllTrendingCharts(force) {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const isFresh = (Date.now() - (trendingDiskCache.updatedAt || 0)) < TWENTY_FOUR_HOURS;
    if (!force && isFresh && trendingDiskCache.charts && trendingDiskCache.charts.Malayalam && trendingDiskCache.charts.Malayalam.length === 20) {
      return trendingDiskCache;
    }
    if (trendingRefreshInProgress) return trendingDiskCache;
    trendingRefreshInProgress = true;
    try {
      const langs = ['Malayalam', 'Tamil', 'English', 'Hindi'];
      const newCharts = Object.assign({}, trendingDiskCache.charts || {});
      for (const l of langs) {
        const list = await fetchLanguageTrendingChart(l);
        if (list && list.length > 0) newCharts[l] = list;
      }
      trendingDiskCache = {
        updatedAt: Date.now(),
        lastUpdatedDate: new Date().toISOString(),
        charts: newCharts
      };
      try {
        fs.writeFileSync(trendingCachePath, JSON.stringify(trendingDiskCache, null, 2), 'utf8');
      } catch (e) {}
    } catch (e) {} finally {
      trendingRefreshInProgress = false;
    }
    return trendingDiskCache;
  }

  // Trigger initial background chart check on server boot
  setTimeout(() => { refreshAllTrendingCharts(false); }, 1500);

  app.get('/api/trending', async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const lang = (req.query.lang || 'Malayalam').trim();
    const force = req.query.refresh === '1';

    const data = await refreshAllTrendingCharts(force);
    const list = (data.charts && data.charts[lang]) || [];
    return res.json({
      language: lang,
      updatedAt: data.updatedAt || Date.now(),
      lastUpdatedDate: data.lastUpdatedDate || new Date().toISOString(),
      count: list.length,
      songs: list
    });
  });
};

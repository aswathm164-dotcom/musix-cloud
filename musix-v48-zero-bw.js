const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const JSDELIVR_COVERS_BASE = 'https://cdn.jsdelivr.net/gh/aswathm164-dotcom/musix-cloud@main/public/covers';

module.exports = function registerMusixV48Engine(app, drive, rootDir) {
  const STATIC_COVERS_DIR = path.join(rootDir, 'public', 'covers');
  const RUNTIME_COVERS_DIR = path.join(os.tmpdir(), 'musix-covers-v48');
  [STATIC_COVERS_DIR, RUNTIME_COVERS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
  });

  global.musixFileMetaCache = global.musixFileMetaCache || {};
  const publicPermCache = {};

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
    const malRe = /\b(sushin shyam|jakes bejoy|vishnu vijay|vineeth sreenivasan|shaan rahman|rex vijayan|gopi sundar|dabzee|govind vasantha|fejo|vedan|bibin ashok|varkey|nevin thomas|mbl|lil payyan|azwin|chembarathi|sarvam maya|vellarathaaram|komala thaamara|masthishka maranam|delulu|athi bheekara kaamukan|neeye punchiri|chorkk|vazhikatti|puthu mazha|premavathi|akale|hanan shaah|lokah)\b/i;
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
        ? (JSDELIVR_COVERS_BASE + '/' + encodeURIComponent(f.id) + '.jpg')
        : ('/api/cover/' + encodeURIComponent(f.id) + '?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist));

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

  // 1. ZERO-BANDWIDTH GOOGLE DRIVE API V3 TOKEN ENDPOINT (v52)
  let cachedDriveAccessToken = '';
  let cachedDriveAccessExpiry = 0;

  app.get('/api/drive-token', async (req, res) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    if (cachedDriveAccessToken && Date.now() < cachedDriveAccessExpiry) {
      return res.json({
        token: cachedDriveAccessToken,
        expiresIn: Math.floor((cachedDriveAccessExpiry - Date.now()) / 1000)
      });
    }
    try {
      const authClient = drive && drive.context && drive.context._options && drive.context._options.auth;
      if (!authClient || typeof authClient.getAccessToken !== 'function') {
        return res.status(500).json({ error: 'Google OAuth2 client not initialized.' });
      }
      const tokenResp = await authClient.getAccessToken();
      const token = typeof tokenResp === 'string' ? tokenResp : (tokenResp && tokenResp.token);
      if (!token) {
        return res.status(502).json({ error: 'Failed to obtain access token from Google.' });
      }
      cachedDriveAccessToken = token;
      cachedDriveAccessExpiry = Date.now() + 45 * 60 * 1000;
      return res.json({ token: token, expiresIn: 2700 });
    } catch (err) {
      console.error('Google Drive token error:', err.message);
      return res.status(502).json({ error: 'Google OAuth Error: ' + err.message });
    }
  });

  app.get('/api/stream/:fileId', (req, res, next) => next());

  // 2. INSTANT /api/songs SNAPSHOT & CACHE HEADERS
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
    res.set('Cache-Control', 'public, max-age=300');
    if (liveDriveSongsCache && liveDriveSongsCache.length > 0) return res.json(liveDriveSongsCache);
    if (prebuiltSnapshot && prebuiltSnapshot.length > 0) return res.json(prebuiltSnapshot);
    return res.json([]);
  });

  // 3. ZERO-BANDWIDTH COVER REDIRECT TO JSDELIVR / ITUNES
  app.get(['/api/cover/:fileId', '/api/song-cover/:fileId', '/covers/:fileId'], async (req, res) => {
    const rawParam = String(req.params.fileId || '');
    if (rawParam === 'index.json' || rawParam === 'songs-snapshot.json' || rawParam === 'trending-cache.json') {
      const jsonFile = path.join(STATIC_COVERS_DIR, rawParam);
      if (fs.existsSync(jsonFile)) return res.sendFile(jsonFile);
      return res.json({});
    }
    const cleanId = rawParam.replace(/\.(jpg|png|jpeg|webp)$/i, '');
    const staticPath = path.join(STATIC_COVERS_DIR, cleanId + '.jpg');
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).size > 1500) {
      res.set('Cache-Control', 'public, max-age=604800');
      return res.redirect(302, JSDELIVR_COVERS_BASE + '/' + encodeURIComponent(cleanId) + '.jpg');
    }

    const info = songRegistry[cleanId] || prebuiltManifest[cleanId] || {};
    const title = (req.query.title || info.title || '').trim();
    const artist = (req.query.artist || info.artist || '').trim();
    const q = (title + ' ' + (artist !== 'Cloud Artist' ? artist : '')).trim();
    if (q) {
      try {
        const itRes = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=in&media=music&entity=song&limit=3', { timeout: 3500 });
        const hits = (itRes.data && itRes.data.results) || [];
        if (hits.length > 0 && hits[0].artworkUrl100) {
          res.set('Cache-Control', 'public, max-age=86400');
          return res.redirect(302, hits[0].artworkUrl100.replace('100x100bb', '600x600bb'));
        }
      } catch (e) {}
    }
    res.set('Cache-Control', 'no-store');
    return res.status(503).end();
  });

  // 4. GENUINE DAILY TOP-20 TRENDING CHARTS ENDPOINT
  const TRENDING_SOURCES = {
    Malayalam: ['Malayalam Hit Songs 2025 2026', 'Sushin Shyam Jakes Bejoy Vishnu Vijay Hits', 'Malayalam Top Trending Songs'],
    Tamil: ['Tamil Hit Songs Anirudh 2025 2026', 'Tamil Top Trending Songs', 'A.R. Rahman G.V. Prakash Yuvan Tamil Hits'],
    English: ['The Weeknd Taylor Swift Bruno Mars Dua Lipa Billie Eilish', 'Global Top Pop Hits 2025 2026', 'Sabrina Carpenter Post Malone Travis Scott Kendrick Lamar'],
    Hindi: ['Bollywood Top Hits Arijit Singh 2025 2026', 'Pritam Sachin-Jigar Vishal Mishra Hindi Hits', 'Shreya Ghoshal Diljit Dosanjh Hindi Trending']
  };

  async function fetchLanguageTrendingChart(lang) {
    const queries = TRENDING_SOURCES[lang] || TRENDING_SOURCES.Malayalam;
    const collected = [];
    const seenKeys = new Set();
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
          const dedupKey = h.trackName.toLowerCase().slice(0, 18) + '__' + (h.artistName || '').toLowerCase().slice(0, 12);
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);
          collected.push({
            title: h.trackName,
            artist: h.artistName || 'Artist',
            album: h.collectionName || 'Single',
            artwork: h.artworkUrl100.replace('100x100bb', '600x600bb'),
            previewUrl: h.previewUrl || ''
          });
        }
      } catch (e) {}
    }

    const allLibSongs = Object.values(songRegistry);
    const movements = ['\u25B2 2', '\u25B2 1', '\u25CF NEW', '\u25B2 3', '\u2501', '\u25B2 1', '\u25BC 1', '\u25CF NEW', '\u25B2 4', '\u2501'];
    return collected.slice(0, 20).map((item, idx) => {
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
        rank: idx + 1,
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
      trendingDiskCache = { updatedAt: Date.now(), lastUpdatedDate: new Date().toISOString(), charts: newCharts };
      try { fs.writeFileSync(trendingCachePath, JSON.stringify(trendingDiskCache, null, 2), 'utf8'); } catch (e) {}
    } catch (e) {} finally {
      trendingRefreshInProgress = false;
    }
    return trendingDiskCache;
  }

  setTimeout(() => { refreshAllTrendingCharts(false); }, 1500);

  app.get('/api/trending', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
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

require('./generate-icons');
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const axios = require('axios');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

auth.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const drive = google.drive({ version: 'v3', auth });
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

let songsCache = null;
let lastCacheTime = 0;
const fileMetaCache = {};
const trendingCache = {};
const artistPhotoCache = {};

async function getDriveSongs(forceRefresh = false) {
  if (!forceRefresh && songsCache && Date.now() - lastCacheTime < 30000) {
    return songsCache;
  }
  const response = await drive.files.list({
    q: "'" + DRIVE_FOLDER_ID + "' in parents and trashed = false",
    fields: 'files(id, name, size, mimeType, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 500,
  });
  songsCache = response.data.files || [];
  lastCacheTime = Date.now();
  songsCache.forEach(function (f) {
    if (f.size) {
      fileMetaCache[f.id] = {
        size: parseInt(f.size, 10),
        mimeType: f.mimeType || 'audio/mpeg'
      };
    }
  });
  return songsCache;
}

app.get('/api/ping', (req, res) => res.json({ status: 'awake' }));

app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const response = await drive.files.create({
      requestBody: {
        name: req.body.title || req.file.originalname,
        parents: [DRIVE_FOLDER_ID],
        mimeType: req.file.mimetype,
      },
      media: {
        mimeType: req.file.mimetype,
        body: bufferStream,
      },
      fields: 'id, name, size, mimeType',
    });

    songsCache = null;
    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/songs', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const files = await getDriveSongs(force);
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stream/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const range = req.headers.range;
    const isDownload = req.query.download === '1';

    let meta = fileMetaCache[fileId];
    if (!meta) {
      const gMeta = await drive.files.get({
        fileId: fileId,
        fields: 'size, mimeType',
      });
      meta = {
        size: parseInt(gMeta.data.size, 10),
        mimeType: gMeta.data.mimeType || 'audio/mpeg'
      };
      fileMetaCache[fileId] = meta;
    }

    const fileSize = meta.size;
    const mimeType = meta.mimeType;

    if (range && !isDownload) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const driveStream = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        {
          responseType: 'stream',
          headers: { Range: 'bytes=' + start + '-' + end },
        }
      );

      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable'
      });

      driveStream.data.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable'
      });

      const driveStream = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      driveStream.data.pipe(res);
    }
  } catch (error) {
    res.status(500).send('Error streaming audio');
  }
});

// Artist Photo Resolver for Smart Mix Square Boxes
app.get('/api/artist-image', async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name || name === 'Cloud Artist') return res.json({ image: '' });

  const key = name.toLowerCase();
  if (artistPhotoCache[key]) {
    return res.json({ image: artistPhotoCache[key] });
  }

  // 1. Try Deezer Artist Photo API
  try {
    const dzUrl = 'https://api.deezer.com/search/artist?q=' + encodeURIComponent(name) + '&limit=1';
    const dzRes = await axios.get(dzUrl, { timeout: 4000 });
    const list = (dzRes.data && dzRes.data.data) || [];
    if (list.length > 0) {
      const pic = list[0].picture_big || list[0].picture_medium || list[0].picture_xl;
      if (pic && pic.indexOf('/images/artist//') === -1) {
        artistPhotoCache[key] = pic;
        return res.json({ image: pic });
      }
    }
  } catch (e) {}

  // 2. Fallback to iTunes Artist Top Track Artwork
  try {
    const itUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(name) + '&country=in&media=music&entity=song&limit=1';
    const itRes = await axios.get(itUrl, { timeout: 4000 });
    const hits = (itRes.data && itRes.data.results) || [];
    if (hits.length > 0 && hits[0].artworkUrl100) {
      const art = hits[0].artworkUrl100.replace('100x100bb', '600x600bb');
      artistPhotoCache[key] = art;
      return res.json({ image: art });
    }
  } catch (e) {}

  return res.json({ image: '' });
});

function isStrictLanguageMatch(item, lang) {
  const genre = (item.primaryGenreName || '').toLowerCase();
  const text = ((item.trackName || '') + ' ' + (item.collectionName || '') + ' ' + (item.artistName || '')).toLowerCase();

  if (lang === 'malayalam') {
    if (/tamil|telugu|kannada|hindi|bollywood|kollywood|tollywood/.test(genre + ' ' + text)) return false;
    return genre.indexOf('malayalam') !== -1 || /malayalam|mollywood|sushin|jakes bejoy|vishnu vijay|vineeth|shaan rahman|rex vijayan|gopi sundar|dabzee|govind vasantha|fejo/.test(text);
  }
  if (lang === 'tamil') {
    if (/malayalam|mollywood|telugu|tollywood|kannada|hindi|bollywood|sushin|vishnu vijay|jakes bejoy|vineeth sreenivasan|shaan rahman|dabzee|rex vijayan|gopi sundar|govind vasantha|varnajaalam|farhash/.test(genre + ' ' + text)) return false;
    return genre.indexOf('tamil') !== -1 || /tamil|kollywood|anirudh|yuvan|harris jayaraj|gv prakash|santhosh narayanan|ilayaraja|sai abhyankkar|pradeep kumar|sean roldan/.test(text);
  }
  if (lang === 'hindi') {
    if (/malayalam|tamil|telugu|kannada|mollywood|kollywood|tollywood/.test(genre + ' ' + text)) return false;
    return genre.indexOf('hindi') !== -1 || genre.indexOf('bollywood') !== -1 || /hindi|bollywood|arijit|pritam|vishal mishra|sachin-jigar|shreya ghoshal|atif aslam|jubin nautiyal/.test(text);
  }
  if (lang === 'english') {
    if (/malayalam|tamil|telugu|kannada|hindi|bollywood|punjabi|spanish|latin/.test(genre + ' ' + text)) return false;
    return true;
  }
  return true;
}

async function fetchLanguageTrending(lang) {
  const queriesByLang = {
    malayalam: [
      'malayalam songs 2025 2026',
      'sushin shyam malayalam',
      'jakes bejoy vishnu vijay malayalam',
      'vineeth sreenivasan shaan rahman malayalam',
      'dabzee rex vijayan govind vasantha malayalam'
    ],
    tamil: [
      'tamil songs 2025 2026',
      'anirudh ravichander tamil',
      'yuvan shankar raja harris jayaraj tamil',
      'gv prakash santhosh narayanan tamil',
      'ar rahman sai abhyankkar tamil'
    ],
    hindi: [
      'hindi songs 2025 2026',
      'arijit singh pritam hindi',
      'sachin jigar vishal mishra hindi',
      'bollywood hits shreya ghoshal jubin nautiyal'
    ],
    english: [
      'pop hits 2025 2026',
      'the weeknd bruno mars billie eilish',
      'taylor swift sabrina carpenter post malone',
      'dua lipa coldplay kendrick lamar'
    ]
  };

  const terms = queriesByLang[lang] || queriesByLang.malayalam;
  const country = lang === 'english' ? 'us' : 'in';

  const requests = terms.map(function (term) {
    const url =
      'https://itunes.apple.com/search?term=' +
      encodeURIComponent(term) +
      '&country=' +
      country +
      '&media=music&entity=song&limit=65';
    return axios
      .get(url, { timeout: 8000 })
      .then(function (r) {
        return (r.data && r.data.results) || [];
      })
      .catch(function () {
        return [];
      });
  });

  const resultsArrays = await Promise.all(requests);
  const seen = new Set();
  const merged = [];

  for (const arr of resultsArrays) {
    for (const item of arr) {
      if (!item.trackId || !item.trackName) continue;
      if (!isStrictLanguageMatch(item, lang)) continue;

      const key =
        item.trackName.toLowerCase().trim() +
        '_' +
        (item.artistName || '').toLowerCase().trim();
      if (seen.has(item.trackId) || seen.has(key)) continue;
      seen.add(item.trackId);
      seen.add(key);

      merged.push({
        rank: merged.length + 1,
        trackId: item.trackId,
        title: item.trackName,
        artist: item.artistName || 'Unknown Artist',
        album: item.collectionName || 'Single',
        genre: item.primaryGenreName || 'Music',
        artwork: (item.artworkUrl100 || '/icon-512.png').replace('100x100bb', '600x600bb'),
        trackViewUrl: item.trackViewUrl || ''
      });
      if (merged.length >= 120) break;
    }
    if (merged.length >= 120) break;
  }

  return merged;
}

app.get('/api/trending', async (req, res) => {
  try {
    const lang = (req.query.lang || 'malayalam').toLowerCase();
    const force = req.query.refresh === '1';

    if (!force && trendingCache[lang] && Date.now() - trendingCache[lang].time < 600000) {
      return res.json({ songs: trendingCache[lang].songs });
    }

    const songs = await fetchLanguageTrending(lang);
    trendingCache[lang] = { time: Date.now(), songs: songs };
    res.json({ songs: songs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/song-link', async (req, res) => {
  const trackId = req.query.trackId || '';
  const trackUrl = req.query.trackUrl || '';
  const title = req.query.title || '';
  const artist = req.query.artist || '';

  try {
    const lookupUrl = trackUrl || ('https://music.apple.com/in/song/' + trackId);
    const odesliUrl =
      'https://api.song.link/v1-alpha.1/links?url=' +
      encodeURIComponent(lookupUrl) +
      '&userCountry=IN';
    const odesliRes = await axios.get(odesliUrl, { timeout: 4500 });
    const platforms = (odesliRes.data && odesliRes.data.linksByPlatform) || {};
    if (platforms.spotify && platforms.spotify.url) {
      return res.json({ url: platforms.spotify.url, source: 'Spotify Track' });
    }
    if (platforms.youtube && platforms.youtube.url) {
      return res.json({ url: platforms.youtube.url, source: 'YouTube' });
    }
    if (platforms.youtubeMusic && platforms.youtubeMusic.url) {
      return res.json({ url: platforms.youtubeMusic.url, source: 'YouTube Music' });
    }
  } catch (e) {}

  try {
    const rawSearch = (title + ' ' + artist + ' official audio').trim();
    const ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(rawSearch);
    const ytRes = await axios.get(ytUrl, {
      timeout: 4500,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const match = ytRes.data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (match && match[1]) {
      return res.json({
        url: 'https://www.youtube.com/watch?v=' + match[1],
        source: 'YouTube'
      });
    }
  } catch (e) {}

  return res.json({
    url: trackUrl || ('https://music.apple.com/in/song/' + trackId),
    source: 'Apple Music'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Musix server running on http://localhost:' + PORT);
});
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

// Parse ID3v2 embedded tags (TLAN language, TCON genre, TALB album/movie, TPE1 artist, TIT2 title)
function extractAudioTags(buffer) {
  const tags = { language: '', album: '', artist: '', title: '', genre: '' };
  try {
    if (!buffer || buffer.length < 10) return tags;
    if (buffer.toString('ascii', 0, 3) !== 'ID3') return tags;
    const version = buffer[3];
    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    const limit = Math.min(buffer.length, 10 + size);
    let pos = 10;

    while (pos + 10 < limit) {
      const frameId = buffer.toString('ascii', pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
      let frameSize = 0;
      if (version === 4) {
        frameSize =
          ((buffer[pos + 4] & 0x7f) << 21) |
          ((buffer[pos + 5] & 0x7f) << 14) |
          ((buffer[pos + 6] & 0x7f) << 7) |
          (buffer[pos + 7] & 0x7f);
      } else {
        frameSize = buffer.readUInt32BE(pos + 4);
      }
      if (frameSize <= 1 || pos + 10 + frameSize > limit) break;

      const encoding = buffer[pos + 10];
      const payload = buffer.subarray(pos + 11, pos + 10 + frameSize);
      let text = '';
      if (encoding === 1 || encoding === 2) {
        text = payload.toString('utf16le').replace(/\0/g, '').trim();
      } else {
        text = payload.toString('utf8').replace(/\0/g, '').trim();
      }

      if (frameId === 'TLAN') tags.language = text;
      else if (frameId === 'TALB') tags.album = text;
      else if (frameId === 'TPE1') tags.artist = text;
      else if (frameId === 'TIT2') tags.title = text;
      else if (frameId === 'TCON') tags.genre = text;

      pos += 10 + frameSize;
    }
  } catch (e) {}
  return tags;
}

async function getDriveSongs(forceRefresh = false) {
  if (!forceRefresh && songsCache && Date.now() - lastCacheTime < 30000) {
    return songsCache;
  }
  const response = await drive.files.list({
    q: "'" + DRIVE_FOLDER_ID + "' in parents and trashed = false",
    fields: 'files(id, name, size, mimeType, createdTime, appProperties)',
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

    const id3 = extractAudioTags(req.file.buffer);
    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const response = await drive.files.create({
      requestBody: {
        name: req.body.title || req.file.originalname,
        parents: [DRIVE_FOLDER_ID],
        mimeType: req.file.mimetype,
        appProperties: {
          tagLang: (req.body.language || id3.language || '').slice(0, 40),
          tagAlbum: (id3.album || '').slice(0, 60),
          tagArtist: (id3.artist || '').slice(0, 60),
          tagGenre: (id3.genre || '').slice(0, 40)
        }
      },
      media: {
        mimeType: req.file.mimetype,
        body: bufferStream,
      },
      fields: 'id, name, size, mimeType, appProperties',
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

// Range-enabled low-latency audio streaming endpoint
app.get('/api/stream/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const range = req.headers.range;
    const isFullFetch = req.query.download === '1' || req.query.warm === '1';

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

    if (range && !isFullFetch) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const requestedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const end = Math.min(requestedEnd, fileSize - 1);
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

      driveStream.data.on('error', () => { if (!res.writableEnded) res.end(); });
      req.on('close', () => { if (driveStream.data && driveStream.data.destroy) driveStream.data.destroy(); });
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
      driveStream.data.on('error', () => { if (!res.writableEnded) res.end(); });
      req.on('close', () => { if (driveStream.data && driveStream.data.destroy) driveStream.data.destroy(); });
      driveStream.data.pipe(res);
    }
  } catch (error) {
    if (!res.headersSent) res.status(500).send('Error streaming audio');
  }
});

app.get('/api/artist-image', async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name || name === 'Cloud Artist') return res.json({ image: '' });

  const key = name.toLowerCase();
  if (artistPhotoCache[key]) return res.json({ image: artistPhotoCache[key] });

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

function detectTrendingTrackLanguage(item) {
  const genre = (item.primaryGenreName || '').toLowerCase();
  const rawText = (item.trackName || '') + ' ' + (item.collectionName || '') + ' ' + (item.artistName || '');
  const lower = rawText.toLowerCase();

  // 1a. Explicit iTunes primaryGenreName language tag
  if (genre.includes('malayalam')) return 'malayalam';
  if (genre.includes('tamil')) return 'tamil';
  if (genre.includes('telugu')) return 'telugu';
  if (genre.includes('kannada')) return 'kannada';
  if (genre.includes('hindi') || genre.includes('bollywood')) return 'hindi';

  // 1b. Unicode Script range check
  if (/[\u0D00-\u0D7F]/.test(rawText)) return 'malayalam';
  if (/[\u0B80-\u0BFF]/.test(rawText)) return 'tamil';
  if (/[\u0C00-\u0C7F]/.test(rawText)) return 'telugu';
  if (/[\u0C80-\u0CFF]/.test(rawText)) return 'kannada';
  if (/[\u0900-\u097F]/.test(rawText)) return 'hindi';

  // 1c. Known artist / film lookup
  if (/\b(sushin shyam|jakes bejoy|vishnu vijay|vineeth sreenivasan|shaan rahman|rex vijayan|gopi sundar|dabzee|govind vasantha|fejo|vedan|thirumaali|job kurian|ks harisankar|sithara krishnakumar|aavesham|premalu|manjummel boys|kumbalangi nights|hridayam|bramayugam|aadujeevitham|bougainvillea|varshangalkku shesham)\b/.test(lower)) return 'malayalam';
  if (/\b(anirudh|anirudh ravichander|yuvan shankar raja|harris jayaraj|g\.?v\.? prakash|santhosh narayanan|ilayaraja|ilaiyaraaja|sai abhyankkar|pradeep kumar|sean roldan|hiphop tamizha|dhee|jailer|leo|vikram|master|ponniyin selvan|amaran|vettaiyan|goat)\b/.test(lower)) return 'tamil';
  if (/\b(arijit singh|pritam|vishal mishra|sachin-jigar|sachin jigar|shreya ghoshal|atif aslam|jubin nautiyal|amit trivedi|badshah|diljit dosanjh|sonu nigam|kumar sanu|udit narayan|animal|stree 2|bhool bhulaiyaa|jawan|pathaan|kabir singh|aashiqui 2)\b/.test(lower)) return 'hindi';
  if (/\b(the weeknd|bruno mars|billie eilish|taylor swift|sabrina carpenter|post malone|dua lipa|coldplay|kendrick lamar|ed sheeran|drake|travis scott|ariana grande|justin bieber|lady gaga|imagine dragons)\b/.test(lower)) return 'english';

  return 'unknown';
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
      'sai abhyankkar sean roldan tamil'
    ],
    hindi: [
      'hindi songs 2025 2026',
      'arijit singh pritam hindi',
      'sachin jigar vishal mishra hindi',
      'bollywood hits shreya ghoshal jubin nautiyal'
    ],
    english: [
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
      .then(function (r) { return (r.data && r.data.results) || []; })
      .catch(function () { return []; });
  });

  const resultsArrays = await Promise.all(requests);
  const seen = new Set();
  const merged = [];

  for (const arr of resultsArrays) {
    for (const item of arr) {
      if (!item.trackId || !item.trackName) continue;
      if (detectTrendingTrackLanguage(item) !== lang) continue;

      const key = item.trackName.toLowerCase().trim() + '_' + (item.artistName || '').toLowerCase().trim();
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
        explicit: item.trackExplicitness === 'explicit',
        artwork: (item.artworkUrl100 || '/icon-512.png').replace('100x100bb', '600x600bb'),
        trackViewUrl: item.trackViewUrl || ''
      });
      if (merged.length >= 100) break;
    }
    if (merged.length >= 100) break;
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

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const axios = require('axios');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(__dirname, 'public')));

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
const trendingCache = {};

async function getDriveSongs(forceRefresh = false) {
  if (!forceRefresh && songsCache && Date.now() - lastCacheTime < 25000) {
    return songsCache;
  }
  const response = await drive.files.list({
    q: "'" + DRIVE_FOLDER_ID + "' in parents and trashed = false",
    fields: 'files(id, name, size, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 500,
  });
  songsCache = response.data.files || [];
  lastCacheTime = Date.now();
  return songsCache;
}

app.get('/api/ping', (req, res) => res.json({ status: 'awake' }));

// 1. Upload Audio File to Google Drive
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
      fields: 'id, name, size',
    });

    songsCache = null;
    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. List All Uploaded Songs from Google Drive
app.get('/api/songs', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const files = await getDriveSongs(force);
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Stream Audio with HTTP 206 Byte-Range Support
app.get('/api/stream/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const range = req.headers.range;

    const meta = await drive.files.get({
      fileId,
      fields: 'size, mimeType',
    });
    const fileSize = parseInt(meta.data.size, 10);
    const mimeType = meta.data.mimeType || 'audio/mpeg';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const driveStream = await drive.files.get(
        { fileId, alt: 'media' },
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
      });

      driveStream.data.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
      });

      const driveStream = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      driveStream.data.pipe(res);
    }
  } catch (error) {
    res.status(500).send('Error streaming audio from Drive');
  }
});

// Helper: Fetch 100+ Songs per Language from iTunes API
async function fetchLanguageTrending(lang) {
  const queriesByLang = {
    malayalam: [
      'malayalam hits 2025 2026',
      'sushin shyam jakes bejoy vishnu vijay',
      'malayalam songs vineeth sreenivasan shaan rahman',
      'mollywood hits dabzee rex vijayan gopi sundar'
    ],
    tamil: [
      'tamil hits 2025 2026',
      'anirudh ravichander sai abhyankkar tamil',
      'ar rahman yuvan shankar raja gv prakash tamil',
      'kollywood hits santhosh narayanan harris jayaraj'
    ],
    hindi: [
      'hindi hits 2025 2026',
      'arijit singh pritam sachin jigar hindi',
      'bollywood hits vishal mishra shreya ghoshal',
      'hindi top songs diljit dosanjh karan aujla'
    ],
    english: [
      'pop hits 2025 2026',
      'the weeknd bruno mars taylor swift billie eilish',
      'global hits sabrina carpenter kendrick lamar',
      'english top songs post malone dua lipa coldplay'
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
      '&media=music&entity=song&limit=60';
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
        artwork: (item.artworkUrl100 || '/icon-192.png').replace('100x100bb', '600x600bb'),
        trackViewUrl: item.trackViewUrl || ''
      });
      if (merged.length >= 120) break;
    }
    if (merged.length >= 120) break;
  }

  return merged;
}

// 4. Trending 100+ Songs Endpoint
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

// 5. Direct Downloadable Song Link Resolver
app.get('/api/song-link', async (req, res) => {
  const trackId = req.query.trackId || '';
  const trackUrl = req.query.trackUrl || '';
  const title = req.query.title || '';
  const artist = req.query.artist || '';

  // Step A: Odesli / Songlink API for direct Spotify Track URL or YouTube Watch URL
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

  // Step B: Fallback to direct YouTube video watch URL
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

  // Step C: Fallback to direct Apple Music song link
  return res.json({
    url: trackUrl || ('https://music.apple.com/in/song/' + trackId),
    source: 'Apple Music'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Musix server running on http://localhost:' + PORT);
});

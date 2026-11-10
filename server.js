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

// Memory cache so library loads fast
let songsCache = null;
let lastCacheTime = 0;

async function getDriveSongs(forceRefresh = false) {
  if (!forceRefresh && songsCache && Date.now() - lastCacheTime < 25000) {
    return songsCache;
  }
  const response = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
    fields: 'files(id, name, size, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 500,
  });
  songsCache = response.data.files || [];
  lastCacheTime = Date.now();
  return songsCache;
}

// Health check endpoint
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

    songsCache = null; // Clear cache so new song appears immediately
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
          headers: { Range: `bytes=${start}-${end}` },
        }
      );

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
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

// 4. Weekly Trending Songs (Official iTunes RSS JSON API + Spotify Links)
app.get('/api/trending', async (req, res) => {
  try {
    const indiaUrl = 'https://itunes.apple.com/in/rss/topsongs/limit=25/json';
    const globalUrl = 'https://itunes.apple.com/us/rss/topsongs/limit=25/json';

    const [indiaRes, globalRes, driveFiles] = await Promise.all([
      axios.get(indiaUrl, { timeout: 8000 }),
      axios.get(globalUrl, { timeout: 8000 }),
      getDriveSongs().catch(() => []),
    ]);

    const uploadedNames = (driveFiles || []).map((f) => f.name.toLowerCase());

    const parseItunesFeed = (feedData) => {
      const entries = feedData?.feed?.entry || [];
      return entries.map((entry, idx) => {
        const title = entry['im:name']?.label || 'Unknown Title';
        const artist = entry['im:artist']?.label || 'Unknown Artist';
        const images = entry['im:image'] || [];
        const rawArt = images[images.length - 1]?.label || '/icon.svg';
        const artwork = rawArt.replace('170x170bb', '600x600bb');
        const releaseDate = entry['im:releaseDate']?.attributes?.label || '';
        const genre = entry.category?.attributes?.label || 'Music';
        const spotifyQuery = encodeURIComponent(`${title} ${artist}`);
        const spotifyUrl = `https://open.spotify.com/search/${spotifyQuery}`;

        return {
          rank: idx + 1,
          title,
          artist,
          genre,
          artwork,
          releaseDate,
          spotifyUrl,
          alreadyInDrive: uploadedNames.some((name) =>
            name.includes(title.toLowerCase())
          ),
        };
      });
    };

    res.json({
      indiaTrending: parseItunesFeed(indiaRes.data),
      globalTrending: parseItunesFeed(globalRes.data),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Musix server running on http://localhost:${PORT}`);
});

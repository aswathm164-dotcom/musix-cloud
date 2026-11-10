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

// Authenticate with Google Drive using OAuth2 Refresh Token
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

    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. List All Uploaded Songs from Google Drive
app.get('/api/songs', async (req, res) => {
  try {
    const response = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, size, createdTime)',
      orderBy: 'createdTime desc',
    });
    res.json(response.data.files || []);
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

// 4. Weekly Trending Songs Checklist (India & Global)
app.get('/api/trending', async (req, res) => {
  try {
    const indiaUrl = 'https://rss.applemarketingtools.com/api/v2/in/music/most-played/25/songs.json';
    const globalUrl = 'https://rss.applemarketingtools.com/api/v2/us/music/most-played/25/songs.json';

    const [indiaRes, globalRes, driveFiles] = await Promise.all([
      axios.get(indiaUrl),
      axios.get(globalUrl),
      drive.files.list({
        q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
        fields: 'files(name)',
      }),
    ]);

    const uploadedNames = (driveFiles.data.files || []).map(f => f.name.toLowerCase());

    const formatChart = (results) =>
      (results || []).map((track, idx) => ({
        rank: idx + 1,
        title: track.name,
        artist: track.artistName,
        artwork: track.artworkUrl100,
        releaseDate: track.releaseDate,
        alreadyInDrive: uploadedNames.some(name => name.includes(track.name.toLowerCase())),
      }));

    res.json({
      indiaTrending: formatChart(indiaRes.data.feed.results),
      globalTrending: formatChart(globalRes.data.feed.results),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Musix server running on http://localhost:${PORT}`);
});

const v8 = require('v8');
v8.setFlagsFromString('--max-old-space-size=350');
const os = require('os');
const fs = require('fs');
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const axios = require('axios');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 80 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));
app.use(express.json({ limit: '5mb' }));

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

const META_FILE_NAME = 'musix-metadata.json';
let metaFileIdCache = null;
let centralDbCache = null; // { version: 2, updatedAt, records: { [fileId]: { ... } } }
let songsCache = null;
let lastCacheTime = 0;
let isScanningDriveTags = false;
const fileMetaCache = {};
const trendingCache = {};
const artistPhotoCache = {};
const sseClients = new Set();

function broadcastSyncEvent(payload) {
  const data = 'data: ' + JSON.stringify(payload) + '\n\n';
  sseClients.forEach(function (client) {
    try {
      client.write(data);
    } catch (e) {
      sseClients.delete(client);
    }
  });
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: ' + JSON.stringify({ type: 'connected', ts: Date.now() }) + '\n\n');
  sseClients.add(res);
  const keepAlive = setInterval(function () {
    try { res.write(': ping\n\n'); } catch (e) {}
  }, 25000);
  req.on('close', function () {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

function decodeId3Text(payload, encoding) {
  if (!payload || payload.length === 0) return '';
  if (encoding === 1) {
    // UTF-16 with BOM
    if (payload.length >= 2 && payload[0] === 0xfe && payload[1] === 0xff) {
      const swapped = Buffer.alloc(payload.length - 2);
      for (let i = 2; i + 1 < payload.length; i += 2) {
        swapped[i - 2] = payload[i + 1];
        swapped[i - 1] = payload[i];
      }
      return swapped.toString('utf16le').replace(/\0/g, '').trim();
    }
    const start = (payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xfe) ? 2 : 0;
    return payload.subarray(start).toString('utf16le').replace(/\0/g, '').trim();
  }
  if (encoding === 2) {
    const swapped = Buffer.alloc(payload.length);
    for (let i = 0; i + 1 < payload.length; i += 2) {
      swapped[i] = payload[i + 1];
      swapped[i + 1] = payload[i];
    }
    return swapped.toString('utf16le').replace(/\0/g, '').trim();
  }
  return payload.toString('utf8').replace(/\0/g, '').trim();
}

// Deep ID3v2.3 & ID3v2.4 parser (Title, Artist, Album, AlbumArtist, Genre, Language, Year, TrackNumber, CoverArt, TXXX)
function extractAudioTags(buffer) {
  const tags = {
    title: '',
    artist: '',
    album: '',
    albumArtist: '',
    genre: '',
    language: '',
    year: '',
    trackNumber: '',
    coverArt: ''
  };
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

      if (frameId === 'APIC') {
        // Parse embedded cover art if under 120KB
        if (frameSize < 120000) {
          let mimeEnd = 0;
          while (mimeEnd < payload.length && payload[mimeEnd] !== 0) mimeEnd++;
          const mime = payload.toString('ascii', 0, mimeEnd) || 'image/jpeg';
          let descStart = mimeEnd + 2; // skip null + picture type byte
          while (descStart < payload.length && payload[descStart] !== 0) descStart++;
          descStart++; // skip null terminator
          if (descStart < payload.length && payload[descStart] === 0) descStart++;
          const imgBuf = payload.subarray(descStart);
          if (imgBuf.length > 128) {
            tags.coverArt = 'data:' + mime + ';base64,' + imgBuf.toString('base64');
          }
        }
      } else if (frameId === 'TXXX') {
        const decoded = decodeId3Text(payload, encoding);
        const parts = payload.toString(encoding === 1 || encoding === 2 ? 'utf16le' : 'utf8').split('\0').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const desc = parts[0].toLowerCase();
          const val = parts[parts.length - 1];
          if (desc.includes('lang')) tags.language = val;
          else if (desc.includes('albumartist') || desc.includes('album artist')) tags.albumArtist = val;
        } else if (/malayalam|tamil|hindi|telugu|kannada|english/i.test(decoded) && !tags.language) {
          tags.language = decoded;
        }
      } else {
        const text = decodeId3Text(payload, encoding);
        if (frameId === 'TIT2') tags.title = text;
        else if (frameId === 'TPE1') tags.artist = text;
        else if (frameId === 'TALB') tags.album = text;
        else if (frameId === 'TPE2') tags.albumArtist = text;
        else if (frameId === 'TCON') {
          tags.genre = text.replace(/^\(\d+\)/, '').trim();
          if (!tags.language && /malayalam|tamil|hindi|telugu|kannada|english/i.test(tags.genre)) {
            tags.language = tags.genre;
          }
        }
        else if (frameId === 'TLAN') tags.language = text;
        else if (frameId === 'TYER' || frameId === 'TDRC') tags.year = text.slice(0, 4);
        else if (frameId === 'TRCK') tags.trackNumber = text;
        else if (frameId === 'COMM' && !tags.language && /malayalam|tamil|hindi|telugu|kannada/i.test(text)) {
          const m = text.match(/(malayalam|tamil|hindi|telugu|kannada)/i);
          if (m) tags.language = m[1];
        }
      }

      pos += 10 + frameSize;
    }
  } catch (e) {}
  return tags;
}

function normalizeLanguageValue(raw) {
  if (!raw) return '';
  const t = String(raw).toLowerCase().trim();
  if (t === 'mal' || t === 'ml' || t.includes('malayalam') || t.includes('mollywood')) return 'Malayalam';
  if (t === 'tam' || t === 'ta' || t.includes('tamil') || t.includes('kollywood')) return 'Tamil';
  if (t === 'hin' || t === 'hi' || t.includes('hindi') || t.includes('bollywood')) return 'Hindi';
  if (t === 'tel' || t === 'te' || t.includes('telugu') || t.includes('tollywood')) return 'Telugu';
  if (t === 'kan' || t === 'kn' || t.includes('kannada') || t.includes('sandalwood')) return 'Kannada';
  if (t === 'eng' || t === 'en' || t.includes('english')) return 'English';
  if (t === 'other/unknown' || t === 'unknown' || t === 'other') return 'Other/Unknown';
  return '';
}

async function loadCentralDb(allFiles) {
  try {
    let metaFile = Array.isArray(allFiles)
      ? allFiles.find(function (f) { return f.name === META_FILE_NAME; })
      : null;

    if (!metaFile && !metaFileIdCache) {
      const search = await drive.files.list({
        q: "'" + DRIVE_FOLDER_ID + "' in parents and name = '" + META_FILE_NAME + "' and trashed = false",
        fields: 'files(id, name)',
        pageSize: 1
      });
      if (search.data.files && search.data.files.length > 0) {
        metaFile = search.data.files[0];
      }
    }

    if (metaFile) metaFileIdCache = metaFile.id;
    if (!metaFileIdCache) {
      centralDbCache = centralDbCache || { version: 2, updatedAt: Date.now(), records: {}, overrides: {} };
      return centralDbCache;
    }

    const fileRes = await drive.files.get(
      { fileId: metaFileIdCache, alt: 'media' },
      { responseType: 'json' }
    );
    const data = typeof fileRes.data === 'string' ? JSON.parse(fileRes.data) : (fileRes.data || {});
    const records = data.records || {};
    const legacyOverrides = data.overrides || {};

    // Migrate any legacy single-field overrides into full records without losing data
    Object.keys(legacyOverrides).forEach(function (songId) {
      const lang = normalizeLanguageValue(legacyOverrides[songId]) || legacyOverrides[songId];
      if (!records[songId]) {
        records[songId] = { id: songId, language: lang, updatedAt: data.updatedAt || Date.now(), source: 'cloud' };
      } else if (!records[songId].language) {
        records[songId].language = lang;
      }
    });

    centralDbCache = {
      version: 2,
      updatedAt: data.updatedAt || Date.now(),
      records: records,
      overrides: legacyOverrides
    };
    return centralDbCache;
  } catch (e) {
    return centralDbCache || { version: 2, updatedAt: Date.now(), records: {}, overrides: {} };
  }
}

// Conflict-safe merge: Last-Write-Wins based on updatedAt timestamp, preserving existing valid non-empty fields
function mergeSongRecord(existing, incoming, incomingTimestamp) {
  const base = Object.assign({
    id: '',
    fileName: '',
    title: '',
    artist: '',
    album: '',
    albumArtist: '',
    genre: '',
    language: '',
    year: '',
    trackNumber: '',
    coverArt: '',
    driveModifiedTime: 0,
    updatedAt: 0,
    source: 'auto'
  }, existing || {});

  const incTs = incomingTimestamp || incoming.updatedAt || Date.now();
  const isIncomingNewer = incTs >= (base.updatedAt || 0);
  const fields = ['fileName', 'title', 'artist', 'album', 'albumArtist', 'genre', 'language', 'year', 'trackNumber', 'coverArt'];

  fields.forEach(function (field) {
    let val = incoming[field];
    if (field === 'language' && val) {
      val = normalizeLanguageValue(val) || val;
    }
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      if (isIncomingNewer || !base[field] || base[field] === 'Other/Unknown' || base[field] === 'Cloud Artist' || base[field] === 'Cloud Drive') {
        base[field] = String(val).trim();
      }
    }
  });

  if (incoming.driveModifiedTime && incoming.driveModifiedTime > (base.driveModifiedTime || 0)) {
    base.driveModifiedTime = incoming.driveModifiedTime;
  }
  if (isIncomingNewer) {
    base.updatedAt = incTs;
    if (incoming.source) base.source = incoming.source;
  }
  return base;
}

async function saveCentralDb(dbObj) {
  dbObj.updatedAt = Date.now();
  dbObj.overrides = dbObj.overrides || {};
  Object.keys(dbObj.records || {}).forEach(function (id) {
    if (dbObj.records[id] && dbObj.records[id].language) {
      dbObj.overrides[id] = dbObj.records[id].language;
    }
  });

  const payload = JSON.stringify(dbObj);
  const media = { mimeType: 'application/json', body: payload };

  if (metaFileIdCache) {
    await drive.files.update({
      fileId: metaFileIdCache,
      media: media,
      fields: 'id'
    });
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: META_FILE_NAME,
        parents: [DRIVE_FOLDER_ID],
        mimeType: 'application/json'
      },
      media: media,
      fields: 'id'
    });
    metaFileIdCache = created.data.id;
  }

  centralDbCache = dbObj;
  songsCache = null;
  return centralDbCache;
}

// Background scanner: reads first 96KB of modified or unindexed Drive audio files to detect PC/Drive tag edits automatically
async function inspectModifiedDriveFiles(filesToScan) {
  if (isScanningDriveTags || !filesToScan || filesToScan.length === 0) return;
  isScanningDriveTags = true;
  try {
    const db = await loadCentralDb(null);
    let changedCount = 0;
    const batch = filesToScan.slice(0, 6); // max 6 per cycle to keep RAM well under 512MB

    for (const f of batch) {
      try {
        const res = await drive.files.get(
          { fileId: f.id, alt: 'media' },
          {
            responseType: 'arraybuffer',
            headers: { Range: 'bytes=0-98303' }
          }
        );
        const buf = Buffer.from(res.data);
        const id3 = extractAudioTags(buf);
        const fileModMs = f.modifiedTime ? new Date(f.modifiedTime).getTime() : Date.now();

        const merged = mergeSongRecord(
          db.records[f.id],
          {
            id: f.id,
            fileName: f.name,
            title: id3.title,
            artist: id3.artist,
            album: id3.album,
            albumArtist: id3.albumArtist,
            genre: id3.genre,
            language: id3.language,
            year: id3.year,
            trackNumber: id3.trackNumber,
            coverArt: id3.coverArt,
            driveModifiedTime: fileModMs,
            source: 'file-id3'
          },
          fileModMs
        );
        merged.driveModifiedTime = fileModMs;
        db.records[f.id] = merged;
        changedCount++;
      } catch (e) {}
    }

    if (changedCount > 0) {
      await saveCentralDb(db);
      broadcastSyncEvent({
        type: 'metadata-update',
        ts: db.updatedAt,
        records: db.records
      });
    }
  } catch (err) {}
  isScanningDriveTags = false;
}

async function getDriveSongs(forceRefresh = false) {
  if (!forceRefresh && songsCache && Date.now() - lastCacheTime < 15000) {
    return songsCache;
  }
  const response = await drive.files.list({
    q: "'" + DRIVE_FOLDER_ID + "' in parents and trashed = false",
    fields: 'files(id, name, size, mimeType, createdTime, modifiedTime, md5Checksum, appProperties)',
    orderBy: 'createdTime desc',
    pageSize: 500,
  });
  const rawFiles = response.data.files || [];
  const db = await loadCentralDb(rawFiles);
  const filesNeedingTagScan = [];

  songsCache = rawFiles
    .filter(function (f) { return f.name !== META_FILE_NAME; })
    .map(function (f) {
      if (f.size) {
        fileMetaCache[f.id] = {
          size: parseInt(f.size, 10),
          mimeType: f.mimeType || 'audio/mpeg'
        };
      }
      const fileModMs = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
      const appProps = f.appProperties || {};
      const rec = db.records[f.id] || {};

      // Check if file on Drive was modified more recently than our last ID3 scan
      if (!rec.driveModifiedTime || fileModMs > rec.driveModifiedTime + 1000) {
        filesNeedingTagScan.push(f);
      }

      const resolvedLang =
        normalizeLanguageValue(rec.language) ||
        normalizeLanguageValue(appProps.manualLang) ||
        normalizeLanguageValue(appProps.tagLang) ||
        normalizeLanguageValue(appProps.tagGenre) ||
        rec.language ||
        '';

      f.cloudLang = resolvedLang;
      f.cloudMeta = {
        id: f.id,
        title: rec.title || '',
        artist: rec.artist || appProps.tagArtist || '',
        album: rec.album || appProps.tagAlbum || '',
        albumArtist: rec.albumArtist || '',
        genre: rec.genre || appProps.tagGenre || '',
        language: resolvedLang,
        year: rec.year || '',
        trackNumber: rec.trackNumber || '',
        coverArt: rec.coverArt || '',
        updatedAt: rec.updatedAt || fileModMs || 0
      };
      return f;
    });

  lastCacheTime = Date.now();

  if (filesNeedingTagScan.length > 0) {
    setImmediate(function () {
      inspectModifiedDriveFiles(filesNeedingTagScan);
    });
  }

  return songsCache;
}

app.get('/api/ping', (req, res) => res.json({ status: 'awake' }));

// Update or upload song binary + metadata from local PC sync agent or web upload
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const headerBuf = Buffer.alloc(98304);
    const fd = fs.openSync(req.file.path, 'r');
    const bytesRead = fs.readSync(fd, headerBuf, 0, 98304, 0);
    fs.closeSync(fd);
    const id3 = extractAudioTags(headerBuf.subarray(0, bytesRead));

    const targetName = req.body.fileName || req.body.title || req.file.originalname;
    const existingId = req.body.fileId || '';

    // Check if file already exists in Drive to prevent duplicates
    let fileIdToUpdate = existingId;
    if (!fileIdToUpdate) {
      const existingList = await getDriveSongs(false);
      const match = existingList.find(function (s) {
        return s.name.toLowerCase().trim() === targetName.toLowerCase().trim();
      });
      if (match) fileIdToUpdate = match.id;
    }

    const fileStream = fs.createReadStream(req.file.path);
    const mergedLang = normalizeLanguageValue(req.body.language || id3.language || '') || '';

    let response;
    if (fileIdToUpdate) {
      response = await drive.files.update({
        fileId: fileIdToUpdate,
        requestBody: {
          name: targetName,
          appProperties: {
            manualLang: mergedLang.slice(0, 40),
            tagLang: mergedLang.slice(0, 40),
            tagAlbum: (req.body.album || id3.album || '').slice(0, 60),
            tagArtist: (req.body.artist || id3.artist || '').slice(0, 60),
            tagGenre: (req.body.genre || id3.genre || '').slice(0, 40)
          }
        },
        media: {
          mimeType: req.file.mimetype,
          body: fileStream
        },
        fields: 'id, name, size, mimeType, modifiedTime, appProperties'
      });
    } else {
      response = await drive.files.create({
        requestBody: {
          name: targetName,
          parents: [DRIVE_FOLDER_ID],
          mimeType: req.file.mimetype,
          appProperties: {
            manualLang: mergedLang.slice(0, 40),
            tagLang: mergedLang.slice(0, 40),
            tagAlbum: (req.body.album || id3.album || '').slice(0, 60),
            tagArtist: (req.body.artist || id3.artist || '').slice(0, 60),
            tagGenre: (req.body.genre || id3.genre || '').slice(0, 40)
          }
        },
        media: {
          mimeType: req.file.mimetype,
          body: fileStream,
        },
        fields: 'id, name, size, mimeType, modifiedTime, appProperties',
      });
    }

    const savedFile = response.data;
    const db = await loadCentralDb(null);
    const modMs = savedFile.modifiedTime ? new Date(savedFile.modifiedTime).getTime() : Date.now();
    db.records[savedFile.id] = mergeSongRecord(
      db.records[savedFile.id],
      {
        id: savedFile.id,
        fileName: savedFile.name,
        title: req.body.songTitle || id3.title,
        artist: req.body.artist || id3.artist,
        album: req.body.album || id3.album,
        albumArtist: req.body.albumArtist || id3.albumArtist,
        genre: req.body.genre || id3.genre,
        language: mergedLang,
        year: req.body.year || id3.year,
        trackNumber: req.body.trackNumber || id3.trackNumber,
        coverArt: id3.coverArt,
        driveModifiedTime: modMs,
        source: req.body.source || 'upload'
      },
      Date.now()
    );
    await saveCentralDb(db);
    broadcastSyncEvent({
      type: 'metadata-update',
      ts: db.updatedAt,
      songId: savedFile.id,
      record: db.records[savedFile.id]
    });

    songsCache = null;
    res.status(200).json(savedFile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, function () {});
    }
  }
});

// Full two-way metadata sync endpoint (supports bulk records + legacy language overrides + conflict resolution)
app.post('/api/sync-metadata', async (req, res) => {
  try {
    const db = await loadCentralDb(null);
    const incomingOverrides = (req.body && req.body.overrides) || {};
    const incomingRecords = (req.body && req.body.records) || {};
    let updatedAny = false;

    Object.keys(incomingOverrides).forEach(function (songId) {
      const lang = normalizeLanguageValue(incomingOverrides[songId]) || incomingOverrides[songId];
      if (!lang) return;
      const existing = db.records[songId];
      if (!existing || existing.language !== lang) {
        db.records[songId] = mergeSongRecord(existing, { id: songId, language: lang, source: 'client' }, Date.now());
        updatedAny = true;
      }
    });

    Object.keys(incomingRecords).forEach(function (songId) {
      const rec = incomingRecords[songId];
      if (!rec) return;
      db.records[songId] = mergeSongRecord(db.records[songId], Object.assign({ id: songId }, rec), rec.updatedAt || Date.now());
      updatedAny = true;
    });

    if (updatedAny) {
      await saveCentralDb(db);
      broadcastSyncEvent({
        type: 'metadata-update',
        ts: db.updatedAt,
        records: db.records
      });
    }

    res.json({
      ok: true,
      updatedAt: db.updatedAt,
      overrides: db.overrides || {},
      records: db.records || {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Single-song full metadata or language update endpoint
app.post('/api/songs/:fileId/metadata', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const body = req.body || {};
    const db = await loadCentralDb(null);
    const updatedRec = mergeSongRecord(
      db.records[fileId],
      {
        id: fileId,
        fileName: body.fileName,
        title: body.title,
        artist: body.artist,
        album: body.album,
        albumArtist: body.albumArtist,
        genre: body.genre,
        language: body.language,
        year: body.year,
        trackNumber: body.trackNumber,
        coverArt: body.coverArt,
        source: body.source || 'app-edit'
      },
      body.updatedAt || Date.now()
    );
    db.records[fileId] = updatedRec;
    await saveCentralDb(db);

    broadcastSyncEvent({
      type: 'metadata-update',
      ts: db.updatedAt,
      songId: fileId,
      record: updatedRec,
      records: db.records
    });

    res.json({ ok: true, id: fileId, record: updatedRec, records: db.records });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/songs/:fileId/language', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const language = String((req.body && req.body.language) || '').trim();
    if (!language) return res.status(400).json({ error: 'Language is required' });

    const db = await loadCentralDb(null);
    const updatedRec = mergeSongRecord(
      db.records[fileId],
      { id: fileId, language: language, source: 'app-edit' },
      Date.now()
    );
    db.records[fileId] = updatedRec;
    await saveCentralDb(db);

    broadcastSyncEvent({
      type: 'metadata-update',
      ts: db.updatedAt,
      songId: fileId,
      record: updatedRec,
      records: db.records
    });

    res.json({ ok: true, id: fileId, language: updatedRec.language, overrides: db.overrides, records: db.records });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to force re-scan ID3 headers of all existing Drive files
app.post('/api/rescan-drive-tags', async (req, res) => {
  try {
    const files = await getDriveSongs(true);
    inspectModifiedDriveFiles(files);
    res.json({ ok: true, queued: files.length });
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

  if (genre.includes('malayalam')) return 'malayalam';
  if (genre.includes('tamil')) return 'tamil';
  if (genre.includes('telugu')) return 'telugu';
  if (genre.includes('kannada')) return 'kannada';
  if (genre.includes('hindi') || genre.includes('bollywood')) return 'hindi';

  if (/[\u0D00-\u0D7F]/.test(rawText)) return 'malayalam';
  if (/[\u0B80-\u0BFF]/.test(rawText)) return 'tamil';
  if (/[\u0C00-\u0C7F]/.test(rawText)) return 'telugu';
  if (/[\u0C80-\u0CFF]/.test(rawText)) return 'kannada';
  if (/[\u0900-\u097F]/.test(rawText)) return 'hindi';

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

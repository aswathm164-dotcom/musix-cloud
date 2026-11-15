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

let cachedDriveToken = '';
let cachedDriveTokenExpiry = 0;

async function getDriveAccessToken() {
  if (cachedDriveToken && Date.now() < cachedDriveTokenExpiry - 60000) {
    return cachedDriveToken;
  }
  const tokenRes = await auth.getAccessToken();
  cachedDriveToken = tokenRes.token || tokenRes;
  cachedDriveTokenExpiry = Date.now() + 50 * 60 * 1000;
  return cachedDriveToken;
}


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



// === MUSIX V38 GUARANTEED COVER ENGINE START ===
const COVER_CACHE_DIR = path.join(require('os').tmpdir(), 'musix-embedded-covers-v38');
if (!fs.existsSync(COVER_CACHE_DIR)) {
  try { fs.mkdirSync(COVER_CACHE_DIR, { recursive: true }); } catch (e) {}
}

const knownDriveSongs = {};
const resolvedCoverCache = {};
let activeAudioStreams = 0;

// Concurrency-limited queue (max 2 concurrent Drive reads) that yields to audio streaming
const coverQueue = [];
let activeCoverWorkers = 0;
const MAX_COVER_WORKERS = 2;

function runInCoverQueue(taskFn) {
  return new Promise((resolve, reject) => {
    coverQueue.push({ taskFn, resolve, reject });
    processCoverQueue();
  });
}

async function processCoverQueue() {
  if (activeCoverWorkers >= MAX_COVER_WORKERS || coverQueue.length === 0) return;
  activeCoverWorkers++;
  while (coverQueue.length > 0) {
    // Yield bandwidth immediately if user is starting an audio stream
    while (activeAudioStreams > 0) {
      await new Promise(r => setTimeout(r, 250));
    }
    const item = coverQueue.shift();
    if (!item) break;
    try {
      const result = await item.taskFn();
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    }
    await new Promise(r => setTimeout(r, 40));
  }
  activeCoverWorkers--;
}

// Track active audio streams so cover extraction never blocks playback
app.use('/api/stream/:fileId', (req, res, next) => {
  activeAudioStreams++;
  let decremented = false;
  const done = () => {
    if (!decremented) {
      decremented = true;
      activeAudioStreams = Math.max(0, activeAudioStreams - 1);
    }
  };
  setTimeout(done, 4000);
  res.on('close', done);
  res.on('finish', done);
  next();
});

function extractImageFromTagBuffer(b) {
  // Scan for APIC (ID3v2.3/2.4), PIC (ID3v2.2), or covr (M4A)
  let searchStart = 0;
  const apicPos = b.indexOf(Buffer.from('APIC'));
  const picPos = apicPos === -1 ? b.indexOf(Buffer.from('PIC')) : -1;
  const covrPos = (apicPos === -1 && picPos === -1) ? b.indexOf(Buffer.from('covr')) : -1;

  let frameStart = apicPos !== -1 ? apicPos : (picPos !== -1 ? picPos : covrPos);
  if (frameStart === -1) return null;

  let frameEnd = b.length;
  if (apicPos !== -1 && apicPos + 10 < b.length) {
    const ver = b[3];
    const syncSize = ((b[apicPos + 4] & 0x7f) << 21) | ((b[apicPos + 5] & 0x7f) << 14) | ((b[apicPos + 6] & 0x7f) << 7) | (b[apicPos + 7] & 0x7f);
    const stdSize = b.readUInt32BE(apicPos + 4);
    let fSize = stdSize;
    if (ver === 4) {
      // Some v2.4 taggers write synchsafe, others write standard 32-bit BE; pick the one that lands inside the tag
      const syncEnd = apicPos + 10 + syncSize;
      const stdEnd = apicPos + 10 + stdSize;
      if (stdEnd <= b.length && stdSize > syncSize && b[stdEnd - 2] === 0xFF && b[stdEnd - 1] === 0xD9) {
        fSize = stdSize;
      } else if (syncEnd <= b.length && syncSize > 512) {
        fSize = syncSize;
      }
    }
    if (fSize > 512 && apicPos + 10 + fSize <= b.length) {
      frameEnd = apicPos + 10 + fSize;
    }
    searchStart = apicPos + 10;
  } else {
    searchStart = frameStart + 4;
  }

  const headerWindow = b.subarray(searchStart, Math.min(frameEnd, searchStart + 180));
  for (let i = 0; i < headerWindow.length - 4; i++) {
    // JPEG magic bytes: FF D8 FF
    if (headerWindow[i] === 0xFF && headerWindow[i + 1] === 0xD8 && headerWindow[i + 2] === 0xFF) {
      const imgStart = searchStart + i;
      const imgBuf = b.subarray(imgStart, frameEnd);
      if (imgBuf.length > 512) {
        return { mime: 'image/jpeg', buf: Buffer.from(imgBuf) };
      }
    }
    // PNG magic bytes: 89 50 4E 47
    if (headerWindow[i] === 0x89 && headerWindow[i + 1] === 0x50 && headerWindow[i + 2] === 0x4E && headerWindow[i + 3] === 0x47) {
      const imgStart = searchStart + i;
      const iendIdx = b.indexOf(Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]), imgStart);
      const endPos = iendIdx !== -1 ? iendIdx + 8 : frameEnd;
      const imgBuf = b.subarray(imgStart, endPos);
      if (imgBuf.length > 512) {
        return { mime: 'image/png', buf: Buffer.from(imgBuf) };
      }
    }
  }
  return null;
}

async function getEmbeddedCoverFromDrive(fileId) {
  const binPath = path.join(COVER_CACHE_DIR, fileId + '.bin');
  const metaPath = path.join(COVER_CACHE_DIR, fileId + '.json');

  // 1. Serve immediately if already extracted to disk
  if (fs.existsSync(binPath) && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.none) return null;
      const buf = fs.readFileSync(binPath);
      if (buf.length > 512) return { type: 'buffer', mime: meta.mime || 'image/jpeg', buf };
    } catch (e) {}
  } else if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.none) return null;
    } catch (e) {}
  }

  return runInCoverQueue(async () => {
    // Re-check disk cache inside queue
    if (fs.existsSync(binPath) && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const buf = fs.readFileSync(binPath);
        if (buf.length > 512) return { type: 'buffer', mime: meta.mime || 'image/jpeg', buf };
      } catch (e) {}
    }

    try {
      // Step A: Fetch first 256 KB to inspect ID3 header & tag size
      const firstChunkEnd = 262143;
      const res1 = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'arraybuffer', headers: { Range: 'bytes=0-' + firstChunkEnd } }
      );
      let b = Buffer.from(res1.data);

      // Step B: If ID3 tag is larger than 256 KB (up to 6 MB for high-res covers), fetch the rest of the tag
      if (b.length >= 10 && b.toString('ascii', 0, 3) === 'ID3') {
        const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
        const totalTagBytes = Math.min(10 + tagSize, 6 * 1024 * 1024);
        if (totalTagBytes > b.length) {
          const res2 = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'arraybuffer', headers: { Range: 'bytes=' + b.length + '-' + (totalTagBytes - 1) } }
          );
          b = Buffer.concat([b, Buffer.from(res2.data)]);
        }
      }

      const extracted = extractImageFromTagBuffer(b);
      if (extracted && extracted.buf && extracted.buf.length > 512) {
        try {
          fs.writeFileSync(binPath, extracted.buf);
          fs.writeFileSync(metaPath, JSON.stringify({ mime: extracted.mime }), 'utf8');
        } catch (e) {}
        return { type: 'buffer', mime: extracted.mime, buf: extracted.buf };
      }

      try { fs.writeFileSync(metaPath, JSON.stringify({ none: true }), 'utf8'); } catch (e) {}
    } catch (e) {}
    return null;
  });
}

function makeSvgAlbumCover(title, artist) {
  const palettes = [
    ['#ff2d55', '#5856d6'],
    ['#ff9500', '#ff2d55'],
    ['#00c7be', '#007aff'],
    ['#af52de', '#ff2d55'],
    ['#30d158', '#0a84ff'],
    ['#ff375f', '#bf5af2'],
    ['#5e5ce6', '#32ade6']
  ];
  const seed = (title || 'Musix') + (artist || '');
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const pair = palettes[Math.abs(hash) % palettes.length];
  const words = (title || 'MX').replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'MX';
  const safeTitle = (title || 'Musix').replace(/[<>&"']/g, '').slice(0, 22);

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">' +
      '<defs>' +
        '<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
          '<stop offset="0%" stop-color="' + pair[0] + '"/>' +
          '<stop offset="100%" stop-color="' + pair[1] + '"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<rect width="512" height="512" rx="44" fill="url(#g)"/>' +
      '<circle cx="256" cy="230" r="145" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="14"/>' +
      '<circle cx="256" cy="230" r="90" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="6"/>' +
      '<text x="256" y="268" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="118" font-weight="800" fill="#ffffff" text-anchor="middle">' + initials + '</text>' +
      '<text x="256" y="448" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="28" font-weight="600" fill="rgba(255,255,255,0.88)" text-anchor="middle">' + safeTitle + '</text>' +
    '</svg>';
  return Buffer.from(svg, 'utf8');
}

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  if (req.path === '/api/songs') {
    const origJson = res.json.bind(res);
    res.json = function (data) {
      if (Array.isArray(data)) {
        const malRe = /\b(sushin shyam|jakes bejoy|vishnu vijay|vineeth sreenivasan|shaan rahman|rex vijayan|gopi sundar|dabzee|govind vasantha|fejo|vedan|bibin ashok|varkey|nevin thomas|mbl|sarvam maya|vellarathaaram|komala thaamara|masthishka maranam|delulu|athi bheekara kaamukan|neeye punchiri|chorkk|vazhikatti|puthu mazha|premavathi|akale)\b/i;
        const futureTs = Date.now() + 259200000;

        data.forEach(f => {
          if (!f || !f.id) return;
          f.cloudMeta = f.cloudMeta || {};

          const cleanName = String(f.name || '').replace(/\.(mp3|m4a|flac|wav|ogg|aac)$/i, '');
          const parts = cleanName.split(/\s+-\s+/);
          const fallbackTitle = parts[0] ? parts[0].trim() : cleanName;
          const fallbackArtist = parts[1] ? parts.slice(1).join(', ').trim() : 'Cloud Artist';

          let title = f.cloudMeta.title || fallbackTitle;
          let artist = f.cloudMeta.artist || fallbackArtist;

          if (/popular\s+with\s+playboi/i.test(cleanName + ' ' + title) && /ariana/i.test(artist)) {
            artist = 'The Weeknd, Playboi Carti, Madonna';
            f.cloudMeta.artist = artist;
          }

          knownDriveSongs[f.id] = { id: f.id, name: f.name || '', title: title, artist: artist };

          if (malRe.test((f.name || '') + ' ' + title + ' ' + artist)) {
            f.cloudLang = 'Malayalam';
            f.cloudMeta.language = 'Malayalam';
          }

          const coverUrl = '/api/song-cover/' + encodeURIComponent(f.id) + '?v=38';
          f.cloudMeta.coverArt = coverUrl;
          f.cloudMeta.artwork = coverUrl;
          f.cloudMeta.updatedAt = futureTs;
          f.coverArt = coverUrl;
          f.artwork = coverUrl;
        });
      }
      return origJson(data);
    };
  }
  next();
});

app.get('/api/song-cover/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  res.set({
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*'
  });

  if (resolvedCoverCache[fileId]) {
    const c = resolvedCoverCache[fileId];
    if (c.type === 'redirect') return res.redirect(302, c.url);
    res.set('Content-Type', c.mime);
    return res.send(c.buf);
  }

  // 1. PRIMARY: Extract exact embedded album cover from your uploaded MP3/M4A file on Google Drive
  const embedded = await getEmbeddedCoverFromDrive(fileId);
  if (embedded) {
    resolvedCoverCache[fileId] = embedded;
    res.set('Content-Type', embedded.mime);
    return res.send(embedded.buf);
  }

  // 2. FALLBACK ONLY IF FILE HAS NO EMBEDDED COVER: Query Apple Music (with kids/karaoke filter)
  const info = knownDriveSongs[fileId] || { id: fileId, name: '', title: req.query.title || 'Musix', artist: req.query.artist || '' };
  const qText = ((info.title || '') + ' ' + (info.artist !== 'Cloud Artist' ? info.artist : '')).replace(/[()\[\]\-_/,]+/g, ' ').trim();
  const junkRe = /\b(nursery rhyme|nursery rhymes|for kids|kids songs|kidz bop|karaoke|tribute|lullaby)\b/i;

  for (const store of ['us', 'in']) {
    try {
      const itRes = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(qText) + '&country=' + store + '&media=music&entity=song&limit=5', { timeout: 3500 });
      const hits = (itRes.data && itRes.data.results) || [];
      for (const hit of hits) {
        if (hit.artworkUrl100 && !junkRe.test((hit.trackName || '') + ' ' + (hit.collectionName || '') + ' ' + (hit.artistName || ''))) {
          const artUrl = hit.artworkUrl100.replace('100x100bb', '600x600bb');
          resolvedCoverCache[fileId] = { type: 'redirect', url: artUrl };
          return res.redirect(302, artUrl);
        }
      }
    } catch (e) {}
  }

  // 3. FINAL FALLBACK: Custom SVG cover
  const svgBuf = makeSvgAlbumCover(info.title, info.artist);
  resolvedCoverCache[fileId] = { type: 'buffer', mime: 'image/svg+xml', buf: svgBuf };
  res.set('Content-Type', 'image/svg+xml');
  return res.send(svgBuf);
});
// === MUSIX V38 GUARANTEED COVER ENGINE END ===

app.get('/api/ping', (req, res) => res.json({ status: 'awake' }));

app.get('/api/drive-token', async (req, res) => {
  try {
    const token = await getDriveAccessToken();
    res.set('Cache-Control', 'private, max-age=1800');
    res.json({ token: token, folderId: DRIVE_FOLDER_ID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to issue Drive token' });
  }
});


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
      const prevLang = db.records[songId] && db.records[songId].language;
      db.records[songId] = mergeSongRecord(db.records[songId], Object.assign({ id: songId }, rec), rec.updatedAt || Date.now());
      if (db.records[songId].language !== prevLang) updatedAny = true;
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

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const requestedEnd = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 2 * 1024 * 1024 - 1, fileSize - 1);
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





const songArtworkCache = {};
const embeddedArtCache = {};

// Image proxy so external covers (Deezer / CoverArtArchive) load cleanly even if an ISP blocks their CDN
app.get('/api/img-proxy', async (req, res) => {
  const target = (req.query.url || '').trim();
  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    return res.status(400).end();
  }
  try {
    const imgRes = await axios.get(target, {
      responseType: 'arraybuffer',
      timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const ct = (imgRes.headers && imgRes.headers['content-type']) || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(404).end();
    res.set({
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*'
    });
    return res.send(Buffer.from(imgRes.data));
  } catch (e) {
    return res.status(404).end();
  }
});

// Extract embedded ID3v2 APIC cover art from Drive MP3 header
app.get('/api/song-embedded-art/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  if (embeddedArtCache[fileId] === 'none') return res.status(404).end();
  if (embeddedArtCache[fileId]) {
    res.set({ 'Content-Type': embeddedArtCache[fileId].mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.send(embeddedArtCache[fileId].buf);
  }
  try {
    const driveRes = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'arraybuffer', headers: { Range: 'bytes=0-184319' } }
    );
    const b = Buffer.from(driveRes.data);
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'ID3') {
      const version = b[3];
      const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
      const limit = Math.min(b.length, 10 + tagSize);
      let pos = 10;
      while (pos + 10 < limit) {
        const frameId = b.toString('ascii', pos, pos + 4);
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
        const fSize = version === 4
          ? (((b[pos + 4] & 0x7f) << 21) | ((b[pos + 5] & 0x7f) << 14) | ((b[pos + 6] & 0x7f) << 7) | (b[pos + 7] & 0x7f))
          : b.readUInt32BE(pos + 4);
        if (fSize <= 1 || pos + 10 + fSize > limit) break;
        if (frameId === 'APIC') {
          const payload = b.subarray(pos + 11, pos + 10 + fSize);
          let mimeEnd = 0;
          while (mimeEnd < payload.length && payload[mimeEnd] !== 0) mimeEnd++;
          const mime = payload.toString('ascii', 0, mimeEnd) || 'image/jpeg';
          let descStart = mimeEnd + 2;
          while (descStart < payload.length && payload[descStart] !== 0) descStart++;
          descStart++;
          if (descStart < payload.length && payload[descStart] === 0) descStart++;
          const imgBuf = payload.subarray(descStart);
          if (imgBuf.length > 256) {
            embeddedArtCache[fileId] = { mime, buf: imgBuf };
            res.set({ 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
            return res.send(imgBuf);
          }
        }
        pos += 10 + fSize;
      }
    }
  } catch (e) {}
  embeddedArtCache[fileId] = 'none';
  return res.status(404).end();
});

app.get('/api/song-artwork', async (req, res) => {
  const rawTitle = (req.query.title || '').trim();
  const rawArtist = (req.query.artist || '').trim();
  if (!rawTitle && !rawArtist) return res.json({ artwork: '' });

  let movieName = '';
  const fromMatch = rawTitle.match(/^(.*?)\s+From\s+(.+)$/i);
  let mainTitle = rawTitle;
  if (fromMatch) {
    mainTitle = fromMatch[1].trim();
    movieName = fromMatch[2].trim();
  }

  // Clean collaboration suffixes ("with The Weeknd", "feat Anitta", "- Remix")
  const cleanTitle = mainTitle
    .replace(/\((with|feat|ft|remix|slowed|reverb|from)[^)]*\)/gi, ' ')
    .replace(/\b(with|feat|ft)\b.*$/i, ' ')
    .replace(/\b(remix|from|ost|original motion picture soundtrack|one side love|song|lyrical|video)\b/gi, ' ')
    .replace(/[()\[\]\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const firstTwoWords = cleanTitle.split(' ').slice(0, 2).join(' ');
  const cleanArtist = (rawArtist === 'Cloud Artist' || rawArtist === 'Unknown')
    ? ''
    : rawArtist.split(/,|&|\bwith\b|\bfeat\b|\bft\b/i)[0].trim();

  const queries = [
    movieName ? (cleanTitle + ' ' + movieName) : '',
    (cleanTitle + ' ' + cleanArtist).trim(),
    movieName,
    (firstTwoWords + ' ' + cleanArtist).trim(),
    cleanTitle
  ].map(s => (s || '').trim()).filter(Boolean);

  const cacheKey = (cleanTitle + '__' + cleanArtist + '__' + movieName).toLowerCase();
  if (songArtworkCache[cacheKey]) return res.json(songArtworkCache[cacheKey]);

  // 1. Apple iTunes Search API (US + IN stores ? mzstatic.com works globally without ISP blocks)
  for (const store of ['us', 'in']) {
    for (const q of queries.slice(0, 4)) {
      try {
        const itUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=' + store + '&media=music&limit=5';
        const itRes = await axios.get(itUrl, { timeout: 4000 });
        const hits = (itRes.data && itRes.data.results) || [];
        for (const hit of hits) {
          if (hit.artworkUrl100) {
            const artUrl = hit.artworkUrl100.replace('100x100bb', '600x600bb');
            const payload = {
              artwork: artUrl,
              album: movieName || hit.collectionName || '',
              artist: cleanArtist || hit.artistName || ''
            };
            songArtworkCache[cacheKey] = payload;
            return res.json(payload);
          }
        }
      } catch (e) {}
    }
  }

  // 2. Deezer Track Cover routed through /api/img-proxy so Indian ISPs never block it
  for (const q of queries.slice(0, 3)) {
    try {
      const dzUrl = 'https://api.deezer.com/search?q=' + encodeURIComponent(q) + '&limit=3';
      const dzRes = await axios.get(dzUrl, { timeout: 4000 });
      const dzHits = (dzRes.data && dzRes.data.data) || [];
      for (const dHit of dzHits) {
        const cover = dHit.album && (dHit.album.cover_big || dHit.album.cover_xl || dHit.album.cover_medium);
        if (cover) {
          const payload = {
            artwork: '/api/img-proxy?url=' + encodeURIComponent(cover),
            album: movieName || dHit.album.title || '',
            artist: cleanArtist || (dHit.artist && dHit.artist.name) || ''
          };
          songArtworkCache[cacheKey] = payload;
          return res.json(payload);
        }
      }
    } catch (e) {}
  }

  // 3. Artist Portrait routed through /api/img-proxy
  if (cleanArtist) {
    try {
      const arRes = await axios.get('https://api.deezer.com/search/artist?q=' + encodeURIComponent(cleanArtist) + '&limit=1', { timeout: 3500 });
      const arList = (arRes.data && arRes.data.data) || [];
      if (arList.length > 0) {
        const pic = arList[0].picture_big || arList[0].picture_medium;
        if (pic && !pic.includes('/images/artist//')) {
          const payload = {
            artwork: '/api/img-proxy?url=' + encodeURIComponent(pic),
            album: movieName || 'Single',
            artist: cleanArtist
          };
          songArtworkCache[cacheKey] = payload;
          return res.json(payload);
        }
      }
    } catch (e) {}
  }

  return res.json({ artwork: '' });
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

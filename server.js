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





// === MUSIX V41 ARTWORK ENGINE START ===
const COVER_CACHE_DIR = path.join(require('os').tmpdir(), 'musix-covers-v41');
if (!fs.existsSync(COVER_CACHE_DIR)) {
  try { fs.mkdirSync(COVER_CACHE_DIR, { recursive: true }); } catch (e) {}
}

const songInfoRegistry = {};
const extractedId3Meta = {};
const memoryCoverCache = {};
const categoryCoverCache = {};
const inFlightCoverPromises = {};

// True FIFO Queue so ZERO embedded cover reads are ever skipped or dropped
const driveReadQueue = [];
let activeDriveWorkers = 0;
const MAX_DRIVE_WORKERS = 4;

function enqueueDriveCoverRead(taskFn, highPriority) {
  return new Promise((resolve, reject) => {
    if (highPriority) {
      driveReadQueue.unshift({ taskFn, resolve, reject });
    } else {
      driveReadQueue.push({ taskFn, resolve, reject });
    }
    pumpDriveReadQueue();
  });
}

async function pumpDriveReadQueue() {
  if (activeDriveWorkers >= MAX_DRIVE_WORKERS || driveReadQueue.length === 0) return;
  activeDriveWorkers++;
  while (driveReadQueue.length > 0) {
    const job = driveReadQueue.shift();
    if (!job) break;
    try {
      const res = await job.taskFn();
      job.resolve(res);
    } catch (err) {
      job.reject(err);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  activeDriveWorkers--;
}

function removeUnsynchronisation(buf) {
  let count = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xFF && buf[i + 1] === 0x00) count++;
  }
  if (count === 0) return buf;
  const out = Buffer.allocUnsafe(buf.length - count);
  let w = 0;
  for (let i = 0; i < buf.length; i++) {
    out[w++] = buf[i];
    if (buf[i] === 0xFF && i + 1 < buf.length && buf[i + 1] === 0x00) {
      i++;
    }
  }
  return out.subarray(0, w);
}

function decodeId3Text(payload) {
  if (!payload || payload.length < 2) return '';
  const enc = payload[0];
  const body = payload.subarray(1);
  let text = '';
  try {
    if (enc === 0) {
      text = body.toString('latin1');
    } else if (enc === 1 || enc === 2) {
      if (body.length >= 2 && body[0] === 0xFE && body[1] === 0xFF) {
        const swapped = Buffer.alloc(body.length - 2);
        for (let i = 2; i < body.length - 1; i += 2) {
          swapped[i - 2] = body[i + 1];
          swapped[i - 1] = body[i];
        }
        text = swapped.toString('utf16le');
      } else {
        const start = (body.length >= 2 && body[0] === 0xFF && body[1] === 0xFE) ? 2 : 0;
        text = body.subarray(start).toString('utf16le');
      }
    } else {
      text = body.toString('utf8');
    }
  } catch (e) {}
  return text.replace(/\0/g, '').trim();
}

function sliceImageFromBuffer(buf, startSearchOffset) {
  const maxWin = Math.min(buf.length, startSearchOffset + 256);
  for (let i = startSearchOffset; i < maxWin - 4; i++) {
    // 1. JPEG (FF D8 FF ... FF D9)
    if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
      let endPos = buf.length;
      for (let j = buf.length - 2; j > i + 512; j--) {
        if (buf[j] === 0xFF && buf[j + 1] === 0xD9) {
          endPos = j + 2;
          break;
        }
      }
      const imgBuf = buf.subarray(i, endPos);
      if (imgBuf.length > 512) return { mime: 'image/jpeg', buf: Buffer.from(imgBuf) };
    }
    // 2. PNG (89 50 4E 47 ... IEND)
    if (buf[i] === 0x89 && buf[i + 1] === 0x50 && buf[i + 2] === 0x4E && buf[i + 3] === 0x47) {
      const iendIdx = buf.indexOf(Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]), i);
      const endPos = iendIdx !== -1 ? iendIdx + 8 : buf.length;
      const imgBuf = buf.subarray(i, endPos);
      if (imgBuf.length > 512) return { mime: 'image/png', buf: Buffer.from(imgBuf) };
    }
    // 3. WebP (RIFF....WEBP)
    if (buf[i] === 0x52 && buf[i + 1] === 0x49 && buf[i + 2] === 0x46 && buf[i + 3] === 0x46 &&
        i + 12 < buf.length && buf[i + 8] === 0x57 && buf[i + 9] === 0x45 && buf[i + 10] === 0x42 && buf[i + 11] === 0x50) {
      const riffLen = buf.readUInt32LE(i + 4) + 8;
      const endPos = Math.min(buf.length, i + riffLen);
      const imgBuf = buf.subarray(i, endPos);
      if (imgBuf.length > 512) return { mime: 'image/webp', buf: Buffer.from(imgBuf) };
    }
  }
  return null;
}

function parseFullId3AndCover(rawBuf) {
  const out = { title: '', artist: '', album: '', year: '', image: null };
  if (!rawBuf || rawBuf.length < 16) return out;

  let b = rawBuf;
  if (b.toString('ascii', 0, 3) === 'ID3') {
    const ver = b[3];
    const flags = b[5];
    const tagUnsync = (flags & 0x80) !== 0;
    const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    const limit = Math.min(b.length, 10 + tagSize);
    let tagBody = b.subarray(0, limit);
    if (tagUnsync) {
      tagBody = Buffer.concat([tagBody.subarray(0, 10), removeUnsynchronisation(tagBody.subarray(10))]);
    }

    // Parse text frames (TIT2, TPE1, TALB, TYER/TDRC) and APIC
    let pos = 10;
    while (pos + 10 < tagBody.length) {
      const frameId = tagBody.toString('ascii', pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const syncSize = ((tagBody[pos + 4] & 0x7f) << 21) | ((tagBody[pos + 5] & 0x7f) << 14) | ((tagBody[pos + 6] & 0x7f) << 7) | (tagBody[pos + 7] & 0x7f);
      const stdSize = tagBody.readUInt32BE(pos + 4);
      const frameFlags = tagBody[pos + 9];

      let fSize = stdSize;
      if (ver === 4) {
        // Check if next frame header exists after stdSize vs syncSize to handle non-compliant v2.4 encoders
        const nextAfterStd = pos + 10 + stdSize;
        const nextAfterSync = pos + 10 + syncSize;
        if (nextAfterStd + 4 <= tagBody.length && /^[A-Z0-9]{4}$/.test(tagBody.toString('ascii', nextAfterStd, nextAfterStd + 4))) {
          fSize = stdSize;
        } else if (nextAfterSync + 4 <= tagBody.length && /^[A-Z0-9]{4}$/.test(tagBody.toString('ascii', nextAfterSync, nextAfterSync + 4))) {
          fSize = syncSize;
        } else {
          fSize = Math.max(syncSize, stdSize);
        }
      }

      if (fSize <= 0 || pos + 10 >= tagBody.length) break;
      const frameEnd = Math.min(tagBody.length, pos + 10 + fSize);
      let payload = tagBody.subarray(pos + 10, frameEnd);
      if ((frameFlags & 0x02) !== 0) {
        payload = removeUnsynchronisation(payload);
      }

      if (frameId === 'TIT2' && !out.title) out.title = decodeId3Text(payload);
      else if (frameId === 'TPE1' && !out.artist) out.artist = decodeId3Text(payload);
      else if (frameId === 'TALB' && !out.album) out.album = decodeId3Text(payload);
      else if ((frameId === 'TYER' || frameId === 'TDRC') && !out.year) out.year = decodeId3Text(payload).slice(0, 4);
      else if (frameId === 'APIC' && !out.image) {
        out.image = sliceImageFromBuffer(payload, 0);
      }

      pos += 10 + fSize;
    }

    // Direct marker scan inside tagBody in case a non-standard frame preceded APIC/PIC
    if (!out.image) {
      const apicIdx = tagBody.indexOf(Buffer.from('APIC'));
      const picIdx = apicIdx === -1 ? tagBody.indexOf(Buffer.from('PIC')) : -1;
      const marker = apicIdx !== -1 ? apicIdx : picIdx;
      if (marker !== -1) {
        let sub = tagBody.subarray(marker);
        if (sub.indexOf(Buffer.from([0xFF, 0x00, 0xD8, 0xFF])) !== -1) {
          sub = removeUnsynchronisation(sub);
        }
        out.image = sliceImageFromBuffer(sub, 4);
      }
    }
  }

  // Fallback for M4A / MP4 'covr' atom
  if (!out.image) {
    const covrIdx = b.indexOf(Buffer.from('covr'));
    if (covrIdx !== -1) {
      out.image = sliceImageFromBuffer(b.subarray(covrIdx), 4);
    }
  }

  return out;
}

// Queued Google Drive reader: NEVER drops a request, fetches full ID3 tag up to 10MB
async function extractFromDriveQueued(fileId, highPriority) {
  return enqueueDriveCoverRead(async () => {
    const binPath = path.join(COVER_CACHE_DIR, fileId + '.bin');
    const metaPath = path.join(COVER_CACHE_DIR, fileId + '.json');

    if (fs.existsSync(binPath) && fs.existsSync(metaPath)) {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const buf = fs.readFileSync(binPath);
        if (buf.length > 512) {
          const item = { mime: m.mime || 'image/jpeg', buf: buf };
          memoryCoverCache[fileId] = item;
          return item;
        }
      } catch (e) {}
    }

    try {
      const firstChunkEnd = 393215; // 384 KB initial chunk
      const r1 = await drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'arraybuffer', headers: { Range: 'bytes=0-' + firstChunkEnd } }
      );
      let b = Buffer.from(r1.data);

      // If ID3v2 tag is larger than 384 KB, fetch the exact remainder of the ID3 tag (up to 10 MB)
      if (b.length >= 10 && b.toString('ascii', 0, 3) === 'ID3') {
        const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
        const totalNeeded = Math.min(10 + tagSize, 10 * 1024 * 1024);
        if (totalNeeded > b.length) {
          const r2 = await drive.files.get(
            { fileId: fileId, alt: 'media' },
            { responseType: 'arraybuffer', headers: { Range: 'bytes=' + b.length + '-' + (totalNeeded - 1) } }
          );
          b = Buffer.concat([b, Buffer.from(r2.data)]);
        }
      }

      const parsed = parseFullId3AndCover(b);
      if (parsed.title || parsed.artist || parsed.album) {
        extractedId3Meta[fileId] = {
          title: parsed.title || '',
          artist: parsed.artist || '',
          album: parsed.album || '',
          year: parsed.year || ''
        };
        if (songInfoRegistry[fileId]) {
          if (parsed.title) songInfoRegistry[fileId].title = parsed.title;
          if (parsed.artist) songInfoRegistry[fileId].artist = parsed.artist;
          if (parsed.album) songInfoRegistry[fileId].album = parsed.album;
        }
      }

      if (parsed.image && parsed.image.buf && parsed.image.buf.length > 512) {
        memoryCoverCache[fileId] = parsed.image;
        try {
          fs.writeFileSync(binPath, parsed.image.buf);
          fs.writeFileSync(metaPath, JSON.stringify({
            mime: parsed.image.mime,
            source: 'embedded',
            title: parsed.title || '',
            artist: parsed.artist || '',
            album: parsed.album || ''
          }), 'utf8');
        } catch (e) {}
        return parsed.image;
      }
    } catch (err) {}
    return null;
  }, highPriority);
}

// Parse clean title, artist, and album from the raw Google Drive filename (ignoring polluted sync DB)
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
    // Handle filenames where artist is appended after (feat. X) or at the end, e.g.:
    // "Headlights (feat. KIDDO) Alok, Alan Walker, KIDDO" or "Way down We Go KALEO"
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

const JUNK_COVER_RE = /\b(nursery rhyme|nursery rhymes|for kids|kids songs|kidz bop|kids bop|lullaby|lullabies|karaoke|tribute|ringtone|8-bit|made famous by)\b/i;

async function fetchImageBytes(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 5000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const ct = (res.headers && res.headers['content-type']) || 'image/jpeg';
  const buf = Buffer.from(res.data);
  if (ct.startsWith('image/') && buf.length > 512) {
    return { mime: ct, buf: buf };
  }
  return null;
}

// Strict online fallback ONLY if the audio file genuinely has no embedded image inside it
async function searchStrictOnlineFallback(fileId) {
  const info = songInfoRegistry[fileId] || {};
  const id3 = extractedId3Meta[fileId] || {};
  const fromFile = parseCleanFilename(info.name || info.title || '');

  const rawTitle = id3.title || fromFile.title || info.title || '';
  const rawArtist = (id3.artist && id3.artist !== 'Cloud Artist')
    ? id3.artist
    : (fromFile.artist !== 'Cloud Artist' ? fromFile.artist : (info.artist || ''));
  const movieOrAlbum = (id3.album && id3.album !== 'Single' && id3.album !== 'Cloud Drive')
    ? id3.album
    : (fromFile.album !== 'Single' ? fromFile.album : '');

  const titleWithCollabs = rawTitle
    .replace(/\b(?:feat\.?|ft\.?|with|prod\.?|by|ost|original motion picture soundtrack|one side love|lyrical|video|audio|320kbps|128kbps)\b/gi, ' ')
    .replace(/[()\[\]\-_/,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const coreTitle = rawTitle
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:feat\.?|ft\.?|with)\b.*$/i, ' ')
    .replace(/\b(?:remix|ost|original motion picture soundtrack|one side love|lyrical|video|audio)\b/gi, ' ')
    .replace(/[()\[\]\-_/,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const primaryArtist = (!rawArtist || rawArtist === 'Cloud Artist' || rawArtist === 'Unknown')
    ? ''
    : String(rawArtist).split(/[/,&;]|\b(?:feat\.?|ft\.?|with)\b/i)[0].trim();

  const queries = [
    movieOrAlbum ? (coreTitle + ' ' + movieOrAlbum) : '',
    (titleWithCollabs + ' ' + primaryArtist).trim(),
    (coreTitle + ' ' + primaryArtist).trim(),
    titleWithCollabs,
    coreTitle
  ].map(s => (s || '').trim()).filter(s => s.length >= 2);

  const uniqueQueries = Array.from(new Set(queries));
  const targetLower = (coreTitle || titleWithCollabs).toLowerCase();
  const artistTokens = (rawArtist + ' ' + titleWithCollabs + ' ' + movieOrAlbum)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !['the', 'and', 'from', 'with', 'feat', 'remix', 'cloud', 'artist'].includes(w));

  function scoreHit(hTitle, hArtist, hAlbum) {
    const comb = (hTitle + ' ' + hArtist + ' ' + hAlbum).toLowerCase();
    if (JUNK_COVER_RE.test(comb)) return -999;
    const tLow = String(hTitle || '').toLowerCase();
    const aLow = String(hArtist || '').toLowerCase();
    const alLow = String(hAlbum || '').toLowerCase();

    let sc = 0;
    if (tLow === targetLower || tLow.startsWith(targetLower)) sc += 45;
    else if (tLow.includes(targetLower) || targetLower.includes(tLow)) sc += 25;
    else return -200; // Title must match

    let tokenHits = 0;
    artistTokens.forEach(tok => {
      if (aLow.includes(tok) || tLow.includes(tok) || alLow.includes(tok)) {
        tokenHits++;
        sc += 25;
      }
    });

    if (primaryArtist && aLow.includes(primaryArtist.toLowerCase())) sc += 50;
    if (movieOrAlbum && alLow.includes(movieOrAlbum.toLowerCase())) sc += 50;

    if (primaryArtist && tokenHits === 0) return -300;
    return sc;
  }

  let bestUrl = '';
  let bestScore = -999;

  for (const q of uniqueQueries.slice(0, 4)) {
    try {
      const dzRes = await axios.get('https://api.deezer.com/search?q=' + encodeURIComponent(q) + '&limit=6', { timeout: 4000 });
      const hits = (dzRes.data && dzRes.data.data) || [];
      for (const h of hits) {
        const cover = h.album && (h.album.cover_big || h.album.cover_xl || h.album.cover_medium);
        if (!cover) continue;
        const sc = scoreHit(h.title, h.artist && h.artist.name, h.album && h.album.title);
        if (sc > bestScore) {
          bestScore = sc;
          bestUrl = cover;
        }
      }
      if (bestScore >= 60 && bestUrl) break;
    } catch (e) {}
  }

  if (bestScore < 60) {
    for (const store of ['in', 'us']) {
      for (const q of uniqueQueries.slice(0, 3)) {
        try {
          const itRes = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&country=' + store + '&media=music&entity=song&limit=6', { timeout: 4000 });
          const hits = (itRes.data && itRes.data.results) || [];
          for (const h of hits) {
            if (!h.artworkUrl100) continue;
            const sc = scoreHit(h.trackName, h.artistName, h.collectionName);
            if (sc > bestScore) {
              bestScore = sc;
              bestUrl = h.artworkUrl100.replace('100x100bb', '600x600bb');
            }
          }
          if (bestScore >= 60 && bestUrl) break;
        } catch (e) {}
      }
      if (bestScore >= 60 && bestUrl) break;
    }
  }

  if (bestScore >= 25 && bestUrl) {
    try {
      return await fetchImageBytes(bestUrl);
    } catch (e) {}
  }
  return null;
}

async function resolveCoverForSong(fileId) {
  if (memoryCoverCache[fileId]) return memoryCoverCache[fileId];

  const binPath = path.join(COVER_CACHE_DIR, fileId + '.bin');
  const metaPath = path.join(COVER_CACHE_DIR, fileId + '.json');

  if (fs.existsSync(binPath) && fs.existsSync(metaPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const buf = fs.readFileSync(binPath);
      if (buf.length > 512) {
        if (m.title || m.artist || m.album) {
          extractedId3Meta[fileId] = { title: m.title || '', artist: m.artist || '', album: m.album || '' };
        }
        const item = { mime: m.mime || 'image/jpeg', buf: buf };
        memoryCoverCache[fileId] = item;
        return item;
      }
    } catch (e) {}
  }

  if (inFlightCoverPromises[fileId]) {
    return inFlightCoverPromises[fileId];
  }

  inFlightCoverPromises[fileId] = (async () => {
    try {
      // 1. ALWAYS wait in the FIFO queue to extract the real embedded cover from Google Drive
      let imgObj = await extractFromDriveQueued(fileId, true);

      // 2. ONLY if the file on Google Drive had zero embedded image, run strict online match
      if (!imgObj) {
        imgObj = await searchStrictOnlineFallback(fileId);
        if (imgObj && imgObj.buf && imgObj.buf.length > 512) {
          memoryCoverCache[fileId] = imgObj;
          try {
            fs.writeFileSync(binPath, imgObj.buf);
            fs.writeFileSync(metaPath, JSON.stringify({ mime: imgObj.mime, source: 'online_strict' }), 'utf8');
          } catch (e) {}
        }
      }
      return imgObj;
    } catch (e) {
      return null;
    } finally {
      delete inFlightCoverPromises[fileId];
    }
  })();

  return inFlightCoverPromises[fileId];
}

// Background pre-warmer: automatically extracts embedded covers and ID3 tags for all songs
let isPrewarming = false;
async function prewarmAllSongCovers(songIds) {
  if (isPrewarming) return;
  isPrewarming = true;
  for (const id of songIds) {
    const binPath = path.join(COVER_CACHE_DIR, id + '.bin');
    if (!memoryCoverCache[id] && !fs.existsSync(binPath)) {
      try { await resolveCoverForSong(id); } catch (e) {}
    }
  }
  isPrewarming = false;
}

const CATEGORY_QUERIES = {
  malayalam: 'Aavesham Sushin Shyam',
  hindi: 'Aashiqui 2 Arijit Singh',
  english: 'After Hours The Weeknd',
  tamil: 'Leo Anirudh Ravichander',
  love: 'Perfect Ed Sheeran',
  sleep: 'Weightless Marconi Union Ambient',
  trending: 'Starboy The Weeknd',
  mood: 'Lovely Billie Eilish Khalid',
  party: 'Titanium David Guetta Sia',
  melody: 'Kun Faya Kun A.R. Rahman',
  other: 'Random Access Memories Daft Punk'
};

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path === '/sw.js') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
  if (req.path === '/api/songs') {
    const origJson = res.json.bind(res);
    res.json = function (data) {
      if (Array.isArray(data)) {
        const malRe = /\b(sushin shyam|jakes bejoy|vishnu vijay|vineeth sreenivasan|shaan rahman|rex vijayan|gopi sundar|dabzee|govind vasantha|fejo|vedan|bibin ashok|varkey|nevin thomas|mbl|sarvam maya|vellarathaaram|komala thaamara|masthishka maranam|delulu|athi bheekara kaamukan|neeye punchiri|chorkk|vazhikatti|puthu mazha|premavathi|akale)\b/i;
        const futureTs = Date.now() + 432000000;
        const idsToWarm = [];

        data.forEach(f => {
          if (!f || !f.id) return;
          idsToWarm.push(f.id);
          f.cloudMeta = f.cloudMeta || {};

          // Prioritize real ID3 tags + clean filename over polluted sync DB records
          const fromFile = parseCleanFilename(f.name || '');
          const id3 = extractedId3Meta[f.id] || {};

          const title = id3.title || fromFile.title || f.cloudMeta.title || f.name;
          const artist = (id3.artist && id3.artist !== 'Cloud Artist')
            ? id3.artist
            : (fromFile.artist !== 'Cloud Artist' ? fromFile.artist : (f.cloudMeta.artist || 'Cloud Artist'));
          const album = (id3.album && id3.album !== 'Cloud Drive' && id3.album !== 'Single')
            ? id3.album
            : (fromFile.album !== 'Single' ? fromFile.album : ((f.cloudMeta.album && f.cloudMeta.album !== 'Cloud Drive') ? f.cloudMeta.album : 'Single'));

          songInfoRegistry[f.id] = { id: f.id, name: f.name || '', title: title, artist: artist, album: album };

          if (malRe.test((f.name || '') + ' ' + title + ' ' + artist + ' ' + album)) {
            f.cloudLang = 'Malayalam';
            f.cloudMeta.language = 'Malayalam';
          }

          const coverUrl = '/api/cover/' + encodeURIComponent(f.id) + '?v=41';
          f.cloudMeta.title = title;
          f.cloudMeta.artist = artist;
          f.cloudMeta.album = album;
          f.cloudMeta.coverArt = coverUrl;
          f.cloudMeta.artwork = coverUrl;
          f.cloudMeta.updatedAt = futureTs;
          f.coverArt = coverUrl;
          f.artwork = coverUrl;
        });

        setTimeout(() => prewarmAllSongCovers(idsToWarm), 200);
      }
      return origJson(data);
    };
  }
  next();
});

app.get(['/api/cover/:fileId', '/api/song-cover/:fileId'], async (req, res) => {
  const fileId = req.params.fileId;

  const imgObj = await resolveCoverForSong(fileId);
  if (imgObj && imgObj.buf) {
    res.set({
      'Content-Type': imgObj.mime || 'image/jpeg',
      'Cache-Control': 'public, max-age=604800',
      'Access-Control-Allow-Origin': '*'
    });
    return res.send(imgObj.buf);
  }

  // Never cache a fallback response so the browser retries once extraction completes
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*'
  });
  return res.status(503).end();
});

app.get('/api/category-cover/:slug', async (req, res) => {
  const slug = String(req.params.slug || 'other').toLowerCase().replace(/[^a-z0-9]/g, '');
  res.set({
    'Cache-Control': 'public, max-age=604800',
    'Access-Control-Allow-Origin': '*'
  });

  if (categoryCoverCache[slug]) {
    res.set('Content-Type', categoryCoverCache[slug].mime);
    return res.send(categoryCoverCache[slug].buf);
  }

  const binPath = path.join(COVER_CACHE_DIR, 'cat_' + slug + '.bin');
  if (fs.existsSync(binPath)) {
    try {
      const buf = fs.readFileSync(binPath);
      if (buf.length > 512) {
        categoryCoverCache[slug] = { mime: 'image/jpeg', buf: buf };
        res.set('Content-Type', 'image/jpeg');
        return res.send(buf);
      }
    } catch (e) {}
  }

  const query = CATEGORY_QUERIES[slug] || CATEGORY_QUERIES.other;
  try {
    const dzRes = await axios.get('https://api.deezer.com/search?q=' + encodeURIComponent(query) + '&limit=3', { timeout: 4500 });
    const hits = (dzRes.data && dzRes.data.data) || [];
    for (const h of hits) {
      const cover = h.album && (h.album.cover_big || h.album.cover_xl || h.album.cover_medium);
      if (cover) {
        const imgObj = await fetchImageBytes(cover);
        if (imgObj) {
          categoryCoverCache[slug] = imgObj;
          try { fs.writeFileSync(binPath, imgObj.buf); } catch (e) {}
          res.set('Content-Type', imgObj.mime);
          return res.send(imgObj.buf);
        }
      }
    }
  } catch (e) {}

  try {
    const itRes = await axios.get('https://itunes.apple.com/search?term=' + encodeURIComponent(query) + '&country=in&media=music&entity=song&limit=3', { timeout: 4500 });
    const hits = (itRes.data && itRes.data.results) || [];
    for (const h of hits) {
      if (h.artworkUrl100) {
        const imgObj = await fetchImageBytes(h.artworkUrl100.replace('100x100bb', '600x600bb'));
        if (imgObj) {
          categoryCoverCache[slug] = imgObj;
          try { fs.writeFileSync(binPath, imgObj.buf); } catch (e) {}
          res.set('Content-Type', imgObj.mime);
          return res.send(imgObj.buf);
        }
      }
    }
  } catch (e) {}

  return res.status(404).end();
});
// === MUSIX V41 ARTWORK ENGINE END ===

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

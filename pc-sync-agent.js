require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');

// Set your local PC music folder via PC_MUSIC_DIR in .env or CLI argument, defaulting to Windows Music folder
const PC_MUSIC_DIR = process.argv[2] || process.env.PC_MUSIC_DIR || path.join(process.env.USERPROFILE || 'C:\\Users\\Aswath M', 'Music');
const APP_BASE_URL = process.env.MUSIX_APP_URL || 'https://musix-cloud.onrender.com';
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);
auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth });

const stateFile = path.join(__dirname, '.pc-sync-state.json');
let syncState = { files: {}, lastCloudTs: 0 };
if (fs.existsSync(stateFile)) {
  try { syncState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
}
const selfWriteLock = new Set();

function saveSyncState() {
  fs.writeFileSync(stateFile, JSON.stringify(syncState, null, 2), 'utf8');
}

function decodeText(payload, enc) {
  if (!payload || payload.length === 0) return '';
  if (enc === 1 || enc === 2) {
    const start = (payload.length >= 2 && ((payload[0] === 0xff && payload[1] === 0xfe) || (payload[0] === 0xfe && payload[1] === 0xff))) ? 2 : 0;
    return payload.subarray(start).toString('utf16le').replace(/\0/g, '').trim();
  }
  return payload.toString('utf8').replace(/\0/g, '').trim();
}

function readLocalId3Tags(filePath) {
  const tags = { title: '', artist: '', album: '', albumArtist: '', genre: '', language: '', year: '', trackNumber: '' };
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(98304);
    const bytesRead = fs.readSync(fd, buf, 0, 98304, 0);
    fs.closeSync(fd);
    const b = buf.subarray(0, bytesRead);
    if (b.length < 10 || b.toString('ascii', 0, 3) !== 'ID3') return tags;

    const version = b[3];
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    const limit = Math.min(b.length, 10 + size);
    let pos = 10;

    while (pos + 10 < limit) {
      const id = b.toString('ascii', pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fSize = version === 4
        ? (((b[pos + 4] & 0x7f) << 21) | ((b[pos + 5] & 0x7f) << 14) | ((b[pos + 6] & 0x7f) << 7) | (b[pos + 7] & 0x7f))
        : b.readUInt32BE(pos + 4);
      if (fSize <= 1 || pos + 10 + fSize > limit) break;
      const enc = b[pos + 10];
      const payload = b.subarray(pos + 11, pos + 10 + fSize);

      if (id === 'TXXX') {
        const parts = payload.toString(enc === 1 || enc === 2 ? 'utf16le' : 'utf8').split('\0').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2 && parts[0].toLowerCase().includes('lang')) {
          tags.language = parts[parts.length - 1];
        }
      } else if (id !== 'APIC') {
        const val = decodeText(payload, enc);
        if (id === 'TIT2') tags.title = val;
        else if (id === 'TPE1') tags.artist = val;
        else if (id === 'TALB') tags.album = val;
        else if (id === 'TPE2') tags.albumArtist = val;
        else if (id === 'TCON') tags.genre = val.replace(/^\(\d+\)/, '').trim();
        else if (id === 'TLAN') tags.language = val;
        else if (id === 'TYER' || id === 'TDRC') tags.year = val.slice(0, 4);
        else if (id === 'TRCK') tags.trackNumber = val;
      }
      pos += 10 + fSize;
    }
  } catch (e) {}
  return tags;
}

function makeId3TextFrame(frameId, text) {
  if (!text) return Buffer.alloc(0);
  const strBuf = Buffer.from(String(text), 'utf8');
  const payload = Buffer.concat([Buffer.from([0x03]), strBuf]); // 0x03 = UTF-8
  const header = Buffer.alloc(10);
  header.write(frameId, 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function makeTxxxLanguageFrame(language) {
  if (!language) return Buffer.alloc(0);
  const desc = Buffer.from('LANGUAGE\0', 'utf8');
  const val = Buffer.from(String(language), 'utf8');
  const payload = Buffer.concat([Buffer.from([0x03]), desc, val]);
  const header = Buffer.alloc(10);
  header.write('TXXX', 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// Safely writes updated ID3v2.3 tags into a local PC .mp3 file while preserving existing APIC cover art and audio data
function writeId3TagsToLocalMp3(filePath, meta) {
  if (!filePath.toLowerCase().endsWith('.mp3') || !fs.existsSync(filePath)) return false;
  try {
    const fullBuf = fs.readFileSync(filePath);
    let audioOffset = 0;
    const preservedFrames = [];

    if (fullBuf.length >= 10 && fullBuf.toString('ascii', 0, 3) === 'ID3') {
      const version = fullBuf[3];
      const tagSize = ((fullBuf[6] & 0x7f) << 21) | ((fullBuf[7] & 0x7f) << 14) | ((fullBuf[8] & 0x7f) << 7) | (fullBuf[9] & 0x7f);
      audioOffset = Math.min(fullBuf.length, 10 + tagSize);

      // Preserve existing APIC (cover art) frames
      let pos = 10;
      while (pos + 10 < audioOffset) {
        const id = fullBuf.toString('ascii', pos, pos + 4);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const fSize = version === 4
          ? (((fullBuf[pos + 4] & 0x7f) << 21) | ((fullBuf[pos + 5] & 0x7f) << 14) | ((fullBuf[pos + 6] & 0x7f) << 7) | (fullBuf[pos + 7] & 0x7f))
          : fullBuf.readUInt32BE(pos + 4);
        if (fSize <= 0 || pos + 10 + fSize > audioOffset) break;
        if (id === 'APIC') {
          preservedFrames.push(fullBuf.subarray(pos, pos + 10 + fSize));
        }
        pos += 10 + fSize;
      }
    }

    const newFrames = Buffer.concat([
      makeId3TextFrame('TIT2', meta.title),
      makeId3TextFrame('TPE1', meta.artist),
      makeId3TextFrame('TALB', meta.album),
      makeId3TextFrame('TPE2', meta.albumArtist),
      makeId3TextFrame('TCON', meta.genre),
      makeId3TextFrame('TLAN', meta.language),
      makeTxxxLanguageFrame(meta.language),
      makeId3TextFrame('TYER', meta.year),
      makeId3TextFrame('TRCK', meta.trackNumber),
      ...preservedFrames
    ]);

    const synchsafeSize = Buffer.alloc(4);
    const s = newFrames.length;
    synchsafeSize[0] = (s >>> 21) & 0x7f;
    synchsafeSize[1] = (s >>> 14) & 0x7f;
    synchsafeSize[2] = (s >>> 7) & 0x7f;
    synchsafeSize[3] = s & 0x7f;

    const id3Header = Buffer.concat([
      Buffer.from('ID3', 'ascii'),
      Buffer.from([0x03, 0x00, 0x00]),
      synchsafeSize
    ]);

    selfWriteLock.add(filePath);
    fs.writeFileSync(filePath, Buffer.concat([id3Header, newFrames, fullBuf.subarray(audioOffset)]));
    setTimeout(() => selfWriteLock.delete(filePath), 3000);
    return true;
  } catch (e) {
    selfWriteLock.delete(filePath);
    return false;
  }
}

async function syncPcFolderWithCloud() {
  if (!fs.existsSync(PC_MUSIC_DIR)) {
    console.log('PC Music folder not found at: ' + PC_MUSIC_DIR);
    return;
  }

  console.log('Scanning PC folder (' + PC_MUSIC_DIR + ') and Google Drive...');
  const driveRes = await drive.files.list({
    q: "'" + DRIVE_FOLDER_ID + "' in parents and trashed = false",
    fields: 'files(id, name, modifiedTime)',
    pageSize: 500
  });
  const driveFiles = (driveRes.data.files || []).filter(f => f.name !== 'musix-metadata.json');
  const localFiles = fs.readdirSync(PC_MUSIC_DIR).filter(f => /\.(mp3|m4a|wav|flac|ogg)$/i.test(f));

  const recordsToPush = {};

  for (const fileName of localFiles) {
    const fullPath = path.join(PC_MUSIC_DIR, fileName);
    const stat = fs.statSync(fullPath);
    const mtimeMs = Math.floor(stat.mtimeMs);
    const tags = readLocalId3Tags(fullPath);

    const driveMatch = driveFiles.find(df => df.name.toLowerCase().trim() === fileName.toLowerCase().trim());
    if (driveMatch) {
      const prevMtime = (syncState.files[fileName] && syncState.files[fileName].mtimeMs) || 0;
      if (mtimeMs > prevMtime) {
        recordsToPush[driveMatch.id] = {
          id: driveMatch.id,
          fileName: fileName,
          title: tags.title,
          artist: tags.artist,
          album: tags.album,
          albumArtist: tags.albumArtist,
          genre: tags.genre,
          language: tags.language,
          year: tags.year,
          trackNumber: tags.trackNumber,
          updatedAt: mtimeMs,
          source: 'pc-file'
        };
        syncState.files[fileName] = { id: driveMatch.id, mtimeMs: mtimeMs };
      }
    }
  }

  const syncRes = await axios.post(APP_BASE_URL + '/api/sync-metadata', { records: recordsToPush }, { timeout: 15000 });
  const cloudRecords = (syncRes.data && syncRes.data.records) || {};

  // Apply newer cloud edits back to local PC .mp3 files (App -> PC Sync)
  for (const fileName of localFiles) {
    const fullPath = path.join(PC_MUSIC_DIR, fileName);
    const driveMatch = driveFiles.find(df => df.name.toLowerCase().trim() === fileName.toLowerCase().trim());
    if (!driveMatch) continue;

    const cRec = cloudRecords[driveMatch.id];
    if (!cRec) continue;

    const localTags = readLocalId3Tags(fullPath);
    const needsLocalWrite =
      (cRec.language && cRec.language !== localTags.language) ||
      (cRec.title && cRec.title !== localTags.title) ||
      (cRec.artist && cRec.artist !== localTags.artist) ||
      (cRec.album && cRec.album !== localTags.album);

    if (needsLocalWrite && cRec.source === 'app-edit') {
      const ok = writeId3TagsToLocalMp3(fullPath, cRec);
      if (ok) {
        const newStat = fs.statSync(fullPath);
        syncState.files[fileName] = { id: driveMatch.id, mtimeMs: Math.floor(newStat.mtimeMs) };
        console.log('App -> PC Updated local file tags: ' + fileName + ' [' + cRec.language + ']');
      }
    }
  }

  saveSyncState();
  console.log('Two-way sync complete. Watching ' + PC_MUSIC_DIR + ' for real-time file changes...');
}

let watchDebounce = {};
if (fs.existsSync(PC_MUSIC_DIR)) {
  fs.watch(PC_MUSIC_DIR, (eventType, filename) => {
    if (!filename || !/\.(mp3|m4a|wav|flac|ogg)$/i.test(filename)) return;
    const fullPath = path.join(PC_MUSIC_DIR, filename);
    if (selfWriteLock.has(fullPath)) return;
    clearTimeout(watchDebounce[filename]);
    watchDebounce[filename] = setTimeout(() => {
      console.log('Detected PC metadata edit on: ' + filename + ' -> syncing to Cloud & App...');
      syncPcFolderWithCloud().catch(() => {});
    }, 1200);
  });
}

// Poll every 20 seconds so App -> PC edits apply automatically
setInterval(() => {
  syncPcFolderWithCloud().catch(() => {});
}, 20000);

syncPcFolderWithCloud().catch(err => console.error('Sync error:', err.message));

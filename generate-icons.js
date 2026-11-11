const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function createMusixPng(size, filePath) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;

  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const t = (u + v) * 0.5;
      let r = Math.round(255 * (1 - t) + 248 * t);
      let g = Math.round(88 * (1 - t) + 31 * t);
      let b = Math.round(114 * (1 - t) + 56 * t);

      const dLeft = Math.hypot(u - 0.31, v - 0.68);
      const dRight = Math.hypot(u - 0.63, v - 0.62);
      const inLeftHead = dLeft <= 0.088;
      const inRightHead = dRight <= 0.088;
      const inLeftStem = u >= 0.355 && u <= 0.398 && v >= 0.30 && v <= 0.68;
      const inRightStem = u >= 0.675 && u <= 0.718 && v >= 0.24 && v <= 0.62;
      const beamTop = 0.30 - 0.06 * ((u - 0.355) / 0.363);
      const inBeam = u >= 0.355 && u <= 0.718 && v >= beamTop && v <= beamTop + 0.085;

      if (inLeftHead || inRightHead || inLeftStem || inRightStem || inBeam) {
        r = 255;
        g = 255;
        b = 255;
      }

      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = 255;
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);

  fs.writeFileSync(filePath, png);
  console.log('Generated ' + filePath + ' (' + png.length + ' bytes)');
}

const pubDir = path.join(__dirname, 'public');
if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });
createMusixPng(192, path.join(pubDir, 'icon-192.png'));
createMusixPng(512, path.join(pubDir, 'icon-512.png'));

// Generates icon.ico + icon.png (no dependencies): an orchid "copy" glyph on ink.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sdBox = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const cov = (d) => Math.min(1, Math.max(0, 0.5 - d)); // 1px antialiased edge
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const over = (dst, src, a) => [src[0] * a + dst[0] * (1 - a), src[1] * a + dst[1] * (1 - a), src[2] * a + dst[2] * (1 - a)];

function render(S) {
  const buf = Buffer.alloc(S * S * 4);
  const top = [74, 39, 102], bot = [33, 24, 39], orchid = [197, 139, 242];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const px = x + 0.5, py = y + 0.5;
    const bgA = cov(sdBox(px, py, S / 2, S / 2, S / 2, S / 2, S * 0.22));
    let col = mix(top, bot, (px + py) / (2 * S));
    const grad = col;
    // back square: outline only
    const back = sdBox(px, py, S * 0.42, S * 0.42, S * 0.21, S * 0.21, S * 0.06);
    col = over(col, orchid, Math.min(cov(back), cov(-(back + S * 0.05))) );
    // front square: ink gap, then solid orchid
    const gap = cov(sdBox(px, py, S * 0.58, S * 0.58, S * 0.21 + S * 0.035, S * 0.21 + S * 0.035, S * 0.075));
    col = over(col, grad, gap);
    const front = cov(sdBox(px, py, S * 0.58, S * 0.58, S * 0.21, S * 0.21, S * 0.06));
    col = over(col, orchid, front);
    // play triangle cut into the front square (ink)
    const tx = (px - S * 0.545) / S, ty = (py - S * 0.58) / S; // triangle pointing right
    const h = 0.085, w = 0.1;
    const inTri = tx >= -w * 0.5 && tx <= w * 0.9 && Math.abs(ty) <= h * (1 - (tx + w * 0.5) / (w * 1.4));
    if (inTri && front > 0.5) col = over(col, [33, 24, 39], 1);
    const o = (y * S + x) * 4;
    buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; buf[o + 3] = Math.round(bgA * 255);
  }
  return png(S, S, buf);
}

const sizes = [256, 64, 48, 32, 16];
const images = sizes.map((s) => ({ s, data: render(s) }));
fs.writeFileSync(path.join(HERE, 'icon.png'), images[0].data);

const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
const dir = Buffer.concat(images.map(({ s, data }) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12); offset += data.length;
  return e;
}));
fs.writeFileSync(path.join(HERE, 'icon.ico'), Buffer.concat([head, dir, ...images.map((i) => i.data)]));
console.log('icon.ico + icon.png written');

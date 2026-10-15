/**
 * Generates the PWA icons as real PNGs with no image dependency: a rounded
 * indigo tile with a white bar-chart mark, encoded by hand via zlib.
 * Run with `npm run icons` after changing the artwork.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** @param maskable full-bleed background for Android's safe-zone masking */
function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : size * 0.22;
  const inset = maskable ? size * 0.16 : size * 0.26; // keep the mark inside the safe zone
  const set = (x, y, r, g, b, a = 255) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };

  const inRounded = (x, y) => {
    if (radius === 0) return true;
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRounded(x + 0.5, y + 0.5)) { set(x, y, 0, 0, 0, 0); continue; }
      // Indigo -> violet diagonal gradient, matching the app's brand colours.
      const t = (x / size) * 0.5 + (y / size) * 0.5;
      set(x, y, Math.round(99 + (139 - 99) * t), Math.round(102 + (92 - 102) * t), Math.round(241 + (246 - 241) * t));
    }
  }

  // Three rising bars.
  const usable = size - inset * 2;
  const barW = usable / 5;
  const heights = [0.42, 0.68, 1.0];
  const baseline = size - inset;
  for (let b = 0; b < 3; b++) {
    const x0 = Math.round(inset + b * (barW * 1.6));
    const x1 = Math.round(x0 + barW);
    const y0 = Math.round(baseline - usable * heights[b]);
    for (let y = y0; y < baseline; y++) {
      for (let x = x0; x < x1; x++) {
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, 255, 255, 255, 245);
      }
    }
  }
  return encodePng(size, size, px);
}

fs.mkdirSync(OUT, { recursive: true });
const written = [];
for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  written.push(`${path.basename(file)} (${size}x${size})`);
}
const maskable = path.join(OUT, 'maskable-512.png');
fs.writeFileSync(maskable, drawIcon(512, { maskable: true }));
written.push('maskable-512.png (512x512)');
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), drawIcon(180));
written.push('apple-touch-icon.png (180x180)');
console.log('Wrote', written.join(', '), 'to', OUT);

// Generates PWA and Wallet pass icons as PNGs without external tools.
// Run with: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const SS = 4;
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / width, (y + (sy + 0.5) / SS) / height);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const TEAL = [14, 116, 144];
const TEAL_DARK = [12, 74, 110];
const RED = [176, 28, 46];
const WHITE = [255, 255, 255];
const NONE = [0, 0, 0, 0];

const roundedRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
};
// Capsule (pill) rotated 45°, centred at (cx, cy)
const capsule = (x, y, cx, cy, len, rad) => {
  const u = ((x - cx) + (y - cy)) / Math.SQRT2;
  const v = ((x - cx) - (y - cy)) / Math.SQRT2;
  const cu = Math.max(-len / 2, Math.min(len / 2, u));
  return (u - cu) ** 2 + v ** 2 <= rad * rad;
};
const triangle = (x, y, cx, top, size) => {
  const h = size * 0.87;
  if (y < top || y > top + h) return false;
  const half = ((y - top) / h) * (size / 2);
  return Math.abs(x - cx) <= half;
};

/** App icon: teal tile, white rounded card with a red alert band and a pill. */
function appIcon(maskable) {
  return (x, y) => {
    const inset = maskable ? 0 : 0.04;
    if (!maskable && !roundedRect(x, y, inset, inset, 1 - inset, 1 - inset, 0.2)) return NONE;
    const t = y;
    const bg = TEAL.map((c, i) => Math.round(c + (TEAL_DARK[i] - c) * t));
    const s = maskable ? 0.72 : 1; // keep artwork inside the maskable safe zone
    const nx = 0.5 + (x - 0.5) / s;
    const ny = 0.5 + (y - 0.5) / s;
    if (roundedRect(nx, ny, 0.2, 0.28, 0.8, 0.72, 0.06)) {
      if (ny < 0.4) return [...RED, 1];
      if (capsule(nx, ny, 0.5, 0.56, 0.16, 0.07)) return [...(nx + ny < 1.06 ? RED : TEAL), 1];
      return [...WHITE, 1];
    }
    return [...bg, 1];
  };
}

/** Wallet icon: red tile with a white warning triangle and "!" cut-out. */
function passIcon(x, y) {
  if (!roundedRect(x, y, 0, 0, 1, 1, 0.22)) return NONE;
  if (triangle(x, y, 0.5, 0.18, 0.7)) {
    const bar = Math.abs(x - 0.5) < 0.045 && y > 0.36 && y < 0.62;
    const dot = (x - 0.5) ** 2 + (y - 0.7) ** 2 < 0.05 ** 2;
    return bar || dot ? [...RED, 1] : [...WHITE, 1];
  }
  return [...RED, 1];
}

/** Wallet logo (shown on the red pass background): white triangle mark, transparent elsewhere. */
function passLogo(x, y) {
  const ax = x * (160 / 50);
  if (triangle(ax, y, 0.5, 0.12, 0.8)) {
    const bar = Math.abs(ax - 0.5) < 0.05 && y > 0.34 && y < 0.62;
    const dot = (ax - 0.5) ** 2 + (y - 0.72) ** 2 < 0.055 ** 2;
    return bar || dot ? NONE : [...WHITE, 1];
  }
  return NONE;
}

const out = (rel, buf) => {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  console.log('wrote', rel, buf.length, 'bytes');
};

out('public/icons/icon-192.png', png(192, 192, appIcon(false)));
out('public/icons/icon-512.png', png(512, 512, appIcon(false)));
out('public/icons/maskable-512.png', png(512, 512, appIcon(true)));
out('public/icons/apple-touch-icon.png', png(180, 180, appIcon(true)));
out('server/assets/pass/icon.png', png(29, 29, passIcon));
out('server/assets/pass/icon@2x.png', png(58, 58, passIcon));
out('server/assets/pass/icon@3x.png', png(87, 87, passIcon));
out('server/assets/pass/logo.png', png(160, 50, passLogo));
out('server/assets/pass/logo@2x.png', png(320, 100, passLogo));

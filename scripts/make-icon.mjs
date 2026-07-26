// Generates assets/icon.png - the app icon, drawn rather than hand-authored so
// it stays reproducible and tweakable. A skeleton: joint dots and the bones
// between them, which is literally what the app records. Opaque, because iOS
// icons must not be transparent.
//
// Usage: node scripts/make-icon.mjs
//
// Deliberately dependency-free: zlib is built into Node, and a PNG is a short
// enough format to emit by hand. Replace it with real artwork whenever someone
// wants to - nothing depends on this script at build time.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZE = 1024;
const BG = [0x10, 0x12, 0x16];     // the app's background
const BONE = [0x7f, 0xb2, 0xe0];   // its link colour
const JOINT = [0xf2, 0xf4, 0xf8];  // its foreground

const px = Buffer.alloc(SIZE * SIZE * 3);
for (let i = 0; i < SIZE * SIZE; ++i) {
  px[i * 3] = BG[0];
  px[i * 3 + 1] = BG[1];
  px[i * 3 + 2] = BG[2];
}

const blend = (x, y, c, a) => {
  if (a <= 0 || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const o = (y * SIZE + x) * 3;
  for (let ch = 0; ch < 3; ++ch)
    px[o + ch] = Math.round(px[o + ch] * (1 - a) + c[ch] * a);
};

// Antialiased disc and capsule - at 1024 this is what keeps the figure from
// looking like it was assembled out of Lego at home-screen size.
const disc = (cx, cy, r, c) => {
  for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; ++y)
    for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; ++x)
      blend(x, y, c, Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy))));
};
const bone = (x0, y0, x1, y1, w, c) => {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const minx = Math.min(x0, x1) - w - 2, maxx = Math.max(x0, x1) + w + 2;
  const miny = Math.min(y0, y1) - w - 2, maxy = Math.max(y0, y1) + w + 2;
  for (let y = Math.floor(miny); y <= maxy; ++y)
    for (let x = Math.floor(minx); x <= maxx; ++x) {
      const t = Math.max(0, Math.min(1, ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2));
      const d = Math.hypot(x + 0.5 - (x0 + dx * t), y + 0.5 - (y0 + dy * t));
      blend(x, y, c, Math.max(0, Math.min(1, w + 0.5 - d)));
    }
};

// A figure mid-stride, in the same joint names the takes carry. Normalised
// coordinates so the pose is readable as a pose rather than as pixel soup.
const P = (x, y) => [SIZE * x, SIZE * y];
const head = P(0.50, 0.20);
const neck = P(0.50, 0.30);
const hips = P(0.50, 0.55);
const shoulderL = P(0.38, 0.33);
const shoulderR = P(0.62, 0.33);
const elbowL = P(0.28, 0.46);
const elbowR = P(0.71, 0.44);
const handL = P(0.33, 0.58);
const handR = P(0.79, 0.56);
const kneeL = P(0.39, 0.71);
const kneeR = P(0.62, 0.72);
const footL = P(0.31, 0.86);
const footR = P(0.70, 0.85);

const bones = [
  [neck, hips], [shoulderL, shoulderR],
  [shoulderL, elbowL], [elbowL, handL],
  [shoulderR, elbowR], [elbowR, handR],
  [hips, kneeL], [kneeL, footL],
  [hips, kneeR], [kneeR, footR],
];
for (const [a, b] of bones) bone(a[0], a[1], b[0], b[1], 17, BONE);

disc(head[0], head[1], 62, JOINT);
for (const j of [neck, hips, shoulderL, shoulderR, elbowL, elbowR, handL, handR,
                 kneeL, kneeR, footL, footR])
  disc(j[0], j[1], 26, JOINT);

// --- minimal PNG writer ---
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // truecolour RGB
// Each scanline is prefixed with its filter type (0 = none).
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; ++y) {
  raw[y * (SIZE * 3 + 1)] = 0;
  px.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
const out = new URL('../assets/icon.png', import.meta.url);
writeFileSync(out, png);
console.log(`assets/icon.png: ${SIZE}x${SIZE}, ${png.length} bytes`);

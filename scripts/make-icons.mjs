// Generates the extension icons (PNG) without any image library: a violet rounded square with a speaker glyph.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";

const outDir = path.resolve("src/icons");
mkdirSync(outDir, { recursive: true });

// ---- tiny PNG encoder ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- shapes (unit square coordinates) ----
function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inSpeaker(x, y) {
  // body
  if (x >= 0.2 && x <= 0.33 && y >= 0.4 && y <= 0.6) return true;
  // cone (trapezoid)
  if (x >= 0.33 && x <= 0.5) {
    const t = (x - 0.33) / 0.17;
    const half = 0.1 + t * 0.15;
    return Math.abs(y - 0.5) <= half;
  }
  return false;
}
function inWave(x, y, r, thickness) {
  const cx = 0.47;
  const cy = 0.5;
  const d = Math.hypot(x - cx, y - cy);
  if (Math.abs(d - r) > thickness / 2) return false;
  const ang = Math.atan2(y - cy, x - cx);
  return Math.abs(ang) < Math.PI / 4.2;
}

function render(size) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (!inRoundedRect(x, y, 0.22)) continue;
          // background gradient
          let cr = 109 + (124 - 109) * x, cg = 40 + (58 - 40) * x, cb = 217 + (237 - 217) * y;
          if (inSpeaker(x, y) || inWave(x, y, 0.2, 0.055) || inWave(x, y, 0.3, 0.055)) {
            cr = 255; cg = 255; cb = 255;
          }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      if (a) {
        const cov = a / n / 255;
        out[i] = Math.round(r / (a / 255));
        out[i + 1] = Math.round(g / (a / 255));
        out[i + 2] = Math.round(b / (a / 255));
        out[i + 3] = Math.round(cov * 255);
      }
    }
  }
  return png(size, size, out);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(outDir, `icon${size}.png`), render(size));
}
console.log("icons written to", outDir);

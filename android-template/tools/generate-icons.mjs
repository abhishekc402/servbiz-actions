#!/usr/bin/env node
/**
 * Generates the template's placeholder launcher icons.
 *
 * Every generated app replaces these, so they only need to be valid PNGs at the
 * right densities and filenames. They exist so a fresh clone compiles and so the
 * fast-patch path has a known set of files to swap.
 *
 * Written with a tiny inline PNG encoder rather than a dependency: the build host
 * should not need an image library just to bootstrap, and `sharp` has native
 * bindings that are one more thing to get wrong on ARM64.
 *
 * Usage:
 *   node tools/generate-icons.mjs
 *   node tools/generate-icons.mjs --out /path/to/res
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** @param {{width:number,height:number,rgba:Buffer}} img */
function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing ---------------------------------------------------------------

const hex = (s) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) throw new Error(`Bad colour: ${s}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/** Coverage of a pixel by a circle, sampled 3x3 for cheap antialiasing. */
function circleCoverage(x, y, cx, cy, r) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) hits++;
    }
  }
  return hits / 9;
}

function roundedRectCoverage(x, y, size, radius) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      const dx = Math.max(radius - px, px - (size - radius), 0);
      const dy = Math.max(radius - py, py - (size - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / 9;
}

function blend(dst, i, [r, g, b], alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  if (a <= 0) return;
  const inv = 1 - a;
  dst[i] = Math.round(dst[i] * inv + r * a);
  dst[i + 1] = Math.round(dst[i + 1] * inv + g * a);
  dst[i + 2] = Math.round(dst[i + 2] * inv + b * a);
  dst[i + 3] = Math.round(dst[i + 3] * inv + 255 * a);
}

/**
 * @param {number} size
 * @param {'square'|'round'|'foreground'} shape
 */
function drawIcon(size, shape) {
  const bg = hex('#0F172A');
  const fg = hex('#FFFFFF');
  const rgba = Buffer.alloc(size * size * 4, 0);

  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      if (shape === 'square') {
        blend(rgba, i, bg, roundedRectCoverage(x, y, size, size * 0.18));
      } else if (shape === 'round') {
        blend(rgba, i, bg, circleCoverage(x, y, cx, cy, size / 2));
      }
      // 'foreground' stays transparent; the adaptive background layer supplies
      // the colour so the launcher can mask and animate the two separately.
    }
  }

  // Glyph: a ring with a filled centre. Deliberately abstract -- a placeholder
  // should not look like a finished brand.
  //
  // For adaptive foregrounds the drawable is 108dp but only the central 72dp is
  // guaranteed visible after masking, so the glyph is scaled to sit inside that
  // safe zone.
  const glyphScale = shape === 'foreground' ? (72 / 108) * 0.62 : 0.52;
  const outer = size * glyphScale * 0.5;
  const inner = outer * 0.58;
  const glyphColour = shape === 'foreground' ? hex('#0F172A') : fg;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const ring =
        circleCoverage(x, y, cx, cy, outer) - circleCoverage(x, y, cx, cy, outer * 0.78);
      if (ring > 0) blend(rgba, i, glyphColour, ring);
      const dot = circleCoverage(x, y, cx, cy, inner * 0.52);
      if (dot > 0) blend(rgba, i, glyphColour, dot);
    }
  }

  return encodePng({ width: size, height: size, rgba });
}

// --- output ----------------------------------------------------------------

// Launcher icon is 48dp; adaptive foreground/background layers are 108dp.
const DENSITIES = [
  { dir: 'mipmap-mdpi', legacy: 48, adaptive: 108 },
  { dir: 'mipmap-hdpi', legacy: 72, adaptive: 162 },
  { dir: 'mipmap-xhdpi', legacy: 96, adaptive: 216 },
  { dir: 'mipmap-xxhdpi', legacy: 144, adaptive: 324 },
  { dir: 'mipmap-xxxhdpi', legacy: 192, adaptive: 432 },
];

function main() {
  const outFlag = process.argv.indexOf('--out');
  const resDir =
    outFlag !== -1 && process.argv[outFlag + 1]
      ? resolve(process.argv[outFlag + 1])
      : resolve(HERE, '..', 'app', 'src', 'main', 'res');

  let written = 0;
  for (const { dir, legacy, adaptive } of DENSITIES) {
    const target = join(resDir, dir);
    mkdirSync(target, { recursive: true });

    const files = {
      'ic_launcher.png': drawIcon(legacy, 'square'),
      'ic_launcher_round.png': drawIcon(legacy, 'round'),
      'ic_launcher_foreground.png': drawIcon(adaptive, 'foreground'),
    };

    for (const [name, buf] of Object.entries(files)) {
      writeFileSync(join(target, name), buf);
      written++;
    }
  }

  console.log(`Wrote ${written} placeholder icons under ${resDir}`);
}

main();

#!/usr/bin/env node
/**
 * Tests the hand-written PNG codec and resampler in lib/png.mjs.
 *
 * Worth testing directly rather than only through a built APK: a wrong filter
 * reconstruction or an off-by-one in the resampler produces an icon that is
 * subtly ugly rather than an error, and nothing downstream would notice. The
 * lossless round-trip is the load-bearing case -- if encode and decode disagree,
 * every generated icon is quietly wrong.
 *
 * Usage:
 *   node tools/test-png.mjs
 */

import {
  decodePng, encodePng, resizeRgba, solid, over, circleMask, insetInto, hexToRgb,
} from './lib/png.mjs';

let pass = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`);
};

// --- codec ------------------------------------------------------------------
const W = 64;
const H = 48;
const src = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    src[i] = (x * 4) % 256;
    src[i + 1] = (y * 5) % 256;
    src[i + 2] = (x + y) % 256;
    src[i + 3] = x % 8 === 0 ? 0 : 255;
  }
}
const png = encodePng({ width: W, height: H, rgba: src });
const back = decodePng(png);
check('output carries the PNG signature', png.subarray(1, 4).toString() === 'PNG');
check('round-trip preserves dimensions', back.width === W && back.height === H,
      `${back.width}x${back.height}`);
check('round-trip is lossless', Buffer.compare(back.rgba, src) === 0);

// --- resampling -------------------------------------------------------------
const flat = resizeRgba(solid(100, 100, [10, 200, 30]), 100, 100, 25, 25);
check('a solid colour survives downscaling',
      flat[0] === 10 && flat[1] === 200 && flat[2] === 30,
      `rgb(${flat[0]},${flat[1]},${flat[2]})`);

// Two black and two white pixels to one: an averaging filter gives mid-grey, a
// nearest-neighbour one gives pure black or white.
const checker = Buffer.from([0,0,0,255, 255,255,255,255, 255,255,255,255, 0,0,0,255]);
const averaged = resizeRgba(checker, 2, 2, 1, 1);
check('the filter averages rather than samples',
      averaged[0] >= 127 && averaged[0] <= 128, `r=${averaged[0]}`);

// Premultiplication check: a clear pixel next to a red one must not drag the red
// toward black. This is what causes dark halos on transparent logos.
const halo = resizeRgba(Buffer.from([255,0,0,255, 0,0,0,0]), 2, 1, 1, 1);
check('clear pixels do not darken their neighbours',
      halo[0] === 255, `r=${halo[0]} a=${halo[3]}`);

// --- compositing ------------------------------------------------------------
const composited = over(solid(2, 1, [0, 0, 255]), Buffer.from([255,0,0,255, 0,0,0,0]));
check('over() keeps the background where the top is clear',
      composited[4] === 0 && composited[6] === 255,
      `second px = rgb(${composited[4]},${composited[5]},${composited[6]})`);

const half = over(solid(1, 1, [0, 0, 0]), Buffer.from([255, 255, 255, 128]));
check('over() blends partial alpha', half[0] === 128, `r=${half[0]}`);

// --- masks and insets -------------------------------------------------------
const disc = circleMask(solid(64, 64, [255, 255, 255]), 64);
check('the circle mask clears the corners', disc[3] === 0, `corner alpha=${disc[3]}`);
check('the circle mask keeps the centre',
      disc[(32 * 64 + 32) * 4 + 3] === 255, `centre alpha=${disc[(32 * 64 + 32) * 4 + 3]}`);

const inset = insetInto(solid(64, 64, [9, 9, 9]), 64, 64, 108, 72 / 108);
check('the adaptive inset leaves the edge transparent', inset[3] === 0);
check('the adaptive inset fills the centre', inset[(54 * 108 + 54) * 4 + 3] === 255);

// --- colours ----------------------------------------------------------------
check('hexToRgb parses #RRGGBB', JSON.stringify(hexToRgb('#0F172A')) === '[15,23,42]');
try {
  hexToRgb('nope');
  check('hexToRgb rejects junk', false, 'it was accepted');
} catch {
  check('hexToRgb rejects junk', true);
}
try {
  decodePng(Buffer.from('not a png at all'));
  check('decodePng rejects a non-PNG', false, 'it was accepted');
} catch (e) {
  check('decodePng rejects a non-PNG', true, e.message);
}

// Greyscale and RGB inputs are widened to RGBA. Hand-built so the decoder is
// exercised on colour types a canvas would not produce but a user might paste in.
for (const [name, colourType, channels, pixel] of [
  ['greyscale', 0, 1, [128]],
  ['RGB', 2, 3, [10, 20, 30]],
  ['greyscale+alpha', 4, 2, [200, 128]],
]) {
  const { deflateSync } = await import('node:zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = colourType;
  const raw = Buffer.concat([Buffer.from([0]), Buffer.from(pixel)]);
  const crc = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ -1) >>> 0;
  };
  const mk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const built = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mk('IHDR', ihdr),
    mk('IDAT', deflateSync(raw)),
    mk('IEND', Buffer.alloc(0)),
  ]);
  try {
    const d = decodePng(built);
    const ok = d.width === 1 && d.height === 1 && d.rgba.length === 4 &&
      (channels === 1 ? d.rgba[0] === 128 && d.rgba[3] === 255
       : channels === 3 ? d.rgba[0] === 10 && d.rgba[3] === 255
       : d.rgba[0] === 200 && d.rgba[3] === 128);
    check(`decodes ${name} as RGBA`, ok, `rgba=${[...d.rgba]}`);
  } catch (e) {
    check(`decodes ${name} as RGBA`, false, e.message);
  }
}

console.log(`\n${'='.repeat(66)}`);
console.log(`${pass}/${total} png checks passed`);
process.exit(pass === total ? 0 : 1);

/**
 * Minimal PNG codec and resampler.
 *
 * WHY NOT sharp
 *   The build host deliberately has no image library. sharp means native bindings
 *   compiled per platform, which is one more thing that can break a signing-path
 *   build for reasons unrelated to the app. The work needed here is narrow --
 *   decode one known PNG, downscale it, re-encode -- and that is a few hundred
 *   lines rather than a dependency.
 *
 *   Format coverage is narrow on purpose: the customer's upload is decoded and
 *   re-encoded to an 8-bit non-interlaced RGBA PNG by a canvas in the browser
 *   before it is ever stored, so that is the only shape this has to read. Anything
 *   else fails loudly rather than producing a subtly wrong icon.
 */

import { deflateSync, inflateSync } from 'node:zlib';

// --- CRC and chunks --------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- Encode ----------------------------------------------------------------

/** Encodes 8-bit RGBA pixels as a non-interlaced PNG. */
export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced

  // Filter type 0 per scanline. Not the smallest output, but the icons are a few
  // KB either way and this keeps the encoder trivially verifiable.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Decode ----------------------------------------------------------------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decodes an 8-bit non-interlaced PNG to RGBA.
 *
 * Handles greyscale, RGB, palette, greyscale+alpha and RGBA. Palette matters even
 * though a canvas never emits one: aapt2 re-encodes launcher icons to a palette
 * during resource crunching, so reading an icon back out of a built APK -- which
 * is how the icon pipeline is verified -- means decoding one.
 *
 * Adam7 interlacing is rejected rather than half-supported. Nothing in this
 * pipeline produces it, so meeting one means the input is not what was expected.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  const idat = [];
  let palette = null;
  let paletteAlpha = null;

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      // For a palette image this is one alpha byte per entry, and entries beyond
      // its length are fully opaque.
      paletteAlpha = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }

  if (colourType === 3 && !palette) throw new Error('palette PNG has no PLTE chunk');

  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}, expected 8`);
  const channels = CHANNELS[colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);
  if (!width || !height) throw new Error('PNG has no dimensions');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is truncated');

  // Reverse the per-scanline filters. Each is defined against the byte to the
  // left (a), above (b) and above-left (c).
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`unknown PNG filter type ${filter}`);
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }

  // Widen whatever came in to RGBA so callers only handle one layout.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * channels;
    if (colourType === 3) {
      const index = out[s];
      rgba[p] = palette[index * 3];
      rgba[p + 1] = palette[index * 3 + 1];
      rgba[p + 2] = palette[index * 3 + 2];
      rgba[p + 3] = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index] : 255;
    } else if (channels === 4) {
      out.copy(rgba, p, s, s + 4);
    } else if (channels === 3) {
      rgba[p] = out[s]; rgba[p + 1] = out[s + 1]; rgba[p + 2] = out[s + 2]; rgba[p + 3] = 255;
    } else if (channels === 2) {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = out[s]; rgba[p + 3] = out[s + 1];
    } else {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = out[s]; rgba[p + 3] = 255;
    }
  }

  return { width, height, rgba };
}

// --- Resampling ------------------------------------------------------------

/**
 * Area-averaged resize.
 *
 * A box filter rather than nearest-neighbour because every use here is a large
 * downscale -- 512px source to as little as 48px -- and nearest-neighbour throws
 * away most of the pixels, which on a logo with thin strokes loses the strokes.
 *
 * Alpha is premultiplied during averaging and un-premultiplied afterwards.
 * Averaging colour and alpha independently makes fully transparent pixels drag
 * their (usually black) colour into the edges of the logo, which shows up as a
 * dark halo on the adaptive foreground.
 */
export function resizeRgba(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.ceil((y + 1) * yRatio)));

    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.ceil((x + 1) * xRatio)));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * srcW + sx) * 4;
          const alpha = src[s + 3] / 255;
          r += src[s] * alpha;
          g += src[s + 1] * alpha;
          b += src[s + 2] * alpha;
          a += src[s + 3];
          n++;
        }
      }

      const d = (y * dstW + x) * 4;
      const meanAlpha = a / n;
      if (meanAlpha === 0) {
        dst[d] = dst[d + 1] = dst[d + 2] = dst[d + 3] = 0;
      } else {
        const unpremul = n * (meanAlpha / 255);
        dst[d] = Math.round(r / unpremul);
        dst[d + 1] = Math.round(g / unpremul);
        dst[d + 2] = Math.round(b / unpremul);
        dst[d + 3] = Math.round(meanAlpha);
      }
    }
  }

  return dst;
}

/** Fills every pixel with one opaque colour. */
export function solid(width, height, [r, g, b]) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  return rgba;
}

/** Composites `fg` over `bg` in place, both the same size, straight alpha. */
export function over(bg, fg) {
  for (let i = 0; i < bg.length; i += 4) {
    const a = fg[i + 3] / 255;
    if (a === 0) continue;
    if (a === 1) {
      fg.copy(bg, i, i, i + 4);
      continue;
    }
    bg[i] = Math.round(fg[i] * a + bg[i] * (1 - a));
    bg[i + 1] = Math.round(fg[i + 1] * a + bg[i + 1] * (1 - a));
    bg[i + 2] = Math.round(fg[i + 2] * a + bg[i + 2] * (1 - a));
    bg[i + 3] = Math.max(bg[i + 3], fg[i + 3]);
  }
  return bg;
}

/**
 * Places `src` centred inside a transparent canvas of `size`, scaled to `inset`
 * of it. Used for the adaptive foreground, where only the central 72 of 108dp is
 * guaranteed visible after the launcher applies its mask.
 */
export function insetInto(src, srcW, srcH, size, inset) {
  const target = Math.max(1, Math.round(size * inset));
  const scaled = resizeRgba(src, srcW, srcH, target, target);
  const canvas = Buffer.alloc(size * size * 4);
  const offset = Math.floor((size - target) / 2);

  for (let y = 0; y < target; y++) {
    scaled.copy(
      canvas,
      ((y + offset) * size + offset) * 4,
      y * target * 4,
      (y + 1) * target * 4
    );
  }
  return canvas;
}

/** Clears everything outside the inscribed circle, for the round launcher icon. */
export function circleMask(rgba, size) {
  const centre = (size - 1) / 2;
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      if (distance > radius) {
        rgba[i + 3] = 0;
      } else if (distance > radius - 1) {
        // One-pixel feather, or the circle looks visibly jagged at 48px.
        rgba[i + 3] = Math.round(rgba[i + 3] * (radius - distance));
      }
    }
  }
  return rgba;
}

/** #RRGGBB to [r, g, b]. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export const DENSITIES = [
  { dir: 'mipmap-mdpi', legacy: 48, adaptive: 108 },
  { dir: 'mipmap-hdpi', legacy: 72, adaptive: 162 },
  { dir: 'mipmap-xhdpi', legacy: 96, adaptive: 216 },
  { dir: 'mipmap-xxhdpi', legacy: 144, adaptive: 324 },
  { dir: 'mipmap-xxxhdpi', legacy: 192, adaptive: 432 },
];

/** The fraction of an adaptive icon guaranteed visible after masking: 72 of 108dp. */
export const ADAPTIVE_SAFE_FRACTION = 72 / 108;

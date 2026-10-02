// ============================================================
// Flattens the customer's icon onto an opaque background.
//
// App Store Connect rejects an app icon containing an alpha channel. The upload
// is a PNG from a browser canvas, which always has one, so something has to
// composite it onto a colour before it reaches the asset catalog. This is that.
//
// ── WHY NO IMAGE LIBRARY ──
//
// sharp, canvas and jimp were all rejected. The first two are native modules,
// which means a compiler and a platform-specific binary in the path that builds
// and signs customer apps -- the same argument the Android side makes for keeping
// image handling in the browser. jimp is pure JS but is 2 MB of dependency for
// one composite.
//
// What is actually needed is narrow: decode one 8-bit PNG, composite it onto a
// solid colour, re-encode without alpha. PNG's own compression is zlib, which
// node has built in, so the only real work is the scanline filters. That is the
// code below, and it is about 120 lines.
//
// Deliberately NOT a general PNG decoder. 8-bit RGBA and 8-bit RGB only, no
// interlacing, no 16-bit, no palettes. Anything else is rejected loudly, because
// the only producer is a browser canvas and a surprise here means the upload path
// changed rather than that this needs to be more capable.
// ============================================================
import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const COLOUR_TYPE = { RGB: 2, RGBA: 6 }

// ------------------------------------------------------------
// Decode
// ------------------------------------------------------------

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG.')
  }

  const chunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end > buffer.length) throw new Error('PNG is truncated.')
    chunks.push({ type, data: buffer.subarray(start, end) })
    // 4 length + 4 type + data + 4 crc
    offset = end + 4
    if (type === 'IEND') break
  }
  return chunks
}

/** Paeth predictor, exactly as the PNG spec defines it. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Reverses the per-scanline filters.
 *
 * Each row carries a filter byte, and filters 1-4 are differences against the
 * pixel to the left, the row above, their average, or Paeth's predictor. All of
 * them operate on bytes `bpp` apart, not adjacent bytes -- getting that wrong
 * produces an image that looks like coloured static, which is the classic symptom
 * of a hand-rolled PNG decoder.
 */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const inRow = (y * (stride + 1)) + 1
    const outRow = y * stride
    const prevRow = outRow - stride

    for (let x = 0; x < stride; x++) {
      const value = raw[inRow + x]
      const left = x >= bpp ? out[outRow + x - bpp] : 0
      const up = y > 0 ? out[prevRow + x] : 0
      const upLeft = (y > 0 && x >= bpp) ? out[prevRow + x - bpp] : 0

      let result
      switch (filter) {
        case 0: result = value; break
        case 1: result = value + left; break
        case 2: result = value + up; break
        case 3: result = value + ((left + up) >> 1); break
        case 4: result = value + paeth(left, up, upLeft); break
        default: throw new Error(`Unsupported PNG row filter ${filter}.`)
      }
      out[outRow + x] = result & 0xff
    }
  }
  return out
}

/** @returns {{width: number, height: number, channels: number, pixels: Buffer}} */
export function decodePng(buffer) {
  const chunks = readChunks(buffer)

  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr) throw new Error('PNG has no IHDR.')

  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const depth = ihdr.data[8]
  const colourType = ihdr.data[9]
  const interlace = ihdr.data[12]

  if (depth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${depth}; expected 8.`)
  }
  if (colourType !== COLOUR_TYPE.RGBA && colourType !== COLOUR_TYPE.RGB) {
    throw new Error(
      `Unsupported PNG colour type ${colourType}; expected 6 (RGBA) or 2 (RGB). ` +
      'The upload path normalises icons to RGBA in a browser canvas, so this ' +
      'means the icon did not come from there.'
    )
  }
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported.')

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  if (!idat.length) throw new Error('PNG has no image data.')

  const channels = colourType === COLOUR_TYPE.RGBA ? 4 : 3
  const pixels = unfilter(zlib.inflateSync(idat), width, height, channels)

  const expected = width * height * channels
  if (pixels.length !== expected) {
    throw new Error(`PNG decoded to ${pixels.length} bytes, expected ${expected}.`)
  }
  return { width, height, channels, pixels }
}

// ------------------------------------------------------------
// Encode
// ------------------------------------------------------------

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData) >>> 0)
  return Buffer.concat([length, typeAndData, crc])
}

// Standard PNG/zlib CRC-32. Table built once on first use.
let CRC_TABLE = null
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  }
  return crc ^ -1
}

/**
 * Writes 8-bit RGB with no alpha channel.
 *
 * Every row uses filter 0 (None). A real encoder would try all five per row and
 * keep the smallest, but the input is a flat-background logo that zlib already
 * compresses well, and an icon is written once per build. Simplicity is worth
 * more here than a few kilobytes.
 */
export function encodePngRgb(width, height, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8                    // bit depth
  ihdr[9] = COLOUR_TYPE.RGB      // colour type: no alpha. The whole point.
  ihdr[10] = 0                   // deflate
  ihdr[11] = 0                   // adaptive filtering
  ihdr[12] = 0                   // no interlace

  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------
// Composite
// ------------------------------------------------------------

const parseHex = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/**
 * Composites a PNG onto a solid colour and returns opaque RGB PNG bytes.
 *
 * Source-over with straight (un-premultiplied) alpha, which is what a browser
 * canvas toDataURL produces. Treating it as premultiplied would darken every
 * semi-transparent edge pixel -- subtle enough to pass review and obvious enough
 * to look wrong on a light icon.
 */
export function flattenOntoColour(pngBuffer, backgroundHex) {
  const { width, height, channels, pixels } = decodePng(pngBuffer)

  if (width !== height) {
    throw new Error(`Icon must be square; got ${width}x${height}.`)
  }

  const [br, bg, bb] = parseHex(backgroundHex)
  const out = Buffer.alloc(width * height * 3)

  if (channels === 3) {
    // Already opaque. Copied rather than returned untouched so the output is
    // always a known-shape PNG written by encodePngRgb.
    pixels.copy(out)
  } else {
    for (let i = 0, o = 0; i < pixels.length; i += 4, o += 3) {
      const alpha = pixels[i + 3] / 255
      const inverse = 1 - alpha
      out[o] = Math.round(pixels[i] * alpha + br * inverse)
      out[o + 1] = Math.round(pixels[i + 1] * alpha + bg * inverse)
      out[o + 2] = Math.round(pixels[i + 2] * alpha + bb * inverse)
    }
  }

  return { png: encodePngRgb(width, height, out), width, height }
}

/** Minimum the App Store will accept. Checked before a build, not after. */
export const REQUIRED_ICON_PX = 1024

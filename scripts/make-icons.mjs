// Generates the Akansha window/tray/installer icons as real PNG files.
// Kept as a script (not a build step) so the committed assets stay stable, and
// so there is no image-library dependency: PNG chunks are written by hand.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}

function png(size, pixel) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y)
      raw.set([r, g, b, a], row + 1 + x * 4)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Dark disc, cyan ring, bright core -- 4x4 supersampled for clean edges. */
function akanshaIcon(size) {
  const c = (size - 1) / 2
  const disc = size * 0.47
  const ring = size * 0.34
  const ringWidth = Math.max(1.2, size * 0.06)
  const core = size * 0.13
  const at = (fx, fy) => {
    const d = Math.hypot(fx - c, fy - c)
    if (d <= core) return [125, 211, 252, 255]
    if (Math.abs(d - ring) <= ringWidth / 2) return [56, 189, 248, 255]
    if (d <= disc) return [11, 18, 32, 255]
    return [0, 0, 0, 0]
  }
  return (x, y) => {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const [pr, pg, pb, pa] = at(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)
        r += pr * pa
        g += pg * pa
        b += pb * pa
        a += pa
      }
    }
    if (!a) return [0, 0, 0, 0]
    return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / 16)]
  }
}

const assets = join(root, 'assets')
mkdirSync(assets, { recursive: true })
const files = [
  ['icon.png', 256],
  ['tray.png', 32],
  ['tray@2x.png', 64]
]
for (const [name, size] of files) writeFileSync(join(assets, name), png(size, akanshaIcon(size)))
console.log(`wrote ${files.map(([n]) => `assets/${n}`).join(', ')}`)

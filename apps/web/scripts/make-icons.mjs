// Генератор иконок приложения: сплошной холст + знак «Э» блоками. Сторонних зависимостей нет.
// Запуск: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'i')

const BG = [0x13, 0x14, 0x17]
const FG = [0xfc, 0xfb, 0xf9]

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** true — пиксель знака. Знак «Э»: три горизонтальные перекладины и правая стойка. */
function isGlyph(x, y, size, inset) {
  const u = (x - inset) / (size - 2 * inset)
  const v = (y - inset) / (size - 2 * inset)
  if (u < 0 || u > 1 || v < 0 || v > 1) return false
  const bar = 0.16
  const top = v < bar && u > 0.05
  const mid = Math.abs(v - 0.5) < bar / 2 && u > 0.38
  const bottom = v > 1 - bar && u > 0.05
  const stem = u > 1 - bar
  return top || mid || bottom || stem
}

function png(size, maskable) {
  const inset = maskable ? Math.round(size * 0.28) : Math.round(size * 0.2)
  const radius = maskable ? size : Math.round(size * 0.22)
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0
    for (let x = 0; x < size; x += 1) {
      const o = 1 + x * 4
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0)
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0)
      const outside = !maskable && Math.hypot(dx, dy) > radius
      const glyph = isGlyph(x, y, size, inset)
      const color = glyph ? FG : BG
      row[o] = color[0]
      row[o + 1] = color[1]
      row[o + 2] = color[2]
      row[o + 3] = outside ? 0 : 255
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(outDir, { recursive: true })
for (const [name, size, maskable] of [
  ['app-192.png', 192, false],
  ['app-512.png', 512, false],
  ['app-180.png', 180, false],
  ['app-mask.png', 512, true],
]) {
  writeFileSync(join(outDir, name), png(size, maskable))
  process.stdout.write(`${name}\n`)
}

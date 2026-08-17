/**
 * QR постоянной ссылки (§12.8): 232×232, SVG, считается локально,
 * ECC M, тихая зона 4 модуля. Тёмные модули — --e-fg, поле — --e-surface.
 */
import qrcode from 'qrcode-generator'

export const QR_SIZE_PX = 232
export const QR_QUIET_MODULES = 4
export const QR_ECC = 'M'

export type QrEcc = 'L' | 'M' | 'Q' | 'H'

export interface QrMatrix {
  size: number
  /** Ряды по строкам: true — тёмный модуль. */
  rows: boolean[][]
}

/** Матрица модулей. Тип 0 — автоподбор версии по длине данных. */
export function qrMatrix(text: string, ecc: QrEcc = QR_ECC): QrMatrix {
  const qr = qrcode(0, ecc)
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let r = 0; r < size; r++) {
    const row: boolean[] = []
    for (let c = 0; c < size; c++) row.push(qr.isDark(r, c))
    rows.push(row)
  }
  return { size, rows }
}

/**
 * Один путь на все тёмные модули: горизонтальные пробеги склеиваются,
 * иначе на версии 8 получается больше тысячи прямоугольников.
 */
export function qrPath(m: QrMatrix): string {
  const parts: string[] = []
  for (let r = 0; r < m.size; r++) {
    const row = m.rows[r]
    if (row === undefined) continue
    let c = 0
    while (c < m.size) {
      if (row[c] !== true) {
        c += 1
        continue
      }
      let width = 1
      while (c + width < m.size && row[c + width] === true) width += 1
      parts.push(`M${c} ${r}h${width}v1h-${width}z`)
      c += width
    }
  }
  return parts.join('')
}

export interface QrSvgOptions {
  ecc?: QrEcc
  quiet?: number
  /** Цвета: по умолчанию — токены темы, чтобы QR читался и в тёмной. */
  dark?: string
  light?: string
  title?: string
}

/** Готовая разметка: удобно для скачивания файлом и для теста. */
export function qrSvg(text: string, opts: QrSvgOptions = {}): string {
  const m = qrMatrix(text, opts.ecc ?? QR_ECC)
  const quiet = opts.quiet ?? QR_QUIET_MODULES
  const side = m.size + quiet * 2
  const dark = opts.dark ?? 'var(--e-fg)'
  const light = opts.light ?? 'var(--e-surface)'
  const title = opts.title ?? ''
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img"${title === '' ? ' aria-hidden="true"' : ''}>`,
    title === '' ? '' : `<title>${escapeXml(title)}</title>`,
    `<rect width="${side}" height="${side}" fill="${light}"/>`,
    `<g transform="translate(${quiet} ${quiet})" fill="${dark}"><path d="${qrPath(m)}"/></g>`,
    '</svg>',
  ].join('')
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

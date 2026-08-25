import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { looksLikeXlsx, readXlsx } from '../src/xlsx.js'
import { parseRows } from '../src/statement.js'

/**
 * Книга Excel собирается прямо здесь, а не кладётся файлом в репозиторий.
 *
 * Так тест проверяет именно то, что читает разбор: если формат опишут неверно,
 * ошибка будет видна здесь же, а не спрячется в двоичном файле, который никто
 * не откроет.
 *
 * `deflate` — не роскошь, а единственный настоящий случай: Excel всегда пишет
 * записи сжатыми, и до 25 августа ветка `DecompressionStream('deflate-raw')` —
 * та, по которой идёт любой файл из банка, — не выполнялась в тестах ни разу.
 * Проверялось только хранение без сжатия, которого в жизни не бывает.
 */
function zip(
  files: ReadonlyArray<{ name: string; text: string }>,
  deflate = false,
): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const name = enc.encode(file.name)
    const raw = enc.encode(file.text)
    // CRC и «размер до сжатия» считаются по исходным байтам, а «размер после» —
    // по сжатым. Перепутать их — обычная ошибка в самодельном zip.
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const method = deflate ? 8 : 0
    const crc = crc32(raw)

    const local = new Uint8Array(30 + name.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const dir = new Uint8Array(46 + name.length)
    const dv = new DataView(dir.buffer)
    dv.setUint32(0, 0x02014b50, true)
    dv.setUint16(10, method, true)
    dv.setUint32(16, crc, true)
    dv.setUint32(20, data.length, true)
    dv.setUint32(24, raw.length, true)
    dv.setUint16(28, name.length, true)
    dv.setUint32(42, offset, true)
    dir.set(name, 46)
    central.push(dir)

    offset += local.length
  }

  const dirSize = central.reduce((n, d) => n + d.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, dirSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + dirSize + 22
  const out = new Uint8Array(total)
  let at = 0
  for (const part of [...locals, ...central, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const STRINGS = `<?xml version="1.0"?><sst count="6" uniqueCount="6">
<si><t>Дата операции</t></si>
<si><t>Сумма операции</t></si>
<si><t>Описание</t></si>
<si><t>PYATEROCHKA 5566</t></si>
<si><t>Зарплата за месяц</t></si>
<si><t>SURF &amp; COFFEE</t></si>
</sst>`

const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>05.01.2026</t></is></c><c r="B2"><v>-900</v></c><c r="C2" t="s"><v>3</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>06.01.2026</t></is></c><c r="B3"><v>120000</v></c><c r="C3" t="s"><v>4</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>07.01.2026</t></is></c><c r="C4" t="s"><v>5</v></c><c r="B4"><v>-300</v></c></row>
</sheetData></worksheet>`

const book = zip([
  { name: '[Content_Types].xml', text: '<Types/>' },
  { name: 'xl/sharedStrings.xml', text: STRINGS },
  { name: 'xl/worksheets/sheet1.xml', text: SHEET },
])

/** Та же книга, но сжатая — так её пишет Excel и любой банк. */
const packed = zip(
  [
    { name: '[Content_Types].xml', text: '<Types/>' },
    { name: 'xl/sharedStrings.xml', text: STRINGS },
    { name: 'xl/worksheets/sheet1.xml', text: SHEET },
  ],
  true,
)

/**
 * Книга с датами числами. Excel хранит дату числом дней от 30 декабря 1899
 * года, и настоящая выгрузка выглядит именно так — строковые даты в тестах
 * были удобной выдумкой.
 */
const SERIAL_SHEET = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" s="1"><v>46027</v></c><c r="B2"><v>-900</v></c><c r="C2" t="s"><v>3</v></c></row>
<row r="3"><c r="A3" s="1"><v>46028</v></c><c r="B3"><v>120000</v></c><c r="C3" t="s"><v>4</v></c></row>
</sheetData></worksheet>`

const serialBook = zip(
  [
    { name: '[Content_Types].xml', text: '<Types/>' },
    { name: 'xl/sharedStrings.xml', text: STRINGS },
    { name: 'xl/worksheets/sheet1.xml', text: SERIAL_SHEET },
  ],
  true,
)

describe('сжатая книга — та, что приходит из банка', () => {
  it('распаковывается и читается', async () => {
    // До 25 августа эта ветка не выполнялась в тестах ни разу: архив собирался
    // без сжатия, а Excel всегда пишет сжатым.
    expect(looksLikeXlsx(packed)).toBe(true)
    const rows = await readXlsx(packed)
    expect(rows[0]).toEqual(['Дата операции', 'Сумма операции', 'Описание'])
    expect(rows[1]).toEqual(['05.01.2026', '-900', 'PYATEROCHKA 5566'])
  })

  it('сжатая книга заметно меньше несжатой — значит сжатие настоящее', () => {
    expect(packed.length).toBeLessThan(book.length)
  })

  it('даты числами читаются, а не дают «ноль операций»', async () => {
    const result = parseRows(await readXlsx(serialBook), 'выписка.xlsx')
    expect(result.error).toBeNull()
    expect(result.transactions).toHaveLength(2)
    expect(result.skipped).toBe(0)
    // 46027 — 5 января 2026 года.
    expect(result.transactions[1]?.date).toBe('2026-01-05')
  })
})

describe('книга Excel', () => {
  it('опознаётся по содержимому, а не по имени файла', () => {
    expect(looksLikeXlsx(book)).toBe(true)
    expect(looksLikeXlsx(new TextEncoder().encode('Дата;Сумма'))).toBe(false)
  })

  it('читается в те же строки, что и CSV', async () => {
    const rows = await readXlsx(book)
    expect(rows[0]).toEqual(['Дата операции', 'Сумма операции', 'Описание'])
    expect(rows[1]).toEqual(['05.01.2026', '-900', 'PYATEROCHKA 5566'])
  })

  it('колонка берётся из имени ячейки, а не из порядка', async () => {
    // В XLSX пустых ячеек просто нет, и ячейки могут идти не по порядку.
    // Считать по порядку значило бы поставить суммы под чужие заголовки —
    // молча.
    const rows = await readXlsx(book)
    expect(rows[3]).toEqual(['07.01.2026', '-300', 'SURF & COFFEE'])
  })

  it('разбирается тем же кодом, что и таблица из CSV', async () => {
    const result = parseRows(await readXlsx(book), 'выписка.xlsx')
    expect(result.error).toBeNull()
    expect(result.transactions).toHaveLength(3)
    const sums = result.transactions.map((tx) => tx.amount).sort((a, b) => a - b)
    expect(sums).toEqual([-90000, -30000, 12000000])
  })
})

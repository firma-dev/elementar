/**
 * Чтение XLSX.
 *
 * Часть банков не отдаёт CSV вовсе — только таблицу Excel. Пока её не читаем,
 * «универсальность» разбора остаётся наполовину правдой: файл опознаётся,
 * человеку говорят «нужен CSV», и на этом разговор кончается.
 *
 * Написано своим кодом, без библиотеки. Не из гордости: зависимость в
 * Элементаре не добавляется без решения архитектора, а любая библиотека для
 * таблиц тащит за собой чтение формул, стилей и диаграмм — сотни килобайт кода,
 * читающего чужие файлы. Нам нужны строки и числа с одного листа.
 *
 * XLSX — это zip с XML внутри. Распаковку делает сам браузер:
 * `DecompressionStream('deflate-raw')` есть везде, где работает остальной
 * корпус. Ни одного внешнего запроса, как и во всём остальном (ТЗ §1).
 */

/** Запись в оглавлении zip: где лежит файл и как он сжат. */
interface Entry {
  name: string
  method: number
  offset: number
  compressed: number
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Оглавление zip читается с конца: там лежит запись «конец каталога», а в ней
 * — где начинается сам каталог. Идти с начала нельзя: между файлами бывает
 * что угодно, и позиции надо брать из каталога, а не угадывать.
 */
function readDirectory(bytes: Uint8Array): Entry[] {
  const dv = view(bytes)
  let end = -1
  // Комментарий в конце архива до 64 КБ — дальше искать бессмысленно.
  const from = Math.max(0, bytes.length - 66000)
  for (let i = bytes.length - 22; i >= from; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end === -1) return []

  const count = dv.getUint16(end + 10, true)
  let at = dv.getUint32(end + 16, true)
  const out: Entry[] = []
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(at, true) !== 0x02014b50) break
    const method = dv.getUint16(at + 10, true)
    const compressed = dv.getUint32(at + 20, true)
    const nameLen = dv.getUint16(at + 28, true)
    const extraLen = dv.getUint16(at + 30, true)
    const commentLen = dv.getUint16(at + 32, true)
    const offset = dv.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    out.push({ name, method, offset, compressed })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** Достать один файл из архива. Возвращает null, если способ сжатия чужой. */
async function readEntry(bytes: Uint8Array, entry: Entry): Promise<string | null> {
  const dv = view(bytes)
  if (dv.getUint32(entry.offset, true) !== 0x04034b50) return null
  const nameLen = dv.getUint16(entry.offset + 26, true)
  const extraLen = dv.getUint16(entry.offset + 28, true)
  const start = entry.offset + 30 + nameLen + extraLen
  const raw = bytes.subarray(start, start + entry.compressed)

  if (entry.method === 0) return new TextDecoder().decode(raw)
  if (entry.method !== 8) return null

  // Копия, а не вид на исходный буфер: `Blob` требует собственный
  // `ArrayBuffer`, а подрезанный вид делит его со всем остальным файлом.
  const own = new Uint8Array(raw)
  const stream = new Blob([own.buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

/** Значения тегов `<t>` из общей таблицы строк, по порядку. */
function sharedStrings(xml: string): string[] {
  const out: string[] = []
  // `<si>` — одна строка, внутри может быть несколько `<t>`: так Excel хранит
  // строки с разным начертанием внутри одной ячейки.
  for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    let text = ''
    for (const t of si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []) {
      text += unescapeXml(t.replace(/<[^>]+>/g, ''))
    }
    out.push(text)
  }
  return out
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

/** Номер колонки из имени ячейки: `A1` → 0, `AB7` → 27. */
function columnOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * Разобрать лист в строки таблицы.
 *
 * Пустые ячейки в XML просто отсутствуют, поэтому колонка берётся из имени
 * ячейки, а не из порядка: иначе строка с пропуском посередине съезжает на
 * одну позицию, и суммы оказываются под чужими заголовками. Молча.
 */
function readSheet(xml: string, strings: readonly string[]): string[][] {
  const rows: string[][] = []
  for (const rowXml of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: string[] = []
    for (const cellXml of rowXml.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) ?? []) {
      const ref = /r="([A-Z]+\d+)"/.exec(cellXml)?.[1] ?? ''
      const type = /t="([^"]+)"/.exec(cellXml)?.[1] ?? 'n'
      const at = ref === '' ? cells.length : columnOf(ref)

      let value = ''
      if (type === 'inlineStr') {
        value = unescapeXml(
          (cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '').replace(/<[^>]+>/g, ''),
        )
      } else {
        const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? ''
        value = type === 's' ? (strings[Number(raw)] ?? '') : unescapeXml(raw)
      }
      while (cells.length < at) cells.push('')
      cells[at] = value
    }
    rows.push(cells)
  }
  return rows
}

/**
 * Первый лист книги как таблица строк.
 *
 * Первый — потому что банки кладут выписку на первый лист, а разбираться в
 * порядке листов из `workbook.xml` значит читать ещё два файла ради случая,
 * которого пока не видели. Не нашли — вернём пусто, и человек получит
 * понятную ошибку от разбора выписки, а не молчание.
 */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const entries = readDirectory(bytes)
  if (entries.length === 0) return []

  const sheetEntry =
    entries.find((e) => e.name === 'xl/worksheets/sheet1.xml') ??
    entries.find((e) => e.name.startsWith('xl/worksheets/sheet'))
  if (sheetEntry === undefined) return []

  const stringsEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml')
  const stringsXml = stringsEntry === undefined ? null : await readEntry(bytes, stringsEntry)
  const sheetXml = await readEntry(bytes, sheetEntry)
  if (sheetXml === null) return []

  return readSheet(sheetXml, stringsXml === null ? [] : sharedStrings(stringsXml))
}

/** Похож ли файл на книгу Excel: сигнатура zip плюс `xl/` внутри. */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  return readDirectory(bytes).some((e) => e.name.startsWith('xl/'))
}

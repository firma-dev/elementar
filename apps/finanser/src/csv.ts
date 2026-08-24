/**
 * Разбор CSV. Устойчивость важнее скорости: выгрузка банка приходит в чужой
 * кодировке, с чужим разделителем и с кавычками внутри кавычек — падать на этом
 * нельзя (ТЗ §2 п.2). Ни одного сетевого вызова: всё делается над Uint8Array,
 * который дал `<input type="file">`.
 */

/** Разделители, которые встречаются в банковских выгрузках. */
const DELIMITERS = [';', ',', '\t', '|'] as const

export type Delimiter = (typeof DELIMITERS)[number]

/**
 * Опознание формата по сигнатуре первых байтов. Нужно, чтобы человек получил
 * ответ на свой вопрос, а не на наш: «не нашлись колонки» — это правда про
 * разбор, но ложь про причину, если он принёс PDF. Ошибка должна называть то,
 * что человек сделал, и то, что делать вместо этого.
 *
 * Возвращает готовый текст ошибки или null, если файл похож на текст.
 */
export function sniffNotCsv(bytes: Uint8Array): string | null {
  const b = (i: number): number => bytes[i] ?? 0
  const starts = (sig: readonly number[]): boolean => sig.every((v, i) => b(i) === v)

  // %PDF
  if (starts([0x25, 0x50, 0x44, 0x46])) {
    return (
      'Это PDF — скорее всего «справка о движении средств». Финансер читает CSV: ' +
      'в приложении банка выберите выписку по счёту и формат CSV, а не PDF.'
    )
  }
  // PK.. — zip. Книга Excel сюда больше не попадает: её разбирает `readXlsx`,
  // и до этой проверки такой файл не доходит. Остаются ods и просто архивы.
  if (starts([0x50, 0x4b, 0x03, 0x04]) || starts([0x50, 0x4b, 0x05, 0x06])) {
    return (
      'Это архив или таблица в чужом формате. Финансер читает CSV и книги Excel ' +
      '(.xlsx): при выгрузке из банка выберите один из них.'
    )
  }
  // Старый .xls
  if (starts([0xd0, 0xcf, 0x11, 0xe0])) {
    return (
      'Это старый файл Excel (.xls). Финансер читает CSV и новый формат книги ' +
      '(.xlsx) — пересохраните или выгрузите заново.'
    )
  }
  // Нулевой байт в начале файла — верный признак двоичного формата.
  if (bytes.slice(0, 512).includes(0)) {
    return 'Похоже, это не текстовый файл. Финансер читает CSV — выгрузку операций из банка.'
  }
  return null
}

/**
 * Декодирование байтов. Банки часто отдают windows-1251, но выгрузка, прошедшая через
 * таблицу или почту, приезжает в UTF-8 — определяем, а не предполагаем.
 * Приём: UTF-8 с `fatal: true` не переварит кириллицу в 1251 и бросит; поймали —
 * значит однобайтовая кодировка.
 */
export function decodeBytes(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('windows-1251').decode(bytes)
  }
  // BOM в начале — служебный символ, а не первая буква заголовка: снимаем,
  // иначе имя первой колонки перестаёт совпадать со словарём.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Выбор разделителя: тот, что даёт больше всего колонок в первой непустой строке
 * и одинаковое их число в следующих. Считаем вне кавычек.
 */
export function detectDelimiter(text: string): Delimiter {
  const head = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 5)
  let best: Delimiter = ';'
  let bestScore = -1
  for (const d of DELIMITERS) {
    const counts = head.map((line) => countOutsideQuotes(line, d))
    const first = counts[0] ?? 0
    if (first === 0) continue
    const stable = counts.every((c) => c === first)
    const score = first * (stable ? 10 : 1)
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false
  let n = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1
      else inQuotes = !inQuotes
    } else if (ch === delimiter && !inQuotes) n += 1
  }
  return n
}

/**
 * Строки таблицы. Кавычки по RFC 4180: удвоенная кавычка внутри поля — это одна
 * кавычка; перевод строки внутри кавычек не разрывает запись. Хвостовые пустые
 * строки отбрасываются, пустые строки внутри файла — тоже (банк ставит их между
 * блоками).
 */
export function parseCsv(text: string, delimiter?: Delimiter): string[][] {
  const d = delimiter ?? detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  const pushField = (): void => {
    row.push(field.trim())
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    if (row.some((c) => c !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === d) {
      pushField()
    } else if (ch === '\n') {
      pushRow()
    } else if (ch === '\r') {
      // \r\n — перевод строки; одиночный \r (старый Mac) тоже перевод строки.
      if (text[i + 1] === '\n') i += 1
      pushRow()
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

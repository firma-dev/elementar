/**
 * Чтение банковской выписки.
 *
 * Банк здесь не назван намеренно. Колонки берутся по имени заголовка, а не по
 * номеру, и у имени есть список синонимов — этого хватает, чтобы читать
 * выгрузки разных банков одним кодом. Позиционный разбор ломался бы молча:
 * цифры остались бы, но не те, а это худший вид поломки.
 *
 * Три вещи, которыми выгрузки отличаются друг от друга, и ответ на каждую:
 *   — заголовок не на первой строке, сверху шапка со счётом → ищем его;
 *   — приход и расход в разных колонках, а не одной суммой со знаком → сводим;
 *   — остаток по счёту отдельной колонкой → берём, он говорит текущий баланс.
 */
import { parseCsv, decodeBytes, sniffNotCsv } from './csv.js'
import { looksLikeXlsx, readXlsx } from './xlsx.js'
import { parseAmount } from './money.js'
import type { Kopeck } from './money.js'
import type { Tx } from './model.js'
import { accountKey, txId } from './model.js'

/** Как называется колонка в разных выгрузках. Сравнение — по нормализованному имени. */
const COLUMNS = {
  date: [
    'ДАТА ОПЕРАЦИИ',
    'ДАТА ПЛАТЕЖА',
    'ДАТА ПРОВЕДЕНИЯ',
    'ДАТА ОБРАБОТКИ',
    'ДАТА ТРАНЗАКЦИИ',
    'ДАТА СОВЕРШЕНИЯ ОПЕРАЦИИ',
    'DATE',
    'ДАТА',
  ],
  amount: [
    'СУММА ОПЕРАЦИИ',
    'СУММА ПЛАТЕЖА',
    'СУММА В ВАЛЮТЕ СЧЕТА',
    'СУММА В ВАЛЮТЕ СЧЁТА',
    'СУММА ОПЕРАЦИИ В ВАЛЮТЕ СЧЕТА',
    'AMOUNT',
    'СУММА',
  ],
  /** Приход и расход отдельными колонками: так отдаёт заметная часть банков. */
  credit: [
    'ПРИХОД',
    'ПОСТУПЛЕНИЕ',
    'ПОСТУПЛЕНИЯ',
    'ЗАЧИСЛЕНИЕ',
    'СУММА ЗАЧИСЛЕНИЯ',
    'КРЕДИТ',
    'CREDIT',
  ],
  debit: ['РАСХОД', 'РАСХОДЫ', 'СПИСАНИЕ', 'СПИСАНИЯ', 'СУММА СПИСАНИЯ', 'ДЕБЕТ', 'DEBIT'],
  balance: ['ОСТАТОК', 'ОСТАТОК ПО СЧЕТУ', 'ОСТАТОК ПО СЧЁТУ', 'БАЛАНС', 'BALANCE'],
  currency: ['ВАЛЮТА ОПЕРАЦИИ', 'ВАЛЮТА СЧЕТА', 'ВАЛЮТА СЧЁТА', 'CURRENCY', 'ВАЛЮТА'],
  payAmount: ['СУММА ПЛАТЕЖА'],
  payCurrency: ['ВАЛЮТА ПЛАТЕЖА'],
  description: [
    'ОПИСАНИЕ',
    'ОПИСАНИЕ ОПЕРАЦИИ',
    'НАЗНАЧЕНИЕ ПЛАТЕЖА',
    'НАЗНАЧЕНИЕ',
    'КОНТРАГЕНТ',
    'ПОЛУЧАТЕЛЬ',
    'МЕСТО СОВЕРШЕНИЯ',
    'КОММЕНТАРИЙ',
    'ДЕТАЛИ ОПЕРАЦИИ НАЗНАЧЕНИЕ ПЛАТЕЖА',
    'ДЕТАЛИ ОПЕРАЦИИ',
    'ДЕТАЛИ',
    'DESCRIPTION',
  ],
  status: ['СТАТУС', 'STATUS'],
  category: ['КАТЕГОРИЯ', 'КАТЕГОРИЯ ОПЕРАЦИИ', 'CATEGORY'],
  mcc: ['MCC', 'МСС', 'КОД MCC'],
  /** Карта или счёт: по ним выписка раскладывается на счета внутри банка. */
  account: ['НОМЕР КАРТЫ', 'КАРТА', 'НОМЕР СЧЕТА', 'НОМЕР СЧЁТА', 'СЧЕТ', 'СЧЁТ', 'ACCOUNT'],
} as const

type ColumnKey = keyof typeof COLUMNS

function normalizeHeader(cell: string): string {
  return cell
    .replace(/^﻿/, '')
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[^0-9A-ZА-Я]+/gu, ' ')
    .trim()
}

/**
 * Строка заголовка не всегда первая: часть банков ставит сверху шапку с именем
 * владельца, номером счёта и периодом. Ищем первую строку, где опознались и
 * дата, и сумма. Глубже пятнадцати строк не лезем — дальше это уже не шапка, а
 * случайное совпадение в теле файла.
 */
const HEADER_SEARCH_DEPTH = 15

export function findHeader(rows: readonly (readonly string[])[]): number {
  const limit = Math.min(HEADER_SEARCH_DEPTH, rows.length)
  for (let i = 0; i < limit; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    const columns = mapColumns(row)
    if (columns.date === undefined) continue
    if (columns.amount !== undefined) return i
    if (columns.credit !== undefined || columns.debit !== undefined) return i
  }
  return -1
}

/**
 * Число у слова отбрасывается.
 *
 * Банк пишет колонки во множественном: «Поступления», «Расходы». Список
 * синонимов знал только единственное — «Поступление», «Расход», — и выписка не
 * читалась вовсе: ни даты, ни суммы, при том что обе колонки в файле были и
 * назывались почти теми же словами. Дописать в список ещё две формы мало:
 * следующий банк напишет «Списания» или «Суммы», и всё повторится.
 *
 * Правило простое и потому предсказуемое: у слова от четырёх букв снимается
 * последняя гласная. «ПОСТУПЛЕНИЯ» и «ПОСТУПЛЕНИЕ» сходятся в «ПОСТУПЛЕНИ»,
 * «РАСХОДЫ» и «РАСХОД» — в «РАСХОД». Короткие слова не трогаются: там снятие
 * буквы меняет слово, а не форму.
 */
function stemHeader(name: string): string {
  return name
    .split(' ')
    .map((word) => (word.length >= 4 ? word.replace(/[АЯЫИЕОУЬ]$/u, '') : word))
    .join(' ')
}

/**
 * Индексы колонок по заголовку. Не нашлась — undefined, а не ноль.
 *
 * Два прохода, и порядок между ними важен: сначала точные имена по всем
 * ключам, и только потом — по формам слова. Иначе колонка, названная точно так
 * же, как синоним одного ключа, могла бы достаться другому, чья форма совпала
 * раньше по списку.
 */
function mapColumns(header: readonly string[]): Partial<Record<ColumnKey, number>> {
  const normalized = header.map(normalizeHeader)
  const out: Partial<Record<ColumnKey, number>> = {}
  for (const key of Object.keys(COLUMNS) as ColumnKey[]) {
    for (const name of COLUMNS[key]) {
      const index = normalized.indexOf(name)
      if (index !== -1) {
        out[key] = index
        break
      }
    }
  }

  const stems = normalized.map(stemHeader)
  for (const key of Object.keys(COLUMNS) as ColumnKey[]) {
    if (out[key] !== undefined) continue
    for (const name of COLUMNS[key]) {
      const index = stems.indexOf(stemHeader(name))
      if (index !== -1) {
        out[key] = index
        break
      }
    }
  }
  return out
}

/**
 * Дата к ISO. Понимает «31.12.2025 14:23:45», «31.12.2025», «2025-12-31»,
 * «31/12/2025». Возвращает null, если даты нет: строка без даты в картину года
 * не встанет и должна быть пропущена, а не приписана к сегодняшнему дню.
 */
/**
 * Границы правдоподобия для года. Выписки за пределами этого окна не бывает, а
 * одна опечатка в годе внутри годовой выписки растягивала картину по месяцам на
 * весь промежуток: график получал 1200 столбцов, и понять, что случилось, было
 * нельзя. Лучше пропустить строку и сказать об этом, чем показать такое.
 */
const YEAR_MIN = 1990
const YEAR_MAX = 2100

/**
 * Excel держит дату числом дней от 30 декабря 1899 года. Так её отдаёт
 * `xlsx.ts`, читающий книгу напрямую: в ячейке лежит `45678`, а не «12.01.2025»,
 * и формат хранится отдельно от значения.
 *
 * Без этой ветки настоящая книга из банка давала ноль операций при пустой
 * ошибке — человек видел бодрое «в файле не нашлось ни одной операции» и думал,
 * что виноват банк.
 *
 * Точка отсчёта именно 30 декабря, а не 31: Excel считает 1900 год високосным,
 * которым он не был, и сдвиг на сутки уже заложен в саму эпоху.
 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

function fromExcelSerial(s: string): string | null {
  if (!/^\d{1,6}(?:\.\d+)?$/.test(s)) return null
  const serial = Number(s)
  // 32874 — 1 января 1990 года, 73415 — 31 декабря 2100-го. Вне окна это не
  // дата, а число, случайно попавшее в колонку даты.
  if (serial < 32874 || serial > 73415) return null
  const d = new Date(EXCEL_EPOCH_UTC + Math.floor(serial) * DAY_MS)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (s === '') return null

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso !== null) {
    const year = Number(iso[1])
    if (year < YEAR_MIN || year > YEAR_MAX) return null
    return `${iso[1]}-${iso[2]}-${iso[3]}`
  }

  const dmy = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(s)
  if (dmy === null) return fromExcelSerial(s)
  const day = (dmy[1] ?? '').padStart(2, '0')
  const month = (dmy[2] ?? '').padStart(2, '0')
  const rawYear = dmy[3] ?? ''
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null
  if (Number(year) < YEAR_MIN || Number(year) > YEAR_MAX) return null
  return `${year}-${month}-${day}`
}

function isRouble(currency: string): boolean {
  const c = currency.trim().toUpperCase()
  return c === '' || c === 'RUB' || c === 'RUR' || c === 'РУБ' || c === '643' || c === '₽'
}

/** Что вернул разбор: операции и то, что с ними по дороге случилось. */
export interface ParseResult {
  transactions: Tx[]
  /** Строк в файле, не считая заголовка. */
  rows: number
  /** Пропущено: не отражённые операции, строки без даты или без суммы. */
  skipped: number
  /** Операция в валюте, пересчитанная по сумме платежа банка. */
  converted: number
  /**
   * Операции в валюте, которые пересчитать не удалось: банк не дал рублёвой
   * суммы платежа. Они посчитаны как рубли — и это неправда, о которой человек
   * должен узнать. Молчаливо смешивать евро с рублями нельзя: сумма выглядит
   * правдоподобно и потому не проверяется.
   */
  foreign: number
  /** Заголовок не опознан — колонок даты или суммы в файле нет. */
  error: string | null
  /**
   * Остаток по счёту на конец выписки, если банк его отдал. Сложением операций
   * его не получить: выписка начинается не с нуля, и полученное число было бы
   * похоже на баланс, но им не являлось.
   */
  balance: Kopeck | null
  /** Ключи счетов, встреченные в файле: обычно один, но бывает и несколько. */
  accounts: string[]
  /**
   * Были ли в файле колонки MCC и «Категория».
   *
   * Банки отдают выписку в двух видах. Короткая — пять
   * колонок без кодов: тогда категорию приходится угадывать по описанию, и в
   * «Прочее» падает заметно больше. Полная выгрузка операций несёт и MCC, и
   * собственную категорию банка — с ними разбор точнее в разы.
   *
   * Человек об этой разнице не знает и знать не обязан, поэтому приложение
   * говорит о ней само, когда видит короткий файл.
   */
  hasCodes: boolean
}

/** Статусы, при которых деньги не двигались. */
const DEAD_STATUS = new Set(['FAILED', 'ОТКАЗ', 'ОТКЛОНЕНО', 'WAITING', 'ОЖИДАЕТ'])

/**
 * Разбор выписки из байтов файла: CSV или книга Excel.
 *
 * `fallbackAccount` — чем назвать счёт, если в файле нет колонки карты или
 * счёта. Зовущий передаёт имя файла: банки выгружают его одинаково от раза к
 * разу, поэтому как устойчивый ключ оно годится.
 *
 * Асинхронный, потому что распаковку zip делает браузер потоком. Для CSV
 * ожидание пустое — ни одного лишнего кадра.
 */
export async function parseFile(bytes: Uint8Array, fallbackAccount = ''): Promise<ParseResult> {
  if (looksLikeXlsx(bytes)) {
    const rows = await readXlsx(bytes)
    if (rows.length === 0) {
      return {
        ...EMPTY_RESULT,
        error:
          'Это книга Excel, но выписки в ней не нашлось: первый лист пуст или ' +
          'сохранён в формате, который здесь не читается. Выгрузите операции в CSV.',
      }
    }
    return parseRows(rows, fallbackAccount)
  }
  return parseStatement(bytes, fallbackAccount)
}

const EMPTY_RESULT: ParseResult = {
  transactions: [],
  rows: 0,
  skipped: 0,
  converted: 0,
  foreign: 0,
  error: null,
  balance: null,
  accounts: [],
  hasCodes: false,
}

/**
 * Разбор CSV из байтов файла. Сеть не задействована ни в одной строке.
 */
export function parseStatement(bytes: Uint8Array, fallbackAccount = ''): ParseResult {
  const wrongFormat = sniffNotCsv(bytes)
  if (wrongFormat !== null) {
    return {
      transactions: [],
      rows: 0,
      skipped: 0,
      converted: 0,
      foreign: 0,
      error: wrongFormat,
      balance: null,
      accounts: [],
      hasCodes: false,
    }
  }
  return parseStatementText(decodeBytes(bytes), fallbackAccount)
}

export function parseStatementText(text: string, fallbackAccount = ''): ParseResult {
  return parseRows(parseCsv(text), fallbackAccount)
}

/**
 * Разбор уже разложенной таблицы.
 *
 * Отдельно от чтения CSV, потому что таблица приезжает не только из CSV: книга
 * Excel даёт те же строки и те же колонки, и разбирать их вторым кодом значило
 * бы завести второе место, где правила расходятся.
 */
export function parseRows(rows: readonly (readonly string[])[], fallbackAccount = ''): ParseResult {
  const headerAt = findHeader(rows)
  const header = headerAt === -1 ? rows[0] : rows[headerAt]
  const empty: ParseResult = {
    transactions: [],
    rows: 0,
    skipped: 0,
    converted: 0,
    foreign: 0,
    error: null,
    balance: null,
    accounts: [],
    hasCodes: false,
  }
  if (header === undefined) return { ...empty, error: 'Файл пуст.' }

  const columns = mapColumns(header)
  const hasAmount =
    columns.amount !== undefined || columns.credit !== undefined || columns.debit !== undefined
  if (columns.date === undefined || !hasAmount) {
    // Показываем найденные заголовки: если файл всё-таки таблица, но чужая,
    // человек по ним сразу поймёт, что принёс не тот экспорт.
    const found = header
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '')
      .slice(0, 6)
      .join(', ')
    return {
      ...empty,
      error:
        // Формат здесь не называется: parseRows разбирает и CSV, и книгу
        // Excel, а «это CSV» про .xlsx — ошибка, которая называет не то, что
        // человек сделал. Ровно то, против чего написан sniffNotCsv.
        'Таблица прочитана, но колонок с датой и суммой в ней не нашлось. ' +
        (found === '' ? '' : `Первые колонки файла: ${found}. `) +
        'Нужна выгрузка операций из банка: дата, сумма (или приход и расход ' +
        'по отдельности) и описание.',
    }
  }

  const body = rows.slice(headerAt === -1 ? 1 : headerAt + 1)
  const transactions: Tx[] = []
  // Идентификаторы получают ключ выписки, чтобы одинаковые покупки с разных
  // счетов не схлопнулись при склейке. Ключ считается после разбора — из дат
  // и числа строк, — поэтому проставляется вторым проходом.
  const seen = new Map<string, number>()
  const accounts = new Set<string>()
  let skipped = 0
  let converted = 0
  let foreign = 0

  const at = (row: readonly string[], index: number | undefined): string =>
    index === undefined ? '' : (row[index] ?? '')

  for (const row of body) {
    const status = at(row, columns.status).trim().toUpperCase()
    if (DEAD_STATUS.has(status)) {
      skipped += 1
      continue
    }

    const date = parseDate(at(row, columns.date))
    if (date === null) {
      skipped += 1
      continue
    }

    // Сумма приходит либо одной колонкой со знаком, либо двумя — приход и
    // расход раздельно. Во втором случае знак несёт сама колонка, а не число:
    // расход там записан положительным, и без разворота знака траты сложились
    // бы с доходами в одну кучу.
    let foreignCurrency: string | null = null
    let amount: Kopeck | null = parseAmount(at(row, columns.amount))
    if (amount === null && (columns.credit !== undefined || columns.debit !== undefined)) {
      const credit = parseAmount(at(row, columns.credit)) ?? 0
      const debit = parseAmount(at(row, columns.debit)) ?? 0
      const net = credit - Math.abs(debit)
      amount = net === 0 ? null : (net as Kopeck)
    }

    // Операция в валюте: сумма операции — в евро, сумма платежа — в рублях.
    // Считаем в рублях, потому что картина года рублёвая.
    const currency = at(row, columns.currency)
    if (!isRouble(currency)) {
      const payCurrency = at(row, columns.payCurrency)
      const pay = parseAmount(at(row, columns.payAmount))
      if (pay !== null && isRouble(payCurrency)) {
        amount = pay
        converted += 1
      } else {
        foreign += 1
        foreignCurrency = currency.trim().toUpperCase()
      }
    }
    if (amount === null || amount === 0) {
      skipped += 1
      continue
    }

    const description = at(row, columns.description).trim()
    const mccRaw = at(row, columns.mcc).trim()
    const bankRaw = at(row, columns.category).trim()

    // Счёт берётся из строки, если банк выгрузил его колонкой: в одном файле
    // могут лежать операции нескольких карт.
    const rawAccount = at(row, columns.account).trim()
    const account = accountKey(rawAccount === '' ? fallbackAccount : rawAccount)
    accounts.add(account)

    const key = `${account}|${date}|${amount}|${description}`
    const duplicate = seen.get(key) ?? 0
    seen.set(key, duplicate + 1)

    transactions.push({
      id: txId(date, amount, description, duplicate, account),
      account,
      date,
      amount,
      description: description === '' ? 'Без описания' : description,
      mcc: mccRaw === '' || mccRaw === '0' ? null : mccRaw,
      bankCategory: bankRaw === '' ? null : bankRaw,
      currency: foreignCurrency,
    })
  }

  transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  // Остаток берётся из самой поздней строки, где он вообще был: это и есть
  // «на счёте» на конец выписки. Сложением операций его не получить — выписка
  // начинается не с нуля, и сумма выглядела бы балансом, не будучи им.
  let balance: Kopeck | null = null
  if (columns.balance !== undefined) {
    let latest = ''
    for (const row of body) {
      const date = parseDate(at(row, columns.date))
      const value = parseAmount(at(row, columns.balance))
      if (date === null || value === null) continue
      if (date >= latest) {
        latest = date
        balance = value
      }
    }
  }

  return {
    transactions,
    rows: body.length,
    skipped,
    converted,
    foreign,
    error: null,
    balance,
    accounts: [...accounts],
    hasCodes: columns.mcc !== undefined || columns.category !== undefined,
  }
}

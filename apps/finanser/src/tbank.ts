/**
 * Чтение выписки Т-Банка (ТЗ §2 п.1: один банк хорошо, а не пять кое-как).
 *
 * Колонки берутся по имени заголовка, а не по номеру: банк меняет порядок и
 * добавляет столбцы между выгрузками, и позиционный разбор ломается молча —
 * это худший вид поломки, потому что цифры остаются, но не те.
 */
import { parseCsv, decodeBytes, sniffNotCsv } from './csv.js'
import { parseAmount } from './money.js'
import type { Kopeck } from './money.js'
import type { Tx } from './model.js'
import { txId } from './model.js'

/** Как называется колонка в разных выгрузках. Сравнение — по нормализованному имени. */
const COLUMNS = {
  date: ['ДАТА ОПЕРАЦИИ', 'ДАТА ПЛАТЕЖА', 'ДАТА'],
  amount: ['СУММА ОПЕРАЦИИ', 'СУММА ПЛАТЕЖА', 'СУММА', 'СУММА В ВАЛЮТЕ СЧЕТА'],
  currency: ['ВАЛЮТА ОПЕРАЦИИ', 'ВАЛЮТА'],
  payAmount: ['СУММА ПЛАТЕЖА'],
  payCurrency: ['ВАЛЮТА ПЛАТЕЖА'],
  description: ['ОПИСАНИЕ', 'НАЗНАЧЕНИЕ ПЛАТЕЖА', 'КОНТРАГЕНТ', 'МЕСТО СОВЕРШЕНИЯ'],
  status: ['СТАТУС'],
  category: ['КАТЕГОРИЯ'],
  mcc: ['MCC', 'МСС'],
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

/** Индексы колонок по заголовку. Не нашлась — undefined, а не ноль. */
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
  return out
}

/**
 * Дата к ISO. Понимает «31.12.2025 14:23:45», «31.12.2025», «2025-12-31»,
 * «31/12/2025». Возвращает null, если даты нет: строка без даты в картину года
 * не встанет и должна быть пропущена, а не приписана к сегодняшнему дню.
 */
export function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (s === '') return null

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`

  const dmy = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(s)
  if (dmy === null) return null
  const day = (dmy[1] ?? '').padStart(2, '0')
  const month = (dmy[2] ?? '').padStart(2, '0')
  const rawYear = dmy[3] ?? ''
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null
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
  /** Заголовок не опознан — колонок даты или суммы в файле нет. */
  error: string | null
  /**
   * Были ли в файле колонки MCC и «Категория».
   *
   * Т-Банк отдаёт выписку в двух видах. Короткая («Выписки и справки») — пять
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

/** Разбор выписки из байтов файла. Сеть не задействована ни в одной строке. */
export function parseStatement(bytes: Uint8Array): ParseResult {
  const wrongFormat = sniffNotCsv(bytes)
  if (wrongFormat !== null) {
    return {
      transactions: [],
      rows: 0,
      skipped: 0,
      converted: 0,
      error: wrongFormat,
      hasCodes: false,
    }
  }
  return parseStatementText(decodeBytes(bytes))
}

export function parseStatementText(text: string): ParseResult {
  const rows = parseCsv(text)
  const header = rows[0]
  const empty: ParseResult = {
    transactions: [],
    rows: 0,
    skipped: 0,
    converted: 0,
    error: null,
    hasCodes: false,
  }
  if (header === undefined) return { ...empty, error: 'Файл пуст.' }

  const columns = mapColumns(header)
  if (columns.date === undefined || columns.amount === undefined) {
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
        'Это CSV, но в нём нет колонок «Дата операции» и «Сумма операции». ' +
        (found === '' ? '' : `Первые колонки файла: ${found}. `) +
        'Финансер читает выгрузку операций из Т-Банка.',
    }
  }

  const body = rows.slice(1)
  const transactions: Tx[] = []
  const seen = new Map<string, number>()
  let skipped = 0
  let converted = 0

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

    // Операция в валюте: сумма операции — в евро, сумма платежа — в рублях.
    // Считаем в рублях, потому что картина года рублёвая.
    let amount: Kopeck | null = parseAmount(at(row, columns.amount))
    const currency = at(row, columns.currency)
    if (!isRouble(currency)) {
      const payCurrency = at(row, columns.payCurrency)
      const pay = parseAmount(at(row, columns.payAmount))
      if (pay !== null && isRouble(payCurrency)) {
        amount = pay
        converted += 1
      }
    }
    if (amount === null || amount === 0) {
      skipped += 1
      continue
    }

    const description = at(row, columns.description).trim()
    const mccRaw = at(row, columns.mcc).trim()
    const bankRaw = at(row, columns.category).trim()

    const key = `${date}|${amount}|${description}`
    const duplicate = seen.get(key) ?? 0
    seen.set(key, duplicate + 1)

    transactions.push({
      id: txId(date, amount, description, duplicate),
      date,
      amount,
      description: description === '' ? 'Без описания' : description,
      mcc: mccRaw === '' || mccRaw === '0' ? null : mccRaw,
      bankCategory: bankRaw === '' ? null : bankRaw,
    })
  }

  transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return {
    transactions,
    rows: body.length,
    skipped,
    converted,
    error: null,
    hasCodes: columns.mcc !== undefined || columns.category !== undefined,
  }
}

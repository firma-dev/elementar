/**
 * Перенос данных наружу и обратно (ТЗ §2 п.6).
 *
 * Выгрузка была с самого начала, чтения не было — и обещание «человек не
 * заперт» выполнялось наполовину. Разметив полторы сотни получателей, человек
 * терял их при смене браузера: правки живут в localStorage этого устройства.
 * Поэтому файл возит не только операции, но и обе таблицы правок, а
 * приложение умеет прочитать собственную выгрузку.
 *
 * Всё делается в памяти вкладки, через blob: — ни одного запроса наружу.
 */
import type { Categorized, Category, Tx } from './model.js'
import { isCategory } from './model.js'
import type { MerchantOverrides, Overrides } from './categorize.js'
import type { SourceInfo } from './store.js'

/** Версия формата. 1 — только операции, 2 — операции и правки. */
const VERSION = 2

export interface ExportShape {
  format: 'elementar.finanser'
  version: number
  source: SourceInfo | null
  /** Суммы в копейках — тот же вид, в котором они считались. */
  units: 'kopeck'
  /** Ручные правки по операции: без них разметка не переживает переезд. */
  overrides: Record<string, string>
  /** Ручные правки по получателю. */
  merchantOverrides: Record<string, string>
  transactions: Array<{
    id: string
    date: string
    amount: number
    description: string
    mcc: string | null
    bankCategory: string | null
    category: string
    source: Categorized['source']
  }>
}

export function buildExport(
  list: readonly Categorized[],
  source: SourceInfo | null,
  overrides: Overrides = {},
  merchantOverrides: MerchantOverrides = {},
): ExportShape {
  return {
    format: 'elementar.finanser',
    version: VERSION,
    source,
    units: 'kopeck',
    overrides: { ...overrides },
    merchantOverrides: { ...merchantOverrides },
    transactions: list.map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      description: tx.description,
      mcc: tx.mcc,
      bankCategory: tx.bankCategory,
      category: tx.category,
      source: tx.source,
    })),
  }
}

/** Что удалось прочитать из своего же файла. */
export interface ImportResult {
  transactions: Tx[]
  overrides: Overrides
  merchantOverrides: MerchantOverrides
  source: SourceInfo | null
  error: string | null
}

const EMPTY: ImportResult = {
  transactions: [],
  overrides: {},
  merchantOverrides: {},
  source: null,
  error: null,
}

/** Похоже ли содержимое на нашу выгрузку. Дешёвая проверка до разбора. */
export function looksLikeExport(text: string): boolean {
  return text.trimStart().startsWith('{') && text.includes('elementar.finanser')
}

function categoryMap(raw: unknown): Record<string, Category> {
  const out: Record<string, Category> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Чужая или испорченная категория молча не принимается: лучше потерять
    // одну правку, чем показать человеку категорию, которой нет в списке.
    if (typeof value === 'string' && isCategory(value)) out[key] = value
  }
  return out
}

/**
 * Чтение своей выгрузки. Файл мог быть отредактирован руками или собран
 * другой версией, поэтому проверяется каждое поле, а не только формат.
 */
export function readExport(text: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ...EMPTY, error: 'Файл повреждён: это не JSON.' }
  }
  if (typeof data !== 'object' || data === null) {
    return { ...EMPTY, error: 'Файл повреждён: внутри не объект.' }
  }
  const shape = data as Partial<ExportShape>
  if (shape.format !== 'elementar.finanser') {
    return { ...EMPTY, error: 'Это JSON, но не выгрузка финансера.' }
  }
  if (!Array.isArray(shape.transactions)) {
    return { ...EMPTY, error: 'В файле нет списка операций.' }
  }

  const transactions: Tx[] = []
  for (const raw of shape.transactions) {
    if (typeof raw !== 'object' || raw === null) continue
    const t = raw as Record<string, unknown>
    if (typeof t['id'] !== 'string') continue
    if (typeof t['date'] !== 'string') continue
    if (typeof t['amount'] !== 'number' || !Number.isFinite(t['amount'])) continue
    transactions.push({
      id: t['id'],
      date: t['date'],
      // Суммы всегда в копейках и целые: дробь здесь означала бы, что файл
      // правили руками, и её лучше отсечь, чем тащить во все расчёты.
      amount: Math.round(t['amount']),
      description: typeof t['description'] === 'string' ? t['description'] : 'Без описания',
      mcc: typeof t['mcc'] === 'string' ? t['mcc'] : null,
      bankCategory: typeof t['bankCategory'] === 'string' ? t['bankCategory'] : null,
    })
  }
  if (transactions.length === 0) {
    return { ...EMPTY, error: 'В файле не нашлось ни одной пригодной операции.' }
  }

  const source = shape.source ?? null
  return {
    transactions,
    overrides: categoryMap(shape.overrides),
    merchantOverrides: categoryMap(shape.merchantOverrides),
    source:
      source === null
        ? null
        : { ...source, name: `${source.name} (из выгрузки)`, rows: transactions.length },
    error: null,
  }
}

/** Сохранение файла. Ссылка живёт ровно до клика и отзывается сразу после. */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

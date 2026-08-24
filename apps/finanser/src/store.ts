/**
 * Состояние финансера. Один сигнал на факт, производные — computed: пересчёт
 * идёт от изменения, а не от рендера.
 *
 * Персистентность (ТЗ §5): выписка и ручные правки лежат в localStorage этого
 * устройства. Выбор сознательный — человек не должен грузить файл заново на
 * каждой вкладке, — и он произносится вслух в интерфейсе: на общем компьютере
 * так делать не стоит, и кнопка «Забыть» стоит рядом с этой фразой.
 */
import { computed, signal } from '@preact/signals'
import type { Category, Categorized, Tx } from './model.js'
import { categorizeAll } from './categorize.js'
import type { MerchantOverrides, Overrides } from './categorize.js'
import { summarize } from './insights.js'
import type { Summary } from './insights.js'

const KEY_TX = 'f.tx.v1'
const KEY_OVERRIDES = 'f.cat.v1'
const KEY_MERCHANTS = 'f.merchant.v1'
const KEY_SOURCE = 'f.src.v1'

/** Что известно о загруженном файле: имя и что с ним случилось при разборе. */
export interface SourceInfo {
  name: string
  rows: number
  skipped: number
  converted: number
  loadedAt: string
  /** Были ли в файле MCC и категория банка. См. `ParseResult.hasCodes`. */
  hasCodes: boolean
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === null || raw === undefined) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // Хранилище переполнено или запрещено (приватное окно Safari) — работаем
    // в памяти вкладки. Молча: терять данные нельзя, а падать здесь не за что.
  }
}

export const transactions = signal<Tx[]>(readJson<Tx[]>(KEY_TX, []))
export const overrides = signal<Overrides>(readJson<Overrides>(KEY_OVERRIDES, {}))

/**
 * Правки по получателю. Отдельно от правок по операции: «Пятёрочка — это
 * продукты» сказано один раз и держится на всех пятидесяти покупках за год,
 * включая те, что приедут со следующей выпиской.
 */
export const merchantOverrides = signal<MerchantOverrides>(
  readJson<MerchantOverrides>(KEY_MERCHANTS, {}),
)
export const source = signal<SourceInfo | null>(readJson<SourceInfo | null>(KEY_SOURCE, null))

/** Сводка считается по нажатию — держим её отдельным сигналом, а не computed. */
export const summary = signal<Summary | null>(null)

/** Операции с категориями. Пересчитывается сама при правке правил или списка. */
export const categorized = computed<Categorized[]>(() =>
  categorizeAll(transactions.value, overrides.value, merchantOverrides.value),
)

export const hasData = computed(() => transactions.value.length > 0)

export function setStatement(list: Tx[], info: SourceInfo): void {
  transactions.value = list
  source.value = info
  summary.value = null
  writeJson(KEY_TX, list)
  writeJson(KEY_SOURCE, info)
}

/** Ручная правка категории. Переживает перезагрузку выписки: ключ — id операции. */
export function setCategory(id: string, category: Category): void {
  const next: Record<string, Category> = { ...overrides.value, [id]: category }
  overrides.value = next
  summary.value = null
  writeJson(KEY_OVERRIDES, next)
}

/** Правка категории у получателя целиком: одна на всю «Пятёрочку» за год. */
export function setMerchantCategory(key: string, category: Category): void {
  const next: Record<string, Category> = { ...merchantOverrides.value, [key]: category }
  merchantOverrides.value = next
  summary.value = null
  writeJson(KEY_MERCHANTS, next)
}

export function clearCategory(id: string): void {
  const next: Record<string, Category> = { ...overrides.value }
  delete next[id]
  overrides.value = next
  summary.value = null
  writeJson(KEY_OVERRIDES, next)
}

/**
 * Посчитать сводку. Явный жест человека, а не фоновая работа (ТЗ §1).
 *
 * Считается по тому разрезу, который человек сейчас видит: если открыт месяц,
 * сводка про месяц. Иначе она отвечала бы на вопрос, которого не задавали.
 */
export function compute(rows?: readonly Categorized[]): void {
  summary.value = summarize(rows ?? categorized.value)
}

/** Забыть всё: и выписку, и правки. Кнопка стоит рядом с честной оговоркой. */
export function forgetEverything(): void {
  transactions.value = []
  overrides.value = {}
  merchantOverrides.value = {}
  source.value = null
  summary.value = null
  try {
    globalThis.localStorage?.removeItem(KEY_TX)
    globalThis.localStorage?.removeItem(KEY_OVERRIDES)
    globalThis.localStorage?.removeItem(KEY_MERCHANTS)
    globalThis.localStorage?.removeItem(KEY_SOURCE)
  } catch {
    // см. writeJson
  }
}

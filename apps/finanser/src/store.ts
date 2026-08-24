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
  /** Валютные операции, посчитанные как рубли. См. `ParseResult.foreign`. */
  foreign: number
  loadedAt: string
  /** Были ли в файле MCC и категория банка. См. `ParseResult.hasCodes`. */
  hasCodes: boolean
  /** Ключ выписки: по нему её операции отличаются от операций других счетов. */
  key: string
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
/**
 * Загруженные выписки. Список, а не одна: у человека дебетовая, кредитная и
 * накопительный, и картина года по одной карте — не картина года.
 */
export const sources = signal<SourceInfo[]>(readJson<SourceInfo[]>(KEY_SOURCE, []))

/** Последняя загруженная — для строки над картиной. */
export const source = computed<SourceInfo | null>(
  () => sources.value[sources.value.length - 1] ?? null,
)

/** Сводка считается по нажатию — держим её отдельным сигналом, а не computed. */
export const summary = signal<Summary | null>(null)

/** Операции с категориями. Пересчитывается сама при правке правил или списка. */
export const categorized = computed<Categorized[]>(() =>
  categorizeAll(transactions.value, overrides.value, merchantOverrides.value),
)

export const hasData = computed(() => transactions.value.length > 0)

/**
 * Добавить выписку к уже загруженным.
 *
 * Именно добавить, а не заменить: раньше вторая выписка стирала первую, и
 * свести два счёта было невозможно. Повторная загрузка того же файла ничего не
 * задваивает — идентификаторы считаны из содержимого (`statementKey`), и
 * совпадающие строки просто перекрываются.
 */
export function addStatement(list: Tx[], info: SourceInfo): void {
  const byId = new Map<string, Tx>()
  for (const tx of transactions.value) byId.set(tx.id, tx)
  for (const tx of list) byId.set(tx.id, tx)
  const merged = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const nextSources = sources.value.filter((s) => s.name !== info.name).concat(info)
  transactions.value = merged
  sources.value = nextSources
  summary.value = null
  writeJson(KEY_TX, merged)
  writeJson(KEY_SOURCE, nextSources)
}

/** Убрать одну выписку из склейки вместе с её операциями. */
export function dropStatement(name: string): void {
  const gone = sources.value.filter((s) => s.name === name)
  if (gone.length === 0) return
  const keys = new Set(gone.map((s) => s.key))
  const left = transactions.value.filter((tx) => !keys.has(tx.id.split(':')[0] ?? ''))
  const nextSources = sources.value.filter((s) => s.name !== name)
  transactions.value = left
  sources.value = nextSources
  summary.value = null
  writeJson(KEY_TX, left)
  writeJson(KEY_SOURCE, nextSources)
}

/**
 * Вернуть всё из своей же выгрузки: операции и обе таблицы правок.
 *
 * Отдельно от `setStatement`, потому что смысл другой: там человек принёс
 * новую выписку, здесь — вернул то, что уже размечал. Правки не дописываются
 * к текущим, а заменяют их целиком: иначе после переезда получился бы
 * невидимый гибрид двух разметок.
 */
export function restoreEverything(
  list: Tx[],
  nextOverrides: Overrides,
  nextMerchants: MerchantOverrides,
  info: SourceInfo | null,
): void {
  transactions.value = list
  overrides.value = { ...nextOverrides }
  merchantOverrides.value = { ...nextMerchants }
  sources.value = info === null ? [] : [info]
  summary.value = null
  writeJson(KEY_TX, list)
  writeJson(KEY_OVERRIDES, nextOverrides)
  writeJson(KEY_MERCHANTS, nextMerchants)
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

/** Снять правку с получателя: он снова попадёт под словарь. */
export function clearMerchantCategory(key: string): void {
  const next: Record<string, Category> = { ...merchantOverrides.value }
  delete next[key]
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
  sources.value = []
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

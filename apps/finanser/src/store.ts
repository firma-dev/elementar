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
import { PARENT, currentName } from './model.js'
import { cleanParts, expandCash } from './cash.js'
import { markPairs } from './pairs.js'
import { applyRates } from './rates.js'
import type { Rates } from './rates.js'
import type { CashPart, CashSplits } from './cash.js'
import { categorizeAll } from './categorize.js'
import type { MerchantOverrides, Overrides } from './categorize.js'
import { summarize } from './insights.js'
import type { Summary } from './insights.js'
import { EMPTY_PLAN } from './plan.js'
import type { Plan } from './plan.js'
import type { Kopeck } from './money.js'

const KEY_TX = 'f.tx.v1'
const KEY_OVERRIDES = 'f.cat.v1'
const KEY_MERCHANTS = 'f.merchant.v1'
const KEY_SOURCE = 'f.src.v1'
const KEY_ACCOUNTS = 'f.acc.v1'
const KEY_PLAN = 'f.plan.v1'
const KEY_EXTRAS = 'f.extra.v1'
const KEY_CASH = 'f.cash.v1'
const KEY_RATES = 'f.rate.v1'

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
  /** Остаток по счёту на конец выписки, если банк его отдал. */
  balance?: Kopeck | null
  /** Ключи счетов, встреченные в файле. */
  accounts?: string[]
}

/**
 * Счёт.
 *
 * Один счёт — одна карта или один вклад, а не один файл: в одном файле их
 * может быть несколько, и одну карту выгружают много раз. Имя и банк человек
 * правит сам — угадать их по номеру карты нельзя, а показывать восьмизначный
 * ключ вместо имени незачем.
 *
 * Цвет не выбирается, а раздаётся по порядку: выбор цвета — это работа, за
 * которую человек ничего не получает, а различать счета взглядом надо.
 */
export interface Account {
  key: string
  name: string
  bank: string
  /** Номер цвета в наборе корпуса, 0…5. */
  tone: number
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === null || raw === undefined) return fallback
    const parsed = JSON.parse(raw) as unknown
    // `JSON.parse('null')` — это null, а не отсутствие значения: без этой
    // проверки хранимый null проезжает мимо fallback и падает на первом же
    // обращении к полю.
    if (parsed === null || parsed === undefined) return fallback
    // Форма важнее содержимого: массив, прочитанный как объект, роняет весь
    // рендер на `.filter`, и починить это из интерфейса уже нельзя — экран
    // белый вместе с кнопкой «забыть всё». Чужую форму отбрасываем к fallback.
    if (Array.isArray(fallback) !== Array.isArray(parsed)) return fallback
    return parsed as T
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
/**
 * Правки по операции. Имена категорий прогоняются через `currentName`: правка,
 * сделанная до переразбивки категорий, должна найти свою, а не превратиться в
 * «Прочее». Переименование редко, но потерянная правка — это работа человека,
 * выброшенная молча.
 */
export const overrides = signal<Overrides>(renameAll(readJson<Overrides>(KEY_OVERRIDES, {})))

function renameAll(table: Readonly<Record<string, string>>): Record<string, Category> {
  const out: Record<string, Category> = {}
  for (const [key, value] of Object.entries(table)) out[key] = currentName(value)
  return out
}

/**
 * Правки по получателю. Отдельно от правок по операции: «Пятёрочка — это
 * продукты» сказано один раз и держится на всех пятидесяти покупках за год,
 * включая те, что приедут со следующей выпиской.
 */
export const merchantOverrides = signal<MerchantOverrides>(
  renameAll(readJson<MerchantOverrides>(KEY_MERCHANTS, {})),
)
/**
 * Загруженные выписки. Список, а не одна: у человека дебетовая, кредитная и
 * накопительный, и картина года по одной карте — не картина года.
 */
export const sources = signal<SourceInfo[]>(readJson<SourceInfo[]>(KEY_SOURCE, []))

/**
 * Счета. Заводятся сами при загрузке выписки, правятся человеком.
 */
export const accounts = signal<Account[]>(readJson<Account[]>(KEY_ACCOUNTS, []))

/**
 * Какой счёт сейчас смотрим. `null` — все сразу: это и есть ответ по умолчанию,
 * потому что вопрос «сколько я трачу» задают про все деньги, а не про карту.
 */
export const activeAccount = signal<string | null>(null)

/** План: три введённых числа плюс копилка. Пустой, пока человек его не завёл. */
export const plan = signal<Plan>(readJson<Plan>(KEY_PLAN, EMPTY_PLAN))

/**
 * Включённые дополнительные категории.
 *
 * Пусто по умолчанию: девяти основных хватает, чтобы увидеть картину, а
 * различия сверх них человек добавляет сам, когда они ему понадобились.
 */
export const extras = signal<string[]>(readJson<string[]>(KEY_EXTRAS, []))

/**
 * Разложенные снятия наличных: что человек рассказал про купюры.
 *
 * Хранится отдельно от операций и их не меняет: выписка остаётся тем, что
 * сказал банк, а разбивка — тем, что сказал человек, и она наложена поверх.
 */
export const cashSplits = signal<CashSplits>(readJson<CashSplits>(KEY_CASH, {}))

/** Записать разбивку снятия. Пустая — снять разбивку совсем. */
export function setCashSplit(id: string, parts: readonly CashPart[]): void {
  const clean = cleanParts(parts)
  const next: Record<string, readonly CashPart[]> = { ...cashSplits.value }
  if (clean.length === 0) delete next[id]
  else next[id] = clean
  cashSplits.value = next
  summary.value = null
  writeJson(KEY_CASH, next)
}

/**
 * Курсы валют, названные человеком. Сами они не выясняются: любой источник
 * курса — внешний запрос, а корпус герметичен (ТЗ §1).
 */
export const rates = signal<Rates>(readJson<Rates>(KEY_RATES, {}))

/** Назвать курс валюты. Ноль или пусто — снять курс. */
export function setRate(code: string, kopecksPerUnit: number): void {
  const next: Record<string, number> = { ...rates.value }
  if (kopecksPerUnit > 0) next[code] = kopecksPerUnit
  else delete next[code]
  rates.value = next
  summary.value = null
  writeJson(KEY_RATES, next)
}

/** Включить или выключить дополнительную категорию. */
export function toggleExtra(category: string): void {
  const set = new Set(extras.value)
  if (set.has(category)) set.delete(category)
  else set.add(category)
  const next = [...set]
  extras.value = next
  summary.value = null
  writeJson(KEY_EXTRAS, next)
}

/** Последняя загруженная — для строки над картиной. */
export const source = computed<SourceInfo | null>(
  () => sources.value[sources.value.length - 1] ?? null,
)

/** Сводка считается по нажатию — держим её отдельным сигналом, а не computed. */
export const summary = signal<Summary | null>(null)

/** Операции с категориями. Пересчитывается сама при правке правил или списка. */
export const categorized = computed<Categorized[]>(() =>
  expandCash(
    applyRates(
      markPairs(
        categorizeAll(
          transactions.value,
          overrides.value,
          merchantOverrides.value,
          new Set(extras.value),
        ),
      ),
      rates.value,
    ),
    cashSplits.value,
  ),
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
  registerAccounts(list, info)
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

/**
 * Завести счета, которых ещё нет.
 *
 * Имя по умолчанию — имя файла без расширения: человек его узнаёт, а
 * восьмизначный ключ — нет. Уже заведённый счёт не трогается: у него может
 * быть имя, данное рукой.
 */
function registerAccounts(list: readonly Tx[], info: SourceInfo): void {
  const known = new Set(accounts.value.map((a) => a.key))
  const fresh: Account[] = []
  const fallback = info.name.replace(/\.[a-z0-9]+$/i, '')
  for (const tx of list) {
    if (known.has(tx.account) || fresh.some((a) => a.key === tx.account)) continue
    fresh.push({
      key: tx.account,
      name: fallback === '' ? `Счёт ${known.size + fresh.length + 1}` : fallback,
      bank: '',
      tone: (known.size + fresh.length) % 6,
    })
  }
  if (fresh.length === 0) return
  const next = [...accounts.value, ...fresh]
  accounts.value = next
  writeJson(KEY_ACCOUNTS, next)
}

/** Переименовать счёт или назвать его банк. */
export function renameAccount(key: string, name: string, bank: string): void {
  const next = accounts.value.map((a) => (a.key === key ? { ...a, name, bank } : a))
  accounts.value = next
  writeJson(KEY_ACCOUNTS, next)
}

/** Записать план. Три числа и копилка — всё, что человек вводит руками. */
export function setPlan(next: Plan): void {
  plan.value = next
  writeJson(KEY_PLAN, next)
}

/**
 * Убрать счёт вместе со всеми его операциями.
 *
 * Убирается именно счёт, а не выписка. Выписка — это привоз: их бывает
 * двадцать на один счёт, они перекрываются, и «убрать вторую из них» не имеет
 * смысла — операции у них общие. Счёт же существует сам по себе, его и видно
 * в переключателе (Д-026).
 */
export function dropAccount(key: string): void {
  const left = transactions.value.filter((tx) => tx.account !== key)
  const nextAccounts = accounts.value.filter((a) => a.key !== key)
  transactions.value = left
  accounts.value = nextAccounts
  if (activeAccount.value === key) activeAccount.value = null
  summary.value = null
  writeJson(KEY_TX, left)
  writeJson(KEY_ACCOUNTS, nextAccounts)
  // Выписки, от которых не осталось ни одной операции, уходят из списка сами.
  const live = new Set(left.map((tx) => tx.account))
  const nextSources = sources.value.filter((src) => (src.accounts ?? []).some((a) => live.has(a)))
  sources.value = nextSources
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
  if (info !== null) registerAccounts(list, info)
  transactions.value = list
  overrides.value = { ...nextOverrides }
  merchantOverrides.value = { ...nextMerchants }
  const nextSources = info === null ? [] : [info]
  sources.value = nextSources
  summary.value = null
  writeJson(KEY_TX, list)
  writeJson(KEY_OVERRIDES, nextOverrides)
  writeJson(KEY_MERCHANTS, nextMerchants)
  // Массив, а не `info`: остальные записи в этот ключ кладут список, и объект
  // здесь означал бы белый экран при следующем открытии вкладки.
  writeJson(KEY_SOURCE, nextSources)
}

/**
 * Ручная правка категории. Переживает перезагрузку выписки: ключ — id операции.
 *
 * Выбор дополнительной категории её же и включает: человек только что сказал,
 * что различие ему нужно, — спрашивать об этом отдельным шагом незачем.
 */
export function setCategory(id: string, category: Category): void {
  enableIfExtra(category)
  const next: Record<string, Category> = { ...overrides.value, [id]: category }
  overrides.value = next
  summary.value = null
  writeJson(KEY_OVERRIDES, next)
}

/** Правка категории у получателя целиком: одна на всю «Пятёрочку» за год. */
export function setMerchantCategory(key: string, category: Category): void {
  enableIfExtra(category)
  const next: Record<string, Category> = { ...merchantOverrides.value, [key]: category }
  merchantOverrides.value = next
  summary.value = null
  writeJson(KEY_MERCHANTS, next)
}

/** Выбранная рукой дополнительная категория включается сама. */
function enableIfExtra(category: Category): void {
  if (PARENT[category] === undefined) return
  if (extras.value.includes(category)) return
  const next = [...extras.value, category]
  extras.value = next
  writeJson(KEY_EXTRAS, next)
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
  accounts.value = []
  activeAccount.value = null
  plan.value = EMPTY_PLAN
  extras.value = []
  cashSplits.value = {}
  rates.value = {}
  summary.value = null
  try {
    globalThis.localStorage?.removeItem(KEY_TX)
    globalThis.localStorage?.removeItem(KEY_OVERRIDES)
    globalThis.localStorage?.removeItem(KEY_MERCHANTS)
    globalThis.localStorage?.removeItem(KEY_SOURCE)
    globalThis.localStorage?.removeItem(KEY_ACCOUNTS)
    globalThis.localStorage?.removeItem(KEY_PLAN)
    globalThis.localStorage?.removeItem(KEY_EXTRAS)
    globalThis.localStorage?.removeItem(KEY_CASH)
    globalThis.localStorage?.removeItem(KEY_RATES)
  } catch {
    // см. writeJson
  }
}

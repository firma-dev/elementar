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
import { EMPTY_PLAN, normalizePlan } from './plan.js'
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
const KEY_SAVED = 'f.saved.v1'

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
  /** Как счёт назывался в выписке: ключ → «**3523». */
  accountLabels?: Record<string, string>
  /** Чей это банк, по подписи выгрузки. Догадка, не факт. */
  bank?: { name: string; why: string } | null
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

/**
 * Запись не удалась: хранилище переполнено или запрещено (приватное окно
 * Safari, жёсткие настройки приватности). Падать здесь не за что — вкладка
 * продолжает работать на том, что в памяти.
 *
 * Но молчать нельзя. Молчание означало вот что: человек грузит три выписки,
 * размечает полтораста получателей, всё на экране и выглядит сохранённым, —
 * а после закрытия вкладки пусто. Приложение знало об этом в момент отказа и
 * не сказало.
 */
export const storageFailed = signal(false)

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    storageFailed.value = true
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
// Через `normalizePlan`: планы, сохранённые до появления цели, полей `goal` и
// `goalDate` не имеют, и `undefined` в сравнении даёт ложь молча.
export const plan = signal<Plan>(normalizePlan(readJson<Partial<Plan>>(KEY_PLAN, EMPTY_PLAN)))

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

  /**
   * Счета, которые этот же файл заводил раньше, а теперь не заводит.
   *
   * Так бывает, когда меняется сам разбор. Операции по СБП банк отдаёт без
   * номера карты, и раньше они уезжали на отдельный счёт; теперь, если карта в
   * файле одна, они её. Идентификатор считается вместе со счётом — значит у
   * тех же самых строк он стал другим, и при повторной загрузке они легли бы
   * рядом со старыми: те же деньги, посчитанные дважды.
   *
   * Поэтому строки исчезнувших счетов этого файла убираются. Именно этого
   * файла: чужие счета трогать нельзя, там может лежать другая выписка.
   */
  const before = sources.value.find((s) => s.name === info.name)
  const now = new Set(info.accounts ?? [])
  const gone = new Set((before?.accounts ?? []).filter((key) => !now.has(key)))

  const byId = new Map<string, Tx>()
  for (const tx of transactions.value) {
    if (gone.has(tx.account)) continue
    byId.set(tx.id, tx)
  }
  for (const tx of list) byId.set(tx.id, tx)
  const merged = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  // Счёт без единой операции — пустая кнопка в переключателе. Он мог остаться
  // и от исчезнувшего разбора, и от выписки, которую человек забыл.
  const live = new Set(merged.map((tx) => tx.account))
  const keptAccounts = accounts.value.filter((a) => live.has(a.key))
  if (keptAccounts.length !== accounts.value.length) {
    accounts.value = keptAccounts
    writeJson(KEY_ACCOUNTS, keptAccounts)
  }

  const nextSources = sources.value.filter((s) => s.name !== info.name).concat(info)
  transactions.value = merged
  sources.value = nextSources
  summary.value = null
  writeJson(KEY_TX, merged)
  writeJson(KEY_SOURCE, nextSources)
}

/**
 * Когда в последний раз выгружали. ISO-дата, пустая строка — ни разу.
 *
 * Нужна не для статистики, а для одного вопроса: пора ли напомнить. Safari
 * сносит хранилище сайта, на который не заходили неделю, а `localStorage`
 * ничем не защищён — `navigator.storage.persist()` его не спасает. Значит
 * единственная настоящая защита года разметки — файл на устройстве человека,
 * и предложить его сделать должно приложение, а не человек вспомнить.
 */
export const savedAt = signal<string>(readJson<string>(KEY_SAVED, ''))

/** Отметить, что выгрузка сделана. */
export function markSaved(day: string): void {
  savedAt.value = day
  writeJson(KEY_SAVED, day)
}

/**
 * Пора ли предложить выгрузку.
 *
 * Неделя — не круглое число, а срок, за который Safari сносит хранилище
 * неоткрытого сайта. Порог по количеству правок нужен, чтобы не звать
 * человека сохранять пустоту: пока в приложении нечего терять, напоминание —
 * просто шум, который приучают пропускать.
 */
export function backupDue(day: string): boolean {
  if (transactions.value.length === 0) return false
  const last = savedAt.value
  if (last === '') return true
  const diff = new Date(`${day}T00:00:00Z`).getTime() - new Date(`${last}T00:00:00Z`).getTime()
  return diff >= 7 * 86_400_000
}

/**
 * Имя по умолчанию для нового счёта.
 *
 * Порядок: номер карты из самой выписки, потом имя файла, потом «Счёт N».
 *
 * Имя файла было первым и оказалось худшим из трёх. Банки называют выгрузку
 * «account_statement_25.06.26-18.08.26» — в переключателе счетов стояло именно
 * это, и оно не отвечало ни на один вопрос: ни чей счёт, ни какой банк.
 * «Карта ·3523» отвечает на оба сразу, потому что последние цифры человек
 * знает наизусть.
 *
 * Имя файла остаётся запасным, но только человеческое: «Выписка Сбербанк» —
 * да, «export-2026-08-27» — нет. Отличаем по признакам машинного имени:
 * латиница со служебными словами, даты, длинные цепочки цифр.
 */
const MACHINE_NAME = /statement|export|report|extract|operations|history|vypiska|\d{2}[._-]\d{2}/i

export function accountNameFor(info: SourceInfo, key: string, index: number): string {
  const label = info.accountLabels?.[key]?.trim() ?? ''
  if (label !== '') {
    // «**3523» → «Карта ·3523»: звёздочки терминала заменяются точкой, потому
    // что это подпись, а не маска.
    const digits = /(\d{4})\s*$/.exec(label)
    return digits === null ? label : `Карта ·${digits[1]}`
  }
  const file = info.name.replace(/\.[a-z0-9]+$/i, '').trim()
  if (file !== '' && !MACHINE_NAME.test(file)) return file
  return `Счёт ${index}`
}

/**
 * Завести счета, которых ещё нет, и поправить машинные имена у заведённых.
 *
 * Имя, данное рукой, не трогается никогда. Но «account_statement_25.06.26» —
 * не имя, данное рукой: это плохое умолчание, которое приложение выбрало само.
 * Как только в новой выписке находится номер карты, оно заменяется на «Карта
 * ·3523»; человек ничего для этого не делает и ничего не теряет.
 */
function registerAccounts(list: readonly Tx[], info: SourceInfo): void {
  const known = new Set(accounts.value.map((a) => a.key))
  const fresh: Account[] = []
  for (const tx of list) {
    if (known.has(tx.account) || fresh.some((a) => a.key === tx.account)) continue
    fresh.push({
      key: tx.account,
      name: accountNameFor(info, tx.account, known.size + fresh.length + 1),
      // Догадка о банке ставится сразу: спрашивать «чей это банк», когда
      // ответ уже известен из подписи выгрузки, значит перекладывать на
      // человека работу, которую сделала машина. Ошиблись — он переименует;
      // рядом с именем стоит, откуда оно взялось.
      bank: info.bank?.name ?? '',
      tone: (known.size + fresh.length) % 6,
    })
  }

  const upgraded = accounts.value.map((account, index) => {
    const bank = account.bank === '' ? (info.bank?.name ?? '') : account.bank
    if (!MACHINE_NAME.test(account.name)) {
      return bank === account.bank ? account : { ...account, bank }
    }
    const better = accountNameFor(info, account.key, index + 1)
    return better === account.name && bank === account.bank
      ? account
      : { ...account, name: better, bank }
  })
  const changed = upgraded.some(
    (a, i) => a.name !== accounts.value[i]?.name || a.bank !== accounts.value[i]?.bank,
  )
  if (fresh.length === 0 && !changed) return

  const next = [...upgraded, ...fresh]
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
  savedAt.value = ''
  try {
    globalThis.localStorage?.removeItem(KEY_TX)
    globalThis.localStorage?.removeItem(KEY_OVERRIDES)
    globalThis.localStorage?.removeItem(KEY_MERCHANTS)
    globalThis.localStorage?.removeItem(KEY_SOURCE)
    globalThis.localStorage?.removeItem(KEY_ACCOUNTS)
    globalThis.localStorage?.removeItem(KEY_SAVED)
    globalThis.localStorage?.removeItem(KEY_PLAN)
    globalThis.localStorage?.removeItem(KEY_EXTRAS)
    globalThis.localStorage?.removeItem(KEY_CASH)
    globalThis.localStorage?.removeItem(KEY_RATES)
  } catch {
    // см. writeJson
  }
}

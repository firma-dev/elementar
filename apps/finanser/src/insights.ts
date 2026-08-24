/**
 * Счётная сводка (ТЗ §2 п.5). Арифметика на странице: ни модели, ни сети, ни
 * догадок. Каждый вывод либо следует из чисел, либо не произносится — сводка,
 * которая додумывает, хуже пустой.
 */
import type { Kopeck } from './money.js'
import type { Categorized, Category, MonthKey } from './model.js'
import { monthOf, monthLabel } from './model.js'
import { normalize } from './text.js'
import {
  byCategory,
  byMonth,
  byPlane,
  categoryByMonth,
  median,
  period,
  spendOnly,
} from './stats.js'
import type { CategoryTotals, MonthTotals, PlaneTotals } from './stats.js'

export type InsightTone = 'neutral' | 'warn' | 'good'

export interface Insight {
  kind: 'top' | 'month' | 'trend' | 'anomaly'
  title: string
  detail: string
  tone: InsightTone
}

/** Регулярный одинаковый платёж: то, что ТЗ называет подпиской. */
export interface Subscription {
  /** Описание, как оно стоит в выписке. */
  merchant: string
  amount: Kopeck
  count: number
  /** Средний шаг между платежами в днях. */
  everyDays: number
  first: string
  last: string
  /** Дней между последним платежом и концом выписки. */
  silentDays: number
  /** Платежи прекратились: пропущено больше полутора шагов. */
  stopped: boolean
  /** Сколько такой платёж стоит в год при нынешнем шаге. */
  perYear: Kopeck
}

export interface Summary {
  planes: PlaneTotals
  from: string | null
  to: string | null
  months: MonthTotals[]
  categories: CategoryTotals[]
  insights: Insight[]
  subscriptions: Subscription[]
}

const DAY = 86_400_000

function toEpoch(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function daysBetween(a: string, b: string): number {
  return Math.round((toEpoch(b) - toEpoch(a)) / DAY)
}

function lastDayOfMonth(month: MonthKey): number {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  return new Date(Date.UTC(year, index, 0)).getUTCDate()
}

/**
 * Полные месяцы: крайние отбрасываются, если выписка начинается или кончается
 * в середине. Сравнивать половину декабря с целым ноябрём — это выдумать падение
 * расходов там, где просто кончился файл.
 */
export function completeMonths(list: readonly Categorized[]): MonthTotals[] {
  const months = byMonth(list)
  const { from, to } = period(list)
  if (from === null || to === null || months.length === 0) return months

  const out = [...months]
  const firstMonth = out[0]
  if (firstMonth !== undefined && monthOf(from) === firstMonth.month && Number(from.slice(8)) > 3) {
    out.shift()
  }
  const lastMonth = out[out.length - 1]
  if (
    lastMonth !== undefined &&
    monthOf(to) === lastMonth.month &&
    Number(to.slice(8)) < lastDayOfMonth(lastMonth.month) - 3
  ) {
    out.pop()
  }
  return out.length === 0 ? months : out
}

function share(part: Kopeck, whole: Kopeck): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100)
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/** Целые рубли строкой с разрядами — сводка говорит рублями, не копейками. */
function rub(value: Kopeck): string {
  return String(Math.round(Math.abs(value) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/**
 * Сумма словом в связном тексте. Знак `₽` здесь не ставится намеренно: по Д-013
 * рубль рисуется отдельным компонентом, а внутри предложения это была бы строка,
 * которую нечем нарисовать, — значит, в предложении слово, в колонке знак.
 */
function rubs(value: Kopeck): string {
  const n = Math.round(Math.abs(value) / 100)
  return `${rub(value)} ${plural(n, 'рубль', 'рубля', 'рублей')}`
}

function topInsight(categories: readonly CategoryTotals[], spend: Kopeck): Insight | null {
  const first = categories[0]
  if (first === undefined || spend === 0) return null
  const three = categories.slice(0, 3)
  const threeSum = three.reduce((sum, c) => sum + c.spend, 0)
  return {
    kind: 'top',
    title: `Больше всего — «${first.category}»`,
    detail:
      `${rubs(first.spend)}, это ${share(first.spend, spend)}% всех трат. ` +
      `Первые три категории вместе — ${share(threeSum, spend)}%.`,
    tone: 'neutral',
  }
}

function monthInsight(months: readonly MonthTotals[]): Insight | null {
  const spent = months.filter((m) => m.spend > 0)
  if (spent.length < 2) return null
  const sorted = [...spent].sort((a, b) => b.spend - a.spend)
  const most = sorted[0]
  const least = sorted[sorted.length - 1]
  if (most === undefined || least === undefined || most.month === least.month) return null
  return {
    kind: 'month',
    title: `Самый дорогой месяц — ${monthLabel(most.month)}`,
    detail:
      `${rubs(most.spend)}. Самый дешёвый — ${monthLabel(least.month)}, ` +
      `${rubs(least.spend)}. Разница ${Math.round(most.spend / Math.max(least.spend, 1))}×.`,
    tone: 'neutral',
  }
}

/**
 * Динамика категорий: последние три полных месяца против трёх предыдущих.
 * Меньше шести месяцев — сравниваем последний полный месяц с предыдущим.
 * Мелочь отсекается порогом: рост «Цветов» с 200 до 600 ₽ формально втрое,
 * а по существу шум.
 */
function trendInsights(list: readonly Categorized[], months: readonly MonthTotals[]): Insight[] {
  const window = months.length >= 6 ? 3 : 1
  if (months.length < window * 2) return []

  const recent = months.slice(-window).map((m) => m.month)
  const previous = months.slice(-window * 2, -window).map((m) => m.month)
  const perCategory = categoryByMonth(list)

  const sumOver = (map: Map<MonthKey, Kopeck>, keys: readonly MonthKey[]): Kopeck =>
    keys.reduce((sum, key) => sum + (map.get(key) ?? 0), 0)

  const changes: Array<{ category: Category; now: Kopeck; before: Kopeck; delta: Kopeck }> = []
  for (const [category, map] of perCategory) {
    const now = sumOver(map, recent)
    const before = sumOver(map, previous)
    // Порог в 3 000 ₽ за окно: ниже него разговор о процентах бессмысленен.
    if (Math.max(now, before) < 300_000) continue
    changes.push({ category, now, before, delta: now - before })
  }
  if (changes.length === 0) return []

  changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const biggest = changes[0]
  if (biggest === undefined || biggest.delta === 0) return []

  const label =
    window === 3
      ? 'за последние три месяца против трёх предыдущих'
      : `в ${monthLabel(recent[0] ?? '')} против ${monthLabel(previous[0] ?? '')}`
  const grew = biggest.delta > 0
  const times = biggest.before === 0 ? null : Math.round((biggest.now / biggest.before) * 10) / 10

  return [
    {
      kind: 'trend',
      title: `«${biggest.category}»: ${grew ? 'рост' : 'спад'} на ${rubs(biggest.delta)}`,
      detail:
        `${rub(biggest.before)} → ${rubs(biggest.now)} ${label}` +
        (times === null ? '.' : ` (${String(times).replace('.', ',')}×).`),
      tone: grew ? 'warn' : 'good',
    },
  ]
}

/**
 * Аномалия месяца: расход вдвое выше медианы остальных месяцев. Медиана, а не
 * среднее — среднее само уезжает за тем выбросом, который мы ищем.
 */
function anomalyInsights(months: readonly MonthTotals[]): Insight[] {
  const spent = months.filter((m) => m.spend > 0)
  if (spent.length < 4) return []
  const out: Insight[] = []
  for (const month of spent) {
    const others = spent.filter((m) => m.month !== month.month).map((m) => m.spend)
    const base = median(others)
    if (base === 0 || month.spend < base * 2) continue
    out.push({
      kind: 'anomaly',
      title: `${monthLabel(month.month)} выбивается из ряда`,
      detail:
        `${rubs(month.spend)} против обычных ${rub(base)} — ` +
        `в ${String(Math.round((month.spend / base) * 10) / 10).replace('.', ',')} раза больше.`,
      tone: 'warn',
    })
  }
  return out.slice(0, 2)
}

/** Известные шаги регулярных платежей: неделя, месяц, квартал, полгода, год. */
const CADENCES: ReadonlyArray<{ days: number; slack: number; name: string }> = [
  { days: 7, slack: 2, name: 'каждую неделю' },
  { days: 30, slack: 5, name: 'каждый месяц' },
  { days: 91, slack: 10, name: 'раз в квартал' },
  { days: 182, slack: 16, name: 'раз в полгода' },
  { days: 365, slack: 20, name: 'раз в год' },
]

function cadenceOf(days: number): { days: number; name: string } | null {
  for (const c of CADENCES) {
    if (Math.abs(days - c.days) <= c.slack) return { days: c.days, name: c.name }
  }
  return null
}

/**
 * Регулярные одинаковые платежи. Признак — тот же получатель, та же сумма до
 * копейки и ровный шаг: три и более раза подряд. Отсюда же и «забытая подписка»:
 * платежи шли ровно и перестали — но это вывод из выписки, а не из того, чем
 * человек пользуется, и в интерфейсе он произносится именно так.
 */
export function subscriptions(list: readonly Categorized[]): Subscription[] {
  const { to } = period(list)
  if (to === null) return []

  const groups = new Map<string, Categorized[]>()
  // Только траты: ежемесячный перевод человеку — это движение денег, а не
  // подписка, и в списке «что у вас списывается» ему не место.
  for (const tx of spendOnly(list)) {
    const key = `${normalize(tx.description).trim()}|${tx.amount}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [tx])
    else bucket.push(tx)
  }

  const out: Subscription[] = []
  for (const bucket of groups.values()) {
    if (bucket.length < 3) continue
    const sorted = [...bucket].sort((a, b) => (a.date < b.date ? -1 : 1))
    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]
      const current = sorted[i]
      if (previous === undefined || current === undefined) continue
      gaps.push(daysBetween(previous.date, current.date))
    }
    const step = median(gaps)
    const cadence = cadenceOf(step)
    if (cadence === null) continue
    // Шаг должен быть ровным, а не «в среднем ровным»: пара платежей в один день
    // и один через год дают ту же медиану, что и честная подписка.
    const ragged = gaps.some((g) => Math.abs(g - step) > Math.max(5, step * 0.35))
    if (ragged) continue

    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (first === undefined || last === undefined) continue
    const silentDays = daysBetween(last.date, to)

    out.push({
      merchant: last.description,
      amount: last.amount,
      count: sorted.length,
      everyDays: step,
      first: first.date,
      last: last.date,
      silentDays,
      stopped: silentDays > step * 1.6,
      perYear: Math.round((Math.abs(last.amount) * 365) / Math.max(step, 1)),
    })
  }

  return out.sort((a, b) => b.perYear - a.perYear)
}

/** Полная сводка. Считается по нажатию, а не в фоне (ТЗ §1). */
export function summarize(list: readonly Categorized[]): Summary {
  const planes = byPlane(list)
  const { from, to } = period(list)
  const months = byMonth(list)
  const complete = completeMonths(list)
  const categories = byCategory(list)

  const insights: Insight[] = []
  const top = topInsight(categories, planes.spend.total)
  if (top !== null) insights.push(top)
  const month = monthInsight(complete)
  if (month !== null) insights.push(month)
  insights.push(...trendInsights(list, complete))
  insights.push(...anomalyInsights(complete))

  return { planes, from, to, months, categories, insights, subscriptions: subscriptions(list) }
}

export { plural }

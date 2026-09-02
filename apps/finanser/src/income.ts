/**
 * Откуда приходят деньги.
 *
 * Траты раскладываются по категориям — на входе категории не годятся: у денег
 * там другая природа. Важно не «на что», а от кого, как часто и сколько обычно.
 * Пять источников по сорок тысяч и один на двести — разные жизни, и годовая
 * сумма поступлений об этом молчит.
 *
 * Регулярность считается, а не спрашивается: если источник приходил почти
 * каждый месяц с тех пор, как появился, — он регулярный, и по нему можно
 * сказать, когда ждать следующего. Если данных мало, так и говорится: судить
 * о регулярности по двум месяцам нельзя.
 */
import type { Categorized } from './model.js'
import type { Kopeck } from './money.js'
import { merchantKey, merchantLabel } from './merchant.js'
import { operationOf } from './operation.js'
import { planeOfTx } from './plane.js'
import { daysInMonth } from './period.js'

/** Как деньги пришли. Не категория — способ. */
export type IncomeKind = 'salary' | 'transfer' | 'refund' | 'reward' | 'interest' | 'other'

export const INCOME_KIND_LABEL: Readonly<Record<IncomeKind, string>> = {
  salary: 'зарплата',
  transfer: 'перевод',
  refund: 'возврат',
  reward: 'кэшбэк и бонусы',
  interest: 'проценты',
  other: 'прочее',
}

export interface IncomeSource {
  key: string
  label: string
  kind: IncomeKind
  total: Kopeck
  count: number
  /** В скольких разных месяцах источник появлялся. */
  months: number
  /** Приходит ли он почти каждый месяц с тех пор, как появился. */
  regular: boolean
  /** Хватает ли данных, чтобы вообще судить о регулярности. */
  judged: boolean
  /** Обычная сумма: медиана, а не среднее — одна премия не должна её сдвигать. */
  typical: Kopeck
  /**
   * Доля платежей, попавших в ±10% от обычной суммы.
   *
   * Отличает подписку от привычки. «Пятёрочка» формально регулярна — она
   * появляется каждый месяц, — но списывается вполне с участием человека и
   * каждый раз на другую сумму. Подписка же всегда на одну и ту же, и именно
   * поэтому её перестают замечать.
   */
  steady: number
  /** Обычное число месяца, когда приходит. Для регулярных. */
  typicalDay: number
  /**
   * Обычный промежуток между приходами, в днях.
   *
   * По нему считается ожидание, а не по числу месяца. Работодатель платит
   * дважды в месяц — десятого и двадцать пятого, — и «обычное число» у такого
   * источника выходит двадцать четвёртым: это середина между двумя настоящими
   * датами, то есть день, когда не приходит ничего. Промежуток же честно
   * говорит «примерно раз в две недели».
   */
  typicalGap: number
  lastDate: string
  /**
   * Операции источника.
   *
   * Нужны, чтобы источник можно было убрать целиком: банк называет переводом
   * от человека и зарплату, и возврат долга, и деньги, переложенные с чужой
   * карты. Отличить их выписка не даёт, а человек — сразу. Без списка
   * идентификаторов убирать было бы нечего.
   */
  ids: readonly string[]
}

const SALARY = /ZARPLATA|ZP |AVANS|OKLAD|SALARY|PREMI|ЗАРПЛАТ|АВАНС|ОКЛАД|ПРЕМИ/
const REFUND = /VOZVRAT|REFUND|ВОЗВРАТ|ОТМЕНА|CANCEL/
const INTEREST = /PROCENT|PERCENT|ПРОЦЕНТ|НАЧИСЛЕНИЕ ПРОЦЕНТ|КАПИТАЛИЗ/

function kindOf(description: string): IncomeKind {
  const upper = description.toUpperCase()
  if (SALARY.test(upper)) return 'salary'
  if (REFUND.test(upper)) return 'refund'
  if (INTEREST.test(upper)) return 'interest'
  const operation = operationOf(description)
  if (operation.kind === 'reward') return 'reward'
  if (operation.kind === 'transfer' || operation.kind === 'topup') return 'transfer'
  return 'other'
}

/** Какая доля сумм лежит в ±10% от медианы. Одна сумма — считаем устойчивой. */
function steadiness(values: readonly number[]): number {
  if (values.length === 0) return 0
  const middle = median(values)
  if (middle === 0) return 0
  const close = values.filter((v) => Math.abs(v - middle) <= middle * 0.1).length
  return close / values.length
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
}

/** Сколько месяцев прошло между двумя датами, считая оба края. */
function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return ((ty ?? 0) - (fy ?? 0)) * 12 + ((tm ?? 0) - (fm ?? 0)) + 1
}

/**
 * Регулярные траты: подписки, аренда, рассрочки.
 *
 * Тот же приём, что и с доходами, — и это не экономия кода, а то же самое
 * знание: если платёж приходил почти каждый месяц с тех пор, как появился, он
 * регулярный. Разница в вопросе. По доходу спрашивают «на что рассчитывать»,
 * по трате — «сколько уходит само, без моего участия каждый месяц» и «нет ли
 * здесь того, о чём я забыл».
 *
 * Разовая крупная покупка сюда не попадает, и это главное: список из ста
 * получателей бесполезен, список из девяти регулярных — это разговор.
 */
export function regularSpends(rows: readonly Categorized[], edge: string): IncomeSource[] {
  const flipped = rows
    .filter((tx) => tx.amount < 0 && planeOfTx(tx.category, tx.amount) === 'spend')
    .map((tx) => ({ ...tx, amount: -tx.amount as Kopeck }))
  return byIncomeSource(flipped, edge).filter(
    (source) =>
      source.regular &&
      // Подписку от привычки отличают две вещи. Первая: сумма одна и та же —
      // «Пятёрочка» появляется каждый месяц, но каждый раз на другую.
      source.steady >= 0.6 &&
      // Вторая: платёж один в месяц, а не тридцать. Тридцать — это магазин, в
      // который человек ходит, а не подписка, о которой он забыл.
      source.count <= source.months * 1.6,
  )
}

/** Сколько уходит регулярно за месяц: сумма обычных сумм. */
export function regularMonthly(list: readonly IncomeSource[]): Kopeck {
  return list.reduce((sum, source) => sum + source.typical, 0) as Kopeck
}

/**
 * Источники дохода за отрезок, самые крупные сверху.
 *
 * `edge` — край данных: по нему считается, сколько месяцев источник мог бы
 * прийти, но не пришёл.
 */
export function byIncomeSource(rows: readonly Categorized[], edge: string): IncomeSource[] {
  const groups = new Map<
    string,
    { label: string; amounts: number[]; dates: string[]; sample: string; ids: string[] }
  >()
  for (const tx of rows) {
    if (tx.amount <= 0) continue
    // Знака суммы мало: приходом считается только то, что и по категории приход.
    // Иначе сюда попадали переводы между своими счетами, возвраты и всё, что
    // человек уже назвал не доходом, — и кнопка «не доход» ничего не меняла:
    // операция получала категорию «Переводы» и оставалась в списке источников.
    if (planeOfTx(tx.category, tx.amount) !== 'income') continue
    const key = merchantKey(tx.description)
    const group = groups.get(key) ?? {
      label: merchantLabel(tx.description),
      amounts: [],
      dates: [],
      sample: tx.description,
      ids: [],
    }
    group.amounts.push(tx.amount)
    group.dates.push(tx.date)
    group.ids.push(tx.id)
    groups.set(key, group)
  }

  const out: IncomeSource[] = []
  for (const [key, group] of groups) {
    const dates = [...group.dates].sort()
    const first = dates[0] ?? edge
    const last = dates[dates.length - 1] ?? edge
    const months = new Set(dates.map((d) => d.slice(0, 7))).size
    // Сколько месяцев источник мог прийти с тех пор, как появился впервые.
    const possible = Math.max(1, monthSpan(first, edge))
    // Судить о регулярности по двум месяцам нельзя: слишком короткая история.
    const judged = possible >= 3
    out.push({
      key,
      label: group.label,
      kind: kindOf(group.sample),
      total: group.amounts.reduce((sum, a) => sum + a, 0) as Kopeck,
      count: group.amounts.length,
      months,
      judged,
      regular: judged && months >= 3 && months / possible >= 0.6,
      typical: median(group.amounts) as Kopeck,
      steady: steadiness(group.amounts),
      typicalDay: median(dates.map((d) => Number(d.slice(8, 10)))),
      typicalGap: median(gaps(dates)),
      ids: group.ids,
      lastDate: last,
    })
  }
  return out.sort((a, b) => b.total - a.total)
}

/** Промежутки между соседними приходами, в днях. */
function gaps(dates: readonly string[]): number[] {
  const out: number[] = []
  for (let i = 1; i < dates.length; i += 1) {
    const a = Date.parse(`${dates[i - 1] ?? ''}T00:00:00Z`)
    const b = Date.parse(`${dates[i] ?? ''}T00:00:00Z`)
    if (Number.isFinite(a) && Number.isFinite(b)) out.push(Math.round((b - a) / 86400000))
  }
  return out.length === 0 ? [30] : out
}

/** Прибавить дни к ISO-дате. */
function plusDays(date: string, days: number): string {
  const stamp = Date.parse(`${date}T00:00:00Z`) + days * 86400000
  return new Date(stamp).toISOString().slice(0, 10)
}

/**
 * Когда ждать следующего прихода.
 *
 * Считается от последнего прихода плюс обычный промежуток, а не по числу
 * месяца. Причина простая: зарплату часто платят дважды в месяц, и «обычное
 * число» такого источника — середина между авансом и расчётом, день, когда не
 * приходит ничего. На настоящей выписке это давало «ждём 24 сентября» при
 * приходах десятого и двадцать пятого, и главное число экрана — сколько можно
 * тратить в день — считалось на двадцать четыре дня вместо девяти.
 *
 * Только по регулярным источникам: у разового «следующего» не бывает, и
 * обещать его — придумывать. Возвращает ближайшую дату от края данных.
 */
export function nextArrival(
  sources: readonly IncomeSource[],
  edge: string,
): { date: string; label: string; amount: Kopeck } | null {
  let best: { date: string; label: string; amount: Kopeck } | null = null
  for (const source of sources) {
    if (!source.regular) continue
    const gap = Math.max(1, Math.round(source.typicalGap))
    let date: string
    if (gap >= 26 && gap <= 32) {
      // Раз в месяц — ждём то же число. Так честнее, чем шагать тридцатью
      // днями: зарплату тридцать первого платят тридцатого сентября, а не
      // первого октября, и в коротком месяце дата поджимается к последнему дню.
      date = expectedAfter(edge, source.typicalDay)
      if (date <= source.lastDate) date = expectedAfter(source.lastDate, source.typicalDay)
    } else {
      // Чаще или реже месяца — шагаем промежутком от последнего прихода, пока
      // не окажемся за краем данных.
      date = plusDays(source.lastDate, gap)
      let шагов = 0
      while (date <= edge && шагов < 60) {
        date = plusDays(date, gap)
        шагов += 1
      }
    }
    if (best === null || date < best.date) {
      best = { date, label: source.label, amount: source.typical }
    }
  }
  return best
}

/** Ближайшее после `after` число месяца `day`. */
function expectedAfter(after: string, day: number): string {
  const year = Number(after.slice(0, 4))
  const month = Number(after.slice(5, 7))
  const inThis = Math.min(day, daysInMonth(`${after.slice(0, 7)}-01`))
  const candidate = `${after.slice(0, 7)}-${String(inThis).padStart(2, '0')}`
  if (candidate > after) return candidate
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const stamp = `${nextYear}-${String(nextMonth).padStart(2, '0')}`
  return `${stamp}-${String(Math.min(day, daysInMonth(`${stamp}-01`))).padStart(2, '0')}`
}

/**
 * Агрегаты картины года. Чистые функции над массивом операций: ничего не кэшируют
 * и ничего не знают об интерфейсе. Все суммы — копейки и хранятся положительными;
 * направление задано планом (`plane.ts`), а не знаком.
 */
import type { Kopeck } from './money.js'
import type { Categorized, Category, MonthKey } from './model.js'
import { monthOf } from './model.js'
import { planeOfTx } from './plane.js'
import type { Plane } from './plane.js'

export interface Totals {
  total: Kopeck
  count: number
}

export interface PlaneTotals {
  spend: Totals
  move: Totals
  income: Totals
}

export interface MonthTotals {
  month: MonthKey
  spend: Kopeck
  move: Kopeck
  income: Kopeck
  count: number
}

export interface CategoryTotals {
  category: Category
  spend: Kopeck
  count: number
}

/** Только траты. Переезды денег и приход в разбивку по категориям не идут. */
export function spendOnly(list: readonly Categorized[]): Categorized[] {
  return list.filter((tx) => planeOfTx(tx.category, tx.amount) === 'spend')
}

/**
 * Итоги по планам. Именно это стоит в шапке: расход — только траты, снятие
 * наличных в них не попадает и годовую сумму не раздувает.
 */
export function byPlane(list: readonly Categorized[]): PlaneTotals {
  const out: PlaneTotals = {
    spend: { total: 0, count: 0 },
    move: { total: 0, count: 0 },
    income: { total: 0, count: 0 },
  }
  for (const tx of list) {
    const row = out[planeOfTx(tx.category, tx.amount)]
    row.total += Math.abs(tx.amount)
    row.count += 1
  }
  return out
}

/** Период данных: первая и последняя дата. Пустой список — обе null. */
export function period(list: readonly Categorized[]): { from: string | null; to: string | null } {
  let from: string | null = null
  let to: string | null = null
  for (const tx of list) {
    if (from === null || tx.date < from) from = tx.date
    if (to === null || tx.date > to) to = tx.date
  }
  return { from, to }
}

/**
 * Помесячно, по возрастанию. Месяцы без операций внутри периода добавляются
 * нулями: провал в графике — это факт, и он должен быть виден как провал,
 * а не как сомкнутый столбик.
 */
export function byMonth(list: readonly Categorized[]): MonthTotals[] {
  const map = new Map<MonthKey, MonthTotals>()
  for (const tx of list) {
    const month = monthOf(tx.date)
    let row = map.get(month)
    if (row === undefined) {
      row = { month, spend: 0, move: 0, income: 0, count: 0 }
      map.set(month, row)
    }
    row[planeOfTx(tx.category, tx.amount)] += Math.abs(tx.amount)
    row.count += 1
  }
  const keys = [...map.keys()].sort()
  const first = keys[0]
  const last = keys[keys.length - 1]
  if (first === undefined || last === undefined) return []

  const out: MonthTotals[] = []
  for (const month of monthRange(first, last)) {
    out.push(map.get(month) ?? { month, spend: 0, move: 0, income: 0, count: 0 })
  }
  return out
}

/** Все месяцы от `from` до `to` включительно. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = []
  let year = Number(from.slice(0, 4))
  let month = Number(from.slice(5, 7))
  const endYear = Number(to.slice(0, 4))
  const endMonth = Number(to.slice(5, 7))
  // Ограничение сверху на случай мусорной даты в выписке: сто лет помесячно —
  // это 1200 итераций, а не бесконечный цикл в главном потоке.
  for (let guard = 0; guard < 1200; guard += 1) {
    out.push(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`)
    if (year > endYear || (year === endYear && month >= endMonth)) break
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

/** По категориям, только траты, по убыванию суммы. */
export function byCategory(list: readonly Categorized[]): CategoryTotals[] {
  const map = new Map<Category, CategoryTotals>()
  for (const tx of spendOnly(list)) {
    let row = map.get(tx.category)
    if (row === undefined) {
      row = { category: tx.category, spend: 0, count: 0 }
      map.set(tx.category, row)
    }
    row.spend -= tx.amount
    row.count += 1
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend)
}

/** Движения денег по видам: из чего сложились `move`, `income`. */
export function byPlaneCategory(list: readonly Categorized[], plane: Plane): CategoryTotals[] {
  const map = new Map<Category, CategoryTotals>()
  for (const tx of list) {
    if (planeOfTx(tx.category, tx.amount) !== plane) continue
    let row = map.get(tx.category)
    if (row === undefined) {
      row = { category: tx.category, spend: 0, count: 0 }
      map.set(tx.category, row)
    }
    row.spend += Math.abs(tx.amount)
    row.count += 1
  }
  return [...map.values()].sort((a, b) => b.spend - a.spend)
}

/** Трата по категории внутри одного месяца. Нужна динамике и аномалиям. */
export function categoryByMonth(
  list: readonly Categorized[],
): Map<Category, Map<MonthKey, Kopeck>> {
  const out = new Map<Category, Map<MonthKey, Kopeck>>()
  for (const tx of spendOnly(list)) {
    let months = out.get(tx.category)
    if (months === undefined) {
      months = new Map<MonthKey, Kopeck>()
      out.set(tx.category, months)
    }
    const month = monthOf(tx.date)
    months.set(month, (months.get(month) ?? 0) - tx.amount)
  }
  return out
}

/** Медиана. Нужна аномалиям: среднее само уезжает за выбросом, который мы ищем. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
}

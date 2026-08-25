/**
 * Копилка: сроки и качество выполнения.
 *
 * Всё здесь считается из двух источников: операции категории «Накопления» дают
 * факт, план даёт норму. Ни одно число не спрашивается второй раз — кроме
 * самой цели и того, сколько уже лежит: накопительный счёт человек обычно не
 * выгружает, и вывести это неоткуда.
 *
 * Функции чистые: массив на вход, числа на выход. Ни хранилища, ни сети.
 */
import type { Categorized } from './model.js'
import type { Kopeck } from './money.js'
import type { Plan } from './plan.js'

/** Сколько отложено за один календарный месяц. */
export interface SavedMonth {
  /** `ГГГГ-ММ`. */
  month: string
  /** Отложено на самом деле. Всегда положительное. */
  saved: Kopeck
  /** Сколько собирались отложить. Ноль — плана на тот момент не было. */
  planned: Kopeck
}

/**
 * Как прошёл месяц.
 *
 * Три исхода, а не два: «пропущено» отделено от «недобрано» намеренно. Месяц,
 * в который не отложено ничего, и месяц, в который отложено чуть меньше
 * нужного, — разные новости, а в одной шкале «выполнено на N%» выглядели бы
 * соседними значениями.
 */
export type MonthVerdict = 'взято' | 'недобрано' | 'пропущено' | 'без плана'

export function verdictOf(row: SavedMonth): MonthVerdict {
  if (row.planned === 0) return 'без плана'
  if (row.saved >= row.planned) return 'взято'
  if (row.saved === 0) return 'пропущено'
  return 'недобрано'
}

/**
 * Отложенное по месяцам, от старых к новым.
 *
 * Месяцы без единой операции «Накоплений» тоже попадают в список нулями: без
 * них пропущенный месяц просто исчезал бы из истории, а именно он и есть
 * главная новость. Ряд идёт сплошняком от первого месяца с данными до края.
 */
export function savedByMonth(
  rows: readonly Categorized[],
  edge: string,
  planned: Kopeck,
): SavedMonth[] {
  const sums = new Map<string, number>()
  let first: string | null = null

  for (const tx of rows) {
    if (tx.category !== 'Накопления' || tx.amount >= 0) continue
    const month = tx.date.slice(0, 7)
    sums.set(month, (sums.get(month) ?? 0) - tx.amount)
    if (first === null || month < first) first = month
  }
  if (first === null) return []

  const out: SavedMonth[] = []
  const last = edge.slice(0, 7)
  let cursor = first
  // Ограничитель: испорченная дата в одной строке иначе растянула бы ряд на
  // столетия. Двадцать лет истории копилки — заведомо больше, чем бывает.
  for (let guard = 0; cursor <= last && guard < 240; guard += 1) {
    out.push({ month: cursor, saved: (sums.get(cursor) ?? 0) as Kopeck, planned })
    cursor = nextMonth(cursor)
  }
  return out
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m === 12
    ? `${year + 1}-01`
    : `${year}-${String(m + 1).padStart(2, '0')}`
}

/**
 * Темп: сколько в среднем откладывается за месяц.
 *
 * Берутся последние шесть месяцев, а не вся история: копилка живёт годами, и
 * то, как откладывали позапрошлой зимой, к сегодняшнему сроку отношения не
 * имеет. Неполный последний месяц включается как есть — он и показывает, как
 * идут дела сейчас.
 */
export function pace(history: readonly SavedMonth[], window = 6): Kopeck {
  if (history.length === 0) return 0 as Kopeck
  const tail = history.slice(-window)
  const sum = tail.reduce((acc, row) => acc + row.saved, 0)
  return Math.round(sum / tail.length) as Kopeck
}

/** Что известно о сроке. */
export interface Forecast {
  /** Сколько осталось до цели. Ноль — цель взята. */
  left: Kopeck
  /** Месяцев при нынешнем темпе. `null` — темп нулевой, срока нет. */
  months: number | null
  /** Месяц, в который цель будет взята, `ГГГГ-ММ`. `null` — то же. */
  month: string | null
}

/**
 * Когда наберётся.
 *
 * При нулевом темпе срока нет — и это честнее, чем «бесконечность» или
 * подставленный план. Человек, который ничего не откладывает, не «дойдёт до
 * цели через 999 месяцев», он до неё не дойдёт.
 */
export function forecast(plan: Plan, rate: Kopeck, from: string): Forecast {
  const left = Math.max(0, plan.goal - plan.saved) as Kopeck
  if (plan.goal <= 0 || left === 0) return { left, months: null, month: null }
  if (rate <= 0) return { left, months: null, month: null }

  const months = Math.ceil(left / rate)
  let cursor = from.slice(0, 7)
  for (let i = 0; i < months; i += 1) cursor = nextMonth(cursor)
  return { left, months, month: cursor }
}

/** Успеваем ли к назначенному сроку. */
export interface Deadline {
  /** Месяцев до назначенного срока от края данных. Отрицательное — срок прошёл. */
  monthsLeft: number
  /** Опоздание в месяцах. Ноль или меньше — успеваем. */
  late: number
  /** Сколько надо откладывать в месяц, чтобы успеть. `null` — срок уже прошёл. */
  needed: Kopeck | null
}

export function deadline(plan: Plan, from: string): Deadline | null {
  if (plan.goalDate === '' || plan.goal <= 0) return null
  const left = Math.max(0, plan.goal - plan.saved)
  const monthsLeft = monthsBetween(from.slice(0, 7), plan.goalDate.slice(0, 7))
  if (left === 0) return { monthsLeft, late: 0, needed: 0 as Kopeck }
  if (monthsLeft <= 0) return { monthsLeft, late: 0, needed: null }
  return {
    monthsLeft,
    late: 0,
    needed: Math.ceil(left / monthsLeft) as Kopeck,
  }
}

/** Разница в месяцах между `ГГГГ-ММ`. Положительная — второй позже первого. */
export function monthsBetween(a: string, b: string): number {
  const ya = Number(a.slice(0, 4))
  const ma = Number(a.slice(5, 7))
  const yb = Number(b.slice(0, 4))
  const mb = Number(b.slice(5, 7))
  return (yb - ya) * 12 + (mb - ma)
}

/** Доля пути до цели, 0…1. Без цели — `null`: пустая шкала врёт. */
export function progress(plan: Plan): number | null {
  if (plan.goal <= 0) return null
  return Math.max(0, Math.min(1, plan.saved / plan.goal))
}

/**
 * Периоды.
 *
 * Шесть отрезков: сегодня, неделя, месяц, три, шесть, год. Период здесь не
 * фильтр, а режим (Д-026): на коротких отрезках человек спрашивает «сколько я
 * уже потратил и сколько осталось», на длинных — «куда всё ушло». Границы
 * поэтому считаются в одном месте и проверяются отдельно от разметки.
 *
 * Отсчёт идёт от края данных, а не от системной даты. Данные приезжают
 * выпиской, а не проводами из банка: выгрузку могли сделать неделю назад, и
 * «сегодня» от системной даты дало бы пустой экран и ноль вместо трат. Край
 * данных при этом называется вслух — см. `daysBehind`.
 *
 * «Неделя» и «месяц» календарные: так о них и думают («на этой неделе»), да и
 * бюджет сбрасывается по месяцам. «3 / 6 / год» — скользящие, потому что
 * календарного трёхмесячья не существует.
 */

/**
 * `all` в ряду кнопок не стоит: шесть отрезков закрывают ежедневные вопросы, а
 * седьмая кнопка на телефоне уже не помещается. Но данные старше года иначе
 * стали бы недоступны молча — а молча спрятать данные хуже, чем показать
 * лишнюю ссылку. Поэтому «всё» появляется отдельной строкой и только тогда,
 * когда операции старше года действительно есть.
 */
export type PeriodKey = 'day' | 'week' | 'month' | 'q' | 'half' | 'year' | 'all'

export interface Period {
  key: PeriodKey
  /** Подпись на кнопке. Короткая: их шесть в ряд на телефоне. */
  label: string
  /** Полное имя для заголовка разреза и для экранного диктора. */
  title: string
  /** Считается ли период календарным — от этого зависит и предел трат. */
  calendar: boolean
}

export const PERIODS: readonly Period[] = [
  { key: 'day', label: 'день', title: 'за день', calendar: true },
  { key: 'week', label: 'неделя', title: 'за неделю', calendar: true },
  { key: 'month', label: 'месяц', title: 'за месяц', calendar: true },
  { key: 'q', label: '3 мес', title: 'за три месяца', calendar: false },
  { key: 'half', label: '6 мес', title: 'за полгода', calendar: false },
  { key: 'year', label: 'год', title: 'за год', calendar: false },
]

/** «Всё» — не кнопка ряда, а выход к данным старше года. */
export const ALL: Period = { key: 'all', label: 'всё', title: 'за всё время', calendar: false }

/** Описание отрезка по ключу. Ключей ровно шесть, поэтому промаха не бывает. */
export function periodOf(key: PeriodKey): Period {
  if (key === 'all') return ALL
  return PERIODS.find((p) => p.key === key) ?? PERIODS[5]!
}

/** Короткие периоды показывают дневной ритм, длинные — картину по месяцам. */
export function isDaily(key: PeriodKey): boolean {
  return key === 'day' || key === 'week' || key === 'month'
}

function utc(date: string): Date {
  return new Date(`${date}T00:00:00Z`)
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Сдвиг на дни. Отдельной функцией, потому что через месяцы это врёт. */
export function shiftDays(date: string, days: number): string {
  const d = utc(date)
  d.setUTCDate(d.getUTCDate() + days)
  return iso(d)
}

/**
 * Понедельник недели, в которую попала дата. Неделя начинается с понедельника,
 * а не с воскресенья: здесь так считают.
 */
export function weekStart(date: string): string {
  const d = utc(date)
  const shift = (d.getUTCDay() + 6) % 7
  return shiftDays(date, -shift)
}

/** Первое число месяца, в который попала дата. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** Сколько дней в месяце этой даты. Нужно, чтобы делить месячный предел. */
export function daysInMonth(date: string): number {
  const d = utc(date)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

/**
 * Границы периода, включительно с обеих сторон.
 *
 * `edge` — край данных: самая поздняя операция, какая есть. Всё считается от
 * него, чтобы «сегодня» показывало последний день, о котором вообще что-то
 * известно, а не пустоту.
 */
export function bounds(key: PeriodKey, edge: string): { from: string; to: string } {
  switch (key) {
    case 'all':
      return { from: '0000-01-01', to: edge }
    case 'day':
      return { from: edge, to: edge }
    case 'week':
      return { from: weekStart(edge), to: edge }
    case 'month':
      return { from: monthStart(edge), to: edge }
    default: {
      const months = key === 'q' ? 3 : key === 'half' ? 6 : 12
      const d = utc(edge)
      d.setUTCMonth(d.getUTCMonth() - months)
      return { from: iso(d), to: edge }
    }
  }
}

/**
 * Какая доля периода прожита. Нужна, чтобы честно сравнивать траты с пределом:
 * «75 928 из 80 000» в начале месяца и в конце — разные новости.
 */
export function elapsed(key: PeriodKey, edge: string): { done: number; total: number } {
  switch (key) {
    case 'all':
      return { done: 1, total: 1 }
    case 'day':
      return { done: 1, total: 1 }
    case 'week': {
      const done = (utc(edge).getUTCDay() + 6) % 7
      return { done: done + 1, total: 7 }
    }
    case 'month':
      return { done: Number(edge.slice(8, 10)), total: daysInMonth(edge) }
    default: {
      const months = key === 'q' ? 3 : key === 'half' ? 6 : 12
      return { done: months, total: months }
    }
  }
}

/**
 * На сколько дней данные отстали от сегодняшнего дня.
 *
 * Ноль — выгрузка свежая, и «за день» это буквально сегодня. Больше нуля —
 * приложение обязано сказать об этом, иначе «за день» врёт: показывает не
 * пустой день, а последний непустой.
 */
export function daysBehind(edge: string, today: string): number {
  const diff = utc(today).getTime() - utc(edge).getTime()
  return Math.max(0, Math.round(diff / 86400000))
}

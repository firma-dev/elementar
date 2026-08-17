import type { LocalDate } from '@elementar/core'
import { localDate } from './schema.js'
import { S } from './strings.js'

export { localDate }

export function parseLocalDate(date: LocalDate): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (m === null) return null
  const [, y, mo, d] = m
  const out = new Date(Number(y), Number(mo) - 1, Number(d))
  return Number.isNaN(out.getTime()) ? null : out
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const base = parseLocalDate(date) ?? new Date()
  base.setDate(base.getDate() + days)
  return localDate(base)
}

export function todayDate(now: number = Date.now()): LocalDate {
  return localDate(new Date(now))
}

export function startOfDayMs(date: LocalDate): number {
  return (parseLocalDate(date) ?? new Date()).getTime()
}

/** 1 = понедельник … 7 = воскресенье. */
export function weekdayOf(date: LocalDate): number {
  const d = parseLocalDate(date)
  if (d === null) return 1
  const js = d.getDay()
  return js === 0 ? 7 : js
}

export function monthKey(date: LocalDate): string {
  return date.slice(0, 7)
}

export function monthTitle(month: string): string {
  const [y, m] = month.split('-')
  const index = Number(m) - 1
  const name = S.calendar.monthsNominative[index] ?? ''
  return `${name} ${y ?? ''}`.trim()
}

/** Все даты месяца 'YYYY-MM' по порядку. */
export function daysOfMonth(month: string): LocalDate[] {
  const [y, m] = month.split('-').map((x) => Number(x))
  if (y === undefined || m === undefined) return []
  const out: LocalDate[] = []
  const cursor = new Date(y, m - 1, 1)
  while (cursor.getMonth() === m - 1) {
    out.push(localDate(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map((x) => Number(x))
  if (y === undefined || m === undefined) return month
  const cursor = new Date(y, m - 1 + delta, 1)
  return monthKey(localDate(cursor))
}

/** Понедельник (или воскресенье) недели, в которую попадает дата. */
export function startOfWeek(date: LocalDate, weekStart: 1 | 7): LocalDate {
  const wd = weekdayOf(date)
  const shift = weekStart === 1 ? wd - 1 : wd % 7
  return addDays(date, -shift)
}

export function formatDay(date: LocalDate): string {
  const d = parseLocalDate(date)
  if (d === null) return date
  return `${d.getDate()} ${S.calendar.months[d.getMonth()] ?? ''}`
}

/** Короткая подпись даты в строке задачи: сегодня / завтра / вчера / 12 сентября. */
export function formatRelativeDay(date: LocalDate, today: LocalDate): string {
  if (date === today) return S.task.today
  if (date === addDays(today, 1)) return S.task.tomorrow
  if (date === addDays(today, -1)) return 'вчера'
  return formatDay(date)
}

const WEEKDAY_WORDS: Record<string, number> = {
  пн: 1,
  понедельник: 1,
  вт: 2,
  вторник: 2,
  ср: 3,
  среда: 3,
  чт: 4,
  четверг: 4,
  пт: 5,
  пятница: 5,
  сб: 6,
  суббота: 6,
  вс: 7,
  воскресенье: 7,
}

export interface ComposerParse {
  title: string
  date: LocalDate | null
  time: string | null
}

/** Ближайший день недели строго после сегодня (или сегодня, если совпало и это будущее). */
function nextWeekday(today: LocalDate, target: number): LocalDate {
  const current = weekdayOf(today)
  const delta = (target - current + 7) % 7
  return addDays(today, delta === 0 ? 7 : delta)
}

/**
 * Композер разбирает префиксы на лету (§12.4): «завтра», «пн», «12.09», «в 9:30».
 * Восклицательный знак ничего не делает — приоритетов в планере нет, и это специально.
 */
export function parseComposer(input: string, today: LocalDate): ComposerParse {
  let rest = input.trim()
  let date: LocalDate | null = null
  let time: string | null = null

  const dateMatch = /(?:^|\s)(\d{1,2})[.](\d{1,2})(?:[.](\d{2,4}))?(?=\s|$)/.exec(rest)
  if (dateMatch !== null) {
    const day = Number(dateMatch[1])
    const month = Number(dateMatch[2])
    const rawYear = dateMatch[3]
    const year =
      rawYear === undefined
        ? Number(today.slice(0, 4))
        : rawYear.length === 2
          ? 2000 + Number(rawYear)
          : Number(rawYear)
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      date = localDate(new Date(year, month - 1, day))
      rest = `${rest.slice(0, dateMatch.index)} ${rest.slice(dateMatch.index + dateMatch[0].length)}`.trim()
    }
  }

  // время разбирается ПОСЛЕ даты: иначе «12.09» съедается как 12:09
  const timeMatch = /(?:^|\s)(?:в\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s|$)/.exec(rest)
  if (timeMatch !== null) {
    const h = (timeMatch[1] ?? '0').padStart(2, '0')
    time = `${h}:${timeMatch[2] ?? '00'}`
    rest = `${rest.slice(0, timeMatch.index)} ${rest.slice(timeMatch.index + timeMatch[0].length)}`.trim()
  }

  if (date === null) {
    const words = rest.split(/\s+/)
    for (let i = 0; i < words.length; i += 1) {
      const w = (words[i] ?? '').toLowerCase().replace(/[,;]$/, '')
      if (w === 'сегодня') date = today
      else if (w === 'завтра') date = addDays(today, 1)
      else if (w === 'послезавтра') date = addDays(today, 2)
      else if (WEEKDAY_WORDS[w] !== undefined) date = nextWeekday(today, WEEKDAY_WORDS[w] ?? 1)
      else continue
      words.splice(i, 1)
      rest = words.join(' ').trim()
      break
    }
  }

  return { title: rest.replace(/\s{2,}/g, ' ').trim(), date, time }
}

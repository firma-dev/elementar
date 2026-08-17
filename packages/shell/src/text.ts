/** Мелкая типографика оболочки: склонения и человеческое время. */

/** «1 задача / 2 задачи / 5 задач». */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(n) % 100
  const tail = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (tail > 1 && tail < 5) return forms[1]
  if (tail === 1) return forms[0]
  return forms[2]
}

export function withCount(n: number, forms: readonly [string, string, string]): string {
  return `${n} ${plural(n, forms)}`
}

export const TASKS = ['задача', 'задачи', 'задач'] as const
export const CHANGES = ['изменение', 'изменения', 'изменений'] as const
export const DEVICES = ['устройство', 'устройства', 'устройств'] as const

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** «только что» / «12 минут назад» / «час назад» / «вчера» / дата. */
export function formatLastSeen(at: number, now: number = Date.now()): string {
  const delta = now - at
  if (delta < 0) return 'только что'
  if (delta < 2 * MINUTE) return 'только что'
  if (delta < HOUR) return `${withCount(Math.floor(delta / MINUTE), ['минуту', 'минуты', 'минут'])} назад`
  if (delta < 2 * HOUR) return 'час назад'
  if (delta < DAY) return `${withCount(Math.floor(delta / HOUR), ['час', 'часа', 'часов'])} назад`
  if (delta < 2 * DAY) return 'вчера'
  if (delta < 7 * DAY) return `${withCount(Math.floor(delta / DAY), ['день', 'дня', 'дней'])} назад`
  return new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

/** Инициал для аватара: одна буква, верхний регистр. */
export function initialOf(name: string): string {
  const trimmed = name.trim()
  return trimmed === '' ? '?' : trimmed.slice(0, 1).toUpperCase()
}

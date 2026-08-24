import { describe, expect, it } from 'vitest'
import {
  bounds,
  daysBehind,
  daysInMonth,
  elapsed,
  isDaily,
  monthStart,
  shiftDays,
  weekStart,
} from '../src/period.js'

/**
 * Границы периодов. Проверяются отдельно от разметки: ошибка здесь не видна
 * глазом — цифра просто оказывается не той, и это худший вид поломки.
 */
describe('границы периода', () => {
  it('день — это один день', () => {
    expect(bounds('day', '2026-08-24')).toEqual({ from: '2026-08-24', to: '2026-08-24' })
  })

  it('неделя начинается с понедельника', () => {
    // 24 августа 2026 — понедельник.
    expect(weekStart('2026-08-24')).toBe('2026-08-24')
    // 23 августа — воскресенье, и оно относится к предыдущей неделе.
    expect(weekStart('2026-08-23')).toBe('2026-08-17')
    expect(bounds('week', '2026-08-26')).toEqual({ from: '2026-08-24', to: '2026-08-26' })
  })

  it('месяц календарный, а не тридцать дней назад', () => {
    expect(monthStart('2026-08-24')).toBe('2026-08-01')
    expect(bounds('month', '2026-08-24')).toEqual({ from: '2026-08-01', to: '2026-08-24' })
  })

  it('три, шесть и год отсчитываются от края данных', () => {
    expect(bounds('q', '2026-08-24').from).toBe('2026-05-24')
    expect(bounds('half', '2026-08-24').from).toBe('2026-02-24')
    expect(bounds('year', '2026-08-24').from).toBe('2025-08-24')
  })

  it('переход через границу года считается верно', () => {
    expect(bounds('q', '2026-01-15').from).toBe('2025-10-15')
    expect(shiftDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(weekStart('2026-01-01')).toBe('2025-12-29')
  })

  it('февраль високосного года — двадцать девять дней', () => {
    expect(daysInMonth('2028-02-10')).toBe(29)
    expect(daysInMonth('2026-02-10')).toBe(28)
    expect(daysInMonth('2026-08-10')).toBe(31)
  })
})

describe('прожитая доля периода', () => {
  it('в середине месяца прожито столько дней, сколько прошло', () => {
    expect(elapsed('month', '2026-08-24')).toEqual({ done: 24, total: 31 })
  })

  it('понедельник — первый день недели из семи', () => {
    expect(elapsed('week', '2026-08-24')).toEqual({ done: 1, total: 7 })
    expect(elapsed('week', '2026-08-30')).toEqual({ done: 7, total: 7 })
  })

  it('длинные периоды прожиты целиком: сравнивать не с чем', () => {
    expect(elapsed('year', '2026-08-24')).toEqual({ done: 12, total: 12 })
  })
})

describe('отставание данных', () => {
  it('свежая выгрузка не отстаёт', () => {
    expect(daysBehind('2026-08-24', '2026-08-24')).toBe(0)
  })

  it('недельная выгрузка отстаёт на неделю', () => {
    expect(daysBehind('2026-08-17', '2026-08-24')).toBe(7)
  })

  it('выгрузка из будущего отставанием не считается', () => {
    // Часовые пояса и переведённые вручную часы: отрицательных дней не бывает.
    expect(daysBehind('2026-08-25', '2026-08-24')).toBe(0)
  })
})

describe('режим периода', () => {
  it('короткие периоды показывают дневной ритм, длинные — картину', () => {
    expect(isDaily('day')).toBe(true)
    expect(isDaily('week')).toBe(true)
    expect(isDaily('month')).toBe(true)
    expect(isDaily('q')).toBe(false)
    expect(isDaily('year')).toBe(false)
  })
})

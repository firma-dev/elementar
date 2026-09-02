import { describe, expect, it } from 'vitest'
import { EMPTY_PLAN, hasPlan, limitFor, living, toGoal } from '../src/plan.js'
import type { Plan } from '../src/plan.js'

const plan: Plan = {
  income: 20000000,
  fixed: 7000000,
  save: 5000000,
  saved: 10103500,
  goal: 0,
  goalDate: '',
  onAccount: 0,
  onAccountAt: '',
}

describe('план', () => {
  it('на жизнь остаётся то, что не обязательное и не в копилку', () => {
    expect(living(plan)).toBe(8000000)
  })

  it('не сходящийся план показывается не сошедшимся', () => {
    // Подтянуть до нуля значило бы выдать невыполнимый план за выполнимый.
    expect(living({ ...plan, fixed: 18000000 })).toBe(-3000000)
    expect(limitFor('month', '2026-08-24', { ...plan, fixed: 18000000 })).toBeNull()
  })

  it('дневной предел — месячный, делённый на дни этого месяца', () => {
    // 80 000 за август: 80 000 / 31 = 2 581.
    expect(limitFor('day', '2026-08-24', plan)).toBe(258065)
    // В феврале тот же план даёт предел выше — и это правда, а не округление.
    expect(limitFor('day', '2026-02-10', plan)).toBe(285714)
  })

  it('недельный предел — семь дневных', () => {
    expect(limitFor('week', '2026-08-24', plan)).toBe(1806452)
  })

  it('у длинных периодов предела нет', () => {
    // План месячный; за прошедший год он наверняка был другим.
    expect(limitFor('q', '2026-08-24', plan)).toBeNull()
    expect(limitFor('year', '2026-08-24', plan)).toBeNull()
  })

  it('пустой план не даёт пределов', () => {
    expect(hasPlan(EMPTY_PLAN)).toBe(false)
    expect(limitFor('month', '2026-08-24', EMPTY_PLAN)).toBeNull()
  })

  it('до месячной цели считается от отложенного в этом месяце', () => {
    // Копилка в сто тысяч не отменяет того, что в августе отложено 30 000.
    expect(toGoal(plan, 3000000)).toBe(2000000)
    expect(toGoal(plan, 6000000)).toBe(0)
  })
})

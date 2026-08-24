import { describe, expect, it } from 'vitest'
import { cleanParts, expandCash, splitLeft, splitTotal, withdrawals } from '../src/cash.js'
import { categorizeAll } from '../src/categorize.js'
import { byPlane } from '../src/stats.js'
import type { Tx } from '../src/model.js'

const tx = (description: string, amount: number, date = '2026-08-10'): Tx => ({
  id: `${date}|${amount}|${description}`,
  date,
  amount,
  description,
  mcc: null,
  bankCategory: null,
  account: 'default',
})

const list = categorizeAll(
  [tx('Снятие наличных ATM 4417', -800000), tx('PYATEROCHKA', -90000)],
  {},
  {},
)
const cash = withdrawals(list)[0]

describe('наличные', () => {
  it('находит снятия и не путает их с покупками', () => {
    expect(withdrawals(list)).toHaveLength(1)
    expect(cash?.category).toBe('Наличные')
  })

  it('считает, сколько осталось разложить', () => {
    const parts = [
      { category: 'Продукты' as const, amount: 500000 },
      { category: 'Такси' as const, amount: 100000 },
    ]
    expect(splitTotal(parts)).toBe(600000)
    expect(splitLeft(-800000, parts)).toBe(200000)
  })

  it('перебор показывается перебором, а не подрезается до нуля', () => {
    // Человек написал больше, чем снял. Это его ошибка, и увидеть её он
    // должен: молча подрезанная, она осталась бы в картине навсегда.
    expect(splitLeft(-800000, [{ category: 'Продукты' as const, amount: 900000 }])).toBe(-100000)
  })

  it('нулевые доли не хранятся', () => {
    // «0 ₽ на продукты» — не сведение, а мусор, который потом надо объяснять.
    const clean = cleanParts([
      { category: 'Продукты' as const, amount: 0 },
      { category: 'Такси' as const, amount: -30000 },
    ])
    expect(clean).toEqual([{ category: 'Такси', amount: 30000 }])
  })

  it('разложенное становится тратами, а снятие остаётся переездом', () => {
    // Двойного счёта нет ровно потому, что снятие тратой не считается: со
    // счёта деньги ушли (переезд), потом купюры потратили (трата).
    const before = byPlane(list)
    expect(before.spend.total).toBe(90000)
    expect(before.move.total).toBe(800000)

    const after = byPlane(
      expandCash(list, {
        [cash?.id ?? '']: [
          { category: 'Продукты', amount: 500000 },
          { category: 'Кафе и рестораны', amount: 300000 },
        ],
      }),
    )
    expect(after.spend.total).toBe(890000)
    // Снятие как было переездом, так и осталось: выписку мы не переписываем.
    expect(after.move.total).toBe(800000)
  })

  it('доли не считаются снятиями и не предлагаются к разбору повторно', () => {
    const expanded = expandCash(list, {
      [cash?.id ?? '']: [{ category: 'Продукты', amount: 500000 }],
    })
    expect(withdrawals(expanded)).toHaveLength(1)
  })

  it('без разбивок список не меняется вовсе', () => {
    expect(expandCash(list, {})).toBe(list)
  })
})

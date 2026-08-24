import { describe, expect, it } from 'vitest'
import { applyRates, foreignCurrencies, stillForeign } from '../src/rates.js'
import { categorizeAll } from '../src/categorize.js'
import { byPlane } from '../src/stats.js'
import type { Tx } from '../src/model.js'

const tx = (amount: number, description: string, currency: string | null = null): Tx => ({
  id: `${amount}|${description}`,
  date: '2026-08-10',
  amount,
  description,
  mcc: null,
  bankCategory: null,
  currency,
  account: 'a',
})

const list = categorizeAll(
  [tx(-90000, 'PYATEROCHKA'), tx(-5000, 'SUPERMARKET ISTANBUL', 'TRY'), tx(-2000, 'CAFE', 'EUR')],
  {},
  {},
)

describe('курсы валют', () => {
  it('находит валюты, которые банк не пересчитал', () => {
    const found = foreignCurrencies(list)
    expect([...found.keys()].sort()).toEqual(['EUR', 'TRY'])
    expect(found.get('EUR')).toBe(1)
  })

  it('пересчитывает по названному курсу', () => {
    // 20,00 EUR по 95 ₽ = 1 900 ₽.
    const converted = applyRates(list, { EUR: 9500 })
    const cafe = converted.find((t) => t.description.startsWith('CAFE'))
    expect(cafe?.amount).toBe(-190000)
    expect(cafe?.currency).toBeNull()
  })

  it('валюта без курса остаётся как была, и о ней по-прежнему говорят', () => {
    // Пересчитать наполовину и промолчать было бы хуже, чем не пересчитать.
    const converted = applyRates(list, { EUR: 9500 })
    expect(converted.find((t) => t.description.startsWith('SUPERMARKET'))?.amount).toBe(-5000)
    expect(stillForeign(converted, { EUR: 9500 })).toBe(1)
  })

  it('картина трат меняется вместе с курсом', () => {
    // 900 ₽ + 50 «рублей» вместо лир + 20 «рублей» вместо евро.
    expect(byPlane(list).spend.total).toBe(97000)
    // Те же 20 EUR по 95 ₽ — это 1 900 ₽, и картина трат вырастает на 1 880 ₽.
    expect(byPlane(applyRates(list, { EUR: 9500 })).spend.total).toBe(285000)
  })

  it('нулевой и отрицательный курс не применяются', () => {
    expect(applyRates(list, { EUR: 0 })).toEqual(list)
    expect(applyRates(list, { EUR: -100 })).toEqual(list)
  })

  it('без курсов список не меняется вовсе', () => {
    expect(applyRates(list, {})).toBe(list)
  })
})

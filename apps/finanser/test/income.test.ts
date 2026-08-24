import { describe, expect, it } from 'vitest'
import { byIncomeSource, nextArrival } from '../src/income.js'
import { categorizeAll } from '../src/categorize.js'
import type { Categorized, Tx } from '../src/model.js'

const tx = (date: string, amount: number, description: string): Tx => ({
  id: `${date}|${amount}|${description}`,
  date,
  amount,
  description,
  mcc: null,
  bankCategory: null,
  account: 'default',
})

const rows = (list: readonly Tx[]): Categorized[] => categorizeAll(list, {}, {})

describe('источники дохода', () => {
  it('складывает приходы по источнику и ставит крупные сверху', () => {
    const list = rows([
      tx('2026-06-05', 12000000, 'Зарплата ООО РОГА И КОПЫТА'),
      tx('2026-07-05', 12000000, 'Зарплата ООО РОГА И КОПЫТА'),
      tx('2026-07-14', 500000, 'Перевод от Иван И.'),
    ])
    const sources = byIncomeSource(list, '2026-08-24')
    expect(sources).toHaveLength(2)
    expect(sources[0]?.total).toBe(24000000)
    expect(sources[0]?.kind).toBe('salary')
    expect(sources[1]?.total).toBe(500000)
  })

  it('расходы в источники дохода не попадают', () => {
    const sources = byIncomeSource(rows([tx('2026-07-05', -90000, 'PYATEROCHKA')]), '2026-08-24')
    expect(sources).toEqual([])
  })

  it('обычная сумма — медиана: одна премия её не сдвигает', () => {
    const list = rows([
      tx('2026-05-05', 12000000, 'Зарплата РОГА'),
      tx('2026-06-05', 12000000, 'Зарплата РОГА'),
      tx('2026-07-05', 90000000, 'Зарплата РОГА'),
    ])
    expect(byIncomeSource(list, '2026-07-31')[0]?.typical).toBe(12000000)
  })

  it('приходящий каждый месяц считается регулярным', () => {
    const list = rows([
      tx('2026-05-05', 12000000, 'Зарплата РОГА'),
      tx('2026-06-05', 12000000, 'Зарплата РОГА'),
      tx('2026-07-05', 12000000, 'Зарплата РОГА'),
      tx('2026-08-05', 12000000, 'Зарплата РОГА'),
    ])
    const source = byIncomeSource(list, '2026-08-24')[0]
    expect(source?.judged).toBe(true)
    expect(source?.regular).toBe(true)
    expect(source?.months).toBe(4)
  })

  it('пришедший однажды год назад регулярным не считается', () => {
    const list = rows([tx('2025-09-05', 12000000, 'Продажа велосипеда')])
    const source = byIncomeSource(list, '2026-08-24')[0]
    expect(source?.judged).toBe(true)
    expect(source?.regular).toBe(false)
  })

  it('по двум месяцам о регулярности не судят', () => {
    // Слишком короткая история: сказать «регулярный» было бы гаданием.
    const list = rows([
      tx('2026-08-05', 12000000, 'Зарплата РОГА'),
      tx('2026-08-20', 12000000, 'Зарплата РОГА'),
    ])
    const source = byIncomeSource(list, '2026-08-24')[0]
    expect(source?.judged).toBe(false)
    expect(source?.regular).toBe(false)
  })
})

describe('ближайший приход', () => {
  it('ждётся в то же число следующего месяца', () => {
    const list = rows([
      tx('2026-05-05', 12000000, 'Зарплата РОГА'),
      tx('2026-06-05', 12000000, 'Зарплата РОГА'),
      tx('2026-07-05', 12000000, 'Зарплата РОГА'),
      tx('2026-08-05', 12000000, 'Зарплата РОГА'),
    ])
    const next = nextArrival(byIncomeSource(list, '2026-08-24'), '2026-08-24')
    expect(next?.date).toBe('2026-09-05')
    expect(next?.amount).toBe(12000000)
  })

  it('у разовых источников следующего прихода нет', () => {
    // Обещать его значило бы придумывать.
    const list = rows([tx('2026-08-05', 12000000, 'Продажа велосипеда')])
    expect(nextArrival(byIncomeSource(list, '2026-08-24'), '2026-08-24')).toBeNull()
  })

  it('тридцать первое число не сваливается в следующий месяц', () => {
    const list = rows([
      tx('2026-05-31', 12000000, 'Зарплата РОГА'),
      tx('2026-06-30', 12000000, 'Зарплата РОГА'),
      tx('2026-07-31', 12000000, 'Зарплата РОГА'),
      tx('2026-08-31', 12000000, 'Зарплата РОГА'),
    ])
    const next = nextArrival(byIncomeSource(list, '2026-09-10'), '2026-09-10')
    // В сентябре тридцати одного числа нет — ждём тридцатого.
    expect(next?.date).toBe('2026-09-30')
  })
})

import { describe, expect, it } from 'vitest'
import { findPairs, markPairs, pairedIncoming } from '../src/pairs.js'
import { byPlane } from '../src/stats.js'
import { categorizeAll } from '../src/categorize.js'
import type { Tx } from '../src/model.js'

const tx = (date: string, amount: number, description: string, account = 'a'): Tx => ({
  id: `${account}|${date}|${amount}|${description}`,
  date,
  amount,
  description,
  mcc: null,
  bankCategory: null,
  account,
})

const rows = (list: readonly Tx[]) => categorizeAll(list, {}, {})

describe('переводы между своими счетами', () => {
  it('находит две стороны одного перевода', () => {
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод на карту', 'дебетовая'),
      tx('2026-08-10', 1000000, 'Пополнение', 'кредитная'),
    ])
    const pairs = findPairs(list)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.out.account).toBe('дебетовая')
    expect(pairs[0]?.in.account).toBe('кредитная')
  })

  it('терпит день-два разницы: банки проводят стороны не одновременно', () => {
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод', 'дебетовая'),
      tx('2026-08-12', 1000000, 'Пополнение', 'кредитная'),
    ])
    expect(findPairs(list)).toHaveLength(1)
  })

  it('не пара, если разница больше двух дней', () => {
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод', 'дебетовая'),
      tx('2026-08-20', 1000000, 'Пополнение', 'кредитная'),
    ])
    expect(findPairs(list)).toEqual([])
  })

  it('не пара внутри одного счёта', () => {
    // Иначе снятие и внесение той же суммы в тот же день слиплись бы в перевод.
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод', 'одна'),
      tx('2026-08-10', 1000000, 'Пополнение', 'одна'),
    ])
    expect(findPairs(list)).toEqual([])
  })

  it('не пара, если суммы не совпадают в точности', () => {
    // Осторожность дороже полноты: ложная пара уносит из картины настоящий
    // приход и настоящую трату, пропущенная — оставляет строку, которая и так
    // была.
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод', 'дебетовая'),
      tx('2026-08-10', 999900, 'Пополнение', 'кредитная'),
    ])
    expect(findPairs(list)).toEqual([])
  })

  it('траты в пары не собираются, даже совпав по сумме', () => {
    const list = rows([
      tx('2026-08-10', -1000000, 'PYATEROCHKA', 'дебетовая'),
      tx('2026-08-10', 1000000, 'Зарплата', 'кредитная'),
    ])
    expect(findPairs(list)).toEqual([])
  })

  it('каждая операция участвует ровно в одной паре', () => {
    // Два одинаковых перевода в один день — это две пары, а не четыре.
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод', 'дебетовая'),
      tx('2026-08-10', -1000000, 'Внутренний перевод 2', 'дебетовая'),
      tx('2026-08-10', 1000000, 'Пополнение', 'кредитная'),
      tx('2026-08-10', 1000000, 'Пополнение 2', 'кредитная'),
    ])
    const pairs = findPairs(list)
    expect(pairs).toHaveLength(2)
    expect(pairedIncoming(pairs).size).toBe(2)
  })

  it('убирается приходная сторона: у расходной есть имя получателя', () => {
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод на карту', 'дебетовая'),
      tx('2026-08-10', 1000000, 'Пополнение', 'кредитная'),
    ])
    const hidden = pairedIncoming(findPairs(list))
    const shown = list.filter((t) => !hidden.has(t.id))
    expect(shown).toHaveLength(1)
    expect(shown[0]?.description).toBe('Внутренний перевод на карту')
  })
})

describe('приход не удваивается переводом', () => {
  it('приходная сторона перестаёт считаться поступлением', () => {
    // Эта тысяча уже была на другом счёте: считать её приходом значило бы
    // удвоить настоящий доход.
    const list = rows([
      tx('2026-08-05', 12000000, 'Зарплата за месяц', 'дебетовая'),
      tx('2026-08-10', -1000000, 'Внутренний перевод на карту', 'дебетовая'),
      tx('2026-08-10', 1000000, 'Пополнение', 'кредитная'),
    ])
    expect(byPlane(list).income.total).toBe(13000000)
    expect(byPlane(markPairs(list)).income.total).toBe(12000000)
  })

  it('операция не выбрасывается, а переводится в переезд', () => {
    // Выписка должна показывать то, что сказал банк: иначе человек не найдёт
    // операцию, которую видит в приложении банка.
    const list = rows([
      tx('2026-08-10', -1000000, 'Внутренний перевод на карту', 'дебетовая'),
      tx('2026-08-10', 1000000, 'Пополнение', 'кредитная'),
    ])
    const marked = markPairs(list)
    expect(marked).toHaveLength(2)
    expect(marked.find((t) => t.amount > 0)?.category).toBe('Переводы')
  })

  it('без пар список не меняется вовсе', () => {
    const list = rows([tx('2026-08-05', 12000000, 'Зарплата', 'дебетовая')])
    expect(markPairs(list)).toBe(list)
  })
})

/**
 * Находки враждебного ревью 24 августа. Каждый тест закрывает ошибку, которая
 * молча портила деньги или роняла приложение целиком, — поэтому они собраны в
 * одном файле: их легко потерять, разложив по темам.
 */
import { describe, expect, it } from 'vitest'
import { parseAmount } from '../src/money.js'
import { buildExport, readExport } from '../src/export.js'
import { markPairs } from '../src/pairs.js'
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

describe('разбор суммы: длинный дробный хвост', () => {
  it('четыре знака после запятой — это копейки, а не тысячи', () => {
    // Было 1234567800 — ошибка в десять тысяч раз. Валютные и инвестиционные
    // строки банки отдают именно так.
    expect(parseAmount('1 234,5678')).toBe(123457)
  })

  it('три знака остаются группой тысяч', () => {
    expect(parseAmount('1.234')).toBe(123400)
  })

  it('одна и две цифры — копейки, как и раньше', () => {
    expect(parseAmount('1234.5')).toBe(123450)
    expect(parseAmount('0,01')).toBe(1)
  })

  it('округляет до копейки, а не отбрасывает', () => {
    expect(parseAmount('0,455')).toBe(46)
  })

  it('за пределом целочисленной точности отдаёт null, а не приблизительное число', () => {
    expect(parseAmount('999999999999999999,99')).toBeNull()
  })
})

describe('круг «выгрузил — загрузил»', () => {
  const list = [
    tx('2026-03-10', -5000000, 'Внешний перевод по номеру телефона', 'карта-A'),
    tx('2026-03-10', 5000000, 'Пополнение', 'карта-B'),
    tx('2026-03-05', 15000000, 'Зарплата', 'карта-A'),
  ]

  it('счёт переживает выгрузку', () => {
    const back = readExport(JSON.stringify(buildExport(categorizeAll(list, {}, {}), null)))
    expect(back.error).toBeNull()
    expect(back.transactions.map((t) => t.account).sort()).toEqual([
      'карта-A',
      'карта-A',
      'карта-B',
    ])
  })

  it('перевод между своими счетами не превращается в доход после круга', () => {
    // Без счёта пара не находится: findPairs требует разных счетов. Приход
    // вырастал на сумму каждого перевода, и это было незаметно.
    const back = readExport(JSON.stringify(buildExport(categorizeAll(list, {}, {}), null)))
    const after = markPairs(categorizeAll(back.transactions, {}, {}))
    const income = after
      .filter((t) => t.amount > 0 && t.category !== 'Переводы')
      .reduce((sum, t) => sum + t.amount, 0)
    expect(income).toBe(15000000)
  })

  it('валюта переживает выгрузку', () => {
    const withCurrency: Tx[] = [{ ...tx('2026-03-01', -1000, 'Кофе'), currency: 'EUR' }]
    const back = readExport(JSON.stringify(buildExport(categorizeAll(withCurrency, {}, {}), null)))
    expect(back.transactions[0]?.currency).toBe('EUR')
  })
})

describe('пара переводов и рука человека', () => {
  it('не затирает категорию, поставленную вручную', () => {
    const list = [
      tx('2026-03-10', -5000000, 'Внешний перевод по номеру телефона', 'карта-A'),
      tx('2026-03-11', 5000000, 'Пополнение по СБП', 'карта-B'),
    ]
    const incoming = list[1]!
    const marked = markPairs(categorizeAll(list, { [incoming.id]: 'Доход' }, {}))
    const row = marked.find((t) => t.id === incoming.id)
    expect(row?.source).toBe('manual')
    expect(row?.category).toBe('Доход')
  })

  it('без ручной правки по-прежнему помечает пару переводом', () => {
    const list = [
      tx('2026-03-10', -5000000, 'Внешний перевод по номеру телефона', 'карта-A'),
      tx('2026-03-11', 5000000, 'Пополнение по СБП', 'карта-B'),
    ]
    const marked = markPairs(categorizeAll(list, {}, {}))
    expect(marked.find((t) => t.id === list[1]!.id)?.category).toBe('Переводы')
  })
})

describe('дата: числовая из Excel и окно правдоподобия', () => {
  it('число из книги Excel читается как дата', async () => {
    const { parseDate } = await import('../src/statement.js')
    // 45678 — 21 января 2025 года. Именно так дату отдаёт книга, а не строкой.
    expect(parseDate('45678')).toBe('2025-01-21')
    expect(parseDate('45292')).toBe('2024-01-01')
  })

  it('строковые форматы не сломались', async () => {
    const { parseDate } = await import('../src/statement.js')
    expect(parseDate('2025-01-12')).toBe('2025-01-12')
    expect(parseDate('12.01.2025')).toBe('2025-01-12')
    expect(parseDate('12/01/25')).toBe('2025-01-12')
  })

  it('год вне окна не принимается: одна опечатка растягивала график на 1200 столбцов', async () => {
    const { parseDate } = await import('../src/statement.js')
    expect(parseDate('12.01.2125')).toBeNull()
    expect(parseDate('0001-01-01')).toBeNull()
  })

  it('число вне диапазона дат — не дата', async () => {
    const { parseDate } = await import('../src/statement.js')
    expect(parseDate('12')).toBeNull()
    expect(parseDate('999999')).toBeNull()
  })
})

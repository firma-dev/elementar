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

describe('комиссии и плата за обслуживание — это трата', () => {
  it('плата банка попадает в траты, а не в переезды денег', async () => {
    const { categorizeAll } = await import('../src/categorize.js')
    const { byPlane } = await import('../src/stats.js')
    const list = [
      tx('2026-03-01', -19900, 'Плата за обслуживание'),
      tx('2026-03-02', -300000, 'Страхование кредита'),
      tx('2026-03-03', -5000, 'Комиссия за перевод'),
    ]
    const totals = byPlane(categorizeAll(list, {}, {}))
    // byPlane складывает по модулю: 199 + 3000 + 50 рублей.
    expect(totals.spend.total).toBe(324900)
    expect(totals.spend.count).toBe(3)
    expect(totals.move.total).toBe(0)
  })
})

describe('словарь правил ловит слово, а не его середину', () => {
  it('пятибуквенный ключ больше не срабатывает внутри чужого слова', async () => {
    const { byRules } = await import('../src/categorize.js')
    // «ЛЕНТА» внутри «VALENTA», «МЕТРО» внутри «METROPOLIS» — аптека и торговый
    // центр становились продуктами.
    expect(byRules('VALENTA PHARM')).not.toBe('Продукты')
    expect(byRules('METROPOLIS TRC MOSCOW')).not.toBe('Продукты')
  })

  it('само слово по-прежнему ловится, вместе с падежами', async () => {
    const { byRules } = await import('../src/categorize.js')
    expect(byRules('LENTA 1234 MOSCOW')).toBe('Продукты')
    expect(byRules('МЕТРО КЭШ ЭНД КЕРРИ')).toBe('Продукты')
  })
})

describe('наличные: переименованное снятие не удваивает траты', () => {
  it('доли не разворачиваются, если снятие перестало быть наличными', async () => {
    const { expandCash } = await import('../src/cash.js')
    const { categorizeAll } = await import('../src/categorize.js')
    const снятие = tx('2026-03-01', -800000, 'Снятие наличных Т-Банк')
    const splits = { [снятие.id]: [{ category: 'Продукты' as never, amount: 800000 as never }] }

    // Пока это наличные — доля добавляется отдельной строкой.
    const обычно = expandCash(categorizeAll([снятие], {}, {}), splits)
    expect(обычно).toHaveLength(2)

    // Человек назвал само снятие «Продуктами»: теперь оно трата само по себе,
    // и доля к ней добавила бы вторые восемь тысяч.
    const переименовано = expandCash(
      categorizeAll([снятие], { [снятие.id]: 'Продукты' as never }, {}),
      splits,
    )
    expect(переименовано).toHaveLength(1)

    const сумма = переименовано.reduce((s, t) => s + Math.abs(t.amount), 0)
    expect(сумма).toBe(800000)
  })
})

describe('один файл под другим именем — один счёт', () => {
  it('следы повторного скачивания снимаются', async () => {
    const { statementName } = await import('../src/model.js')
    expect(statementName('выписка.csv')).toBe('выписка')
    expect(statementName('выписка (1).csv')).toBe('выписка')
    expect(statementName('выписка (12).xlsx')).toBe('выписка')
    expect(statementName('выписка-1.csv')).toBe('выписка')
    expect(statementName('выписка — копия.csv')).toBe('выписка')
    expect(statementName('statement copy.csv')).toBe('statement')
  })

  it('осмысленные части имени не срезаются', async () => {
    const { statementName } = await import('../src/model.js')
    // Год — не номер повтора.
    expect(statementName('выписка-2024.csv')).toBe('выписка-2024')
    // Разные банки остаются разными счетами.
    expect(statementName('сбер.csv')).not.toBe(statementName('тинькофф.csv'))
    // Имя без расширения не превращается в пустую строку.
    expect(statementName('выписка')).toBe('выписка')
  })

  it('одинаковые операции из двух копий файла дают один счёт', async () => {
    const { statementName, accountKey } = await import('../src/model.js')
    const a = accountKey(statementName('выписка.csv'))
    const b = accountKey(statementName('выписка (1).csv'))
    expect(a).toBe(b)
  })
})

describe('пара переводов видна и расцепляется', () => {
  it('приход, засчитанный переводом, помечен так, что его можно найти', async () => {
    const { markPairs } = await import('../src/pairs.js')
    const { categorizeAll } = await import('../src/categorize.js')
    const list = [
      tx('2026-03-10', -5000000, 'Внешний перевод по номеру телефона', 'карта-A'),
      tx('2026-03-11', 5000000, 'Пополнение по СБП', 'карта-B'),
    ]
    const marked = markPairs(categorizeAll(list, {}, {}))
    // Ровно по этому следу раздел «Движения денег» показывает догадку.
    const guessed = marked.filter(
      (t) => t.amount > 0 && t.category === 'Переводы' && t.source === 'operation',
    )
    expect(guessed).toHaveLength(1)
    expect(guessed[0]?.description).toBe('Пополнение по СБП')
  })

  it('расцепление переживает пересчёт: рука сильнее пары', async () => {
    const { markPairs } = await import('../src/pairs.js')
    const { categorizeAll } = await import('../src/categorize.js')
    const list = [
      tx('2026-03-10', -5000000, 'Внешний перевод по номеру телефона', 'карта-A'),
      tx('2026-03-11', 5000000, 'Пополнение по СБП', 'карта-B'),
    ]
    const incoming = list[1]!
    // «Это не перевод» ставит категорию рукой.
    const marked = markPairs(categorizeAll(list, { [incoming.id]: 'Доход' }, {}))
    const row = marked.find((t) => t.id === incoming.id)
    expect(row?.category).toBe('Доход')
    expect(row?.source).toBe('manual')
  })
})

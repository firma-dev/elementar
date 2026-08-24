import { describe, expect, it } from 'vitest'
import { formatAmount, formatShare, parseAmount } from '../src/money.js'
import { decodeBytes, detectDelimiter, parseCsv } from '../src/csv.js'
import { parseDate, parseStatement, parseStatementText } from '../src/tbank.js'
import { byBank, byRules, categorize, categorizeAll, normalize } from '../src/categorize.js'
import { operationOf } from '../src/operation.js'
import { byMcc } from '../src/mcc.js'
import { byCategory, byMonth, byPlane, median, monthRange, spendOnly } from '../src/stats.js'
import { planeOfTx } from '../src/plane.js'
import { groupByMerchant, merchantKey, merchantLabel } from '../src/merchant.js'
import { completeMonths, subscriptions, summarize } from '../src/insights.js'
import { dayLabel, monthLabel, txId } from '../src/model.js'
import { buildExport } from '../src/export.js'
import type { Tx } from '../src/model.js'

describe('деньги — целые копейки', () => {
  it('читает форматы, которые встречаются в выписках', () => {
    expect(parseAmount('-1 234,50')).toBe(-123450)
    expect(parseAmount('1234.5')).toBe(123450)
    expect(parseAmount('+1 234')).toBe(123400)
    expect(parseAmount('1 234,50 ₽')).toBe(123450)
    expect(parseAmount('(1 234,50)')).toBe(-123450)
    expect(parseAmount('−99,99')).toBe(-9999)
    expect(parseAmount('1.234,50')).toBe(123450)
    expect(parseAmount('0,01')).toBe(1)
  })

  it('не путает разделитель тысяч с дробной частью', () => {
    expect(parseAmount('1.234')).toBe(123400)
    expect(parseAmount('12 345')).toBe(1234500)
  })

  it('возвращает null там, где числа нет', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('—')).toBeNull()
    expect(parseAmount('нет данных')).toBeNull()
  })

  it('складывает без потери копейки', () => {
    // Тот самый случай, ради которого деньги — целые: 0.1 + 0.2 во float.
    let sum = 0
    for (let i = 0; i < 1000; i += 1) sum += parseAmount('0,10') ?? 0
    expect(sum).toBe(10000)
  })

  it('форматирует по-русски и не рвёт число', () => {
    // Разряды разделяет неразрывный пробел: число не должно рваться по строкам.
    expect(formatAmount(-123450)).toBe('\u22121\u00A0234,50')
    expect(formatAmount(123400)).toBe('1\u00A0234')
    expect(formatAmount(123450, { kopecks: 'never' })).toBe('1\u00A0235')
    expect(formatAmount(123450, { abs: true })).toBe('1\u00A0234,50')
    expect(formatAmount(500, { plus: true })).toBe('+5')
    expect(formatShare(2500, 10000)).toBe('25')
    expect(formatShare(120, 10000)).toBe('1,2')
  })
})

describe('CSV', () => {
  it('находит разделитель', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
  })

  it('держит кавычки, удвоенные кавычки и перевод строки внутри поля', () => {
    const rows = parseCsv('"a";"b ""в кавычках""";"c\nпродолжение"\n"1";"2";"3"')
    expect(rows[0]).toEqual(['a', 'b "в кавычках"', 'c\nпродолжение'])
    expect(rows[1]).toEqual(['1', '2', '3'])
  })

  it('переживает CRLF и пустые строки между блоками', () => {
    expect(parseCsv('a;b\r\n\r\n1;2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('снимает BOM и читает UTF-8', () => {
    const bytes = new TextEncoder().encode('﻿Дата;Сумма\n01.01.2026;-100')
    expect(decodeBytes(bytes).startsWith('Дата')).toBe(true)
  })

  it('читает windows-1251, когда UTF-8 не сходится', () => {
    // «Дата;Сумма» в 1251: кириллица А-Я → 0xC0…, а-я → 0xE0…
    const bytes = cp1251('Дата;Сумма\n01.01.2026;-100')
    expect(decodeBytes(bytes).startsWith('Дата;Сумма')).toBe(true)
  })
})

/** Кодирование в windows-1251 для фикстур: хватает кириллицы и ASCII. */
function cp1251(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) out[i] = code
    else if (code === 0x401) out[i] = 0xa8
    else if (code === 0x451) out[i] = 0xb8
    else if (code >= 0x410 && code <= 0x44f) out[i] = code - 0x410 + 0xc0
    else out[i] = 0x3f
  }
  return out
}

const HEADER =
  '"Дата операции";"Дата платежа";"Номер карты";"Статус";"Сумма операции";' +
  '"Валюта операции";"Сумма платежа";"Валюта платежа";"Кэшбэк";"Категория";' +
  '"MCC";"Описание";"Бонусы (включая кэшбэк)"'

function row(
  date: string,
  amount: string,
  category: string,
  description: string,
  status = 'OK',
  currency = 'RUB',
  payAmount = '',
  payCurrency = 'RUB',
): string {
  return [
    `"${date}"`,
    `"${date}"`,
    '"*1234"',
    `"${status}"`,
    `"${amount}"`,
    `"${currency}"`,
    `"${payAmount === '' ? amount : payAmount}"`,
    `"${payCurrency}"`,
    '"0"',
    `"${category}"`,
    '"5411"',
    `"${description}"`,
    '"0"',
  ].join(';')
}

describe('выписка Т-Банка', () => {
  it('читает даты в разных видах', () => {
    expect(parseDate('31.12.2025 14:23:45')).toBe('2025-12-31')
    expect(parseDate('01.02.2026')).toBe('2026-02-01')
    expect(parseDate('2026-02-01')).toBe('2026-02-01')
    expect(parseDate('1/2/26')).toBe('2026-02-01')
    expect(parseDate('')).toBeNull()
    expect(parseDate('не дата')).toBeNull()
  })

  it('разбирает выгрузку и считает пропущенное', () => {
    const csv = [
      HEADER,
      row('05.01.2026 10:00:00', '-1 234,50', 'Супермаркеты', 'PYATEROCHKA 5566'),
      row('06.01.2026 11:00:00', '-300,00', 'Такси', 'YANDEX GO'),
      row('07.01.2026 12:00:00', '-999,00', 'Рестораны', 'FAILED PAYMENT', 'FAILED'),
      row('10.01.2026 09:00:00', '120 000,00', 'Пополнения', 'Зарплата'),
      row('12.01.2026 09:00:00', '-50,00', 'Различные товары', 'OOO ROGA I KOPYTA'),
    ].join('\n')

    const result = parseStatementText(csv)
    expect(result.error).toBeNull()
    expect(result.rows).toBe(5)
    expect(result.skipped).toBe(1)
    expect(result.transactions).toHaveLength(4)

    const [first] = result.transactions
    // Сортировка — от свежего к старому.
    expect(first?.date).toBe('2026-01-12')
    const sums = result.transactions.map((t) => t.amount).sort((a, b) => a - b)
    expect(sums).toEqual([-123450, -30000, -5000, 12000000])
  })

  it('пересчитывает валютную операцию по сумме платежа в рублях', () => {
    const csv = [
      HEADER,
      row(
        '05.01.2026 10:00:00',
        '-25,00',
        'Рестораны',
        'CAFE ROMA',
        'OK',
        'EUR',
        '-2 500,00',
        'RUB',
      ),
    ].join('\n')
    const result = parseStatementText(csv)
    expect(result.converted).toBe(1)
    expect(result.transactions[0]?.amount).toBe(-250000)
  })

  it('читает выгрузку в windows-1251 из байтов файла', () => {
    const csv = [HEADER, row('05.01.2026 10:00:00', '-1 234,50', 'Супермаркеты', 'Пятёрочка')].join(
      '\n',
    )
    const result = parseStatement(cp1251(csv))
    expect(result.error).toBeNull()
    expect(result.transactions[0]?.description).toBe('Пятёрочка')
  })

  it('называет проблему, а не молчит, когда заголовок чужой', () => {
    const result = parseStatementText('Товар;Цена\n1;2')
    expect(result.error).not.toBeNull()
    expect(result.transactions).toHaveLength(0)
    // В тексте ошибки видно, что именно за файл принесли.
    expect(result.error).toContain('Товар')
  })

  it('узнаёт PDF и говорит про него, а не про колонки', () => {
    // «Справка о движении средств» из банка — это PDF, и человек должен
    // прочитать про PDF, а не про ненайденные колонки.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35])
    const result = parseStatement(pdf)
    expect(result.error).toContain('PDF')
    expect(result.error).toContain('CSV')
  })

  it('узнаёт Excel и архив', () => {
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
    expect(parseStatement(xlsx).error).toContain('Excel')
    const xls = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])
    expect(parseStatement(xls).error).toContain('xls')
  })

  it('не принимает двоичный файл за таблицу', () => {
    const bin = new Uint8Array(64)
    bin[0] = 0x89
    bin[3] = 0x00
    expect(parseStatement(bin).error).not.toBeNull()
  })

  it('настоящую выписку по-прежнему читает', () => {
    const csv = [HEADER, row('05.01.2026 10:00:00', '-1 234,50', 'Супермаркеты', 'Пятёрочка')].join(
      '\n',
    )
    expect(parseStatement(cp1251(csv)).error).toBeNull()
  })

  it('не падает на кривом описании и на строке без даты', () => {
    const csv = [
      HEADER,
      row('', '-100,00', '', 'OOO "РОГА" И;КОПЫТА'),
      row('05.01.2026', '-100,00', '', ''),
    ].join('\n')
    const result = parseStatementText(csv)
    expect(result.skipped).toBe(1)
    expect(result.transactions[0]?.description).toBe('Без описания')
  })

  it('различает одинаковые операции одного дня', () => {
    const csv = [
      HEADER,
      row('05.01.2026', '-300,00', 'Такси', 'YANDEX GO'),
      row('05.01.2026', '-300,00', 'Такси', 'YANDEX GO'),
    ].join('\n')
    const ids = parseStatementText(csv).transactions.map((t) => t.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('даёт устойчивый идентификатор', () => {
    expect(txId('2026-01-05', -30000, 'YANDEX GO', 0)).toBe(
      txId('2026-01-05', -30000, 'YANDEX GO', 0),
    )
    expect(txId('2026-01-05', -30000, 'YANDEX GO', 0)).not.toBe(
      txId('2026-01-05', -30001, 'YANDEX GO', 0),
    )
  })
})

describe('категории', () => {
  it('приводит описание к сравнимому виду', () => {
    expect(normalize('OOO "Рогa"')).toContain(' OOO ')
    expect(normalize('Пятёрочка')).toBe(' ПЯТЕРОЧКА ')
  })

  it('узнаёт по словарю и предпочитает длинное слово короткому', () => {
    expect(byRules('PYATEROCHKA 5566 MOSCOW')).toBe('Продукты')
    expect(byRules('YANDEX GO 12.01')).toBe('Такси')
    expect(byRules('ЯНДЕКС ЛАВКА')).toBe('Продукты')
    expect(byRules('МАГНИТ КОСМЕТИК')).toBe('Красота')
    expect(byRules('МАГНИТ У ДОМА')).toBe('Продукты')
  })

  it('не цепляет слово внутри другого слова', () => {
    // «МЕТРО » со значащим пробелом не должно ловить «МЕТРОПОЛИС».
    expect(byRules('TRK METROPOLIS')).not.toBe('Транспорт')
  })

  it('ничего не выдумывает на неизвестном мерчанте', () => {
    expect(byRules('OOO ROGA I KOPYTA')).toBeNull()
  })

  it('переводит категорию банка в свою', () => {
    expect(byBank('Супермаркеты')).toBe('Продукты')
    expect(byBank('Ж/д билеты')).toBe('Транспорт')
    expect(byBank('Другое')).toBeNull()
    expect(byBank(null)).toBeNull()
  })

  it('держит порядок источников: рука → вид операции → словарь → MCC → банк → прочее', () => {
    const base: Tx = {
      id: 'x1',
      date: '2026-01-05',
      amount: -10000,
      description: 'OOO ROGA I KOPYTA',
      mcc: '5411',
      bankCategory: 'Супермаркеты',
    }
    // MCC — свидетельство платёжной сети, оно сильнее столбца банка.
    expect(categorize(base, {})).toMatchObject({ category: 'Продукты', source: 'mcc' })
    expect(categorize({ ...base, mcc: null }, {})).toMatchObject({
      category: 'Продукты',
      source: 'bank',
    })
    expect(categorize({ ...base, mcc: null, bankCategory: null }, {})).toMatchObject({
      category: 'Прочее',
      source: 'fallback',
    })
    expect(categorize({ ...base, description: 'PYATEROCHKA' }, {})).toMatchObject({
      source: 'rule',
    })
    expect(categorize(base, { x1: 'Подарки' })).toMatchObject({
      category: 'Подарки',
      source: 'manual',
    })
  })

  it('не считает доходом возврат со знаком минус', () => {
    const tx: Tx = {
      id: 'r1',
      date: '2026-01-05',
      amount: -10000,
      description: 'ВОЗВРАТ ПОКУПКИ',
      mcc: null,
      bankCategory: null,
    }
    expect(categorize(tx, {}).category).not.toBe('Доход')
    expect(categorize({ ...tx, amount: 10000 }, {}).category).toBe('Доход')
  })

  it('приход без опознанного источника всё равно доход, а не «Прочее»', () => {
    const tx: Tx = {
      id: 'i1',
      date: '2026-01-05',
      amount: 500000,
      description: 'НЕПОНЯТНО ЧТО',
      mcc: null,
      bankCategory: null,
    }
    expect(categorize(tx, {}).category).toBe('Доход')
  })
})

/** Список операций для агрегатов: расход `amount` в копейках со знаком минус. */
function tx(date: string, amount: number, description: string, bank: string | null = null): Tx {
  return {
    id: `${date}-${amount}-${description}`,
    date,
    amount,
    description,
    mcc: null,
    bankCategory: bank,
  }
}

describe('агрегаты', () => {
  it('перечисляет месяцы подряд, включая пустые', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthRange('2026-01', '2026-01')).toEqual(['2026-01'])
  })

  it('не смыкает провал в графике', () => {
    const rows = categorizeAll([tx('2026-01-05', -10000, 'A'), tx('2026-03-05', -20000, 'B')], {})
    const months = byMonth(rows)
    expect(months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(months[1]?.spend).toBe(0)
  })

  it('считает траты, приход и переезды раздельно', () => {
    const rows = categorizeAll(
      [tx('2026-01-05', -10000, 'A'), tx('2026-01-06', 50000, 'Зарплата')],
      {},
    )
    const planes = byPlane(rows)
    expect(planes.spend).toMatchObject({ total: 10000, count: 1 })
    expect(planes.income).toMatchObject({ total: 50000, count: 1 })
    // Приход в разбивку трат не попадает.
    expect(byCategory(rows).some((c) => c.category === 'Доход')).toBe(false)
  })

  it('медиана устойчива к выбросу', () => {
    expect(median([1, 2, 3, 100])).toBe(3)
    expect(median([])).toBe(0)
  })

  it('отбрасывает неполные крайние месяцы', () => {
    const rows = categorizeAll(
      [tx('2026-01-28', -10000, 'A'), tx('2026-02-10', -20000, 'B'), tx('2026-03-05', -30000, 'C')],
      {},
    )
    // Январь начат 28-го, март оборван 5-м — остаётся один полный февраль.
    expect(completeMonths(rows).map((m) => m.month)).toEqual(['2026-02'])
  })
})

describe('подписки', () => {
  const monthly = (day: string, amount: number, name: string): Tx[] =>
    ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01'].map((m) =>
      tx(`${m}-${day}`, amount, name),
    )

  it('находит ровный ежемесячный платёж', () => {
    const rows = categorizeAll(
      [...monthly('15', -19900, 'ЯНДЕКС ПЛЮС'), tx('2026-01-20', -5000, 'КОФЕ')],
      {},
    )
    const found = subscriptions(rows)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ count: 5, stopped: false })
    expect(found[0]?.perYear).toBeGreaterThan(19900 * 11)
  })

  it('называет прекратившийся платёж прекратившимся', () => {
    const rows = categorizeAll(
      [
        ...['2025-01', '2025-02', '2025-03', '2025-04'].map((m) =>
          tx(`${m}-15`, -59900, 'NETFLIX'),
        ),
        tx('2025-12-01', -5000, 'КОФЕ'),
      ],
      {},
    )
    const found = subscriptions(rows)
    expect(found[0]).toMatchObject({ merchant: 'NETFLIX', stopped: true })
    expect(found[0]?.silentDays).toBeGreaterThan(200)
  })

  it('не считает подпиской три случайных платежа', () => {
    const rows = categorizeAll(
      [tx('2026-01-02', -30000, 'X'), tx('2026-01-03', -30000, 'X'), tx('2026-06-01', -30000, 'X')],
      {},
    )
    expect(subscriptions(rows)).toHaveLength(0)
  })

  it('не считает подпиской разные суммы одному получателю', () => {
    const rows = categorizeAll(
      [tx('2025-11-15', -10000, 'X'), tx('2025-12-15', -20000, 'X'), tx('2026-01-15', -30000, 'X')],
      {},
    )
    expect(subscriptions(rows)).toHaveLength(0)
  })
})

describe('сводка', () => {
  it('молчит там, где нечего сказать', () => {
    const empty = summarize([])
    expect(empty.insights).toHaveLength(0)
    expect(empty.subscriptions).toHaveLength(0)
    expect(empty.months).toHaveLength(0)
  })

  it('называет топ-категорию, дорогой месяц и аномалию', () => {
    const rows = categorizeAll(
      [
        ...Array.from({ length: 5 }, (_, i) => tx(`2025-0${i + 3}-10`, -1000000, 'PYATEROCHKA')),
        // Август выбивается: вдесятеро больше медианы.
        tx('2025-08-10', -10000000, 'PYATEROCHKA'),
        tx('2025-09-10', -1000000, 'PYATEROCHKA'),
        tx('2025-09-11', -50000, 'YANDEX GO'),
      ],
      {},
    )
    const s = summarize(rows)
    const kinds = s.insights.map((i) => i.kind)
    expect(kinds).toContain('top')
    expect(kinds).toContain('month')
    expect(kinds).toContain('anomaly')
    expect(s.insights[0]?.title).toContain('Продукты')
  })
})

describe('подписи', () => {
  it('пишет месяц и день по-русски без Intl', () => {
    expect(monthLabel('2026-03')).toBe('март 2026')
    expect(monthLabel('2026-03', true)).toBe('мар 2026')
    expect(dayLabel('2026-03-17')).toBe('17 марта')
  })
})

describe('выгрузка JSON', () => {
  it('отдаёт копейки как есть и называет формат', () => {
    const rows = categorizeAll([tx('2026-01-05', -123450, 'PYATEROCHKA')], {})
    const data = buildExport(rows, {
      name: 'выписка.csv',
      rows: 1,
      skipped: 0,
      converted: 0,
      loadedAt: '2026-01-06',
      hasCodes: true,
    })
    expect(data).toMatchObject({ format: 'elementar.finanser', version: 1, units: 'kopeck' })
    expect(data.transactions[0]).toMatchObject({
      amount: -123450,
      category: 'Продукты',
      source: 'rule',
    })
    // Выгрузка должна пережить обратное чтение без потерь.
    expect(JSON.parse(JSON.stringify(data)).transactions[0].amount).toBe(-123450)
  })
})

describe('планы денег', () => {
  it('переезд сильнее знака суммы', () => {
    expect(planeOfTx('Переводы', -50000)).toBe('move')
    expect(planeOfTx('Наличные', -50000)).toBe('move')
    expect(planeOfTx('Кредиты', -50000)).toBe('move')
    expect(planeOfTx('Продукты', -50000)).toBe('spend')
  })

  it('возврат по трате — приход, а не отрицательная трата', () => {
    expect(planeOfTx('Продукты', 30000)).toBe('income')
  })

  it('снятие наличных не удваивает годовую трату', () => {
    // Снял 50 000 и потратил их же: трата — пятьдесят тысяч, а не сто.
    const rows = categorizeAll(
      [
        tx('2026-01-05', -5000000, 'СНЯТИЕ НАЛИЧНЫХ ATM'),
        tx('2026-01-06', -5000000, 'PYATEROCHKA'),
      ],
      {},
    )
    const planes = byPlane(rows)
    expect(planes.spend.total).toBe(5000000)
    expect(planes.move.total).toBe(5000000)
    expect(spendOnly(rows)).toHaveLength(1)
  })
})

describe('получатели', () => {
  it('выбрасывает форму, город и номер точки', () => {
    expect(merchantKey('OOO ROGA I KOPYTA 1234 MOSCOW RUS')).toBe('ROGA I KOPYTA')
    expect(merchantKey('PYATEROCHKA 5566 MOSCOW RU')).toBe('PYATEROCHKA')
    expect(merchantLabel('PYATEROCHKA 5566 MOSCOW RU')).toBe('Pyaterochka')
  })

  it('склеивает разные точки одной сети в одного получателя', () => {
    expect(merchantKey('PYATEROCHKA 5566 MOSCOW')).toBe(merchantKey('PYATEROCHKA 9012 SPB'))
  })

  it('не схлопывает всё в пустоту, если имя было техническим', () => {
    expect(merchantKey('SBP TERMINAL 1234')).not.toBe('')
  })

  it('собирает одинаковых получателей в одну строку', () => {
    const rows = categorizeAll(
      [
        tx('2026-01-05', -10000, 'OOO ROGA I KOPYTA 1 MOSCOW'),
        tx('2026-01-09', -20000, 'OOO ROGA I KOPYTA 2 SPB'),
        tx('2026-01-11', -70000, 'ДРУГОЙ ПОЛУЧАТЕЛЬ'),
      ],
      {},
    )
    const groups = groupByMerchant(rows)
    // По убыванию суммы: одиночный получатель на 700 рублей идёт первым.
    expect(groups[0]).toMatchObject({ count: 1, total: 70000 })
    const roga = groups.find((g) => g.key.includes('ROGA'))
    expect(roga).toMatchObject({ count: 2, total: 30000 })
  })

  it('правка получателя встаёт на все его операции и бьёт правило', () => {
    const list = [
      tx('2026-01-05', -10000, 'PYATEROCHKA 5566 MOSCOW'),
      tx('2026-02-05', -20000, 'PYATEROCHKA 9012 SPB'),
    ]
    const key = merchantKey('PYATEROCHKA 5566 MOSCOW')
    const rows = categorizeAll(list, {}, { [key]: 'Подарки' })
    expect(rows.every((r) => r.category === 'Подарки')).toBe(true)
    expect(rows.every((r) => r.source === 'merchant')).toBe(true)
  })

  it('правка операции сильнее правки получателя', () => {
    const one = tx('2026-01-05', -10000, 'PYATEROCHKA 5566 MOSCOW')
    const key = merchantKey(one.description)
    const rows = categorizeAll([one], { [one.id]: 'Дети' }, { [key]: 'Подарки' })
    expect(rows[0]).toMatchObject({ category: 'Дети', source: 'manual' })
  })
})

describe('вид операции сильнее словаря', () => {
  const tx = (description: string, amount = -10000): Tx => ({
    id: description,
    date: '2026-01-05',
    amount,
    description,
    mcc: null,
    bankCategory: null,
  })

  it('«перевод по номеру телефона» — это перевод, а не связь', () => {
    // Ровно эта ошибка стоила четверти годовых трат: слово «телефон» из
    // словаря «Связи» ловило перевод, и цифра выглядела правдоподобно.
    const row = categorize(tx('Внешний перевод по номеру телефона +79000000000'), {})
    expect(row.category).toBe('Переводы')
    expect(row.source).toBe('operation')
  })

  it('узнаёт снятие, кэшбэк, комиссию и копилку', () => {
    expect(categorize(tx('Снятие наличных. Т-Банк, 12179 Москва'), {}).category).toBe('Наличные')
    expect(categorize(tx('Кэшбэк за обычные покупки', 5000), {}).category).toBe('Доход')
    expect(categorize(tx('Плата за обслуживание'), {}).category).toBe('Кредиты')
    expect(categorize(tx('Перевод для пополнения счета Инвесткопилка'), {}).category).toBe(
      'Переводы',
    )
  })

  it('снимает служебное начало и отдаёт словарю имя получателя', () => {
    expect(operationOf('Оплата в YANDEXGO').rest).toBe('OPLATA V YANDEXGO'.replace('OPLATA V ', ''))
    expect(categorize(tx('Оплата в YANDEXGO'), {}).category).toBe('Такси')
    expect(categorize(tx('Оплата услуг mBank.AKADO'), {}).category).toBe('Связь и интернет')
  })

  it('кэшбэк со знаком минус доходом не считается', () => {
    expect(categorize(tx('Кэшбэк за покупки', -5000), {}).category).not.toBe('Доход')
  })
})

describe('транслитерация и границы слов', () => {
  it('одно слово словаря покрывает оба написания', () => {
    expect(byRules('PYATEROCHKA 5566')).toBe('Продукты')
    expect(byRules('Пятёрочка 5566')).toBe('Продукты')
    expect(byRules('ВКУСВИЛЛ')).toBe(byRules('VKUSVILL'))
  })

  it('хвостовой пробел в слове словаря остаётся значащим', () => {
    // «МЕТРО » ловит метро и не ловит «Метрополис» — иначе торговый центр
    // окажется общественным транспортом.
    expect(byRules('TRK METROPOLIS')).not.toBe('Транспорт')
    expect(byRules('AZSTROY MARKET')).not.toBe('Автомобиль')
    expect(byRules('AZS LUKOIL 12')).toBe('Автомобиль')
  })
})

describe('MCC', () => {
  it('раскладывает по коду платёжной сети', () => {
    expect(byMcc('5411')).toBe('Продукты')
    expect(byMcc('5812')).toBe('Кафе и рестораны')
    expect(byMcc('4121')).toBe('Такси')
    expect(byMcc('5912')).toBe('Здоровье')
  })

  it('молчит там, где кода нет или он мусорный', () => {
    expect(byMcc(null)).toBeNull()
    expect(byMcc('0')).toBeNull()
    expect(byMcc('9999')).toBeNull()
    expect(byMcc('не код')).toBeNull()
  })
})

describe('файл с кодами и без', () => {
  it('видит, что в короткой выписке нет MCC и категории банка', () => {
    // Т-Банк отдаёт выписку в двух видах. Короткая — пять колонок без кодов,
    // и тогда «Прочее» неизбежно больше. Приложение должно это заметить и
    // сказать, а не молча показать худший результат.
    const short = ['Дата операции;Сумма операции;Описание', '05.01.2026;-100,00;PYATEROCHKA'].join(
      '\n',
    )
    expect(parseStatementText(short).hasCodes).toBe(false)

    const full = [HEADER, row('05.01.2026', '-100,00', 'Супермаркеты', 'PYATEROCHKA')].join('\n')
    expect(parseStatementText(full).hasCodes).toBe(true)
  })
})

describe('новые категории', () => {
  const tx = (description: string): Tx => ({
    id: description,
    date: '2026-01-05',
    amount: -10000,
    description,
    mcc: null,
    bankCategory: null,
  })

  it('маркетплейсы отделены от техники и одежды', () => {
    expect(categorize(tx('Оплата в OZON'), {}).category).toBe('Маркетплейсы')
    expect(categorize(tx('Оплата в WILDBERRIES'), {}).category).toBe('Маркетплейсы')
    expect(categorize(tx('Оплата в YM*market.yandex Moskva RUS'), {}).category).toBe('Маркетплейсы')
    expect(categorize(tx('Оплата в LAMODA'), {}).category).toBe('Маркетплейсы')
  })

  it('алкоголь отделён от продуктов', () => {
    expect(categorize(tx('Оплата в AROMATNYJ MIR_ MOSCOW RUS'), {}).category).toBe('Алкоголь')
    expect(categorize(tx('Оплата в КРАСНОЕ БЕЛОЕ'), {}).category).toBe('Алкоголь')
  })

  it('банковские реквизиты не рвут получателя на два ключа', () => {
    expect(merchantKey('Оплата в platipomiru 6728 БИК 044525974 ИНН 7710140679')).toBe(
      merchantKey('Оплата в platipomiru'),
    )
  })
})

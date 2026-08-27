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
  time: null,
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

describe('колонки во множественном числе', () => {
  /**
   * Настоящая выгрузка из банка не читалась вовсе: «Таблица прочитана, но
   * колонок с датой и суммой в ней не нашлось». При этом обе колонки в файле
   * были — просто названы «Поступления» и «Расходы», а список синонимов знал
   * только «Поступление» и «Расход». Сравнение шло точным совпадением, и одна
   * буква в окончании стоила человеку всей выписки.
   *
   * Строки здесь выдуманы, но шапка, разделитель, формат даты со временем,
   * пробел в тысячах и запятая в копейках — из того самого файла.
   */
  const HEADER =
    'Дата операции;Выполнено банком;Номер документа;Поступления;Расходы;Валюта;' +
    'Детали операции (назначение платежа);Номер карты'

  const FILE = [
    HEADER,
    '"17.08.2026 00:00";"17.08.2026";"454965";"5 000,00";"";"RUR";" Перевод по СБП";""',
    '"16.08.2026 19:37";"18.08.2026";"951645";"";"1 319,00";"RUB";" Оплата покупки. LAVKA";"**3523"',
    '"10.08.2026 00:00";"10.08.2026";"303159";"125 590,52";"";"RUR";" Зарплата от ООО РОГА";""',
  ].join('\n')

  it('«Поступления» и «Расходы» опознаются как приход и расход', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    const result = parseStatementText(FILE, 'выписка.csv')

    expect(result.error).toBeNull()
    expect(result.transactions).toHaveLength(3)
    expect(result.skipped).toBe(0)

    // Знак несёт колонка, а не число: в файле расход записан положительным.
    const spend = result.transactions.filter((t) => t.amount < 0)
    expect(spend).toHaveLength(1)
    expect(spend[0]?.amount).toBe(-131900)

    const income = result.transactions.filter((t) => t.amount > 0)
    expect(income.map((t) => t.amount).sort((a, b) => a - b)).toEqual([500000, 12559052])
  })

  it('«Детали операции (назначение платежа)» — это описание', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    const result = parseStatementText(FILE, 'выписка.csv')
    expect(result.transactions.some((t) => t.description.includes('Зарплата от ООО РОГА'))).toBe(
      true,
    )
  })

  it('форма слова не путает колонки между собой', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    // «Суммы» вместо «Сумма», «Даты» вместо «Дата» — та же беда, другой банк.
    const result = parseStatementText(
      ['Даты;Суммы;Описания', '"05.05.2026";"-1 200,50";"Кофе"'].join('\n'),
      'другой.csv',
    )
    expect(result.error).toBeNull()
    expect(result.transactions[0]?.amount).toBe(-120050)
    expect(result.transactions[0]?.description).toBe('Кофе')
  })
})

describe('описание карточной операции разбирается до имени магазина', () => {
  /**
   * «Оплата покупки по карте. CARD **3523 16AUG RUB 1319.00 Suxofruct Moskva».
   *
   * Оборот «Оплата покупки» не ловился — слой видов знал только «ПОКУПКА», — и
   * описание целиком, вместе с номером карты, датой и суммой, уходило и в
   * словарь, и в ключ получателя. На настоящей выписке из-за даты внутри ключа
   * один «Дринкит» рассыпался на семь получателей, а «Прочее» весило 77%.
   */
  const purchase = (tail: string): string => `Оплата покупки по карте. CARD **3523 ${tail}`

  it('дата и валюта не попадают в имя получателя', async () => {
    const { merchantKey } = await import('../src/merchant.js')
    expect(merchantKey(purchase('16AUG RUB 1319.00 Suxofruct Moskva'))).toBe('SUXOFRUCT')
  })

  it('один магазин в разные дни — один получатель', async () => {
    const { merchantKey } = await import('../src/merchant.js')
    const first = merchantKey(purchase('05AUG RUB 225.00 DRINKITMOSKVA 33-1 MOSCOW'))
    const second = merchantKey(purchase('30JUL RUB 245.00 DRINKITMOSKVA 33-1 MOSCOW'))
    expect(first).toBe(second)
  })

  it('код платёжной сети из имени терминала решает категорию', async () => {
    const { categorize } = await import('../src/categorize.js')
    // Банк не выгрузил колонку MCC, но терминал вписал код в имя. Имя словарю
    // неизвестно, а 5411 — это продуктовый: категорию даёт код.
    const row = categorize(
      tx('2026-08-01', -465318, purchase('01AUG RUB 4653.18 SITISTOR*5411*2 MOSCOW')),
      {},
    )
    expect(row.category).toBe('Продукты')
    expect(row.source).toBe('mcc')
  })

  it('словарь узнаёт имя, к которому терминал приписал код', async () => {
    const { categorize } = await import('../src/categorize.js')
    // «YANDEX*4121*GO» в остатке описания — это «YANDEX 4121 GO», и слово
    // словаря «YANDEX GO» через число не перескакивает. Совпадение находится
    // вторым заходом, по очищенному имени.
    const row = categorize(
      tx('2026-07-15', -67000, purchase('15JUL RUB 670.00 YANDEX*4121*GO MOSCOW')),
      {},
    )
    expect(row.category).toBe('Такси')
    expect(row.source).toBe('rule')
  })

  it('номер точки кодом не считается', async () => {
    const { mccFromDescription } = await import('../src/categorize.js')
    // Звёздочки обязательны: «VV_9688_1» — номер точки, а не код сети.
    expect(mccFromDescription('CARD **3523 10JUL RUB 163.00 VV_9688_1 MOSCOW')).toBeNull()
    expect(mccFromDescription('CARD **3523 02AUG RUB 40.00 YANDEX*5411*LAVKA')).toBe('5411')
  })
})

describe('перевод человеку — не «Прочее» и не переезд денег', () => {
  const toPerson =
    'Перевод на номер 0079990000000. Получатель: Иван Иванович И. Осуществлен через СБП.'
  const fromPerson =
    'Перевод с номера 0079990000000. Отправитель: Иван Иванович И. Осуществлен через СБП.'

  it('уходит в свою категорию и остаётся тратой', async () => {
    const { categorize } = await import('../src/categorize.js')
    const row = categorize(tx('2026-08-07', -500000, toPerson), {})
    expect(row.category).toBe('Переводы людям')
    // План по знаку: деньги, отданные человеку, никуда не «переехали» —
    // их больше нет. У «Переводов» план `move`, и там они выпали бы из трат.
    const { planeOfTx } = await import('../src/plane.js')
    expect(planeOfTx(row.category, row.amount)).toBe('spend')
  })

  it('ключ получателя — имя человека, а не номер телефона', async () => {
    const { merchantKey } = await import('../src/merchant.js')
    expect(merchantKey(toPerson)).toBe(merchantKey(fromPerson))
    expect(merchantKey(toPerson)).not.toMatch(/\d/)
  })

  it('«внешний перевод по номеру телефона» остаётся переездом между своими', async () => {
    const { categorize } = await import('../src/categorize.js')
    // Этим оборотом банк называет и перевод себе же. Перехватив его правилом
    // про людей, я сломал поиск пар: исходящий переставал быть «Переводом»,
    // пара не находилась, и входящая сумма считалась доходом.
    const row = categorize(tx('2026-03-10', -5000000, 'Внешний перевод по номеру телефона'), {})
    expect(row.category).toBe('Переводы')
  })

  it('«перевод собственных средств» — переезд, а не трата', async () => {
    const { categorize } = await import('../src/categorize.js')
    const row = categorize(tx('2026-07-10', -1682400, 'Перевод собственных средств'), {})
    expect(row.category).toBe('Переводы')
  })
})

describe('время операции', () => {
  it('берётся из ячейки с датой и переживает выгрузку', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    const { buildExport, readExport } = await import('../src/export.js')
    const { categorizeAll } = await import('../src/categorize.js')

    const file = [
      'Дата операции;Поступления;Расходы;Валюта;Детали операции',
      '"16.08.2026 22:48";"";"110,00";"RUB";" Оплата покупки. BAR"',
      '"17.08.2026 00:00";"5 000,00";"";"RUR";" Перевод по СБП"',
    ].join('\n')

    const parsed = parseStatementText(file, 'выписка.csv')
    const late = parsed.transactions.find((t) => t.amount < 0)
    const zero = parsed.transactions.find((t) => t.amount > 0)
    expect(late?.time).toBe('22:48')
    // Полночь ровно — это не время операции, а его отсутствие: так банк
    // проводит зачисления. Показать «00:00» значило бы соврать про ночь.
    expect(zero?.time).toBeNull()

    const back = readExport(
      JSON.stringify(buildExport(categorizeAll(parsed.transactions, {}, {}), null)),
    )
    expect(back.transactions.find((t) => t.amount < 0)?.time).toBe('22:48')
  })

  it('выгрузка без времени читается, а не отбрасывается', async () => {
    const { readExport } = await import('../src/export.js')
    // Так выглядели файлы до того, как появилось поле: терять из-за него
    // разметку года было бы хуже, чем потерять время.
    const old = {
      format: 'elementar.finanser',
      version: 1,
      units: 'kopeck',
      source: null,
      overrides: {},
      merchantOverrides: {},
      transactions: [
        {
          id: 'a1',
          date: '2026-08-16',
          amount: -11000,
          description: 'BAR',
          mcc: null,
          bankCategory: null,
          account: 'карта',
          currency: null,
        },
      ],
    }
    const back = readExport(JSON.stringify(old))
    expect(back.error).toBeNull()
    expect(back.transactions).toHaveLength(1)
    expect(back.transactions[0]?.time).toBeNull()
  })

  it('день недели считается без сдвига пояса', async () => {
    const { weekdayLabel } = await import('../src/model.js')
    // 16 августа 2026 — воскресенье. Через `new Date('2026-08-16')` это
    // полночь UTC, и западнее Гринвича день уезжал бы на субботу.
    expect(weekdayLabel('2026-08-16')).toBe('вс')
    expect(weekdayLabel('2026-08-21')).toBe('пт')
  })
})

describe('подпись получателя не бывает мусором', () => {
  it('служебные слова отсеиваются в той же форме, в какой приходят', async () => {
    const { merchantLabel } = await import('../src/merchant.js')
    // «Осуществлен» становилось именем получателя с суммой в двадцать три
    // тысячи: список служебных слов писался латиницей руками, и в переводе
    // «щ» вышла как SHCH вместо SCH. Теперь перевод делает тот же `fold`,
    // через который проходит описание.
    expect(merchantLabel(' 10118.00 RUB . Осуществлен через СБП.')).not.toContain('Осуществлен')
  })

  it('когда чистить нечего, подпись называет вид операции', async () => {
    const { merchantLabel, merchantKey } = await import('../src/merchant.js')
    // Описание из одной суммы и способа перевода именем быть не может.
    expect(merchantLabel(' 10118.00 RUB . Осуществлен через СБП.')).toBe('Без описания')
    expect(merchantLabel(' Перевод средств по номеру телефона')).toBe('Перевод')
    // Ключ при этом остаётся описанием целиком: иначе разные безымянные
    // операции склеились бы в одного получателя.
    expect(merchantKey(' 10118.00 RUB . Осуществлен через СБП.')).toContain('10118')
    expect(merchantKey(' Перевод средств по номеру телефона')).not.toBe(
      merchantKey(' 10118.00 RUB . Осуществлен через СБП.'),
    )
  })

  it('настоящее имя по-прежнему достаётся', async () => {
    const { merchantLabel } = await import('../src/merchant.js')
    expect(
      merchantLabel(' Оплата покупки 110.00 RUB ..ЭКСПРЕСС.._SBP. Осуществлен через СБП.'),
    ).toBe('Экспресс')
  })
})

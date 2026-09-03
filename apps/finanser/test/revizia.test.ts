import { describe, expect, it } from 'vitest'

/**
 * Проверки по следам враждебного ревью 3 сентября 2026 года.
 *
 * Каждая — про место, где приложение теряло деньги или называло чужое число
 * своим. Файлы настоящих выписок сюда не попадают: они лежат у человека на
 * диске и в репозиторий не едут.
 */

describe('самоперевод по номеру телефона', () => {
  it('не считается ни тратой, ни доходом', async () => {
    const { categorizeAll } = await import('../src/categorize.js')
    const { markPairs } = await import('../src/pairs.js')
    const { planeOfTx } = await import('../src/plane.js')
    const строки = [
      { id: 'a', date: '2026-08-10', amount: -500000, description: ' Перевод на номер 0079990001122. Получатель: Виктор С.', account: 'A' },
      { id: 'b', date: '2026-08-10', amount: 500000, description: ' Перевод на номер 0079990001122. Отправитель: Виктор С.', account: 'A' },
    ]
    const c = markPairs(categorizeAll(строки as never, {} as never, {} as never))
    const планы = c.map((t) => planeOfTx(t.category, t.amount))
    console.log('планы', JSON.stringify(планы), c.map((t) => t.category))
    expect(планы.every((x) => x === 'move')).toBe(true)
  })
})

describe('словарь: ключи не наступают друг на друга', () => {
  it('метро — транспорт, а не продукты; доставка продуктов — не ресторан', async () => {
    const { byRules, mccFromDescription } = await import('../src/categorize.js')
    expect(byRules('Оплата в МЕТРО МОСКВА')).toBe('Транспорт')
    expect(byRules('METRO CASH AND CARRY')).toBe('Продукты')
    expect(byRules('YANDEX*5411*EDARIT MOSCOW')).not.toBe('Кафе и рестораны')
    expect(mccFromDescription('YANDEX*5411*EDARIT MOSCOW')).toBe('5411')
    expect(byRules('YANDEX EDA MOSCOW')).toBe('Кафе и рестораны')
  })
})

describe('вид операции и номер телефона', () => {
  it('покупка не становится пополнением, а буквы имени не откусываются', async () => {
    const { operationOf } = await import('../src/operation.js')
    expect(operationOf('Оплата покупки 2659.00 RUB Пополнение ЛС_SBP').kind).toBe('purchase')
    expect(operationOf('Оплата в ВКЛАД ЮНИОН МАГАЗИН').category).not.toBe('Накопления')
    expect(operationOf('Оплата ВОСТОК СЕРВИС').rest).toContain('ВОСТОК')
  })
  it('телефон узнаётся в любом виде и не путается с номером документа', async () => {
    const { phoneIn } = await import('../src/merchant.js')
    expect(phoneIn('Перевод на номер +7 916 123-45-67')).toBe('9161234567')
    expect(phoneIn('Перевод 8(916)123-45-67')).toBe('9161234567')
    expect(phoneIn('Перевод по документу 20240613001234 на номер 79161234567')).toBe('9161234567')
    expect(phoneIn('Перевод на номер 0079161234567')).toBe('9161234567')
  })
})

describe('копия возит всю настройку', () => {
  it('план, счета, курсы и наличные возвращаются вместе с операциями', async () => {
    const { buildExport, readExport } = await import('../src/export.js')
    const { restoreEverything, plan, accounts, rates } = await import('../src/store.js')
    const tx = [{ id: 'x', date: '2026-08-01', time: null, amount: -1000, description: 'Лавка', mcc: null, bankCategory: null, account: 'A', currency: null, category: 'Продукты', source: 'rule' }]
    const файл = JSON.stringify(
      buildExport(tx as never, null, {}, {}, {
        plan: { income: 100, fixed: 20, save: 10, saved: 5, goal: 500, goalDate: '2027-01', onAccount: 777, onAccountAt: '2026-08-01', arrivalAt: '' },
        accounts: [{ key: 'A', name: 'Моя карта', bank: 'Райффайзен Банк', tone: 1 }],
        rates: { EUR: 9500 },
        cashSplits: {},
        extras: [],
      }),
    )
    const back = readExport(файл)
    expect(back.error).toBe(null)
    restoreEverything(back.transactions, back.overrides, back.merchantOverrides, null, back.settings)
    expect(plan.value.onAccount).toBe(777)
    expect(accounts.value[0]?.name).toBe('Моя карта')
    expect(rates.value['EUR']).toBe(9500)
  })
})

describe('слияние выписок', () => {
  it('одинаковые операции без номера карты не схлопываются в одну', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    const файл = [
      'Дата операции;Выполнено банком;Номер документа;Поступления;Расходы;Валюта;Детали операции (назначение платежа);Номер карты',
      '"10.08.2026 11:00";"10.08.2026";"1";"";"1 000,00";"RUR";" Перевод на номер 0079990000001. Получатель: Иван И.";""',
      '"10.08.2026 12:00";"10.08.2026";"2";"";"1 000,00";"RUR";" Перевод на номер 0079990000001. Получатель: Иван И.";""',
      '"10.08.2026 13:00";"10.08.2026";"3";"";"500,00";"RUB";" Оплата покупки по карте. CARD **3523 10AUG RUB 500.00 LAVKA";"**3523"',
    ].join('\n')
    const r = parseStatementText(файл, 'выписка.csv')
    expect(r.transactions).toHaveLength(3)
    expect(new Set(r.transactions.map((t) => t.id)).size).toBe(3)
    expect(r.transactions.reduce((s, t) => s + t.amount, 0)).toBe(-250000)
  })

  it('сумма в валюте счёта подписывается валютой счёта, а не операции', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    const файл = [
      'Дата операции;Выполнено банком;Номер документа;Сумма в валюте операции;Валюта операции;Сумма в валюте счета;Валюта счета;Детали операции',
      '"01.09.2026 12:00";"01.09.2026";"X1";"-10,00";"EUR";"-1 000,00";"RUB";"Покупка в Берлине"',
    ].join('\n')
    const r = parseStatementText(файл, 'card.csv')
    expect(r.transactions[0]?.amount).toBe(-100000)
    // Рубли не объявляются евро: курс к ним не предлагается и на них не множится.
    expect(r.transactions[0]?.currency ?? null).toBe(null)
    expect(r.foreign).toBe(0)
  })

  it('месячная выписка не стирает операции, которые банк в неё не включил', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    const { addStatement, forgetEverything, transactions } = await import('../src/store.js')
    forgetEverything()
    const шапка =
      'Дата операции;Выполнено банком;Номер документа;Поступления;Расходы;Валюта;Детали операции (назначение платежа);Номер карты'
    const строка = (день: string, сумма: string, что: string): string =>
      `"${день} 10:00";"${день}";"1";"";"${сумма}";"RUB";" ${что}";"**3523"`
    const положить = (текст: string, имя: string): unknown => {
      const r = parseStatementText(текст, имя)
      return addStatement(r.transactions, {
        name: имя,
        rows: r.rows,
        skipped: r.skipped,
        converted: r.converted,
        foreign: r.foreign,
        loadedAt: '2026-09-03',
        hasCodes: r.hasCodes,
        key: имя,
        balance: r.balance,
        accounts: r.accounts,
        accountLabels: r.accountLabels,
        bank: r.bank,
        kind: r.kind,
      })
    }
    положить(
      [шапка, строка('30.07.2026', '500,00', 'LAVKA'), строка('10.08.2026', '700,00', 'KOFE')].join(
        '\n',
      ),
      'account_statement_25.06.26-01.09.26.csv',
    )
    expect(transactions.value).toHaveLength(2)
    // Месячный файл начинается со 2 августа, но несёт покупку от 30 июля:
    // банк режет по дате проведения. Июльская строка из первой выписки при
    // этом остаётся — про неё месячный файл ничего не говорит.
    положить(
      [шапка, строка('30.07.2026', '900,00', 'DRUGOE'), строка('10.08.2026', '700,00', 'KOFE')].join(
        '\n',
      ),
      'account_statement_02.08.26-01.09.26.csv',
    )
    const дни = transactions.value.map((t) => t.date).sort()
    expect(дни).toEqual(['2026-07-30', '2026-07-30', '2026-08-10'])
  })

  it('выписка по карте не уносит зарплату, о которой ничего не сказала', async () => {
    const { parseStatementText } = await import('../src/statement.js')
    const { addStatement, forgetEverything, transactions } = await import('../src/store.js')
    forgetEverything()
    const положить = (текст: string, имя: string): { removedIncome: number } => {
      const r = parseStatementText(текст, имя)
      return addStatement(r.transactions, {
        name: имя,
        rows: r.rows,
        skipped: r.skipped,
        converted: r.converted,
        foreign: r.foreign,
        loadedAt: '2026-09-03',
        hasCodes: r.hasCodes,
        key: имя,
        balance: r.balance,
        accounts: r.accounts,
        accountLabels: r.accountLabels,
        bank: r.bank,
        kind: r.kind,
      })
    }
    положить(
      [
        'Дата операции;Выполнено банком;Номер документа;Поступления;Расходы;Валюта;Детали операции (назначение платежа);Номер карты',
        '"10.08.2026 00:00";"10.08.2026";"1";"125 590,52";"";"RUR";" Зарплата от КАПИТАЛ ГРУП";""',
        '"11.08.2026 10:00";"11.08.2026";"2";"";"270,00";"RUB";" Дагестанская Лавка";"**3523"',
      ].join('\n'),
      'account_statement_25.06.26-01.09.26.csv',
    )
    const приходДо = transactions.value.filter((t) => t.amount > 0).length
    const итог = положить(
      [
        'Дата операции;Выполнено банком;Номер документа;Сумма в валюте операции;Валюта операции;Сумма в валюте счета;Валюта счета;Детали операции (назначение платежа)',
        '"11.08.2026 10:00";"11.08.2026";"ZR1";"-270,00";"RUB";"-270,00";"RUB";" DAGESTANSKAYA LAVKA"',
      ].join('\n'),
      'card_statement_25.06.26-03.09.26.csv',
    )
    expect(итог.removedIncome).toBe(0)
    expect(transactions.value.filter((t) => t.amount > 0)).toHaveLength(приходДо)
  })
})

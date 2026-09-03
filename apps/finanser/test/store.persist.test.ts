/**
 * Слой хранения. До 24 августа он не был покрыт ничем: в node `localStorage`
 * отсутствует, и все записи молча уходили в никуда. Тест ниже — тот самый,
 * которого не хватило, чтобы поймать белый экран после восстановления.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

const KEY_SOURCE = 'f.src.v1'
const KEY_TX = 'f.tx.v1'

beforeEach(() => {
  localStorage.clear()
})

describe('подмена localStorage в тестах', () => {
  it('вообще работает — иначе всё ниже бессмысленно', () => {
    localStorage.setItem('проверка', 'значение')
    expect(localStorage.getItem('проверка')).toBe('значение')
  })
})

describe('форма записанного', () => {
  it('восстановление кладёт в ключ источников массив, а не объект', async () => {
    const store = await import('../src/store.js')
    store.restoreEverything(
      [
        {
          id: 'x',
          date: '2026-03-01',
          amount: -1000,
          description: 'Кофе',
          time: null,
          mcc: null,
          bankCategory: null,
          account: 'карта',
        },
      ],
      {},
      {},
      { name: 'f.json', rows: 1, accounts: ['карта'] } as never,
    )
    const raw = localStorage.getItem(KEY_SOURCE)
    expect(raw).not.toBeNull()
    expect(Array.isArray(JSON.parse(raw as string))).toBe(true)
  })

  it('операции пишутся массивом', async () => {
    const raw = localStorage.getItem(KEY_TX)
    if (raw !== null) expect(Array.isArray(JSON.parse(raw))).toBe(true)
  })
})

describe('чтение испорченного хранилища', () => {
  it('объект там, где ждали массив, не роняет приложение', async () => {
    // Ровно то, что оставляла прежняя версия: белый экран при каждом старте,
    // без возможности нажать «забыть всё».
    localStorage.setItem(KEY_SOURCE, JSON.stringify({ name: 'f.json', rows: 1 }))
    localStorage.setItem(KEY_TX, JSON.stringify([]))
    const store = await (vi.resetModules(), import('../src/store.js'))
    expect(Array.isArray(store.sources.value)).toBe(true)
  })

  it('строка "null" не проезжает мимо значения по умолчанию', async () => {
    localStorage.setItem(KEY_SOURCE, 'null')
    const store = await (vi.resetModules(), import('../src/store.js'))
    expect(Array.isArray(store.sources.value)).toBe(true)
    expect(store.source.value).toBeNull()
  })

  it('битый JSON не роняет чтение', async () => {
    localStorage.setItem(KEY_SOURCE, '{это не json')
    const store = await (vi.resetModules(), import('../src/store.js'))
    expect(Array.isArray(store.sources.value)).toBe(true)
  })
})

describe('отказ записи не проходит молча', () => {
  it('переполненное хранилище поднимает флаг', async () => {
    vi.resetModules()
    const store = await import('../src/store.js')
    expect(store.storageFailed.value).toBe(false)

    // Подмена ставится на сам объект, а не на Storage.prototype: в тестах
    // localStorage — простая реализация из vitest.setup.ts, и к прототипу
    // браузерного Storage она отношения не имеет.
    const orig = localStorage.setItem.bind(localStorage)
    localStorage.setItem = () => {
      throw new DOMException('QuotaExceededError')
    }
    try {
      // Любая правка, которая пишет на диск.
      store.setCategory('какая-нибудь-операция', 'Продукты' as never)
    } finally {
      localStorage.setItem = orig
    }

    // Данные в памяти остались — вкладка продолжает работать…
    expect(store.overrides.value['какая-нибудь-операция']).toBe('Продукты')
    // …но приложение знает, что на диск не легло, и может это сказать.
    expect(store.storageFailed.value).toBe(true)
  })
})

describe('напоминание сохранить копию', () => {
  it('молчит, пока терять нечего', async () => {
    vi.resetModules()
    const store = await import('../src/store.js')
    expect(store.transactions.value).toHaveLength(0)
    expect(store.backupDue('2026-08-25')).toBe(false)
  })

  it('зовёт сразу, если не сохраняли ни разу', async () => {
    vi.resetModules()
    const store = await import('../src/store.js')
    store.addStatement(
      [
        {
          id: 'x',
          date: '2026-08-25',
          amount: -25000 as never,
          description: 'Кофе',
          time: null,
          mcc: null,
          bankCategory: null,
          account: 'карта',
        },
      ],
      { name: 'выписка', rows: 1, accounts: ['карта'] } as never,
    )
    expect(store.backupDue('2026-08-25')).toBe(true)
  })

  it('молчит неделю после сохранения и зовёт на восьмой день', async () => {
    vi.resetModules()
    const store = await import('../src/store.js')
    store.addStatement(
      [
        {
          id: 'y',
          date: '2026-08-25',
          amount: -25000 as never,
          description: 'Кофе',
          time: null,
          mcc: null,
          bankCategory: null,
          account: 'карта',
        },
      ],
      { name: 'выписка', rows: 1, accounts: ['карта'] } as never,
    )
    store.markSaved('2026-08-25')
    expect(store.backupDue('2026-08-26')).toBe(false)
    expect(store.backupDue('2026-08-31')).toBe(false)
    // Семь дней — срок, за который Safari сносит хранилище неоткрытого сайта.
    expect(store.backupDue('2026-09-01')).toBe(true)
  })
})

describe('повторная загрузка того же файла после смены разбора', () => {
  it('не задваивает операции и убирает исчезнувший счёт', async () => {
    const { addStatement, transactions, accounts, forgetEverything } =
      await import('../src/store.js')
    forgetEverything()

    const tx = (id: string, account: string, description: string) => ({
      id,
      date: '2026-08-16',
      time: '22:48',
      amount: -24000 as never,
      description,
      mcc: null,
      bankCategory: null,
      account,
      currency: null,
    })

    // Как было: строка по СБП жила на счёте, заведённом из имени файла.
    addStatement([tx('старый', 'файл', 'Оплата по СБП'), tx('карта-1', 'карта', 'Покупка')], {
      name: 'выписка.csv',
      rows: 2,
      skipped: 0,
      converted: 0,
      foreign: 0,
      loadedAt: '2026-08-20',
      hasCodes: false,
      key: 'k1',
      accounts: ['файл', 'карта'],
    })
    expect(accounts.value.map((a) => a.key).sort()).toEqual(['карта', 'файл'])

    // Как стало: тот же файл, та же строка — но она на карте, и потому с
    // другим идентификатором.
    addStatement([tx('новый', 'карта', 'Оплата по СБП'), tx('карта-1', 'карта', 'Покупка')], {
      name: 'выписка.csv',
      rows: 2,
      skipped: 0,
      converted: 0,
      foreign: 0,
      loadedAt: '2026-08-27',
      hasCodes: false,
      key: 'k1',
      accounts: ['карта'],
    })

    // Две операции, а не три: старая строка исчезнувшего счёта убрана.
    expect(transactions.value).toHaveLength(2)
    expect(accounts.value.map((a) => a.key)).toEqual(['карта'])
  })
})

describe('обновление выписки, а не добавление', () => {
  const tx = (id: string, date: string, amount: number, account: string) => ({
    id,
    date,
    time: null,
    amount: amount as never,
    description: 'Покупка',
    mcc: null,
    bankCategory: null,
    account,
    currency: null,
  })

  const инфо = (name: string, accounts: string[], labels: Record<string, string>) => ({
    name,
    rows: 2,
    skipped: 0,
    converted: 0,
    foreign: 0,
    loadedAt: '2026-09-03',
    hasCodes: false,
    key: name,
    accounts,
    accountLabels: labels,
  })

  it('выгрузка без номера карты ложится на единственный счёт, а не заводит второй', async () => {
    const { addStatement, accounts, transactions, forgetEverything } =
      await import('../src/store.js')
    forgetEverything()

    // Первая выгрузка — с номером карты.
    addStatement(
      [tx('1', '2026-08-01', -1000, 'карта')],
      инфо('account_statement_01.08.csv', ['карта'], { карта: '**3523' }),
    )
    expect(accounts.value).toHaveLength(1)

    // Вторая — тот же счёт, но банк не выгрузил колонку с картой. Человек
    // нажал «обновить выписку», а получал второй счёт рядом с первым.
    const итог = addStatement(
      [tx('2', '2026-09-01', -2000, 'файл')],
      инфо('card_statement_25.06-03.09.csv', ['файл'], {}),
    )
    expect(accounts.value).toHaveLength(1)
    expect(transactions.value).toHaveLength(2)
    expect(итог.added).toBe(1)
  })

  it('человеческие имена файлов по-прежнему заводят разные счета', async () => {
    const { addStatement, accounts, forgetEverything } = await import('../src/store.js')
    forgetEverything()
    addStatement([tx('1', '2026-08-01', -1000, 'а')], инфо('дебетовая.csv', ['а'], {}))
    addStatement([tx('2', '2026-08-01', -1000, 'б')], инфо('кредитная.csv', ['б'], {}))
    // Человек назвал файлы сам — значит различает счета, и сводить их вместе
    // значит спорить с ним.
    expect(accounts.value).toHaveLength(2)
  })

  it('повторная загрузка того же файла говорит, что нового нет', async () => {
    const { addStatement, forgetEverything } = await import('../src/store.js')
    forgetEverything()
    const строки = [tx('1', '2026-08-01', -1000, 'карта')]
    addStatement(строки, инфо('выписка.csv', ['карта'], { карта: '**3523' }))
    const итог = addStatement(строки, инфо('выписка.csv', ['карта'], { карта: '**3523' }))
    expect(итог.added).toBe(0)
    expect(итог.replaced).toBe(1)
  })
})

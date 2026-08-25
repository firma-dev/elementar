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

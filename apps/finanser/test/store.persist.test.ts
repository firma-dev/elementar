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

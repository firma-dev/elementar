/**
 * Быстрая запись. Разбор снисходительный намеренно: порядок слов человек не
 * помнит, а помнить его ради записанной чашки кофе — уже причина не записывать.
 */
import { describe, expect, it } from 'vitest'
import { parseQuick } from '../src/quick.js'

describe('быстрая запись', () => {
  it('«кофе 250» — трата 250 рублей', () => {
    const q = parseQuick('кофе 250')
    expect(q?.amount).toBe(-25000)
    expect(q?.description).toBe('кофе')
    expect(q?.income).toBe(false)
  })

  it('порядок слов не важен', () => {
    expect(parseQuick('250 кофе')?.description).toBe('кофе')
    expect(parseQuick('250 кофе')?.amount).toBe(-25000)
  })

  it('копейки и запятая', () => {
    expect(parseQuick('кофе 250,50')?.amount).toBe(-25050)
    expect(parseQuick('кофе 250.50')?.amount).toBe(-25050)
  })

  it('хвост про валюту уходит из описания', () => {
    expect(parseQuick('кофе 250 р')?.description).toBe('кофе')
    expect(parseQuick('кофе 250 ₽')?.description).toBe('кофе')
    expect(parseQuick('кофе 250 руб')?.description).toBe('кофе')
  })

  it('«+» делает приход', () => {
    const q = parseQuick('+ вернули долг 5000')
    expect(q?.amount).toBe(500000)
    expect(q?.income).toBe(true)
    expect(q?.description).toBe('вернули долг')
  })

  it('сумма берётся последняя: номер рейса не деньги', () => {
    const q = parseQuick('такси до Внуково 1200')
    expect(q?.amount).toBe(-120000)
    expect(q?.description).toBe('такси до Внуково')
  })

  it('категория угадывается словарём', () => {
    expect(parseQuick('пятёрочка 1200')?.category).toBe('Продукты')
    expect(parseQuick('такси 400')?.category).not.toBeNull()
  })

  it('не угадали — категории нет, а не «Прочее» молча', () => {
    expect(parseQuick('щщщ 100')?.category).toBeNull()
  })

  it('без суммы или без описания записи нет', () => {
    expect(parseQuick('кофе')).toBeNull()
    expect(parseQuick('250')).toBeNull()
    expect(parseQuick('')).toBeNull()
    expect(parseQuick('   ')).toBeNull()
  })

  it('ноль — не трата', () => {
    expect(parseQuick('кофе 0')).toBeNull()
  })

  it('разряды пробелами', () => {
    expect(parseQuick('холодильник 45 000')?.amount).toBe(-4500000)
  })
})

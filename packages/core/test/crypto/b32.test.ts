import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  Base32Error,
  b32decode,
  b32decodeExact,
  b32encode,
  tryB32decode,
} from '../../src/crypto/b32.js'
import { CROCKFORD_ALPHABET, groupForDisplay } from '@elementar/proto'

const utf8 = new TextEncoder()

describe('crockford base32', () => {
  it('замороженные векторы', () => {
    expect(b32encode(new Uint8Array(0))).toBe('')
    expect(b32encode(Uint8Array.of(0x00))).toBe('00')
    expect(b32encode(Uint8Array.of(0xff))).toBe('ZW')
    expect(b32encode(utf8.encode('hello'))).toBe('D1JPRV3F')
    expect(b32encode(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))).toBe('VTPVXVR')
  })

  it('алфавит без I L O U', () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32)
    for (const bad of ['I', 'L', 'O', 'U']) expect(CROCKFORD_ALPHABET).not.toContain(bad)
  })

  it('round-trip на произвольных байтах', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
        const s = b32encode(bytes)
        expect(s).toMatch(/^[0-9A-HJKMNP-TV-Z]*$/)
        expect([...b32decode(s)]).toEqual([...bytes])
      }),
      { numRuns: 300 },
    )
  })

  it('нормализация ввода человеком: регистр, I/l → 1, O → 0, дефисы и пробелы', () => {
    const bytes = utf8.encode('hello')
    expect([...b32decode('d1jprv3f')]).toEqual([...bytes])
    expect([...b32decode('D1-JPR V3F')]).toEqual([...bytes])
    // I и l читаются как 1
    expect([...b32decode('DIJPRV3F')]).toEqual([...bytes])
    expect([...b32decode('dljprv3f')]).toEqual([...bytes])
    // O читается как 0
    expect([...b32decode('O0')]).toEqual([0])
  })

  it('U — ошибка, а не «V»', () => {
    expect(() => b32decode('DUJPRX3F')).toThrowError(Base32Error)
    try {
      b32decode('U0')
    } catch (e) {
      expect((e as Base32Error).reason).toBe('InvalidCharacter')
    }
  })

  it('ненулевой хвостовой bit-паддинг → NonCanonicalEncoding', () => {
    // '00' каноничен, '01' содержит мусор в неиспользованных битах
    expect([...b32decode('00')]).toEqual([0])
    try {
      b32decode('01')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(Base32Error)
      expect((e as Base32Error).reason).toBe('NonCanonicalEncoding')
    }
  })

  it('длина, не дающая целого байта, — ошибка', () => {
    try {
      b32decode('A')
      throw new Error('expected throw')
    } catch (e) {
      expect((e as Base32Error).reason).toBe('InvalidLength')
    }
  })

  it('битый base32 через try-версию — null, без исключений', () => {
    expect(tryB32decode('юникод')).toBeNull()
    expect(tryB32decode('AB!CD')).toBeNull()
    expect(tryB32decode('U')).toBeNull()
    expect(tryB32decode('D1JPRV3F')).not.toBeNull()
  })

  it('b32decodeExact держит длину', () => {
    const twelve = b32encode(new Uint8Array(12))
    expect(b32decodeExact(twelve, 12)).toHaveLength(12)
    expect(() => b32decodeExact(twelve, 16)).toThrowError(Base32Error)
  })

  it('группировка для UI не мешает разбору', () => {
    const s = b32encode(Uint8Array.from({ length: 12 }, (_, i) => i * 7))
    const grouped = groupForDisplay(s)
    expect(grouped).toContain('-')
    expect([...b32decode(grouped)]).toEqual([...b32decode(s)])
  })
})

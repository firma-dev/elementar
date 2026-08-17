/**
 * nonce-clone.test.ts из §4.4: два клона одного профиля не выдают одинаковых nonce,
 * после полной потери IndexedDB новые пакеты не пересекаются со старыми,
 * 10^6 вызовов next() в одной сессии не дают дубликатов.
 */
import { describe, expect, it } from 'vitest'
import { SIZES } from '@elementar/proto'
import { NONCE_COUNTER_LIMIT, createNonceSource } from '../../src/crypto/nonce.js'

const tagOf = (n: Uint8Array): string => [...n.slice(0, 8)].join(',')
const counterOf = (n: Uint8Array): number =>
  new DataView(n.buffer, n.byteOffset, n.byteLength).getUint32(8, false)

describe('сессионный источник nonce', () => {
  it('формат: sessionTag(8) ‖ counter(4, big-endian)', () => {
    const src = createNonceSource()
    expect(src.sessionTag).toHaveLength(SIZES.SESSION_TAG_BYTES)
    const first = src.next()
    expect(first).toHaveLength(SIZES.NONCE_BYTES)
    expect([...first.slice(0, 8)]).toEqual([...src.sessionTag])
    expect([...first.slice(8)]).toEqual([0, 0, 0, 0])
    expect([...src.next().slice(8)]).toEqual([0, 0, 0, 1])
    for (let i = 0; i < 300; i++) src.next()
    expect(counterOf(src.next())).toBe(302)
  })

  it('10^6 вызовов next() в одной сессии — ни одного дубликата', () => {
    const src = createNonceSource()
    const N = 1_000_000
    const seen = new Uint8Array(N / 8)
    const tag = tagOf(src.next())
    let duplicates = 0
    let tagDrift = 0
    let outOfRange = 0
    for (let i = 1; i < N; i++) {
      const n = src.next()
      if (tagOf(n) !== tag) tagDrift++
      const c = counterOf(n)
      if (c >= N) {
        outOfRange++
        continue
      }
      const byte = c >>> 3
      const mask = 1 << (c & 7)
      if (((seen[byte] as number) & mask) !== 0) duplicates++
      seen[byte] = (seen[byte] as number) | mask
    }
    expect({ duplicates, tagDrift, outOfRange }).toEqual({
      duplicates: 0,
      tagDrift: 0,
      outOfRange: 0,
    })
  })

  it('два клона профиля (разные запуски) не пересекаются по nonce', () => {
    const a = createNonceSource()
    const b = createNonceSource()
    expect(tagOf(a.next())).not.toBe(tagOf(b.next()))
    const setA = new Set<string>()
    for (let i = 0; i < 5000; i++) setA.add(a.next().join(','))
    for (let i = 0; i < 5000; i++) expect(setA.has(b.next().join(','))).toBe(false)
  })

  it('после полной потери хранилища новые пакеты не пересекаются со старыми', () => {
    const before = createNonceSource()
    const old = new Set<string>()
    for (let i = 0; i < 1000; i++) old.add(before.next().join(','))
    // IndexedDB стёрт, приложение стартует заново — sessionTag новый по построению
    const after = createNonceSource()
    for (let i = 0; i < 1000; i++) expect(old.has(after.next().join(','))).toBe(false)
  })

  it('rotate() меняет sessionTag и обнуляет счётчик', () => {
    const src = createNonceSource()
    for (let i = 0; i < 10; i++) src.next()
    const tag = tagOf(src.next())
    src.rotate()
    const n = src.next()
    expect(tagOf(n)).not.toBe(tag)
    expect(counterOf(n)).toBe(0)
  })

  it('переполнение счётчика ротирует тег автоматически', () => {
    const src = createNonceSource({ startCounter: NONCE_COUNTER_LIMIT - 1 })
    const last = src.next()
    expect(counterOf(last)).toBe(NONCE_COUNTER_LIMIT - 1)
    const rotated = src.next()
    expect(tagOf(rotated)).not.toBe(tagOf(last))
    expect(counterOf(rotated)).toBe(0)
    expect(NONCE_COUNTER_LIMIT).toBe(2 ** 32 - 2 ** 20)
  })

  it('sessionTag не выводится ни из чего персистентного', () => {
    const tags = new Set<string>()
    for (let i = 0; i < 50; i++) tags.add(createNonceSource().sessionTag.join(','))
    expect(tags.size).toBe(50)
  })
})

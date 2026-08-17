import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { applyAll } from '../../src/doc/apply.js'
import { mergeState } from '../../src/doc/merge.js'
import { emptyState } from '../../src/doc/state.js'
import type { DocState } from '../../src/doc/state.js'
import { canon, CTX, MERGE_OPTS, opsArb, permArb, permute } from './_fixture.js'

const empty = (): DocState => emptyState('planer', 1)
const from = (ops: Parameters<typeof applyAll>[1]): DocState => applyAll(empty(), ops, CTX).state

describe('§6.13.4 mergeState', () => {
  it('коммутативна', () => {
    fc.assert(
      fc.property(opsArb(), fc.nat(40), (ops, cut) => {
        const k = ops.length === 0 ? 0 : cut % (ops.length + 1)
        const a = from(ops.slice(0, k))
        const b = from(ops.slice(k))
        expect(canon(mergeState(a, b, MERGE_OPTS))).toBe(canon(mergeState(b, a, MERGE_OPTS)))
      }),
      { numRuns: 200 },
    )
  })

  it('ассоциативна', () => {
    fc.assert(
      fc.property(opsArb(30), fc.nat(30), fc.nat(30), (ops, c1, c2) => {
        const n = ops.length
        const i = n === 0 ? 0 : c1 % (n + 1)
        const j = n === 0 ? 0 : Math.max(i, c2 % (n + 1))
        const a = from(ops.slice(0, i))
        const b = from(ops.slice(i, j))
        const c = from(ops.slice(j))
        expect(canon(mergeState(mergeState(a, b, MERGE_OPTS), c, MERGE_OPTS))).toBe(canon(mergeState(a, mergeState(b, c, MERGE_OPTS), MERGE_OPTS)))
      }),
      { numRuns: 200 },
    )
  })

  it('идемпотентна', () => {
    fc.assert(
      fc.property(opsArb(), (ops) => {
        const a = from(ops)
        expect(canon(mergeState(a, a, MERGE_OPTS))).toBe(canon(a))
      }),
      { numRuns: 200 },
    )
  })

  it('эквивалентна применению всех операций', () => {
    fc.assert(
      fc.property(opsArb(), fc.nat(40), permArb(), (ops, cut, p) => {
        const k = ops.length === 0 ? 0 : cut % (ops.length + 1)
        const snapshot = from(ops.slice(0, k))
        const local = from(permute(ops.slice(k), p))
        expect(canon(mergeState(snapshot, local, MERGE_OPTS))).toBe(canon(from(ops)))
      }),
      { numRuns: 300 },
    )
  })

  it('слияние снапшота с локальными правками не теряет неотправленное', () => {
    const a = from([
      { i: '0193f1a2b3c4-0000-aaaa1111', k: 's', c: 'task', r: 'task000000000001', v: { title: 'молоко' } },
    ])
    const b = from([
      { i: '0193f1a2b3c5-0000-bbbb2222', k: 's', c: 'task', r: 'task000000000002', v: { title: 'хлеб' } },
    ])
    const m = mergeState(a, b, MERGE_OPTS)
    expect(Object.keys(m.col['task'] ?? {})).toHaveLength(2)
    expect(m.applied).toBe(0)
  })

  it('корпуса не смешиваются', () => {
    expect(() => mergeState(emptyState('planer', 1), emptyState('finanser', 1))).toThrow(/корпуса/)
  })

  it('разрыв схемы больше двух версий блокирует слияние', () => {
    expect(() => mergeState(emptyState('planer', 1), emptyState('planer', 4))).toThrow(/схем/)
  })
})

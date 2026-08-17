import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { applyAll } from '../../src/doc/apply.js'
import { emptyState } from '../../src/doc/state.js'
import type { DocState } from '../../src/doc/state.js'
import { canon, CTX, opsArb, permArb, permute } from './_fixture.js'

const empty = (): DocState => emptyState('planer', 1)

describe('§6.13.1 сходимость', () => {
  it('любые две перестановки дают побайтово равное состояние', () => {
    fc.assert(
      fc.property(opsArb(), permArb(), permArb(), (ops, p1, p2) => {
        const a = applyAll(empty(), permute(ops, p1), CTX).state
        const b = applyAll(empty(), permute(ops, p2), CTX).state
        expect(canon(a)).toBe(canon(b))
      }),
      { numRuns: 200 },
    )
  })

  it('порядок не влияет и при повторной доставке части операций', () => {
    fc.assert(
      fc.property(opsArb(), permArb(), (ops, p) => {
        const straight = applyAll(empty(), ops, CTX).state
        const doubled = applyAll(empty(), [...permute(ops, p), ...ops], CTX).state
        expect(canon(doubled)).toBe(canon(straight))
      }),
      { numRuns: 100 },
    )
  })
})

describe('§6.13.2 идемпотентность', () => {
  it('применение набора дважды равно однократному', () => {
    fc.assert(
      fc.property(opsArb(), (ops) => {
        const once = applyAll(empty(), ops, CTX).state
        const twice = applyAll(once, ops, CTX).state
        expect(canon(twice)).toBe(canon(once))
        // повтор не порождает нового объекта состояния
        expect(twice).toBe(once)
      }),
      { numRuns: 200 },
    )
  })

  it('повторная доставка старой операции ничего не меняет', () => {
    fc.assert(
      fc.property(opsArb(), fc.nat(39), (ops, k) => {
        if (ops.length === 0) return
        const state = applyAll(empty(), ops, CTX).state
        const one = ops[k % ops.length]
        if (one === undefined) return
        expect(canon(applyAll(state, [one], CTX).state)).toBe(canon(state))
      }),
      { numRuns: 200 },
    )
  })
})

describe('§6.13.3 дельта-эквивалентность', () => {
  it('снапшот первых k операций плюс хвост равен применению всего лога', () => {
    fc.assert(
      fc.property(opsArb(), fc.nat(40), (ops, cut) => {
        const k = ops.length === 0 ? 0 : cut % (ops.length + 1)
        const head = applyAll(empty(), ops.slice(0, k), CTX).state
        // снапшот переживает сериализацию
        const restored = JSON.parse(JSON.stringify(head)) as DocState
        const combined = applyAll(restored, ops.slice(k), CTX).state
        const direct = applyAll(empty(), ops, CTX).state
        expect(canon(combined)).toBe(canon(direct))
      }),
      { numRuns: 200 },
    )
  })
})

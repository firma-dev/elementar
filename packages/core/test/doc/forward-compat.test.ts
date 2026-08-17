import { describe, expect, it } from 'vitest'
import { applyAll } from '../../src/doc/apply.js'
import { canonicalize, emptyState } from '../../src/doc/state.js'
import type { DocState } from '../../src/doc/state.js'
import { mergeState } from '../../src/doc/merge.js'
import { decodeOps, encodeOps, parseOp } from '../../src/ops/codec.js'
import type { AnyOp } from '../../src/ops/types.js'
import { CTX, hlcAt, MERGE_OPTS } from './_fixture.js'

/** Лог, записанный «другой» версией приложения: чужая коллекция, чужое поле, чужой вид. */
const GOLDEN: unknown[] = [
  { i: hlcAt(1, 'aaaa1111'), k: 's', c: 'task', r: 'task000000000001', v: { title: 'известное' } },
  { i: hlcAt(2, 'bbbb2222'), k: 's', c: 'task', r: 'task000000000001', v: { unknownField: 42 } },
  { i: hlcAt(3, 'bbbb2222'), k: 's', c: 'habit', r: 'habit00000000001', v: { title: 'коллекция из будущего' } },
  { i: hlcAt(4, 'bbbb2222'), k: 'q', c: 'task', r: 'task000000000001', payload: { any: ['thing', 1, null] } },
]

const empty = (): DocState => emptyState('planer', 1)

describe('§6.13.10 forward-compat', () => {
  it('неизвестные коллекция, поле и вид операции переживают round-trip', () => {
    const ops = decodeOps(JSON.stringify(GOLDEN))
    expect(ops).toHaveLength(4)

    const state = applyAll(empty(), ops, CTX).state
    expect(state.col['habit']?.['habit00000000001']).toBeDefined()
    expect(state.col['task']?.['task000000000001']?.f['unknownField']).toBeDefined()
    expect(Object.keys(state.xops ?? {})).toEqual([hlcAt(4, 'bbbb2222')])

    // снапшот переживает сериализацию и остаётся канонически равным
    const restored = JSON.parse(JSON.stringify(state)) as DocState
    expect(new TextDecoder().decode(canonicalize(restored))).toBe(
      new TextDecoder().decode(canonicalize(state)),
    )

    // и уходит обратно в синк без потерь
    const back = decodeOps(encodeOps(Object.values(restored.xops ?? {}) as AnyOp[]))
    expect(back[0]).toMatchObject({ k: 'q', payload: { any: ['thing', 1, null] } })
  })

  it('старая схема применяет новый лог, новая — старый; результат сходится', () => {
    const ops = decodeOps(JSON.stringify(GOLDEN))
    const oldFirst = applyAll(empty(), ops, CTX).state
    const newFirst = applyAll(empty(), [...ops].reverse(), CTX).state
    expect(new TextDecoder().decode(canonicalize(oldFirst))).toBe(
      new TextDecoder().decode(canonicalize(newFirst)),
    )
  })

  it('неизвестные операции сливаются объединением и не дублируются', () => {
    const ops = decodeOps(JSON.stringify(GOLDEN))
    const a = applyAll(empty(), ops.slice(0, 2), CTX).state
    const b = applyAll(empty(), ops.slice(2), CTX).state
    const m = mergeState(a, b, MERGE_OPTS)
    expect(Object.keys(m.xops ?? {})).toHaveLength(1)
    expect(new TextDecoder().decode(canonicalize(mergeState(m, m, MERGE_OPTS)))).toBe(
      new TextDecoder().decode(canonicalize(m)),
    )
  })

  it('структурный мусор отбрасывается, а не роняет разбор', () => {
    expect(parseOp({ k: 's' })).toBeNull()
    expect(parseOp({ i: 'не-hlc', k: 's', c: 'task', r: 'x', v: {} })).toBeNull()
    expect(parseOp(null)).toBeNull()
    expect(decodeOps('не json')).toEqual([])
    expect(decodeOps('{"a":1}')).toEqual([])
    // битый элемент не мешает остальным
    expect(decodeOps(JSON.stringify([{ bad: true }, GOLDEN[0]]))).toHaveLength(1)
  })

  it('кодек детерминирован: порядок ключей не зависит от порядка записи', () => {
    const a = encodeOps([
      { i: hlcAt(1, 'aaaa1111'), k: 's', c: 'task', r: 'task000000000001', v: { b: 2, a: 1 } },
    ])
    const b = encodeOps([
      { k: 's', v: { a: 1, b: 2 }, r: 'task000000000001', c: 'task', i: hlcAt(1, 'aaaa1111') } as AnyOp,
    ])
    expect(a).toBe(b)
  })
})

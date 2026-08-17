import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { applyAll } from '../../src/doc/apply.js'
import { HLC_ZERO } from '../../src/hlc.js'
import { emptyState, isAlive } from '../../src/doc/state.js'
import type { DocState } from '../../src/doc/state.js'
import { purgeTombstones, purgeWatermark } from '../../src/doc/purge.js'
import type { Op } from '../../src/ops/types.js'
import { buildOps, canon, CTX, hlcAt, opSpecArb, permArb, permute, TASKS } from './_fixture.js'
import type { OpSpec } from './_fixture.js'

const empty = (): DocState => emptyState('planer', 1)

/**
 * Дисциплина водяного знака (§6.7): он двигается только до границы, которую подтвердили
 * все акторы, поэтому операций по уже удалённым записям после неё не появляется.
 */
function splitRespectingTombstones(specs: readonly OpSpec[], cut: number): { ops: Op[]; watermark: string } {
  const head = specs.slice(0, cut)
  const deleted = new Set<number>()
  for (const s of head) if (s.t === 'del') deleted.add(s.rec)
  const tail = specs.slice(cut).filter((s) => !('rec' in s) || s.t === 'proj' || !deleted.has(s.rec))
  const ops = buildOps([...head, ...tail])
  // граница — сразу после последней операции головы (пустая голова: ничего не подтверждено)
  const watermark = head.length === 0 ? HLC_ZERO : hlcAt(head.length - 1, 'zzzzzzzz')
  return { ops, watermark }
}

describe('§6.13.5 чистка надгробий', () => {
  it('две машины с разным расписанием чистки сходятся побайтово', () => {
    fc.assert(
      fc.property(
        fc.array(opSpecArb, { maxLength: 30 }),
        fc.nat(30),
        permArb(),
        permArb(),
        (specs, cut, p1, p2) => {
          const k = specs.length === 0 ? 0 : cut % (specs.length + 1)
          const { ops, watermark } = splitRespectingTombstones(specs, k)
          const headOps = ops.slice(0, k)
          const tailOps = ops.slice(k)

          // машина A: чистит рано, потом догоняет хвост
          const a0 = applyAll(empty(), permute(headOps, p1), CTX).state
          const a1 = purgeTombstones(a0, watermark)
          const a2 = applyAll(a1, permute(tailOps, p2), CTX).state
          const a = purgeTombstones(a2, watermark)

          // машина B: применяет всё и чистит один раз в конце
          const b0 = applyAll(empty(), permute(ops, p2), CTX).state
          const b = purgeTombstones(b0, watermark)

          expect(canon(a)).toBe(canon(b))
        },
      ),
      { numRuns: 300 },
    )
  })

  it('ни при каком расписании чистки не возникает живой записи, ранее удалённой', () => {
    fc.assert(
      fc.property(fc.array(opSpecArb, { maxLength: 30 }), fc.nat(30), permArb(), (specs, cut, p) => {
        const k = specs.length === 0 ? 0 : cut % (specs.length + 1)
        const { ops, watermark } = splitRespectingTombstones(specs, k)
        const deletedFinally = new Set<string>()
        const final = applyAll(empty(), ops, CTX).state
        for (const [id, rec] of Object.entries(final.col['task'] ?? {}))
          if (!isAlive(rec)) deletedFinally.add(id)

        const s1 = purgeTombstones(applyAll(empty(), permute(ops.slice(0, k), p), CTX).state, watermark)
        const s2 = applyAll(s1, ops.slice(k), CTX).state
        for (const id of deletedFinally) {
          const rec = s2.col['task']?.[id]
          if (rec !== undefined) expect(isAlive(rec)).toBe(false)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('операция по вычищенной записи не воскрешает её', () => {
    const del: Op = { i: hlcAt(1, 'aaaa1111'), k: 'd', c: 'task', r: TASKS[0] }
    const old: Op = { i: hlcAt(0, 'bbbb2222'), k: 's', c: 'task', r: TASKS[0], v: { title: 'зомби' } }
    const state = applyAll(empty(), [del], CTX).state
    const purged = purgeTombstones(state, hlcAt(5, 'zzzzzzzz'))
    expect(purged.col['task']).toBeUndefined()
    const after = applyAll(purged, [old], CTX).state
    expect(after.col['task']?.[TASKS[0]]).toBeUndefined()
  })

  it('водяной знак — минимум по неустаревшим акторам', () => {
    const now = 1_700_000_000_000
    expect(
      purgeWatermark(
        [
          { actor: 'aaaa1111', ack: hlcAt(10, 'aaaa1111'), lastSeenAt: now },
          { actor: 'bbbb2222', ack: hlcAt(4, 'bbbb2222'), lastSeenAt: now },
        ],
        now,
      ),
    ).toBe(hlcAt(4, 'bbbb2222'))
    // актор, молчавший больше 90 дней, в расчёт не идёт
    expect(
      purgeWatermark(
        [
          { actor: 'aaaa1111', ack: hlcAt(10, 'aaaa1111'), lastSeenAt: now },
          { actor: 'bbbb2222', ack: hlcAt(4, 'bbbb2222'), lastSeenAt: now - 100 * 864e5 },
        ],
        now,
      ),
    ).toBe(hlcAt(10, 'aaaa1111'))
    expect(purgeWatermark([], now)).toBeNull()
  })
})

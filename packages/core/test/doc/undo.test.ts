import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Clock } from '../../src/hlc.js'
import { createDocCore } from '../../src/doc/handle.js'
import type { Op } from '../../src/ops/types.js'
import { ACTORS, PLANER } from './_fixture.js'

const TASK = 't000000000000001'
const NOW = 1_700_000_000_000

function pair() {
  const a = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0], clock: new Clock(ACTORS[0], undefined, () => NOW) })
  const b = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[1], clock: new Clock(ACTORS[1], undefined, () => NOW) })
  const outA: Op[] = []
  const outB: Op[] = []
  a.onLocalOps((ops) => outA.push(...ops))
  b.onLocalOps((ops) => outB.push(...ops))
  return {
    a,
    b,
    aToB: () => b.applyRemote(outA.splice(0, outA.length)),
    bToA: () => a.applyRemote(outB.splice(0, outB.length)),
  }
}

describe('§6.13.9 undo', () => {
  it('undo не перезаписывает чужую ячейку', () => {
    const { a, b, aToB, bToA } = pair()
    a.tx((t) => {
      t.col['task'].create({ title: 'ремонт', date: '2026-08-11' }, { at: 'end' }, TASK)
    })
    aToB()
    a.tx((t) => {
      t.col['task'].update(TASK, { date: '2026-08-12' })
    }, { label: 'дата' })
    aToB()
    // Аня переносит задачу на среду
    b.tx((t) => {
      t.col['task'].update(TASK, { date: '2026-08-13' })
    })
    bToA()

    const res = a.undo.undo()
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('foreign-cell')
      expect(res.by).toBe(ACTORS[1])
      expect(res.field).toBe('date')
    }
    // чужая правка на месте
    const row = a.col.task.byId(TASK).value as unknown as { date: string }
    expect(row.date).toBe('2026-08-13')
    // стек не рухнул: шаг снят
    expect(a.undo.can.value).toBe(true)
  })

  it('свой шаг откатывается и повторяется', () => {
    const { a } = pair()
    a.tx((t) => {
      t.col['task'].create({ title: 'первое' }, { at: 'end' }, TASK)
    }, { label: 'создание' })
    a.tx((t) => {
      t.col['task'].update(TASK, { title: 'второе' })
    }, { label: 'правка' })

    expect(a.undo.undo()).toEqual({ ok: true, label: 'правка' })
    expect((a.col.task.byId(TASK).value as unknown as { title: string }).title).toBe('первое')

    expect(a.undo.redo()).toEqual({ ok: true, label: 'правка' })
    expect((a.col.task.byId(TASK).value as unknown as { title: string }).title).toBe('второе')

    expect(a.undo.undo()).toEqual({ ok: true, label: 'правка' })
    expect(a.undo.undo()).toEqual({ ok: true, label: 'создание' })
    expect(a.col.task.byId(TASK).value).toBeUndefined()
    expect(a.undo.can.value).toBe(false)
    expect(a.undo.undo()).toEqual({ ok: false, reason: 'empty' })
  })

  it('undo никогда не понижает ячейку, последним писавшим в которую был другой актор', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 8 }), (partnerEdits) => {
        const { a, b, aToB, bToA } = pair()
        a.tx((t) => {
          t.col['task'].create({ title: 'общая' }, { at: 'end' }, TASK)
        }, { label: 'создание' })
        aToB()
        for (const partner of partnerEdits) {
          a.tx((t) => {
            t.col['task'].update(TASK, { title: `мой ${Math.random()}` })
          }, { label: 'моя правка' })
          aToB()
          if (partner) {
            b.tx((t) => {
              t.col['task'].update(TASK, { title: 'правка Ани' })
            })
            bToA()
          }
        }
        const before = a.col.task.byId(TASK).value as unknown as { title: string } | undefined
        const wasForeign = before?.title === 'правка Ани'
        const res = a.undo.undo()
        if (wasForeign) {
          expect(res.ok).toBe(false)
          const after = a.col.task.byId(TASK).value as unknown as { title: string }
          expect(after.title).toBe('правка Ани')
        }
      }),
      { numRuns: 100 },
    )
  })
})

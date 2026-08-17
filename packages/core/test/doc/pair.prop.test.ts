import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createDocCore } from '../../src/doc/handle.js'
import type { DocCore } from '../../src/doc/handle.js'
import { isAlive } from '../../src/doc/state.js'
import { seriesRecordId } from '../../src/id.js'
import type { Op } from '../../src/ops/types.js'
import { ACTORS, PLANER } from './_fixture.js'

const TASKS = ['t000000000000001', 't000000000000002', 't000000000000003'] as const

type Doc = DocCore<(typeof PLANER)['collections']>

interface Side {
  doc: Doc
  out: Op[]
}

function makeSide(actor: string): Side {
  const doc = createDocCore({ def: PLANER, docId: 'DOC', actor }) as Doc
  const out: Op[] = []
  doc.onLocalOps((ops) => out.push(...ops))
  return { doc, out }
}

function flush(from: Side, to: Side): void {
  if (from.out.length === 0) return
  const ops = from.out.splice(0, from.out.length)
  to.doc.applyRemote(ops)
}

type Cmd =
  | { k: 'edit'; a: number; r: number; text: string }
  | { k: 'done'; a: number; r: number; v: boolean }
  | { k: 'move'; a: number; r: number; g: number }
  | { k: 'del'; a: number; r: number }
  | { k: 'restore'; a: number; r: number }
  | { k: 'note'; a: number; r: number; text: string }
  | { k: 'sync' }

const GROUPS = ['list:work', 'list:home', 'list:hobby'] as const

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({ k: fc.constant('edit' as const), a: fc.nat(1), r: fc.nat(2), text: fc.string({ maxLength: 6 }) }),
  fc.record({ k: fc.constant('done' as const), a: fc.nat(1), r: fc.nat(2), v: fc.boolean() }),
  fc.record({ k: fc.constant('move' as const), a: fc.nat(1), r: fc.nat(2), g: fc.nat(2) }),
  fc.record({ k: fc.constant('del' as const), a: fc.nat(1), r: fc.nat(2) }),
  fc.record({ k: fc.constant('restore' as const), a: fc.nat(1), r: fc.nat(2) }),
  fc.record({ k: fc.constant('note' as const), a: fc.nat(1), r: fc.nat(2), text: fc.string({ maxLength: 6 }) }),
  fc.record({ k: fc.constant('sync' as const) }),
)

function alive(doc: Doc, id: string): boolean {
  const rec = doc._state.value.col['task']?.[id]
  return rec !== undefined && isAlive(rec)
}

function exists(doc: Doc, id: string): boolean {
  return doc._state.value.col['task']?.[id] !== undefined
}

describe('§6.13.7 симуляция пары', () => {
  it('после схождения состояния совпадают и инварианты держатся', () => {
    fc.assert(
      fc.property(fc.array(cmdArb, { maxLength: 40 }), (cmds) => {
        const A = makeSide(ACTORS[0])
        const B = makeSide(ACTORS[1])
        const sides: [Side, Side] = [A, B]

        A.doc.tx((t) => {
          for (const id of TASKS) t.col['task'].create({ title: `задача ${id}` }, { at: 'end' }, id)
        })
        flush(A, B)

        for (const cmd of cmds) {
          if (cmd.k === 'sync') {
            flush(A, B)
            flush(B, A)
            continue
          }
          const side = sides[cmd.a] as Side
          const id = TASKS[cmd.r] as string
          if (!exists(side.doc, id)) continue
          side.doc.tx((t) => {
            switch (cmd.k) {
              case 'edit':
                if (alive(side.doc, id)) t.col['task'].update(id, { title: cmd.text })
                break
              case 'note':
                if (alive(side.doc, id)) t.col['task'].update(id, { note: cmd.text })
                break
              case 'done':
                if (alive(side.doc, id)) t.col['task'].update(id, { done: cmd.v })
                break
              case 'move':
                if (alive(side.doc, id)) t.col['task'].move(id, { group: GROUPS[cmd.g] as string })
                break
              case 'del':
                if (alive(side.doc, id)) t.col['task'].remove(id)
                break
              case 'restore':
                if (!alive(side.doc, id)) t.col['task'].restore(id)
                break
            }
          })
        }

        flush(A, B)
        flush(B, A)
        flush(A, B)

        expect(A.doc.stateHash()).toBe(B.doc.stateHash())

        const rows = A.doc.col.task.all.value as unknown as Array<{ id: string }>
        const ids = new Set(rows.map((r) => r.id))
        expect(ids.size).toBe(rows.length) // нет дублей в списке
        for (const [id, rec] of Object.entries(A.doc._state.value.col['task'] ?? {}))
          if (isAlive(rec)) expect(rec.o?.v, `нет ключа порядка у ${id}`).toBeTruthy()

        // порядок одинаков у обоих
        const rowsB = B.doc.col.task.all.value as unknown as Array<{ id: string }>
        expect(rows.map((r) => r.id)).toEqual(rowsB.map((r) => r.id))
      }),
      { numRuns: 100 },
    )
  })

  it('удаление побеждает правку: зомби не появляется', () => {
    const A = makeSide(ACTORS[0])
    const B = makeSide(ACTORS[1])
    A.doc.tx((t) => {
      t.col['task'].create({ title: 'вынести коробки' }, { at: 'end' }, TASKS[0])
    })
    flush(A, B)
    // офлайн: жена удалила, муж правит ту же задачу позже
    A.doc.tx((t) => {
      t.col['task'].remove(TASKS[0])
    })
    B.doc.tx((t) => {
      t.col['task'].update(TASKS[0], { title: 'вынести коробки в четверг' })
    })
    flush(A, B)
    flush(B, A)
    expect(alive(A.doc, TASKS[0])).toBe(false)
    expect(alive(B.doc, TASKS[0])).toBe(false)
    expect(A.doc.stateHash()).toBe(B.doc.stateHash())
    // правка не потеряна: она видна в корзине как «правили после удаления»
    const item = A.doc.trash.items.value.find((i) => i.id === TASKS[0])
    expect(item?.editedAfterDelete).toBe(true)
    // и возвращается кнопкой «Вернуть»
    A.doc.trash.restore('task', TASKS[0])
    expect(alive(A.doc, TASKS[0])).toBe(true)
  })

  it('оба отметили один повтор офлайн — экземпляр серии один', () => {
    const A = makeSide(ACTORS[0])
    const B = makeSide(ACTORS[1])
    const series = TASKS[0]
    A.doc.tx((t) => {
      t.col['task'].create({ title: 'мусор по вторникам', seriesId: series, occurrenceIndex: 0 }, { at: 'end' }, series)
    })
    flush(A, B)

    const next = seriesRecordId(series, 1)
    for (const side of [A, B]) {
      side.doc.tx((t) => {
        t.col['task'].update(series, { done: true })
        t.col['task'].create(
          { title: 'мусор по вторникам', seriesId: series, occurrenceIndex: 1 },
          { at: 'end' },
          next,
        )
      })
    }
    flush(A, B)
    flush(B, A)

    const live = Object.entries(A.doc._state.value.col['task'] ?? {}).filter(
      ([, r]) => isAlive(r) && (r.f['occurrenceIndex'] as { v?: unknown } | undefined)?.v === 1,
    )
    expect(live).toHaveLength(1)
    expect(live[0]?.[0]).toBe(next)
    expect(A.doc.stateHash()).toBe(B.doc.stateHash())
  })
})

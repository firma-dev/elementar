import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createDocCore } from '../../src/doc/handle.js'
import { isAlive, isLww } from '../../src/doc/state.js'
import { ORPHAN } from '../../src/schema/types.js'
import type { Lww } from '../../src/doc/state.js'
import { ACTORS, opSpecArb, buildOps, permArb, permute, PLANER } from './_fixture.js'

describe('§6.13.6 ровно один контейнер', () => {
  it('после любой перестановки у задачи ровно одно значение bucket', () => {
    fc.assert(
      fc.property(fc.array(opSpecArb, { maxLength: 30 }), permArb(), (specs, p) => {
        const ops = permute(buildOps(specs), p)
        const doc = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0] })
        doc.applyRemote(ops)
        for (const [, rec] of Object.entries(doc._state.value.col['task'] ?? {})) {
          const cell = rec.f['bucket']
          if (cell === undefined) continue
          expect(isLww(cell)).toBe(true)
          expect(typeof (cell as Lww).v).toBe('string')
          // зеркало контейнера всегда согласовано с ячейкой
          if (rec.g !== undefined) expect(rec.g.v).toBe((cell as Lww).v)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('нет живой записи, не видимой ни на одном экране (включая ORPHAN)', () => {
    fc.assert(
      fc.property(fc.array(opSpecArb, { maxLength: 30 }), permArb(), (specs, p) => {
        const ops = permute(buildOps(specs), p)
        const doc = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0] })
        doc.applyRemote(ops)
        const live = Object.entries(doc._state.value.col['task'] ?? {}).filter(([, r]) => isAlive(r))
        const groups = doc.col.task.group('bucket').value
        let shown = 0
        const seen = new Set<string>()
        for (const [, rows] of groups)
          for (const row of rows) {
            shown++
            seen.add(row.id)
          }
        expect(shown).toBe(seen.size) // ни одной записи дважды
        expect(seen.size).toBe(live.length) // и ни одной потерянной
      }),
      { numRuns: 200 },
    )
  })

  it('задача в удалённом проекте показывается в псевдогруппе «Без проекта»', () => {
    const doc = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0] })
    let projectId = ''
    doc.tx((t) => {
      projectId = t.col['project'].create({ title: 'Ремонт' })
      t.col['task'].create({ title: 'Купить плитку', bucket: `proj:${projectId}` })
    })
    expect([...doc.col.task.group('bucket').value.keys()]).toEqual([`proj:${projectId}`])

    doc.tx((t) => {
      t.col['project'].remove(projectId)
    })
    const groups = doc.col.task.group('bucket').value
    expect([...groups.keys()]).toEqual([ORPHAN])
    // ячейка не поменялась: вернут проект — вернутся и задачи
    const task = doc.col.task.all.value[0] as unknown as { bucket: string }
    expect(task.bucket).toBe(`proj:${projectId}`)

    doc.tx((t) => {
      t.col['project'].restore(projectId)
    })
    expect([...doc.col.task.group('bucket').value.keys()]).toEqual([`proj:${projectId}`])
  })
})

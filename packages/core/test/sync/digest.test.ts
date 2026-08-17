import { describe, expect, it } from 'vitest'
import { emptyChangeSet } from '../../src/doc/apply.js'
import type { ChangeSet } from '../../src/doc/apply.js'
import { emptyState } from '../../src/doc/state.js'
import type { DocState, RecordState } from '../../src/doc/state.js'
import { buildDigest, shouldShowDigest } from '../../src/sync/digest.js'

const MINE = 'mine0000'
const HERS = 'anya0000'

const hlc = (n: number, actor: string): string =>
  `${n.toString(16).padStart(12, '0')}-0000-${actor}`

function rec(fields: Record<string, [unknown, string]>, actor: string, at = 1): RecordState {
  const f: RecordState['f'] = {}
  for (const [name, [v, t]] of Object.entries(fields)) f[name] = { v: v as never, t }
  return { f, cre: hlc(at, actor), upd: hlc(at, actor) }
}

function state(): DocState {
  const s = emptyState('planer', 1)
  s.col['tasks'] = {
    t1: rec({ title: ['Собрать коробки', hlc(10, HERS)] }, HERS, 10),
    t2: rec({ title: ['Заказать машину', hlc(11, HERS)] }, HERS, 11),
    t3: rec({ title: ['Моя задача', hlc(12, MINE)] }, MINE, 12),
  }
  s.col['_actors'] = {
    [HERS]: rec({ name: ['Аня', hlc(1, HERS)] }, HERS, 1),
  }
  return s
}

function changes(fill: (cs: ChangeSet) => void): ChangeSet {
  const cs = emptyChangeSet()
  fill(cs)
  return cs
}

describe('сводка «пока вас не было»', () => {
  it('считает чужие правки по акторам и берёт имя из _actors', () => {
    const s = state()
    const cs = changes((c) => {
      c.created.push({ c: 'tasks', r: 't1' })
      c.deleted.push({ c: 'tasks', r: 't2' })
      c.collectionOf.set('t1', 'tasks')
      c.collectionOf.set('t2', 'tasks')
    })
    const d = buildDigest([cs], s, MINE, { since: 5 })
    expect(d.since).toBe(5)
    expect(d.items.length).toBe(2)
    expect(d.byActor).toEqual([{ actor: HERS, name: 'Аня', created: 1, updated: 0, deleted: 1 }])
    expect(d.items[0]?.label).toBe('Собрать коробки')
  })

  it('свои правки в сводку не попадают', () => {
    const s = state()
    const cs = changes((c) => {
      c.created.push({ c: 'tasks', r: 't3' })
      c.collectionOf.set('t3', 'tasks')
    })
    expect(buildDigest([cs], s, MINE).items).toEqual([])
  })

  it('служебные коллекции не показываются человеку', () => {
    const s = state()
    const cs = changes((c) => {
      c.created.push({ c: '_actors', r: HERS })
      c.collectionOf.set(HERS, '_actors')
    })
    expect(buildDigest([cs], s, MINE).items).toEqual([])
  })

  it('правка по записи, которую я трогал офлайн, помечается конфликтной', () => {
    const s = state()
    const cs = changes((c) => {
      c.updated.set('t1', ['title'])
      c.collectionOf.set('t1', 'tasks')
    })
    const d = buildDigest([cs], s, MINE, { mine: ['t1'] })
    expect(d.items[0]?.kind).toBe('updated')
    expect(d.items[0]?.fields).toEqual(['title'])
    expect(d.items[0]?.conflictedWithMine).toBe(true)
  })

  it('служебные поля порядка не считаются правкой поля', () => {
    const s = state()
    const cs = changes((c) => {
      c.updated.set('t1', ['#order'])
      c.collectionOf.set('t1', 'tasks')
      c.moved.push({ c: 'tasks', r: 't1' })
    })
    const d = buildDigest([cs], s, MINE)
    expect(d.items.map((i) => i.kind)).toEqual(['moved'])
  })

  it('дубли из нескольких наборов схлопываются', () => {
    const s = state()
    const one = changes((c) => {
      c.created.push({ c: 'tasks', r: 't1' })
      c.collectionOf.set('t1', 'tasks')
    })
    const two = changes((c) => {
      c.created.push({ c: 'tasks', r: 't1' })
      c.collectionOf.set('t1', 'tasks')
    })
    expect(buildDigest([one, two], s, MINE).items.length).toBe(1)
  })

  it('порог показа — больше пяти чужих операций', () => {
    const s = state()
    s.col['tasks'] = {}
    for (let i = 0; i < 7; i++) {
      ;(s.col['tasks'] as Record<string, RecordState>)[`x${i}`] = rec(
        { title: [`задача ${i}`, hlc(20 + i, HERS)] },
        HERS,
        20 + i,
      )
    }
    const few = changes((c) => {
      for (let i = 0; i < 4; i++) {
        c.created.push({ c: 'tasks', r: `x${i}` })
        c.collectionOf.set(`x${i}`, 'tasks')
      }
    })
    expect(shouldShowDigest(buildDigest([few], s, MINE))).toBe(false)

    const many = changes((c) => {
      for (let i = 0; i < 7; i++) {
        c.created.push({ c: 'tasks', r: `x${i}` })
        c.collectionOf.set(`x${i}`, 'tasks')
      }
    })
    expect(shouldShowDigest(buildDigest([many], s, MINE))).toBe(true)
  })
})

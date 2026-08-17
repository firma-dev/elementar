import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Clock, decodeHlc, encodeHlc, HLC_CTR_MAX } from '../../src/hlc.js'
import { isRecordId, recordId, seriesRecordId } from '../../src/id.js'
import { keyBetween, keysBetween, needsRebalance, orderDigits } from '../../src/frac.js'
import { createDocCore } from '../../src/doc/handle.js'
import { TxError } from '../../src/doc/tx.js'
import { coalesceOps } from '../../src/ops/coalesce.js'
import { shouldSnapshot, compactionUrgency } from '../../src/ops/compact.js'
import { migrateState } from '../../src/schema/migrate.js'
import { emptyState } from '../../src/doc/state.js'
import type { Op } from '../../src/ops/types.js'
import { ACTORS, hlcAt, PLANER } from './_fixture.js'

const TASK = 't000000000000001'

describe('HLC', () => {
  it('монотонны и уникальны в пределах одной миллисекунды', () => {
    const clock = new Clock(ACTORS[0], undefined, () => 1_700_000_000_000)
    const seen = new Set<string>()
    let prev = ''
    for (let i = 0; i < 1000; i++) {
      const t = clock.tick()
      expect(t > prev).toBe(true)
      expect(seen.has(t)).toBe(false)
      seen.add(t)
      prev = t
    }
  })

  it('переполнение счётчика двигает wall и не ломает монотонность', () => {
    const clock = new Clock(ACTORS[0], { wall: 5, ctr: HLC_CTR_MAX }, () => 1)
    const a = clock.tick()
    const b = clock.tick()
    expect(decodeHlc(a)?.wall).toBe(6)
    expect(decodeHlc(a)?.ctr).toBe(0)
    expect(b > a).toBe(true)
  })

  it('кодирование обратимо', () => {
    const h = { wall: 1_700_000_000_000, ctr: 7, actor: ACTORS[2] }
    expect(decodeHlc(encodeHlc(h))).toEqual(h)
    expect(decodeHlc('мусор')).toBeNull()
  })
})

describe('идентификаторы', () => {
  it('recordId сортируем по времени и имеет 16 символов base62', () => {
    const a = recordId(1_700_000_000_000)
    const b = recordId(1_700_000_001_000)
    expect(isRecordId(a)).toBe(true)
    expect(a < b).toBe(true)
  })

  it('seriesRecordId детерминирован', () => {
    const a = seriesRecordId('t000000000000001', 7)
    expect(a).toBe(seriesRecordId('t000000000000001', 7))
    expect(a).not.toBe(seriesRecordId('t000000000000001', 8))
    expect(isRecordId(a)).toBe(true)
  })
})

describe('дробный индекс', () => {
  it('ключ всегда строго между соседями', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(3), { maxLength: 30 }), (steps) => {
        const keys: string[] = []
        for (const s of steps) {
          const at = keys.length === 0 ? 0 : s % (keys.length + 1)
          const left = at === 0 ? null : (keys[at - 1] as string)
          const right = at === keys.length ? null : (keys[at] as string)
          const k = keyBetween(left, right, ACTORS[0])
          if (left !== null) expect(k > left).toBe(true)
          if (right !== null) expect(k < right).toBe(true)
          keys.splice(at, 0, k)
        }
        expect([...keys].sort()).toEqual(keys)
      }),
      { numRuns: 200 },
    )
  })

  it('двое офлайн получают разные ключи между теми же соседями, оба выживают', () => {
    const a = keyBetween('V#aaaa1111', 'k#aaaa1111', ACTORS[0])
    const b = keyBetween('V#aaaa1111', 'k#aaaa1111', ACTORS[1])
    expect(a).not.toBe(b)
    expect(orderDigits(a)).toBe(orderDigits(b))
    expect([a, b].sort()).toEqual([a, b].sort()) // порядок между ними детерминирован
  })

  it('keysBetween выдаёт возрастающую последовательность', () => {
    const keys = keysBetween(null, null, 8, ACTORS[0])
    expect(keys).toHaveLength(8)
    expect([...keys].sort()).toEqual(keys)
  })

  it('needsRebalance срабатывает на длинных ключах', () => {
    expect(needsRebalance(['V#aaaa1111'])).toBe(false)
    expect(needsRebalance([`${'z'.repeat(50)}#aaaa1111`])).toBe(true)
  })
})

describe('транзакции', () => {
  const doc = () => createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0] })

  it('заполняет значения по умолчанию и ставит ключ порядка', () => {
    const d = doc()
    const res = d.tx((t) => {
      t.col['task'].create({ title: 'молоко' }, { at: 'end' }, TASK)
    })
    expect(res.ids).toEqual([TASK])
    const row = d.col.task.byId(TASK).value as unknown as Record<string, unknown>
    expect(row['done']).toBe(false)
    expect(row['bucket']).toBe('list:work')
    expect(d._state.value.col['task']?.[TASK]?.o?.v).toBeTruthy()
  })

  it('нарушение схемы — исключение, ни одна операция не записана', () => {
    const d = doc()
    d.tx((t) => {
      t.col['task'].create({ title: 'есть' }, { at: 'end' }, TASK)
    })
    const before = d.stateHash()
    expect(() =>
      d.tx((t) => {
        t.col['task'].update(TASK, { title: 'ок' })
        t.col['task'].update(TASK, { date: 'вчера' })
      }),
    ).toThrow(TxError)
    expect(d.stateHash()).toBe(before)

    expect(() =>
      d.tx((t) => {
        t.col['task'].create({ title: 'x'.repeat(500) })
      }),
    ).toThrow(/длиннее/)
    expect(() =>
      d.tx((t) => {
        t.col['task'].create({ bucket: 'nope:1' })
      }),
    ).toThrow(/вариант/)
    expect(() =>
      d.tx((t) => {
        t.col['task'].create({ bucket: 'proj:неттакого' })
      }),
    ).toThrow(/не существует/)
    expect(d.stateHash()).toBe(before)
  })

  it('порядок: start, end, before, after', () => {
    const d = doc()
    const ids: string[] = []
    d.tx((t) => {
      ids.push(t.col['task'].create({ title: 'a' }, { at: 'end' }))
      ids.push(t.col['task'].create({ title: 'b' }, { at: 'end' }))
      ids.push(t.col['task'].create({ title: 'c' }, { at: 'start' }))
    })
    const order = () => (d.col.task.all.value as unknown as Array<{ id: string }>).map((r) => r.id)
    expect(order()).toEqual([ids[2], ids[0], ids[1]])
    d.tx((t) => {
      t.col['task'].move(ids[1] as string, { before: ids[0] as string })
    })
    expect(order()).toEqual([ids[2], ids[1], ids[0]])
    d.tx((t) => {
      t.col['task'].move(ids[2] as string, { after: ids[0] as string })
    })
    expect(order()).toEqual([ids[1], ids[0], ids[2]])
  })

  it('множества: addTo/removeFrom', () => {
    const d = doc()
    d.tx((t) => {
      t.col['task'].create({ title: 'с тегами' }, { at: 'end' }, TASK)
      t.col['task'].addTo(TASK, 'tags', 'дом', 'срочно')
    })
    expect((d.col.task.byId(TASK).value as unknown as { tags: string[] }).tags).toEqual(['дом', 'срочно'])
    d.tx((t) => {
      t.col['task'].removeFrom(TASK, 'tags', 'срочно')
    })
    expect((d.col.task.byId(TASK).value as unknown as { tags: string[] }).tags).toEqual(['дом'])
  })

  it('мета документа правится и материализуется', () => {
    const d = doc()
    d.tx((t) => {
      t.meta({ title: 'Наш планер' })
    })
    expect(d.meta.value['title']).toBe('Наш планер')
    expect(d.meta.value['weekStart']).toBe('1')
  })
})

describe('конфликты длинного текста', () => {
  it('проигравшая версия видна чипом и уходит после решения человека', () => {
    const a = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0] })
    const b = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[1] })
    const outA: Op[] = []
    const outB: Op[] = []
    a.onLocalOps((o) => outA.push(...o))
    b.onLocalOps((o) => outB.push(...o))

    a.tx((t) => {
      t.col['task'].create({ title: 'заметка' }, { at: 'end' }, TASK)
    })
    b.applyRemote(outA.splice(0, outA.length))

    a.tx((t) => {
      t.col['task'].update(TASK, { note: 'вариант Виктора' })
    })
    b.tx((t) => {
      t.col['task'].update(TASK, { note: 'вариант Ани' })
    })
    b.applyRemote(outA.splice(0, outA.length))
    a.applyRemote(outB.splice(0, outB.length))

    expect(a.stateHash()).toBe(b.stateHash())
    const conflicts = a.col.task.conflicts(TASK).value as Record<string, unknown[]>
    expect(conflicts['note']).toHaveLength(1)

    // человек посмотрел на поле и решил — кольцо чистится у обоих
    a.tx((t) => {
      t.col['task'].resolveConflict(TASK, 'note', 'общий вариант')
    })
    b.applyRemote(outA.splice(0, outA.length))
    expect((a.col.task.conflicts(TASK).value as Record<string, unknown[]>)['note']).toBeUndefined()
    expect(a.stateHash()).toBe(b.stateHash())
  })

  it('последовательные правки одного человека конфликтом не считаются', () => {
    const d = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0] })
    d.tx((t) => {
      t.col['task'].create({ title: 'заметка' }, { at: 'end' }, TASK)
    })
    for (const text of ['раз', 'два', 'три']) {
      d.tx((t) => {
        t.col['task'].update(TASK, { note: text })
      })
    }
    expect((d.col.task.conflicts(TASK).value as Record<string, unknown[]>)['note']).toBeUndefined()
  })
})

describe('запросы и холодная часть', () => {
  it('where, сортировка, лимит и поиск', () => {
    const d = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0] })
    d.tx((t) => {
      t.col['task'].create({ title: 'молоко', done: false }, { at: 'end' })
      t.col['task'].create({ title: 'хлеб', done: true }, { at: 'end' })
      t.col['task'].create({ title: 'молочный шоколад', done: false }, { at: 'end' })
    })
    expect(d.col.task.where({ done: false }).value).toHaveLength(2)
    expect(d.col.task.where({ $search: 'молоч' }).value).toHaveLength(1)
    expect(d.col.task.where({ $order: { by: 'title', dir: 'desc' }, $limit: 1 }).value).toHaveLength(1)
    expect(d.col.task.count.value).toBe(3)
  })

  it('холодные записи не попадают в сигналы, но доступны через cold()', async () => {
    const now = 1_700_000_000_000
    const d = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0], now: () => now })
    d.tx((t) => {
      t.col['task'].create({ title: 'старое', done: true, doneAt: now - 200 * 864e5 }, { at: 'end' })
      t.col['task'].create({ title: 'свежее' }, { at: 'end' })
    })
    expect(d.col.task.all.value).toHaveLength(1)
    expect(await d.col.task.cold()).toHaveLength(1)
  })
})

describe('схлопывание и компактизация', () => {
  it('последовательные правки одного актора схлопываются в одну', () => {
    const ops: Op[] = [
      { i: hlcAt(0, ACTORS[0]), k: 's', c: 'task', r: TASK, v: { note: 'п' } },
      { i: hlcAt(1, ACTORS[0]), k: 's', c: 'task', r: TASK, v: { note: 'пр' } },
      { i: hlcAt(2, ACTORS[0]), k: 's', c: 'task', r: TASK, v: { note: 'при' } },
    ]
    const out = coalesceOps(ops)
    expect(out).toHaveLength(1)
    expect(out[0]?.i).toBe(hlcAt(2, ACTORS[0]))
    expect((out[0] as { v: Record<string, unknown> }).v['note']).toBe('при')
  })

  it('чужая операция и другой вид закрывают окно', () => {
    const ops: Op[] = [
      { i: hlcAt(0, ACTORS[0]), k: 's', c: 'task', r: TASK, v: { note: 'п' } },
      { i: hlcAt(1, ACTORS[1]), k: 's', c: 'task', r: TASK, v: { note: 'чужое' } },
      { i: hlcAt(2, ACTORS[0]), k: 'd', c: 'task', r: TASK },
      { i: hlcAt(3, ACTORS[0]), k: 's', c: 'task', r: TASK, v: { note: 'после' } },
    ]
    expect(coalesceOps(ops)).toHaveLength(4)
  })

  it('пороги снапшота и компактизации', () => {
    const s = { ...emptyState('planer', 1), applied: 400 }
    expect(shouldSnapshot(s)).toBe(true)
    expect(shouldSnapshot(emptyState('planer', 1))).toBe(false)
    expect(compactionUrgency(10, 10)).toBe('none')
    expect(compactionUrgency(300, 10)).toBe('soft')
    expect(compactionUrgency(1300, 10)).toBe('hard')
  })
})

describe('версии схемы', () => {
  it('разрыв больше двух версий переводит документ в чтение', () => {
    const state = { ...emptyState('planer', 5), schema: 5 }
    expect(migrateState(state, PLANER).status).toBe('blocked')
    expect(migrateState({ ...emptyState('planer', 2), schema: 2 }, PLANER).status).toBe('ahead')
    expect(migrateState(emptyState('planer', 1), PLANER).status).toBe('ok')
  })

  it('миграции поднимают версию по лестнице', () => {
    const def = { ...PLANER, schemaVersion: 3, migrations: [
      { to: 2, up: (s: ReturnType<typeof emptyState>) => s },
      { to: 3, up: (s: ReturnType<typeof emptyState>) => s },
    ] }
    const res = migrateState(emptyState('planer', 1), def)
    expect(res.applied).toEqual([2, 3])
    expect(res.state.schema).toBe(3)
  })
})

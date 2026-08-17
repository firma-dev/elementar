import { describe, expect, it } from 'vitest'
import { Clock, encodeHlc } from '../../src/hlc.js'
import { createDocCore } from '../../src/doc/handle.js'
import { applyAll } from '../../src/doc/apply.js'
import { emptyState } from '../../src/doc/state.js'
import type { Op } from '../../src/ops/types.js'
import { ACTORS, CTX, PLANER } from './_fixture.js'

const DAY = 864e5
const NOW = 1_700_000_000_000
const TASK = 't000000000000001'

describe('§6.3 серверное время в порядке не участвует', () => {
  it('правка трёхдневной давности не перебивает свежую правку партнёра', () => {
    // телефон мужа был офлайн с воскресенья: его часы отстают на трое суток
    const offline = new Clock(ACTORS[0], undefined, () => NOW - 3 * DAY)
    const online = new Clock(ACTORS[1], undefined, () => NOW)

    const husband = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[0], clock: offline })
    const wife = createDocCore({ def: PLANER, docId: 'D', actor: ACTORS[1], clock: online })

    const seed: Op[] = []
    husband.onLocalOps((ops) => seed.push(...ops))
    husband.tx((t) => {
      t.col['task'].create({ title: 'позвонить в транспортную', date: '2026-08-10' }, { at: 'end' }, TASK)
    })
    wife.applyRemote(seed.splice(0, seed.length))

    const oldOps: Op[] = []
    husband.onLocalOps((ops) => oldOps.push(...ops))
    husband.tx((t) => {
      t.col['task'].update(TASK, { date: '2026-08-11' })
    })

    wife.tx((t) => {
      t.col['task'].update(TASK, { date: '2026-08-13' })
    })

    // офлайн-правка приезжает сегодня, доставка поздняя — порядок задаёт HLC внутри операции
    wife.applyRemote(oldOps)
    const row = wife.col.task.byId(TASK).value as unknown as { date: string }
    expect(row.date).toBe('2026-08-13')
  })

  it('seq и ts кадра на разрешение конфликта не влияют', () => {
    const early = encodeHlc({ wall: NOW - 3 * DAY, ctr: 0, actor: ACTORS[0] })
    const late = encodeHlc({ wall: NOW, ctr: 0, actor: ACTORS[1] })
    const a: Op = { i: early, k: 's', c: 'task', r: TASK, v: { title: 'офлайн' } }
    const b: Op = { i: late, k: 's', c: 'task', r: TASK, v: { title: 'сегодня' } }
    const first = applyAll(emptyState('planer', 1), [a, b], CTX).state
    const second = applyAll(emptyState('planer', 1), [b, a], CTX).state
    const value = (s: typeof first): unknown => {
      const cell = s.col['task']?.[TASK]?.f['title']
      return cell !== undefined && 'v' in cell ? cell.v : undefined
    }
    expect(value(first)).toBe('сегодня')
    expect(value(second)).toBe('сегодня')
  })

  it('часы подтягиваются к чужой метке: следующая правка выигрывает', () => {
    const clock = new Clock(ACTORS[0], undefined, () => NOW - 3 * DAY)
    const remote = encodeHlc({ wall: NOW, ctr: 7, actor: ACTORS[1] })
    clock.observe(remote)
    expect(clock.tick() > remote).toBe(true)
    expect(clock.drift).toBeGreaterThanOrEqual(3 * DAY)
  })
})

import { describe, expect, it } from 'vitest'
import { computed, signal } from '@preact/signals-core'
import { applyAll } from '../../src/doc/apply.js'
import { emptyState } from '../../src/doc/state.js'
import type { DocState, Lww } from '../../src/doc/state.js'
import { Clock } from '../../src/hlc.js'
import type { Op } from '../../src/ops/types.js'
import { createProposalStore, isStaleAgainst, pruneExpiredProposals } from '../../src/proposals/store.js'
import type { ProposalStore } from '../../src/proposals/store.js'
import {
  PROPOSALS_COLLECTION,
  PROPOSAL_TTL_MS,
  listProposals,
} from '../../src/proposals/types.js'
import type { ProposalDraft, ProposalOrigin } from '../../src/proposals/types.js'

const HUMAN = 'human000'
const ORIGIN: ProposalOrigin = {
  provider: 'anthropic',
  model: 'sonnet',
  runId: 'run-1',
  toolName: 'plan_move',
  by: 'agent000',
}

interface Harness {
  store: ProposalStore
  state: { value: DocState }
  clock: Clock
  committed: Op[]
  now: { value: number }
}

function harness(): Harness {
  const now = { value: 1_700_000_000_000 }
  const state = signal<DocState>(emptyState('planer', 1))
  const clock = new Clock(HUMAN, undefined, () => now.value)
  const committed: Op[] = []
  const store = createProposalStore({
    state: computed(() => state.value),
    actor: HUMAN,
    tick: () => clock.tick(),
    commit: (ops) => {
      committed.push(...ops)
      state.value = applyAll(state.value, ops).state
    },
    now: () => now.value,
  })
  return { store, state, clock, committed, now }
}

function draft(recordId = 'r0000000000000001', title = 'Собрать коробки'): ProposalDraft {
  return {
    title: 'Разложить переезд',
    rationale: 'Три недели до даты',
    changes: [
      {
        kind: 'create',
        collection: 'tasks',
        recordId,
        label: title,
        after: { title },
        ops: [
          {
            i: '000000000001-0000-agent000',
            k: 's',
            c: 'tasks',
            r: recordId,
            v: { title },
          },
        ],
      },
    ],
  }
}

describe('предложения агента: жизненный цикл', () => {
  it('put кладёт предложение в _proposals, а не в реальные записи', async () => {
    const h = harness()
    const id = await h.store.put(draft(), ORIGIN)
    expect(h.state.value.col['tasks']).toBeUndefined()
    expect(h.state.value.col[PROPOSALS_COLLECTION]?.[id]).toBeDefined()
    const pending = h.store.pending.value
    expect(pending.length).toBe(1)
    expect(pending[0]?.title).toBe('Разложить переезд')
    expect(pending[0]?.origin.by).toBe('agent000')
    expect(pending[0]?.status).toBe('pending')
  })

  it('accept применяет операции от имени человека и на свежих HLC', async () => {
    const h = harness()
    const id = await h.store.put(draft(), ORIGIN)
    await h.store.accept(id)
    const task = h.state.value.col['tasks']?.['r0000000000000001']
    expect((task?.f['title'] as Lww | undefined)?.v).toBe('Собрать коробки')
    const applied = h.committed.filter((o) => o.k === 's' && 'c' in o && o.c === 'tasks')
    expect(applied.length).toBe(1)
    expect(applied[0]?.i.endsWith(HUMAN)).toBe(true)
    expect(applied[0]?.i).not.toBe('000000000001-0000-agent000')
    expect(h.store.pending.value.length).toBe(0)
    expect(h.store.get(id)?.status).toBe('accepted')
  })

  it('частичное принятие берётся по индексам changes[]', async () => {
    const h = harness()
    const d = draft('r0000000000000001', 'Коробки')
    d.changes.push({
      kind: 'create',
      collection: 'tasks',
      recordId: 'r0000000000000002',
      label: 'Машина',
      after: { title: 'Машина' },
      ops: [
        {
          i: '000000000002-0000-agent000',
          k: 's',
          c: 'tasks',
          r: 'r0000000000000002',
          v: { title: 'Машина' },
        },
      ],
    })
    const id = await h.store.put(d, ORIGIN)
    await h.store.accept(id, [1])
    expect(h.state.value.col['tasks']?.['r0000000000000002']).toBeDefined()
    expect(h.state.value.col['tasks']?.['r0000000000000001']).toBeUndefined()
    const left = h.store.get(id)
    expect(left?.status).toBe('pending')
    expect(left?.changes.length).toBe(1)
    expect(left?.changes[0]?.recordId).toBe('r0000000000000001')
  })

  it('reject не трогает документ', async () => {
    const h = harness()
    const id = await h.store.put(draft(), ORIGIN)
    await h.store.reject(id)
    expect(h.state.value.col['tasks']).toBeUndefined()
    expect(h.store.pending.value.length).toBe(0)
    expect(h.store.get(id)?.status).toBe('rejected')
  })

  it('повторное принятие не применяет операции дважды', async () => {
    const h = harness()
    const id = await h.store.put(draft(), ORIGIN)
    await h.store.accept(id)
    const after = h.committed.length
    await h.store.accept(id)
    expect(h.committed.length).toBe(after)
  })

  it('правка черновика меняет само предложение, а не задачу', async () => {
    const h = harness()
    const id = await h.store.put(draft(), ORIGIN)
    await h.store.edit(id, 0, { title: 'Собрать коробки на кухне' })
    expect(h.state.value.col['tasks']).toBeUndefined()
    const p = h.store.get(id)
    expect(p?.changes[0]?.after?.['title']).toBe('Собрать коробки на кухне')
    await h.store.accept(id)
    const task = h.state.value.col['tasks']?.['r0000000000000001']
    expect((task?.f['title'] as Lww | undefined)?.v).toBe('Собрать коробки на кухне')
  })
})

describe('предложения агента: устаревание и rebase', () => {
  it('свежее предложение по существующей записи не устарело', async () => {
    const h = harness()
    // сначала реальная задача
    h.state.value = applyAll(h.state.value, [
      { i: h.clock.tick(), k: 's', c: 'tasks', r: 'r1', v: { title: 'Коробки' } },
    ]).state
    const d = draft('r1', 'Коробки')
    d.changes[0] = { ...(d.changes[0] as (typeof d.changes)[0]), kind: 'update' }
    const id = await h.store.put(d, ORIGIN)
    const p = h.store.get(id)
    expect(p).not.toBeNull()
    if (p !== null) expect(h.store.isStale(p)).toBe(false)
  })

  it('чужая правка под предложением делает его устаревшим', async () => {
    const h = harness()
    h.state.value = applyAll(h.state.value, [
      { i: h.clock.tick(), k: 's', c: 'tasks', r: 'r1', v: { title: 'Коробки' } },
    ]).state
    const d = draft('r1', 'Коробки')
    d.changes[0] = { ...(d.changes[0] as (typeof d.changes)[0]), kind: 'update' }
    const id = await h.store.put(d, ORIGIN)
    h.now.value += 1_000
    h.state.value = applyAll(h.state.value, [
      { i: h.clock.tick(), k: 's', c: 'tasks', r: 'r1', v: { title: 'Коробки и книги' } },
    ]).state
    const p = h.store.get(id)
    expect(p).not.toBeNull()
    if (p !== null) {
      expect(isStaleAgainst(h.state.value, p)).toBe(true)
      expect(h.store.isStale(p)).toBe(true)
    }
  })

  it('rebase обновляет отпечаток и «было», после него предложение свежее', async () => {
    const h = harness()
    h.state.value = applyAll(h.state.value, [
      { i: h.clock.tick(), k: 's', c: 'tasks', r: 'r1', v: { title: 'Коробки' } },
    ]).state
    const d = draft('r1', 'Коробки')
    d.changes[0] = { ...(d.changes[0] as (typeof d.changes)[0]), kind: 'update' }
    const id = await h.store.put(d, ORIGIN)
    h.now.value += 1_000
    h.state.value = applyAll(h.state.value, [
      { i: h.clock.tick(), k: 's', c: 'tasks', r: 'r1', v: { title: 'Коробки и книги' } },
    ]).state
    const rebased = await h.store.rebase(id)
    expect(rebased.changes[0]?.before?.['title']).toBe('Коробки и книги')
    expect(h.store.isStale(rebased)).toBe(false)
  })

  it('rebase выбрасывает изменения по исчезнувшим записям', async () => {
    const h = harness()
    h.state.value = applyAll(h.state.value, [
      { i: h.clock.tick(), k: 's', c: 'tasks', r: 'r1', v: { title: 'Коробки' } },
    ]).state
    const d = draft('r1', 'Коробки')
    d.changes[0] = { ...(d.changes[0] as (typeof d.changes)[0]), kind: 'update' }
    const id = await h.store.put(d, ORIGIN)
    h.state.value = applyAll(h.state.value, [
      { i: h.clock.tick(), k: 'd', c: 'tasks', r: 'r1' },
    ]).state
    const rebased = await h.store.rebase(id)
    expect(rebased.changes.length).toBe(0)
  })
})

describe('предложения агента: истечение', () => {
  it('pending — фильтр представления: через 24 часа предложение просто не показывается', async () => {
    const h = harness()
    await h.store.put(draft(), ORIGIN)
    expect(h.store.pending.value.length).toBe(1)
    h.now.value += PROPOSAL_TTL_MS + 1
    h.store.refresh()
    expect(h.store.pending.value.length).toBe(0)
    expect(h.store.all.value.length).toBe(1)
  })

  it('физическая чистка — локальная операция при снапшоте, не правка документа', async () => {
    const h = harness()
    await h.store.put(draft(), ORIGIN)
    const fresh = pruneExpiredProposals(h.state.value, h.now.value)
    expect(fresh).toBe(h.state.value)
    const later = pruneExpiredProposals(h.state.value, h.now.value + PROPOSAL_TTL_MS + 1)
    expect(listProposals(later).length).toBe(0)
    expect(later.col[PROPOSALS_COLLECTION]).toBeUndefined()
  })

  it('принятые и отклонённые тоже вычищаются при снапшоте', async () => {
    const h = harness()
    const id = await h.store.put(draft(), ORIGIN)
    await h.store.reject(id)
    const pruned = pruneExpiredProposals(h.state.value, h.now.value + PROPOSAL_TTL_MS + 1)
    expect(listProposals(pruned).length).toBe(0)
  })
})

describe('предложения агента: разбор чужого', () => {
  it('битое предложение от партнёра игнорируется, а не ломает список', () => {
    const state = emptyState('planer', 1)
    state.col[PROPOSALS_COLLECTION] = {
      good: {
        f: {
          title: { v: 'Норм', t: '000000000001-0000-agent000' },
          origin: {
            v: { provider: 'a', model: 'm', runId: 'r', toolName: 't', by: 'agent000' },
            t: '000000000001-0000-agent000',
          },
          changes: { v: [], t: '000000000001-0000-agent000' },
          base: { v: {}, t: '000000000001-0000-agent000' },
          status: { v: 'pending', t: '000000000001-0000-agent000' },
          createdAt: { v: '000000000001-0000-agent000', t: '000000000001-0000-agent000' },
        },
        cre: '000000000001-0000-agent000',
        upd: '000000000001-0000-agent000',
      },
      bad: {
        f: { title: { v: 42, t: '000000000001-0000-agent000' } },
        cre: '000000000001-0000-agent000',
        upd: '000000000001-0000-agent000',
      },
    }
    const list = listProposals(state)
    expect(list.length).toBe(1)
    expect(list[0]?.id).toBe('good')
  })
})

/**
 * Коллекция `_proposals`: put / accept / reject / edit / rebase (§10.4).
 *
 * Правило слоёв: агент физически не может мутировать документ. Всё, что он делает —
 * кладёт черновик сюда; операции применяются только через accept(), то есть жестом человека,
 * и уходят в лог уже от его актора.
 */
import { computed, signal } from '@preact/signals-core'
import type { ReadonlySignal } from '@preact/signals-core'
import { hlcWall } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import { recordId as newRecordId } from '../id.js'
import type { ActorId, RecordId } from '../id.js'
import type { JsonValue } from '../schema/types.js'
import type { Op } from '../ops/types.js'
import { isOrSet } from '../doc/state.js'
import type { DocState, Lww, RecordState } from '../doc/state.js'
import {
  PROPOSALS_COLLECTION,
  PROPOSAL_TTL_MS,
  baseKey,
  listProposals,
  proposalFromRecord,
  proposalToFields,
} from './types.js'
import type { Proposal, ProposalChange, ProposalDraft, ProposalOrigin } from './types.js'

/** Маркер уровня записи: удаление и перемещение не привязаны к полю. */
export const BASE_RECORD_FIELD = '*'

/**
 * Контракт хоста. `commit` обязан применить операции локально И отправить их в синк
 * как свои (это правка человека, а не пришедшая от партнёра).
 */
export interface ProposalHost {
  state: ReadonlySignal<DocState>
  actor: ActorId
  tick(): HlcString
  commit(ops: Op[]): void
  now?(): number
}

export interface ProposalStore {
  pending: ReadonlySignal<readonly Proposal[]>
  /** Все предложения, включая принятые и отклонённые. */
  all: ReadonlySignal<readonly Proposal[]>
  put(draft: ProposalDraft, origin: ProposalOrigin): Promise<RecordId>
  /** only — индексы changes[]. Однозначно, потому что ops лежат внутри change. */
  accept(id: RecordId, only?: number[]): Promise<void>
  reject(id: RecordId): Promise<void>
  /** Правка черновика до принятия — это правка самого Proposal, а не задачи. */
  edit(id: RecordId, changeIndex: number, patch: Record<string, JsonValue>): Promise<void>
  isStale(p: Proposal): boolean
  rebase(id: RecordId): Promise<Proposal>
  get(id: RecordId): Proposal | null
  /**
   * Пересчитать фильтр истечения: время не сигнал, поэтому «прошли сутки»
   * само по себе `pending` не обновляет. Зовётся по таймеру UI и при открытии шита.
   */
  refresh(): void
}

function cellHlc(rec: RecordState | undefined, field: string): HlcString | undefined {
  if (rec === undefined) return undefined
  if (field === BASE_RECORD_FIELD) return rec.upd
  const cell = rec.f[field]
  if (cell === undefined || isOrSet(cell)) return undefined
  return (cell as Lww).t
}

function cellValue(rec: RecordState | undefined, field: string): unknown {
  if (rec === undefined) return undefined
  const cell = rec.f[field]
  if (cell === undefined || isOrSet(cell)) return undefined
  return (cell as Lww).v
}

/** Поля, которых касается изменение: из операций, а не из `after` — они и применяются. */
export function fieldsOfChange(change: ProposalChange): string[] {
  const out = new Set<string>()
  for (const op of change.ops) {
    if (op.k === 's') for (const f of Object.keys(op.v)) out.add(f)
    else if (op.k === 'g+' || op.k === 'g-') out.add(op.p)
    else out.add(BASE_RECORD_FIELD)
  }
  return [...out]
}

/** Отпечаток состояния под предложением: по нему считается устаревание. */
export function fingerprint(state: DocState, changes: readonly ProposalChange[]): Record<string, HlcString> {
  const base: Record<string, HlcString> = {}
  for (const change of changes) {
    const rec = state.col[change.collection]?.[change.recordId]
    for (const field of fieldsOfChange(change)) {
      const t = cellHlc(rec, field)
      if (t !== undefined) base[baseKey(change.recordId, field)] = t
    }
  }
  return base
}

/** Значения полей до применения — то, что человек увидит как «было». */
export function beforeOf(state: DocState, change: ProposalChange): Record<string, unknown> {
  const rec = state.col[change.collection]?.[change.recordId]
  const out: Record<string, unknown> = {}
  for (const field of fieldsOfChange(change)) {
    if (field === BASE_RECORD_FIELD) continue
    const v = cellValue(rec, field)
    if (v !== undefined) out[field] = v
  }
  return out
}

/** Устарело ли предложение: под ним что-то изменилось после его создания. */
export function isStaleAgainst(state: DocState, p: Proposal): boolean {
  for (const change of p.changes) {
    const rec = state.col[change.collection]?.[change.recordId]
    for (const field of fieldsOfChange(change)) {
      const key = baseKey(change.recordId, field)
      const was = p.base[key]
      const now = cellHlc(rec, field)
      if (was === undefined) {
        // поля не было, а теперь есть — под предложением появилось чужое значение
        if (now !== undefined && change.kind !== 'create') return true
        continue
      }
      if (now === undefined || now > was) return true
    }
  }
  return false
}

/**
 * Физическая чистка истёкших предложений: локальная операция при записи снапшота (§10.4),
 * не правка документа. Возвращает то же состояние, если чистить нечего.
 */
export function pruneExpiredProposals(state: DocState, now: number = Date.now()): DocState {
  const bucket = state.col[PROPOSALS_COLLECTION]
  if (bucket === undefined) return state
  const kept: Record<RecordId, RecordState> = {}
  let dropped = 0
  for (const [id, rec] of Object.entries(bucket)) {
    const p = proposalFromRecord(id, rec)
    const created = p === null ? hlcWall(rec.cre) : hlcWall(p.createdAt)
    if (p !== null && p.status === 'pending' && now - created < PROPOSAL_TTL_MS) {
      kept[id] = rec
      continue
    }
    if (p === null || now - created >= PROPOSAL_TTL_MS) {
      dropped++
      continue
    }
    kept[id] = rec
  }
  if (dropped === 0) return state
  const col = { ...state.col }
  if (Object.keys(kept).length === 0) delete col[PROPOSALS_COLLECTION]
  else col[PROPOSALS_COLLECTION] = kept
  return { ...state, col }
}

export function createProposalStore(host: ProposalHost): ProposalStore {
  const now = (): number => (host.now ?? Date.now)()

  const epoch = signal(0)

  const all = computed<readonly Proposal[]>(() => listProposals(host.state.value))

  const pending = computed<readonly Proposal[]>(() => {
    void epoch.value
    const at = now()
    return all.value.filter((p) => p.status === 'pending' && at - hlcWall(p.createdAt) < PROPOSAL_TTL_MS)
  })

  const read = (id: RecordId): Proposal | null => {
    const rec = host.state.value.col[PROPOSALS_COLLECTION]?.[id]
    return rec === undefined ? null : proposalFromRecord(id, rec)
  }

  const write = (p: Proposal): void => {
    host.commit([
      {
        i: host.tick(),
        k: 's',
        c: PROPOSALS_COLLECTION,
        r: p.id,
        v: proposalToFields(p),
      },
    ])
  }

  return {
    pending,
    all,

    get: read,

    refresh(): void {
      epoch.value = epoch.value + 1
    },

    async put(draft, origin): Promise<RecordId> {
      const state = host.state.value
      const id = newRecordId(now())
      const changes = draft.changes.map((c) => ({ ...c, before: c.before ?? beforeOf(state, c) }))
      const p: Proposal = {
        id,
        title: draft.title,
        origin,
        changes,
        base: fingerprint(state, changes),
        status: 'pending',
        createdAt: host.tick(),
      }
      if (draft.rationale !== undefined && draft.rationale !== '') p.rationale = draft.rationale
      write(p)
      return id
    },

    async accept(id, only): Promise<void> {
      const p = read(id)
      if (p === null || p.status !== 'pending') return
      const picked =
        only === undefined
          ? p.changes
          : only
              .filter((i) => Number.isInteger(i) && i >= 0 && i < p.changes.length)
              .map((i) => p.changes[i] as ProposalChange)
      if (picked.length === 0) return
      // операции пересобираются на свежих HLC: применяет их человек, здесь и сейчас
      const ops: Op[] = picked.flatMap((c) => c.ops.map((op) => ({ ...op, i: host.tick() }) as Op))
      const partial = only !== undefined && picked.length < p.changes.length
      const rest = partial ? p.changes.filter((c) => !picked.includes(c)) : []
      const next: Proposal = partial
        ? { ...p, changes: rest, base: fingerprint(host.state.value, rest) }
        : { ...p, status: 'accepted' }
      host.commit([
        ...ops,
        { i: host.tick(), k: 's', c: PROPOSALS_COLLECTION, r: p.id, v: proposalToFields(next) },
      ])
    },

    async reject(id): Promise<void> {
      const p = read(id)
      if (p === null || p.status !== 'pending') return
      write({ ...p, status: 'rejected' })
    },

    async edit(id, changeIndex, patch): Promise<void> {
      const p = read(id)
      if (p === null || p.status !== 'pending') return
      const change = p.changes[changeIndex]
      if (change === undefined) return
      const ops = change.ops.map((op) => {
        if (op.k !== 's' || op.r !== change.recordId) return op
        return { ...op, v: { ...op.v, ...patch } }
      })
      const edited: ProposalChange = {
        ...change,
        ops,
        after: { ...(change.after ?? {}), ...patch },
      }
      const changes = p.changes.map((c, i) => (i === changeIndex ? edited : c))
      write({ ...p, changes })
    },

    isStale(p): boolean {
      return isStaleAgainst(host.state.value, p)
    },

    async rebase(id): Promise<Proposal> {
      const p = read(id)
      if (p === null) throw new Error(`proposal ${id} not found`)
      const state = host.state.value
      // изменения по исчезнувшим записям пересобирать не на чем — они отбрасываются
      const changes = p.changes.filter((c) => {
        if (c.kind === 'create') return true
        const rec = state.col[c.collection]?.[c.recordId]
        return rec !== undefined && (rec.del === undefined || (rec.und !== undefined && rec.und > rec.del))
      })
      const refreshed = changes.map((c) => ({ ...c, before: beforeOf(state, c) }))
      const next: Proposal = { ...p, changes: refreshed, base: fingerprint(state, refreshed) }
      write(next)
      return next
    },
  }
}

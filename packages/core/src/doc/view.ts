import { computed, signal } from '@preact/signals-core'
import type { ReadonlySignal, Signal } from '@preact/signals-core'
import { hlcActor } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import type { ActorId, RecordId } from '../id.js'
import { compareOrder } from '../frac.js'
import { defaultValue } from '../schema/define.js'
import { ORPHAN, parseTagged } from '../schema/types.js'
import type { CollectionSchema, CollectionsDef, CorpusDef, JsonValue, RecordOf } from '../schema/types.js'
import { isAlive, isOrSet, orSetValues } from './state.js'
import type { DocState, Lww, RecordState } from './state.js'
import type { ChangeSet } from './apply.js'
import { queryKey, runQuery } from './query.js'
import type { Where } from './query.js'

export interface Collection<T extends { id: RecordId }> {
  readonly name: string
  /** Живые, «горячие», в порядке дробного индекса. */
  readonly all: ReadonlySignal<readonly T[]>
  readonly count: ReadonlySignal<number>
  byId(id: RecordId): ReadonlySignal<T | undefined>
  where(spec: Where<T>): ReadonlySignal<readonly T[]>
  group<K extends keyof T>(field: K): ReadonlySignal<ReadonlyMap<T[K], readonly T[]>>
  conflicts(id: RecordId): ReadonlySignal<Partial<Record<keyof T, unknown[]>>>
  /** Холодная часть (§3.8): в сигналы не попадает. */
  cold(): Promise<readonly T[]>
}

export interface TrashItem {
  collection: string
  id: RecordId
  label: string
  deletedAt: HlcString
  deletedBy: ActorId
  /** Удалил не я. */
  byPeer: boolean
  /** Кто-то правил после удаления. */
  editedAfterDelete: boolean
}

export interface Trash<S extends CollectionsDef> {
  items: ReadonlySignal<readonly TrashItem[]>
  restore(collection: keyof S & string, id: RecordId): void
  purge(collection: keyof S & string, id: RecordId): void
  purgeAll(): void
}

/** Материализация одной записи по схеме. Неизвестные поля не показываются (§3.7). */
export function materializeRecord(
  col: CollectionSchema,
  id: RecordId,
  rec: RecordState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id,
    createdAt: rec.cre,
    updatedAt: rec.upd,
  }
  for (const [field, fs] of Object.entries(col.fields)) {
    const cell = rec.f[field]
    if (cell === undefined) {
      const d = defaultValue(fs)
      out[field] = fs.kind === 'set' ? [] : (d ?? null)
      continue
    }
    out[field] = isOrSet(cell) ? orSetValues(cell) : (cell as Lww).v
  }
  return out
}

/**
 * Эффективная группа записи (§3.5): живая запись, чей контейнер указывает на надгробие
 * или на несуществующую запись, показывается в псевдогруппе ORPHAN. Ячейка не меняется.
 */
export function effectiveGroup(
  def: CorpusDef,
  state: DocState,
  collection: string,
  value: unknown,
): unknown {
  const col = def.collections[collection]
  const groupBy = col?.groupBy
  if (col === undefined || groupBy === undefined || typeof value !== 'string') return value
  const fs = col.fields[groupBy]
  if (fs === undefined || fs.onDangling !== 'orphan') return value
  let target: string | null = null
  let of: string | undefined
  if (fs.kind === 'tagged') {
    const t = parseTagged(value)
    const variant = fs.variants?.[t.variant]
    if (variant?.ref === undefined || t.value === '') return value
    target = t.value
    of = variant.ref
  } else if (fs.kind === 'ref') {
    if (value === '') return value
    target = value
    of = fs.of
  } else return value
  if (of === undefined || target === null) return value
  const rec = state.col[of]?.[target]
  return rec !== undefined && isAlive(rec) ? value : ORPHAN
}

/** Коллекции, на которые может указывать поле-контейнер: их жизнь влияет на ORPHAN. */
function referencedCollections(def: CorpusDef, collection: string, field: string): string[] {
  const fs = def.collections[collection]?.fields[field]
  if (fs === undefined) return []
  const out = new Set<string>()
  if (fs.of !== undefined) out.add(fs.of)
  for (const v of Object.values(fs.variants ?? {})) if (v.ref !== undefined) out.add(v.ref)
  return [...out]
}

export interface ViewEnv {
  def: CorpusDef
  state: Signal<DocState>
  actor: ActorId
  now?: () => number
}

export interface DocView<S extends CollectionsDef> {
  col: { [K in keyof S]: Collection<RecordOf<S[K]>> }
  meta: ReadonlySignal<Record<string, unknown>>
  trashItems: ReadonlySignal<readonly TrashItem[]>
  /** Точечное обновление: дёргаются только сигналы затронутых записей и коллекций. */
  notify(changes: ChangeSet): void
  bumpAll(): void
}

interface Materialized {
  rec: RecordState
  value: Record<string, unknown>
}

export function createView<S extends CollectionsDef>(env: ViewEnv): DocView<S> {
  const { def } = env
  const now = env.now ?? Date.now
  const metaRev = signal(0)
  const trashRev = signal(0)
  const colRev = new Map<string, Signal<number>>()
  const recRev = new Map<string, Signal<number>>()
  const cache = new Map<string, Materialized>()

  const colRevOf = (name: string): Signal<number> => {
    let s = colRev.get(name)
    if (s === undefined) {
      s = signal(0)
      colRev.set(name, s)
    }
    return s
  }

  const recRevOf = (name: string, id: RecordId): Signal<number> => {
    const key = `${name} ${id}`
    let s = recRev.get(key)
    if (s === undefined) {
      s = signal(0)
      recRev.set(key, s)
    }
    return s
  }

  const materialize = (name: string, id: RecordId, rec: RecordState): Record<string, unknown> => {
    const key = `${name} ${id}`
    const hit = cache.get(key)
    if (hit !== undefined && hit.rec === rec) return hit.value
    const col = def.collections[name]
    if (col === undefined) return { id, createdAt: rec.cre, updatedAt: rec.upd }
    const value = materializeRecord(col, id, rec)
    cache.set(key, { rec, value })
    return value
  }

  const isCold = (col: CollectionSchema, value: Record<string, unknown>): boolean => {
    if (col.cold === undefined) return false
    return col.cold(value as unknown as RecordOf<CollectionSchema>, now())
  }

  const liveList = (name: string, includeCold: boolean): Array<Record<string, unknown>> => {
    const state = env.state.peek()
    const col = def.collections[name]
    const bucket = state.col[name]
    if (col === undefined || bucket === undefined) return []
    const rows: Array<{ id: RecordId; key: string | undefined; value: Record<string, unknown> }> = []
    for (const [id, rec] of Object.entries(bucket)) {
      if (!isAlive(rec)) continue
      const value = materialize(name, id, rec)
      const cold = isCold(col, value)
      if (cold !== includeCold) continue
      rows.push({ id, key: rec.o?.v, value })
    }
    rows.sort(compareOrder)
    return rows.map((r) => r.value)
  }

  const makeCollection = (name: string): Collection<{ id: RecordId }> => {
    const rev = colRevOf(name)
    const queries = new Map<string, ReadonlySignal<readonly unknown[]>>()
    const groups = new Map<string, ReadonlySignal<ReadonlyMap<unknown, readonly unknown[]>>>()
    const all = computed(() => {
      rev.value
      return liveList(name, false) as unknown as readonly { id: RecordId }[]
    })
    return {
      name,
      all,
      count: computed(() => all.value.length),
      byId(id: RecordId): ReadonlySignal<{ id: RecordId } | undefined> {
        const r = recRevOf(name, id)
        return computed(() => {
          r.value
          rev.value
          const rec = env.state.peek().col[name]?.[id]
          if (rec === undefined || !isAlive(rec)) return undefined
          return materialize(name, id, rec) as unknown as { id: RecordId }
        })
      },
      where(spec: Where<{ id: RecordId }>): ReadonlySignal<readonly { id: RecordId }[]> {
        const key = queryKey(spec)
        const hit = queries.get(key)
        if (hit !== undefined) return hit as ReadonlySignal<readonly { id: RecordId }[]>
        const sig = computed(() => runQuery(all.value as readonly object[], spec as Where<object>))
        queries.set(key, sig as unknown as ReadonlySignal<readonly unknown[]>)
        return sig as unknown as ReadonlySignal<readonly { id: RecordId }[]>
      },
      group<K extends keyof { id: RecordId }>(
        field: K,
      ): ReadonlySignal<ReadonlyMap<{ id: RecordId }[K], readonly { id: RecordId }[]>> {
        type Out = ReadonlySignal<ReadonlyMap<{ id: RecordId }[K], readonly { id: RecordId }[]>>
        const key = String(field)
        const hit = groups.get(key)
        if (hit !== undefined) return hit as unknown as Out
        // видимость группы зависит от живости записей, на которые смотрит контейнер
        const refCols = referencedCollections(def, name, key)
        const sig = computed(() => {
          for (const rc of refCols) colRevOf(rc).value
          const state = env.state.peek()
          const out = new Map<unknown, Array<Record<string, unknown>>>()
          for (const row of all.value as unknown as Array<Record<string, unknown>>) {
            const raw = row[key]
            const g = key === def.collections[name]?.groupBy ? effectiveGroup(def, state, name, raw) : raw
            const list = out.get(g)
            if (list === undefined) out.set(g, [row])
            else list.push(row)
          }
          return out as ReadonlyMap<unknown, readonly Record<string, unknown>[]>
        })
        groups.set(key, sig as unknown as ReadonlySignal<ReadonlyMap<unknown, readonly unknown[]>>)
        return sig as unknown as Out
      },
      conflicts(id: RecordId): ReadonlySignal<Partial<Record<string, unknown[]>>> {
        const r = recRevOf(name, id)
        return computed(() => {
          r.value
          const rec = env.state.peek().col[name]?.[id]
          const out: Record<string, unknown[]> = {}
          if (rec === undefined) return out
          for (const [field, cell] of Object.entries(rec.f)) {
            if (isOrSet(cell)) continue
            const losers = (cell as Lww).c
            if (losers === undefined || losers.length === 0) continue
            out[field] = losers.map((l) => l.v as unknown)
          }
          return out
        })
      },
      async cold(): Promise<readonly { id: RecordId }[]> {
        return liveList(name, true) as unknown as readonly { id: RecordId }[]
      },
    }
  }

  const cols: Record<string, Collection<{ id: RecordId }>> = {}
  for (const name of Object.keys(def.collections)) cols[name] = makeCollection(name)

  const meta = computed(() => {
    metaRev.value
    const state = env.state.peek()
    const out: Record<string, unknown> = {}
    for (const [key, fs] of Object.entries(def.meta ?? {})) {
      const cell = state.meta[key]
      out[key] = cell === undefined ? (defaultValue(fs) ?? null) : cell.v
    }
    for (const [key, cell] of Object.entries(state.meta)) if (!(key in out)) out[key] = cell.v
    return out
  })

  const trashItems = computed(() => {
    trashRev.value
    const state = env.state.peek()
    const out: TrashItem[] = []
    for (const [name, bucket] of Object.entries(state.col)) {
      const col = def.collections[name]
      if (col === undefined) continue
      for (const [id, rec] of Object.entries(bucket)) {
        if (isAlive(rec) || rec.del === undefined) continue
        const value = materialize(name, id, rec)
        const by = hlcActor(rec.del)
        out.push({
          collection: name,
          id,
          label: col.label(value as unknown as RecordOf<CollectionSchema>),
          deletedAt: rec.del,
          deletedBy: by,
          byPeer: by !== env.actor,
          editedAfterDelete: rec.upd > rec.del,
        })
      }
    }
    out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0))
    return out as readonly TrashItem[]
  })

  const bumpAll = (): void => {
    metaRev.value = metaRev.value + 1
    trashRev.value = trashRev.value + 1
    for (const s of colRev.values()) s.value = s.value + 1
    for (const s of recRev.values()) s.value = s.value + 1
  }

  const notify = (changes: ChangeSet): void => {
    const touchedCols = new Set<string>()
    const touchedRecs = new Set<string>()
    const mark = (c: string, r: RecordId): void => {
      touchedCols.add(c)
      touchedRecs.add(`${c} ${r}`)
    }
    for (const a of [...changes.created, ...changes.deleted, ...changes.moved, ...changes.restored]) mark(a.c, a.r)
    for (const [id, col] of changes.collectionOf) mark(col, id)
    for (const id of changes.updated.keys()) {
      const col = changes.collectionOf.get(id)
      if (col !== undefined) mark(col, id)
    }
    for (const c of touchedCols) {
      const s = colRev.get(c)
      if (s !== undefined) s.value = s.value + 1
    }
    for (const key of touchedRecs) {
      const s = recRev.get(key)
      if (s !== undefined) s.value = s.value + 1
    }
    if (changes.meta.length > 0) metaRev.value = metaRev.value + 1
    if (changes.deleted.length > 0 || changes.restored.length > 0 || changes.updated.size > 0)
      trashRev.value = trashRev.value + 1
  }

  return {
    col: cols as unknown as { [K in keyof S]: Collection<RecordOf<S[K]>> },
    meta,
    trashItems,
    notify,
    bumpAll,
  }
}

/** Значения ячеек как JSON — для сводки и экспорта. */
export function recordValues(rec: RecordState): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [field, cell] of Object.entries(rec.f))
    out[field] = isOrSet(cell) ? orSetValues(cell) : (cell as Lww).v
  return out
}

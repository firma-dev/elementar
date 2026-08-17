import { computed, signal } from '@preact/signals-core'
import type { ReadonlySignal, Signal } from '@preact/signals-core'
import { Clock } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import type { ActorId, RecordId } from '../id.js'
import { applyContextOf, f } from '../schema/define.js'
import type { CollectionSchema, CollectionsDef, CorpusDef, RecordOf } from '../schema/types.js'
import { Emitter } from '../util/emitter.js'
import type { Unsubscribe } from '../util/emitter.js'
import type { AnyOp, Op } from '../ops/types.js'
import { applyAll, emptyChangeSet } from './apply.js'
import type { ApplyContext, ChangeSet } from './apply.js'
import { mergeState } from './merge.js'
import { purgeTombstones } from './purge.js'
import { emptyState, isAlive, stateHash as hashOf } from './state.js'
import type { DocState, Lww, RecordState } from './state.js'
import { createTx } from './tx.js'
import type { Tx, TxResult } from './tx.js'
import { createUndo } from './undo.js'
import type { UndoController, UndoHandle } from './undo.js'
import { createView } from './view.js'
import type { Collection, Trash } from './view.js'

/** Участник документа (§3.9, §6.14). Живёт в служебной коллекции `_actors`. */
export interface ActorRecord {
  id: ActorId
  name: string
  lastSeenAt: number
  mergedInto?: ActorId
}

export const ACTORS_COLLECTION = '_actors'

/** Служебные коллекции ядра: в CorpusData не попадают, обычными запросами не видны. */
export function serviceCollections(): Record<string, CollectionSchema> {
  return {
    [ACTORS_COLLECTION]: {
      fields: {
        name: f.text({ max: 64 }),
        lastSeenAt: f.number(),
        mergedInto: f.nullable(f.text({ max: 16 })),
      },
      label(rec): string {
        const name = (rec as unknown as { name?: unknown }).name
        return typeof name === 'string' && name !== '' ? name : 'Кто-то'
      },
    },
  }
}

function withService<S extends CollectionsDef>(def: CorpusDef<S>): CorpusDef {
  return { ...def, collections: { ...serviceCollections(), ...def.collections } }
}

export interface DocCoreOptions<S extends CollectionsDef> {
  def: CorpusDef<S>
  docId: string
  actor: ActorId
  state?: DocState
  clock?: Clock
  now?: () => number
}

export interface TxOptions {
  label?: string
  undoable?: boolean
}

/**
 * Ядро документа без ввода-вывода: состояние, транзакции, undo, материализация.
 * Синк, хранилище и крипта надстраиваются поверх (см. `DocHandle` в фасаде).
 */
export interface DocCore<S extends CollectionsDef> {
  readonly id: string
  readonly corpus: string
  readonly actor: ActorId
  readonly clock: Clock

  readonly title: Signal<string>
  readonly meta: ReadonlySignal<Record<string, unknown>>
  readonly col: { [K in keyof S]: Collection<RecordOf<S[K]>> }

  tx(fn: (t: Tx<S>) => void, opts?: TxOptions): TxResult

  readonly undo: UndoHandle
  readonly trash: Trash<S>
  readonly actors: ReadonlySignal<readonly ActorRecord[]>

  readonly _state: ReadonlySignal<DocState>
  stateHash(): string
  onChange(cb: (c: ChangeSet) => void): Unsubscribe
  /** Локальные операции, готовые к отправке: точка подключения outbox. */
  onLocalOps(cb: (ops: Op[]) => void): Unsubscribe

  /** Применить чужие операции (из синка или импорта). */
  applyRemote(ops: readonly AnyOp[]): ChangeSet
  /** Слить чужой снапшот с локальным состоянием (§6.8). */
  mergeRemote(snapshot: DocState): ChangeSet
  /** Подвинуть водяной знак и вычистить надгробия (§6.7). */
  purgeUpto(upto: HlcString): void
  /** Заменить состояние целиком (загрузка снапшота с диска). */
  setState(state: DocState): void
  /** Записать имя устройства в `_actors`. */
  setActorName(name: string, at?: number): void
}

export function createDocCore<S extends CollectionsDef>(opts: DocCoreOptions<S>): DocCore<S> {
  const def = withService(opts.def)
  const ctx: ApplyContext = applyContextOf(def)
  const clock = opts.clock ?? new Clock(opts.actor)
  const state: Signal<DocState> = signal(opts.state ?? emptyState(opts.def.id, opts.def.schemaVersion))
  const events = new Emitter<{ change: ChangeSet; ops: Op[] }>()
  const view = createView<S>({
    def,
    state,
    actor: opts.actor,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })

  const observeOps = (ops: readonly AnyOp[]): void => {
    for (const op of ops) clock.observe(op.i)
  }

  const publish = (changes: ChangeSet, localOps: Op[]): void => {
    view.notify(changes)
    events.emit('change', changes)
    if (localOps.length > 0) events.emit('ops', localOps)
  }

  const commit = (ops: Op[]): ChangeSet => {
    if (ops.length === 0) return emptyChangeSet()
    const res = applyAll(state.value, ops, ctx)
    state.value = res.state
    publish(res.changes, ops)
    return res.changes
  }

  const undo: UndoController = createUndo({
    state: () => state.value,
    def,
    clock,
    actor: opts.actor,
    commit: (ops) => {
      commit(ops)
    },
  })

  const title = signal('')

  const tx = (fn: (t: Tx<S>) => void, txOpts?: TxOptions): TxResult => {
    const pre = state.value
    const { tx: t, run } = createTx({ state: pre, def, clock, actor: opts.actor, ctx })
    fn(t as unknown as Tx<S>)
    if (run.ops.length === 0) return { ops: 0, ids: [], undoToken: null }
    state.value = run.state
    publish(run.changes, run.ops)
    const token =
      txOpts?.undoable === false ? null : undo.record(pre, run.ops, txOpts?.label ?? '')
    return { ops: run.ops.length, ids: run.ids, undoToken: token }
  }

  const actors = computed<readonly ActorRecord[]>(() => {
    const rows = (view.col as unknown as Record<string, Collection<{ id: RecordId }> | undefined>)[
      ACTORS_COLLECTION
    ]
    const list = rows === undefined ? [] : (rows.all.value as unknown as Array<Record<string, unknown>>)
    return list.map((r) => {
      const mergedInto = r['mergedInto']
      const out: ActorRecord = {
        id: String(r['id']),
        name: typeof r['name'] === 'string' ? r['name'] : '',
        lastSeenAt: typeof r['lastSeenAt'] === 'number' ? r['lastSeenAt'] : 0,
      }
      if (typeof mergedInto === 'string' && mergedInto !== '') out.mergedInto = mergedInto
      return out
    })
  })

  const trash: Trash<S> = {
    items: view.trashItems,
    restore(collection, id): void {
      commit([{ i: clock.tick(), k: 'u', c: collection, r: id }])
    },
    purge(collection, id): void {
      const cur = state.value
      const bucket = cur.col[collection]
      if (bucket === undefined || bucket[id] === undefined) return
      const next: Record<RecordId, RecordState> = { ...bucket }
      delete next[id]
      const col = { ...cur.col }
      if (Object.keys(next).length === 0) delete col[collection]
      else col[collection] = next
      state.value = { ...cur, col }
      const changes = emptyChangeSet()
      changes.deleted.push({ c: collection, r: id })
      changes.collectionOf.set(id, collection)
      publish(changes, [])
    },
    purgeAll(): void {
      const cur = state.value
      const col: Record<string, Record<RecordId, RecordState>> = {}
      const changes = emptyChangeSet()
      for (const [name, bucket] of Object.entries(cur.col)) {
        const next: Record<RecordId, RecordState> = {}
        for (const [id, rec] of Object.entries(bucket)) {
          if (!isAlive(rec)) {
            changes.deleted.push({ c: name, r: id })
            changes.collectionOf.set(id, name)
            continue
          }
          next[id] = rec
        }
        if (Object.keys(next).length > 0) col[name] = next
      }
      state.value = { ...cur, col }
      publish(changes, [])
    },
  }

  return {
    id: opts.docId,
    corpus: opts.def.id,
    actor: opts.actor,
    clock,
    title,
    meta: view.meta,
    col: view.col,
    tx,
    undo,
    trash,
    actors,
    _state: computed(() => state.value),
    stateHash: () => hashOf(state.value),
    onChange: (cb) => events.on('change', cb),
    onLocalOps: (cb) => events.on('ops', cb),

    applyRemote(ops): ChangeSet {
      observeOps(ops)
      const res = applyAll(state.value, ops, ctx)
      if (res.state === state.value) return res.changes
      state.value = res.state
      publish(res.changes, [])
      return res.changes
    },

    mergeRemote(snapshot): ChangeSet {
      const before = state.value
      const merged = mergeState(before, snapshot, {
        keepConflicts: (collection, field) => ctx.keepConflicts?.(collection, field) ?? false,
      })
      state.value = merged
      // слияние снапшотов трогает всё: точечные сигналы здесь не спасают
      const changes = diffStates(before, merged)
      view.bumpAll()
      events.emit('change', changes)
      return changes
    },

    purgeUpto(upto): void {
      const next = purgeTombstones(state.value, upto)
      if (next === state.value) return
      state.value = next
      view.bumpAll()
    },

    setState(next): void {
      const before = state.value
      state.value = next
      const changes = diffStates(before, next)
      view.bumpAll()
      events.emit('change', changes)
    },

    setActorName(name, at = Date.now()): void {
      const cur = state.value.col[ACTORS_COLLECTION]?.[opts.actor]
      const ops: Op[] = [
        {
          i: clock.tick(),
          k: 's',
          c: ACTORS_COLLECTION,
          r: opts.actor,
          v: { name, lastSeenAt: at, mergedInto: (cur?.f['mergedInto'] as Lww | undefined)?.v ?? null },
        },
      ]
      commit(ops)
    },
  }
}

/** Грубый дифф двух состояний: нужен, когда состояние заменяется целиком. */
export function diffStates(before: DocState, after: DocState): ChangeSet {
  const changes = emptyChangeSet()
  const names = new Set([...Object.keys(before.col), ...Object.keys(after.col)])
  for (const name of names) {
    const a = before.col[name] ?? {}
    const b = after.col[name] ?? {}
    for (const [id, rec] of Object.entries(b)) {
      const prev = a[id]
      if (prev === rec) continue
      changes.collectionOf.set(id, name)
      if (prev === undefined) {
        changes.created.push({ c: name, r: id })
        continue
      }
      if (isAlive(prev) && !isAlive(rec)) changes.deleted.push({ c: name, r: id })
      else if (!isAlive(prev) && isAlive(rec)) changes.restored.push({ c: name, r: id })
      const fields: string[] = []
      for (const field of new Set([...Object.keys(prev.f), ...Object.keys(rec.f)]))
        if (prev.f[field] !== rec.f[field]) fields.push(field)
      if (prev.o !== rec.o || prev.g !== rec.g) changes.moved.push({ c: name, r: id })
      if (fields.length > 0) changes.updated.set(id, fields)
    }
    for (const id of Object.keys(a))
      if (b[id] === undefined) {
        changes.deleted.push({ c: name, r: id })
        changes.collectionOf.set(id, name)
      }
  }
  for (const key of new Set([...Object.keys(before.meta), ...Object.keys(after.meta)]))
    if (before.meta[key] !== after.meta[key]) changes.meta.push(key)
  return changes
}

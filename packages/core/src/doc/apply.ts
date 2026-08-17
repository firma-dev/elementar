import { C } from '@elementar/proto'
import { hlcActor } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import type { ActorId, RecordId } from '../id.js'
import type { JsonValue } from '../schema/types.js'
import type { AnyOp, Op } from '../ops/types.js'
import { isKnownOp } from '../ops/types.js'
import { isOrSet } from './state.js'
import type { Cell, DocState, Lww, OrSet, RecordState } from './state.js'

export interface RecordAddr {
  c: string
  r: RecordId
}

/** Что изменилось: по нему view обновляет только затронутые сигналы. */
export interface ChangeSet {
  created: RecordAddr[]
  /** recordId → изменённые поля ('#order', '#group', '#del', '#und' — служебные). */
  updated: Map<RecordId, string[]>
  deleted: RecordAddr[]
  moved: RecordAddr[]
  restored: RecordAddr[]
  /** Ключи мета документа. */
  meta: string[]
  /** recordId → коллекция: сводке (§6.12) нужна пара целиком. */
  collectionOf: Map<RecordId, string>
  /** Акторы, чьи операции попали в этот набор. */
  actors: ActorId[]
}

export const FIELD_ORDER = '#order'
export const FIELD_GROUP = '#group'
export const FIELD_DEL = '#del'
export const FIELD_UND = '#und'

export function emptyChangeSet(): ChangeSet {
  return {
    created: [],
    updated: new Map(),
    deleted: [],
    moved: [],
    restored: [],
    meta: [],
    collectionOf: new Map(),
    actors: [],
  }
}

export function changeSetIsEmpty(cs: ChangeSet): boolean {
  return (
    cs.created.length === 0 &&
    cs.updated.size === 0 &&
    cs.deleted.length === 0 &&
    cs.moved.length === 0 &&
    cs.restored.length === 0 &&
    cs.meta.length === 0
  )
}

function pushAddr(list: RecordAddr[], addr: RecordAddr): void {
  for (const a of list) if (a.c === addr.c && a.r === addr.r) return
  list.push(addr)
}

function pushField(cs: ChangeSet, id: RecordId, field: string): void {
  const cur = cs.updated.get(id)
  if (cur === undefined) cs.updated.set(id, [field])
  else if (!cur.includes(field)) cur.push(field)
}

export function mergeChangeSets(target: ChangeSet, src: ChangeSet): ChangeSet {
  for (const a of src.created) pushAddr(target.created, a)
  for (const a of src.deleted) pushAddr(target.deleted, a)
  for (const a of src.moved) pushAddr(target.moved, a)
  for (const a of src.restored) pushAddr(target.restored, a)
  for (const [id, fields] of src.updated) for (const f of fields) pushField(target, id, f)
  for (const m of src.meta) if (!target.meta.includes(m)) target.meta.push(m)
  for (const [id, col] of src.collectionOf) target.collectionOf.set(id, col)
  for (const a of src.actors) if (!target.actors.includes(a)) target.actors.push(a)
  return target
}

export interface ApplyContext {
  /** Хранить ли проигравшие версии поля (по умолчанию — нет). */
  keepConflicts?(collection: string, field: string): boolean
  /** Имя поля-контейнера коллекции: его значение зеркалится в `rec.g`. */
  groupBy?(collection: string): string | undefined
  /** Размер кольца проигравших версий. */
  conflictRing?: number
}

export interface ApplyResult {
  state: DocState
  changes: ChangeSet
}

function maxStr(a: HlcString | undefined, b: HlcString): HlcString {
  return a === undefined || b > a ? b : a
}

interface LwwUpdate {
  cell: Lww
  winnerChanged: boolean
  losersChanged: boolean
}

/**
 * LWW с кольцом проигравших. Порядок применения не важен: множество проигравших —
 * это top-N по HLC среди всех виденных значений, кроме победителя, за вычетом тех,
 * что старше водяного знака `z` (человек видел поле — значит решил, §6.6a).
 */
function lwwWrite(
  prev: Lww | undefined,
  v: JsonValue,
  t: HlcString,
  base: HlcString | undefined,
  keep: boolean,
  ring: number,
): LwwUpdate | null {
  if (prev === undefined) {
    const cell: Lww = { v, t }
    if (keep && base !== undefined) cell.z = base
    return { cell, winnerChanged: true, losersChanged: false }
  }
  if (t === prev.t) {
    // тот же самый op: HLC уникальны — применять повторно нечего
    if (!keep || base === undefined || (prev.z !== undefined && prev.z >= base)) return null
  }
  const z = keep ? maxStr(prev.z, base ?? '') : undefined
  const winnerNew = t > prev.t
  const winner = winnerNew ? { v, t } : { v: prev.v, t: prev.t }
  const cell: Lww = { v: winner.v, t: winner.t }
  if (keep) {
    const pool: Array<{ v: JsonValue; t: HlcString }> = []
    const seen = new Set<HlcString>()
    const add = (e: { v: JsonValue; t: HlcString }): void => {
      if (e.t === cell.t || seen.has(e.t)) return
      if (z !== undefined && z !== '' && e.t <= z) return
      seen.add(e.t)
      pool.push(e)
    }
    for (const e of prev.c ?? []) add(e)
    if (winnerNew) add({ v: prev.v, t: prev.t })
    else if (t !== prev.t) add({ v, t })
    pool.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0))
    const kept = pool.slice(0, Math.max(0, ring))
    if (kept.length > 0) cell.c = kept
    if (z !== undefined && z !== '') cell.z = z
  }
  const losersChanged = !sameLosers(prev, cell)
  if (!winnerNew && !losersChanged && prev.z === cell.z) return null
  return { cell, winnerChanged: winnerNew, losersChanged }
}

function sameLosers(a: Lww, b: Lww): boolean {
  const x = a.c ?? []
  const y = b.c ?? []
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if ((x[i] as { t: HlcString }).t !== (y[i] as { t: HlcString }).t) return false
  return true
}

function orSetWrite(prev: Cell | undefined, kind: 'g+' | 'g-', els: readonly string[], t: HlcString): OrSet | null {
  const base: OrSet =
    prev !== undefined && isOrSet(prev) ? { e: { ...prev.e }, x: { ...prev.x } } : { e: {}, x: {} }
  const side = kind === 'g+' ? base.e : base.x
  let changed = prev === undefined || !isOrSet(prev)
  for (const el of els) {
    const cur = side[el]
    if (cur === undefined || t > cur) {
      side[el] = t
      changed = true
    }
  }
  return changed ? base : null
}

/**
 * Применение одной операции. Коммутативно, ассоциативно, идемпотентно (§6.5).
 * Состояние неизменяемо: при отсутствии эффекта возвращается тот же объект.
 */
export function apply(state: DocState, op: AnyOp, ctx: ApplyContext = {}): ApplyResult {
  const changes = emptyChangeSet()
  const ring = ctx.conflictRing ?? C.CONFLICT_RING

  if (!isKnownOp(op)) {
    // forward-compat: неизвестный вид операции хранится как есть и уедет обратно в синк
    const xops = state.xops ?? {}
    if (Object.prototype.hasOwnProperty.call(xops, op.i)) return { state, changes }
    return {
      state: { ...state, xops: { ...xops, [op.i]: op as unknown as JsonValue }, applied: state.applied + 1 },
      changes,
    }
  }

  const actor = hlcActor(op.i)

  if (op.k === 'm') {
    let meta: Record<string, Lww> | null = null
    for (const [key, value] of Object.entries(op.v)) {
      const keep = ctx.keepConflicts?.('', key) ?? false
      const upd = lwwWrite(state.meta[key], value, op.i, op.b?.[key], keep, ring)
      if (upd === null) continue
      meta ??= { ...state.meta }
      meta[key] = upd.cell
      changes.meta.push(key)
    }
    if (meta === null) return { state, changes }
    changes.actors.push(actor)
    return { state: { ...state, meta, applied: state.applied + 1 }, changes }
  }

  const known = op as Exclude<Op, { k: 'm' }>
  const existing = state.col[known.c]?.[known.r]

  // §6.7 п.4: операции по вычищенным записям не воскрешают их
  if (existing === undefined && known.i <= state.purgedBefore) return { state, changes }

  const prev: RecordState = existing ?? { f: {}, cre: known.i, upd: known.i }
  const next: RecordState = { ...prev, f: prev.f }
  let changed = false

  if (existing === undefined) {
    changed = true
    changes.created.push({ c: known.c, r: known.r })
  } else if (known.i < prev.cre) {
    next.cre = known.i
    changed = true
  }

  switch (known.k) {
    case 's': {
      const groupField = ctx.groupBy?.(known.c)
      let fields: Record<string, Cell> | null = null
      for (const [key, value] of Object.entries(known.v)) {
        const cur = prev.f[key]
        if (cur !== undefined && isOrSet(cur)) continue // множество не понижается до регистра
        const keep = ctx.keepConflicts?.(known.c, key) ?? false
        const upd = lwwWrite(cur, value, known.i, known.b?.[key], keep, ring)
        if (upd === null) continue
        fields ??= { ...prev.f }
        fields[key] = upd.cell
        changed = true
        pushField(changes, known.r, key)
        if (key === groupField && typeof value === 'string') {
          const g = lwwWrite(prev.g, value, known.i, undefined, false, ring)
          if (g !== null) {
            next.g = g.cell as Lww<string>
            pushField(changes, known.r, FIELD_GROUP)
            pushAddr(changes.moved, { c: known.c, r: known.r })
          }
        }
      }
      if (fields !== null) next.f = fields
      break
    }
    case 'd': {
      const del = maxStr(prev.del, known.i)
      if (del !== prev.del) {
        next.del = del
        changed = true
        pushField(changes, known.r, FIELD_DEL)
        pushAddr(changes.deleted, { c: known.c, r: known.r })
      }
      break
    }
    case 'u': {
      const und = maxStr(prev.und, known.i)
      if (und !== prev.und) {
        next.und = und
        changed = true
        pushField(changes, known.r, FIELD_UND)
        pushAddr(changes.restored, { c: known.c, r: known.r })
      }
      break
    }
    case 'o': {
      if (known.o !== undefined) {
        const upd = lwwWrite(prev.o, known.o, known.i, undefined, false, ring)
        if (upd !== null) {
          next.o = upd.cell as Lww<string>
          changed = true
          pushField(changes, known.r, FIELD_ORDER)
          pushAddr(changes.moved, { c: known.c, r: known.r })
        }
      }
      if (known.g !== undefined) {
        const upd = lwwWrite(prev.g, known.g, known.i, undefined, false, ring)
        if (upd !== null) {
          next.g = upd.cell as Lww<string>
          changed = true
          pushField(changes, known.r, FIELD_GROUP)
          pushAddr(changes.moved, { c: known.c, r: known.r })
        }
      }
      break
    }
    case 'g+':
    case 'g-': {
      const set = orSetWrite(prev.f[known.p], known.k, known.e, known.i)
      if (set !== null) {
        next.f = { ...prev.f, [known.p]: set }
        changed = true
        pushField(changes, known.r, known.p)
      }
      break
    }
  }

  if (!changed) return { state, changes }

  const upd = maxStr(prev.upd, known.i)
  if (upd !== prev.upd) next.upd = upd

  changes.collectionOf.set(known.r, known.c)
  changes.actors.push(actor)

  const bucket = { ...(state.col[known.c] ?? {}), [known.r]: next }
  return {
    state: { ...state, col: { ...state.col, [known.c]: bucket }, applied: state.applied + 1 },
    changes,
  }
}

export function applyAll(state: DocState, ops: readonly AnyOp[], ctx: ApplyContext = {}): ApplyResult {
  let cur = state
  const all = emptyChangeSet()
  for (const op of ops) {
    const res = apply(cur, op, ctx)
    cur = res.state
    mergeChangeSets(all, res.changes)
  }
  return { state: cur, changes: all }
}

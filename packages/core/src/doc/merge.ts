import { C } from '@elementar/proto'
import type { HlcString } from '../hlc.js'
import type { RecordId } from '../id.js'
import type { JsonValue } from '../schema/types.js'
import { isOrSet } from './state.js'
import type { Cell, DocState, Lww, OrSet, RecordState } from './state.js'

export class MergeError extends Error {
  override readonly name = 'MergeError'
  readonly kind: 'corpus-mismatch' | 'schema-gap'
  constructor(kind: 'corpus-mismatch' | 'schema-gap', message: string) {
    super(message)
    this.kind = kind
  }
}

/** Допустимо ли сливать два состояния (§6.6g: разрыв схемы больше двух версий — стоп). */
export function canMerge(a: DocState, b: DocState): { ok: true } | { ok: false; reason: MergeError } {
  if (a.corpus !== b.corpus)
    return { ok: false, reason: new MergeError('corpus-mismatch', `корпуса разные: ${a.corpus} и ${b.corpus}`) }
  if (Math.abs(a.schema - b.schema) > 2)
    return {
      ok: false,
      reason: new MergeError('schema-gap', `версии схемы расходятся больше чем на 2: ${a.schema} и ${b.schema}`),
    }
  return { ok: true }
}

function maxHlcStr(a: HlcString | undefined, b: HlcString | undefined): HlcString | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}

function minHlcStr(a: HlcString, b: HlcString): HlcString {
  return a <= b ? a : b
}

function mergeLww<V>(a: Lww<V>, b: Lww<V>, ring: number, keep = true): Lww<V> {
  if (!keep) {
    const w = a.t >= b.t ? a : b
    const out: Lww<V> = { v: w.v, t: w.t }
    const z = maxHlcStr(a.z, b.z)
    if (z !== undefined && z !== '') out.z = z
    return out
  }
  const winner = a.t >= b.t ? a : b
  const loser = a.t >= b.t ? b : a
  const z = maxHlcStr(a.z, b.z)
  const out: Lww<V> = { v: winner.v, t: winner.t }
  const pool: Array<{ v: V; t: HlcString }> = []
  const seen = new Set<HlcString>()
  const add = (e: { v: V; t: HlcString }): void => {
    if (e.t === winner.t || seen.has(e.t)) return
    if (z !== undefined && z !== '' && e.t <= z) return
    seen.add(e.t)
    pool.push(e)
  }
  for (const e of a.c ?? []) add(e)
  for (const e of b.c ?? []) add(e)
  if (loser.t !== winner.t) add({ v: loser.v, t: loser.t })
  pool.sort((x, y) => (x.t < y.t ? 1 : x.t > y.t ? -1 : 0))
  const kept = pool.slice(0, Math.max(0, ring))
  if (kept.length > 0) out.c = kept
  if (z !== undefined && z !== '') out.z = z
  return out
}

function mergeOrSet(a: OrSet, b: OrSet): OrSet {
  const e: Record<string, HlcString> = { ...a.e }
  const x: Record<string, HlcString> = { ...a.x }
  for (const [el, t] of Object.entries(b.e)) {
    const cur = e[el]
    if (cur === undefined || t > cur) e[el] = t
  }
  for (const [el, t] of Object.entries(b.x)) {
    const cur = x[el]
    if (cur === undefined || t > cur) x[el] = t
  }
  return { e, x }
}

function mergeCell(a: Cell, b: Cell, ring: number, keep: boolean): Cell {
  const ao = isOrSet(a)
  const bo = isOrSet(b)
  if (ao && bo) return mergeOrSet(a, b)
  // множество не понижается до регистра — то же правило, что в apply
  if (ao) return a
  if (bo) return b
  return mergeLww(a as Lww<JsonValue>, b as Lww<JsonValue>, ring, keep)
}

function mergeRecord(
  a: RecordState,
  b: RecordState,
  ring: number,
  keep: (field: string, x: Cell, y: Cell) => boolean,
): RecordState {
  const f: Record<string, Cell> = { ...a.f }
  for (const [key, cell] of Object.entries(b.f)) {
    const mine = f[key]
    f[key] = mine === undefined ? cell : mergeCell(mine, cell, ring, keep(key, mine, cell))
  }
  const out: RecordState = {
    f,
    cre: minHlcStr(a.cre, b.cre),
    upd: maxHlcStr(a.upd, b.upd) as HlcString,
  }
  const o = a.o !== undefined && b.o !== undefined ? mergeLww(a.o, b.o, 0) : (a.o ?? b.o)
  if (o !== undefined) out.o = o
  const g = a.g !== undefined && b.g !== undefined ? mergeLww(a.g, b.g, 0) : (a.g ?? b.g)
  if (g !== undefined) out.g = g
  const del = maxHlcStr(a.del, b.del)
  if (del !== undefined) out.del = del
  const und = maxHlcStr(a.und, b.und)
  if (und !== undefined) out.und = und
  return out
}

export interface MergeOptions {
  conflictRing?: number
  /**
   * Хранит ли поле проигравшие версии. Без этой функции решение принимается
   * консервативно: кольцо ведётся только там, где оно уже было заведено.
   * Имя коллекции '' — мета документа (как в ApplyContext).
   */
  keepConflicts?(collection: string, field: string): boolean
}

/**
 * Слияние двух снапшотов (§6.8). Коммутативна, ассоциативна, идемпотентна и
 * эквивалентна применению всех операций обоих состояний.
 */
export function mergeState(a: DocState, b: DocState, opts: MergeOptions = {}): DocState {
  const check = canMerge(a, b)
  if (!check.ok) throw check.reason
  const ring = opts.conflictRing ?? C.CONFLICT_RING
  const keepOf = (collection: string, field: string, x: Cell, y: Cell): boolean => {
    if (opts.keepConflicts !== undefined) return opts.keepConflicts(collection, field)
    const cx = (x as Lww).c
    const cy = (y as Lww).c
    return (cx?.length ?? 0) + (cy?.length ?? 0) > 0
  }

  const purgedBefore = a.purgedBefore >= b.purgedBefore ? a.purgedBefore : b.purgedBefore

  const meta: Record<string, Lww> = { ...a.meta }
  for (const [key, cell] of Object.entries(b.meta)) {
    const mine = meta[key]
    meta[key] = mine === undefined ? cell : mergeLww(mine, cell, ring, keepOf('', key, mine, cell))
  }

  const col: Record<string, Record<RecordId, RecordState>> = {}
  const names = new Set([...Object.keys(a.col), ...Object.keys(b.col)])
  for (const name of names) {
    const ra = a.col[name] ?? {}
    const rb = b.col[name] ?? {}
    const bucket: Record<RecordId, RecordState> = {}
    const ids = new Set([...Object.keys(ra), ...Object.keys(rb)])
    for (const id of ids) {
      const x = ra[id]
      const y = rb[id]
      if (x !== undefined && y !== undefined) {
        bucket[id] = mergeRecord(x, y, ring, (field, cx, cy) => keepOf(name, field, cx, cy))
        continue
      }
      const only = (x ?? y) as RecordState
      // односторонняя запись старше водяного знака уже вычищена у партнёра
      if (only.cre < purgedBefore) continue
      bucket[id] = only
    }
    if (Object.keys(bucket).length > 0) col[name] = bucket
  }

  const seq = Math.max(a.seq, b.seq)
  const chainHead =
    a.seq === b.seq ? (a.chainHead >= b.chainHead ? a.chainHead : b.chainHead) : a.seq > b.seq ? a.chainHead : b.chainHead

  const out: DocState = {
    v: 1,
    corpus: a.corpus,
    schema: Math.max(a.schema, b.schema),
    meta,
    col,
    purgedBefore,
    chainHead,
    seq,
    applied: 0,
  }
  const xops = { ...(a.xops ?? {}), ...(b.xops ?? {}) }
  if (Object.keys(xops).length > 0) out.xops = xops
  return out
}

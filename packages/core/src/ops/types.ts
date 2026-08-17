import type { HlcString } from '../hlc.js'
import type { RecordId } from '../id.js'
import type { OrderKey } from '../frac.js'
import type { JsonValue } from '../schema/types.js'

/** id (= HLC), коллекция, запись. */
export interface OpBase {
  i: HlcString
  c: string
  r: RecordId
}

export type OpKind = 's' | 'd' | 'u' | 'o' | 'g+' | 'g-' | 'm'

export const OP_KINDS: readonly OpKind[] = ['s', 'd', 'u', 'o', 'g+', 'g-', 'm']

/**
 * `b` — база правки: HLC ячейки, которую автор видел перед записью.
 * Нужна только для полей с keepConflicts: проигравшие версии старше базы
 * не показываются («человек видел поле, значит решил», §6.6a).
 */
export type SetOp = OpBase & { k: 's'; v: Record<string, JsonValue>; b?: Record<string, HlcString> }
export type DeleteOp = OpBase & { k: 'd' }
export type UndeleteOp = OpBase & { k: 'u' }
export type OrderOp = OpBase & { k: 'o'; o?: OrderKey; g?: string }
export type SetAddOp = OpBase & { k: 'g+'; p: string; e: string[] }
export type SetRemOp = OpBase & { k: 'g-'; p: string; e: string[] }
export type MetaOp = { i: HlcString; k: 'm'; v: Record<string, JsonValue>; b?: Record<string, HlcString> }

export type Op = SetOp | DeleteOp | UndeleteOp | OrderOp | SetAddOp | SetRemOp | MetaOp

/** Операция с неизвестным `k`: хранится как есть и уходит обратно в синк (§3.7). */
export interface UnknownOp {
  i: HlcString
  k: string
  [key: string]: JsonValue | undefined
}

export type AnyOp = Op | UnknownOp

export function isOpKind(k: unknown): k is OpKind {
  return typeof k === 'string' && (OP_KINDS as readonly string[]).includes(k)
}

export function isKnownOp(op: AnyOp): op is Op {
  return isOpKind(op.k)
}

/** Пара (коллекция, запись) для всех операций, кроме мета. */
export function opTarget(op: AnyOp): { c: string; r: RecordId } | null {
  if (op.k === 'm') return null
  const c = (op as { c?: unknown }).c
  const r = (op as { r?: unknown }).r
  if (typeof c !== 'string' || typeof r !== 'string') return null
  return { c, r }
}

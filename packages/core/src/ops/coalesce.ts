import { C } from '@elementar/proto'
import { hlcActor, hlcWall } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import type { ActorId } from '../id.js'
import type { Op, SetOp } from './types.js'

/** Окно схлопывания последовательных правок одного актора (§7.4). */
export const COALESCE_WINDOW_MS = C.COALESCE_WINDOW_MS

/**
 * Последовательные `s`-операции одного актора по одной записи внутри окна
 * схлопываются в одну; сохраняется HLC последней и самая ранняя база правки.
 * Операция другого вида по той же записи закрывает окно — иначе схлопывание
 * переставило бы правку через удаление.
 */
export function coalesceOps(ops: readonly Op[], windowMs: number = COALESCE_WINDOW_MS): Op[] {
  const out: Op[] = []
  const open = new Map<string, Map<ActorId, number>>()

  for (const op of ops) {
    if (op.k === 'm') {
      out.push(op)
      continue
    }
    const rkey = `${op.c} ${op.r}`
    if (op.k !== 's') {
      open.delete(rkey)
      out.push(op)
      continue
    }
    const actor = hlcActor(op.i)
    const byActor = open.get(rkey)
    const idx = byActor?.get(actor)
    const prev = idx === undefined ? undefined : (out[idx] as SetOp | undefined)
    if (prev !== undefined && idx !== undefined && hlcWall(op.i) - hlcWall(prev.i) <= windowMs) {
      const merged: SetOp = { i: op.i, k: 's', c: op.c, r: op.r, v: { ...prev.v, ...op.v } }
      const b: Record<string, HlcString> = { ...op.b, ...prev.b } // база — от самой ранней правки
      if (Object.keys(b).length > 0) merged.b = b
      out[idx] = merged
      continue
    }
    const map = byActor ?? new Map<ActorId, number>()
    map.set(actor, out.length)
    open.set(rkey, map)
    out.push(op)
  }
  return out
}

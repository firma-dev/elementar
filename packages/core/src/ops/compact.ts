import { C } from '@elementar/proto'
import type { HlcString } from '../hlc.js'
import { applyAll } from '../doc/apply.js'
import type { ApplyContext } from '../doc/apply.js'
import { canonicalize, emptyState } from '../doc/state.js'
import type { DocState } from '../doc/state.js'
import type { AnyOp } from './types.js'

/** Пора ли писать снапшот: по числу применённых операций или по объёму лога (§7.4). */
export function shouldSnapshot(state: DocState, bytesSinceSnapshot = 0): boolean {
  return state.applied >= C.SNAPSHOT_AFTER_OPS || bytesSinceSnapshot >= C.SNAPSHOT_AFTER_BYTES
}

/** Насколько срочно просить компактизацию у пира (§8, compact-request). */
export function compactionUrgency(logCount: number, logBytes: number): 'none' | 'soft' | 'hard' {
  if (logCount >= C.LOG_HARD_COUNT || logBytes >= C.LOG_HARD_BYTES) return 'hard'
  if (logCount >= C.LOG_SOFT_COUNT || logBytes >= C.LOG_SOFT_BYTES) return 'soft'
  return 'none'
}

export interface SnapshotMark {
  seq: number
  chainHead: string
}

/** Состояние, зафиксированное как снапшот: счётчик применённых обнуляется. */
export function markSnapshot(state: DocState, at: SnapshotMark): DocState {
  return { ...state, seq: at.seq, chainHead: at.chainHead, applied: 0 }
}

/** Пересборка состояния из лога — проверка сходимости и восстановление после сбоя. */
export function rebuildState(
  corpus: string,
  schema: number,
  ops: readonly AnyOp[],
  ctx: ApplyContext = {},
): DocState {
  return applyAll(emptyState(corpus, schema), ops, ctx).state
}

export function snapshotBytes(state: DocState): number {
  return canonicalize(state).length
}

/** Операции, которые уже вошли в снапшот и больше не нужны локально. */
export function prunableOps<T extends { i: HlcString; seq?: number }>(
  ops: readonly T[],
  snapshotSeq: number,
): T[] {
  return ops.filter((o) => o.seq !== undefined && o.seq <= snapshotSeq)
}

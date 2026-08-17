import { HLC_ZERO } from '../hlc.js'
import type { HlcString } from '../hlc.js'
import type { ActorId, RecordId } from '../id.js'
import type { DocState, RecordState } from './state.js'

/** Актор, не подтверждавший ничего 90 дней, выбывает из расчёта водяного знака (§6.7). */
export const ACTOR_STALE_MS = 90 * 864e5

export function isPurgeCandidate(rec: RecordState, upto: HlcString): boolean {
  return rec.del !== undefined && rec.del < upto && (rec.und === undefined || rec.und < rec.del)
}

/**
 * Чистка надгробий по водяному знаку (§6.7). `purgedBefore` — часть состояния,
 * поэтому две машины, почистившие в разное время, сходятся побайтово,
 * а операция по вычищенной записи не воскрешает её (см. apply).
 */
export function purgeTombstones(state: DocState, upto: HlcString): DocState {
  const watermark = upto > state.purgedBefore ? upto : state.purgedBefore
  const col: Record<string, Record<RecordId, RecordState>> = {}
  let removed = 0
  for (const [name, bucket] of Object.entries(state.col)) {
    const next: Record<RecordId, RecordState> = {}
    for (const [id, rec] of Object.entries(bucket)) {
      if (isPurgeCandidate(rec, watermark)) {
        removed++
        continue
      }
      next[id] = rec
    }
    if (Object.keys(next).length > 0) col[name] = next
  }
  if (removed === 0 && watermark === state.purgedBefore) return state
  return { ...state, col, purgedBefore: watermark }
}

export interface ActorAck {
  actor: ActorId
  /** Максимальный HLC, который этот актор точно видел. */
  ack: HlcString
  /** Когда актор давал о себе знать в последний раз, epoch ms. */
  lastSeenAt: number
}

/**
 * Граница, за которой никто из живых участников не может прислать ничего нового:
 * минимум подтверждений по всем неустаревшим акторам. Без подтверждений — null.
 */
export function purgeWatermark(acks: readonly ActorAck[], now: number = Date.now()): HlcString | null {
  let min: HlcString | null = null
  let counted = 0
  for (const a of acks) {
    if (now - a.lastSeenAt > ACTOR_STALE_MS) continue
    counted++
    if (min === null || a.ack < min) min = a.ack
  }
  if (counted === 0 || min === null) return null
  return min === HLC_ZERO ? null : min
}

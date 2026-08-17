/**
 * Исходящая очередь (§7.4). Порядок сохраняется, но не требуется; идемпотентность полная:
 * `i` уникален, сервер игнорирует повтор по (clientId, clientSeq), клиент — по apply.
 * Умерший элемент (tries > 12) не выбрасывается, а помечается и виден в «Что случилось».
 */
import { C, encodeFrames } from '@elementar/proto'
import type { Frame } from '@elementar/proto'
import { b32decode } from '../crypto/b32.js'
import type { HlcString } from '../hlc.js'
import { backoffDelay } from '../util/backoff.js'
import { OUTBOX_MAX_TRIES } from '../storage/schema.js'
import type { OutboxRow } from '../storage/schema.js'
import type { DocRepo } from '../storage/repo.js'

export { OUTBOX_MAX_TRIES }
export type { OutboxItem, OutboxRow } from '../storage/schema.js'

export interface OutboxLimits {
  /** Пачка ≤ 64 операции (§7.4). */
  maxOps: number
  /** Кадр ≤ 128 КБ. */
  maxBytes: number
}

export const WS_LIMITS: OutboxLimits = { maxOps: C.WS_BATCH_OPS, maxBytes: C.WS_FRAME_MAX }
/** Тело fetch(keepalive) — 60 КБ (§7.5). */
export const BEACON_LIMITS: OutboxLimits = { maxOps: C.WS_BATCH_OPS, maxBytes: C.KEEPALIVE_BODY_MAX }

/** Байт в base32-строке: 5 бит на символ. */
export function b32ByteLength(s: string): number {
  return Math.floor((s.length * 5) / 8)
}

export function isDead(tries: number): boolean {
  return tries > OUTBOX_MAX_TRIES
}

/** Пауза перед следующей попыткой отправки: та же лестница, что у переподключения. */
export function retryDelay(tries: number, rnd: () => number = Math.random): number {
  return backoffDelay(tries, rnd)
}

/**
 * Сколько элементов влезает в один пакет: сначала самое старое (§7.5),
 * лимит по числу кадров и по суммарному размеру с учётом заголовков.
 */
export function packBatch(
  rows: readonly OutboxRow[],
  limits: OutboxLimits = WS_LIMITS,
): OutboxRow[] {
  const out: OutboxRow[] = []
  let bytes = 4 // заголовок пакета
  for (const row of rows) {
    if (out.length >= Math.min(limits.maxOps, C.MAX_FRAMES)) break
    const size = 32 + b32ByteLength(row.ct)
    if (out.length > 0 && bytes + size > limits.maxBytes) break
    out.push(row)
    bytes += size
  }
  return out
}

export function packetBytes(rows: readonly OutboxRow[]): number {
  let bytes = 4
  for (const r of rows) bytes += 32 + b32ByteLength(r.ct)
  return bytes
}

/** Кадры направления клиент→сервер: seq и ts нулевые, их проставит DO. */
export function framesOf(rows: readonly OutboxRow[], clientId: Uint8Array): Frame[] {
  return rows.map((r) => ({
    seq: 0,
    clientId,
    clientSeq: r.clientSeq,
    ts: 0,
    payload: b32decode(r.ct),
  }))
}

export function packetOf(rows: readonly OutboxRow[], clientId: Uint8Array): Uint8Array {
  return encodeFrames(framesOf(rows, clientId), { direction: 'c2s' })
}

export interface OutboxEnv {
  repo: DocRepo
  docId: string
  clientId: Uint8Array
  now?(): number
  rnd?(): number
  /** Элемент исчерпал попытки: показать в «Что случилось». */
  onDead?(rows: OutboxRow[]): void
}

export interface Outbox {
  readonly docId: string
  /** Живые элементы очереди (без мёртвых). */
  count(): Promise<number>
  all(): Promise<OutboxRow[]>
  /** Готовые к отправке прямо сейчас, самые старые первыми. */
  take(limits?: OutboxLimits, now?: number): Promise<OutboxRow[]>
  /** Пакет из выбранных элементов. */
  packet(rows: readonly OutboxRow[]): Uint8Array
  /** Подтверждение сервера: элементы уходят, операциям проставляется серверный seq. */
  ack(assigned: ReadonlyArray<{ clientSeq: number; seq: number }>): Promise<number>
  /** Ack по идентификаторам операций — путь HTTP-ответа без assigned. */
  ackByIds(ids: readonly HlcString[]): Promise<number>
  /** Отправка не удалась: попытка засчитана, следующая — по лестнице бэкоффа. */
  fail(rows: readonly OutboxRow[], now?: number): Promise<void>
}

export function createOutbox(env: OutboxEnv): Outbox {
  const now = env.now ?? Date.now
  const rnd = env.rnd ?? Math.random

  const live = async (): Promise<OutboxRow[]> => {
    const rows = await env.repo.outboxAll(env.docId)
    return rows.filter((r) => r.dead !== true)
  }

  return {
    docId: env.docId,

    async count(): Promise<number> {
      return (await live()).length
    },

    all(): Promise<OutboxRow[]> {
      return env.repo.outboxAll(env.docId)
    },

    async take(limits: OutboxLimits = WS_LIMITS, at: number = now()): Promise<OutboxRow[]> {
      const rows = (await live()).filter((r) => r.nextAt <= at)
      return packBatch(rows, limits)
    },

    packet(rows): Uint8Array {
      return packetOf(rows, env.clientId)
    },

    async ack(assigned): Promise<number> {
      if (assigned.length === 0) return 0
      const byClientSeq = new Map(assigned.map((a) => [a.clientSeq, a.seq] as const))
      const rows = await env.repo.outboxAll(env.docId)
      const hit = rows.filter((r) => byClientSeq.has(r.clientSeq))
      if (hit.length === 0) return 0
      await env.repo.markOpsSeq(
        env.docId,
        hit.map((r) => ({ i: r.i, seq: byClientSeq.get(r.clientSeq) as number })),
      )
      await env.repo.outboxAck(
        env.docId,
        hit.map((r) => r.i),
      )
      return hit.length
    },

    async ackByIds(ids): Promise<number> {
      await env.repo.outboxAck(env.docId, ids)
      return ids.length
    },

    async fail(rows, at: number = now()): Promise<void> {
      if (rows.length === 0) return
      const ids = rows.map((r) => r.i)
      const worst = rows.reduce((m, r) => Math.max(m, r.tries), 0)
      const dead = await env.repo.outboxRetry(env.docId, ids, at + retryDelay(worst, rnd))
      if (dead.length > 0) env.onDead?.(dead)
    },
  }
}

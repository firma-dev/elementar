/**
 * Шифрованное присутствие (§6.14). Сервер видит непрозрачный блоб ≤ 256 байт и число пиров.
 * Имена берутся из `_actors` внутри документа, здесь их нет.
 */
import { C, PRESENCE_CT_BYTES, PacketType } from '@elementar/proto'
import type { PeerInfo } from '@elementar/proto'
import { b32decode, b32encode, tryB32decode } from '../crypto/b32.js'
import { openPacket, sealPacket } from '../crypto/envelope.js'
import type { DocKeyInput } from '../crypto/envelope.js'
import type { NonceSource } from '../crypto/nonce.js'
import type { ActorId, RecordId } from '../id.js'
import { fromUtf8, utf8 } from '../util/bytes.js'

export type PresenceView =
  | { kind: 'list'; list: string }
  | { kind: 'project'; id: RecordId }
  | { kind: 'calendar' }
  | { kind: 'today' }

export interface PresencePayload {
  actor: ActorId
  view: PresenceView
  editing: RecordId | null
  /** Голова хеш-цепочки для сверки с партнёром (§6.11). */
  chainHead: string
  at: number
}

export const PRESENCE_TTL_MS = C.PRESENCE_TTL_MS
export const PRESENCE_BEAT_MS = C.PRESENCE_BEAT_MS

function isView(v: unknown): v is PresenceView {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  switch (r['kind']) {
    case 'list':
      return typeof r['list'] === 'string'
    case 'project':
      return typeof r['id'] === 'string'
    case 'calendar':
    case 'today':
      return true
    default:
      return false
  }
}

export function parsePresencePayload(raw: unknown): PresencePayload | null {
  const src = typeof raw === 'string' ? safeJson(raw) : raw
  if (typeof src !== 'object' || src === null) return null
  const r = src as Record<string, unknown>
  if (typeof r['actor'] !== 'string' || !isView(r['view'])) return null
  const editing = r['editing']
  if (editing !== null && typeof editing !== 'string') return null
  if (typeof r['chainHead'] !== 'string' || typeof r['at'] !== 'number') return null
  return {
    actor: r['actor'],
    view: r['view'],
    editing: editing as RecordId | null,
    chainHead: r['chainHead'],
    at: r['at'],
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return null
  }
}

export function encodePresencePayload(p: PresencePayload): Uint8Array {
  return utf8(JSON.stringify(p))
}

export interface SealPresenceArgs {
  key: DocKeyInput
  docIdBytes: Uint8Array
  nonce: Uint8Array | NonceSource
  payload: PresencePayload
}

/**
 * Паддинг выключен намеренно: с корзинами (§4.6) 256-байтный лимит блоба недостижим,
 * а присутствие эфемерно и одинаково по форме у всех — скрывать длину нечего.
 */
export async function sealPresence(args: SealPresenceArgs): Promise<string | null> {
  const nonce = args.nonce instanceof Uint8Array ? args.nonce : args.nonce.next()
  const packet = await sealPacket({
    key: args.key,
    type: PacketType.Presence,
    docIdBytes: args.docIdBytes,
    nonce,
    plaintext: encodePresencePayload(args.payload),
    pad: 'off',
  })
  if (packet.length > PRESENCE_CT_BYTES) return null
  return b32encode(packet)
}

export interface OpenPresenceArgs {
  key: DocKeyInput
  docIdBytes: Uint8Array
  ct: string
}

export async function openPresence(args: OpenPresenceArgs): Promise<PresencePayload | null> {
  const raw = tryB32decode(args.ct)
  if (raw === null || raw.length > PRESENCE_CT_BYTES) return null
  try {
    const opened = await openPacket({
      key: args.key,
      docIdBytes: args.docIdBytes,
      packet: raw,
      expectType: PacketType.Presence,
    })
    return parsePresencePayload(fromUtf8(opened.plaintext))
  } catch {
    return null
  }
}

export interface Peer {
  sessionId: string
  payload: PresencePayload
  /** Локальное время получения: TTL считается по нему, а не по чужим часам. */
  seenAt: number
}

/** Слот цвета вычисляется, а не присваивается (§6.14). */
export function presenceSlot(aliveActorIds: readonly ActorId[], id: ActorId): 'a' | 'b' {
  const sorted = [...aliveActorIds].sort()
  return sorted[0] === id ? 'a' : 'b'
}

/** Комната: пиры с TTL 30 с, максимум 8 (§8.7). */
export class PresenceTracker {
  readonly #peers = new Map<string, Peer>()

  get size(): number {
    return this.#peers.size
  }

  list(now: number = Date.now()): Peer[] {
    this.prune(now)
    return [...this.#peers.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
  }

  payloads(now: number = Date.now()): PresencePayload[] {
    return this.list(now).map((p) => p.payload)
  }

  put(sessionId: string, payload: PresencePayload, now: number = Date.now()): void {
    this.prune(now)
    if (!this.#peers.has(sessionId) && this.#peers.size >= C.MAX_PEERS) return
    this.#peers.set(sessionId, { sessionId, payload, seenAt: now })
  }

  remove(sessionId: string): void {
    this.#peers.delete(sessionId)
  }

  clear(): void {
    this.#peers.clear()
  }

  prune(now: number = Date.now()): void {
    for (const [id, p] of this.#peers) if (now - p.seenAt > PRESENCE_TTL_MS) this.#peers.delete(id)
  }

  /** Головы цепочки живых пиров — вход для сверки §6.11. */
  heads(now: number = Date.now()): string[] {
    return this.list(now).map((p) => p.payload.chainHead)
  }
}

/** Разбор welcome.peers: сессии без блоба остаются анонимными до первого 'pres'. */
export async function adoptPeers(
  tracker: PresenceTracker,
  peers: readonly PeerInfo[],
  open: (ct: string) => Promise<PresencePayload | null>,
  now: number = Date.now(),
): Promise<void> {
  for (const p of peers) {
    if (p.pres === null) continue
    const payload = await open(p.pres)
    if (payload !== null) tracker.put(p.sessionId, payload, now)
  }
}

/** Размер блоба до отправки: удобно для проверки лимита в тестах. */
export function presenceCtBytes(ct: string): number {
  return b32decode(ct).length
}

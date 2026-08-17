/**
 * WebSocket-протокол (§8.7). Текстовые кадры — JSON-контроль, бинарные — пакеты дельт
 * (кодек в frames.ts). Разбор входящего JSON тотальный: мусор → null, без исключений.
 */
import { C } from './consts.js'
import { isElmErrorCode } from './codes.js'
import { b32CharLen, isCrockford, isSigAlg } from './keys.js'
import type { ElmErrorCode } from './codes.js'
import type { B32, SigAlg } from './keys.js'

export type ClientMsg =
  | { t: 'sub'; since: number }
  | { t: 'ack'; upto: number }
  /** Шифрованный блоб ≤ 256 байт (§6.14). */
  | { t: 'pres'; ct: B32 | null }
  | { t: 'snapshot-ready'; baseSeq: number; bytes: number }
  | { t: 'bye' }

export type ServerMsg =
  | {
      t: 'welcome'
      head: number
      snapshotSeq: number
      snapshotGen: number
      sessionId: string
      peers: PeerInfo[]
      compactionNeeded: boolean
      safeCompactSeq: number
      serverTime: number
    }
  | {
      t: 'ack'
      assigned: Array<{ clientSeq: number; seq: number }>
      head: number
      duplicates: number
      compactionNeeded: boolean
      safeCompactSeq: number
    }
  | { t: 'resync'; snapshotSeq: number; reason: 'behind-snapshot' | 'log-pruned' }
  | { t: 'snapshot'; snapshotSeq: number; snapshotGen: number }
  | { t: 'peer'; ev: 'join' | 'leave' | 'pres'; peer: PeerInfo }
  | {
      t: 'compact-request'
      upto: number
      logCount: number
      logBytes: number
      urgency: 'soft' | 'hard'
    }
  | { t: 'error'; code: ElmErrorCode; message: string; retryAfter?: number }
  | { t: 'bye'; code: ElmErrorCode; retryAfter?: number }

export interface PeerInfo {
  sessionId: string
  /** Непрозрачно для сервера. */
  pres: B32 | null
  /** ms с момента подключения. */
  since: number
}

/** Субпротокол соединения; ответ сервера — ровно эта строка. */
export const WS_PROTOCOL = 'elm.v1'

/** Автоответ хибернации: ping 'p' → pong 'o' (§8.7). */
export const WS_AUTO_PING = 'p'
export const WS_AUTO_PONG = 'o'

/** Максимум байт шифротекста присутствия (§6.14) и его длина в base32. */
export const PRESENCE_CT_BYTES = 256
const PRESENCE_CT_CHARS = b32CharLen(PRESENCE_CT_BYTES)

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

const isPres = (v: unknown): v is B32 | null =>
  v === null || (typeof v === 'string' && v.length <= PRESENCE_CT_CHARS && isCrockford(v))

function isPeerInfo(v: unknown): v is PeerInfo {
  return (
    isRec(v) &&
    typeof v['sessionId'] === 'string' &&
    v['sessionId'].length > 0 &&
    v['sessionId'].length <= 64 &&
    isPres(v['pres']) &&
    isSeq(v['since'])
  )
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** Разбор управляющего сообщения от клиента. Любой мусор → null (сервер шлёт ELM_BAD_REQUEST). */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > C.WS_FRAME_MAX) return null
  const v = parseJson(raw)
  if (!isRec(v)) return null
  switch (v['t']) {
    case 'sub':
      return isSeq(v['since']) ? { t: 'sub', since: v['since'] } : null
    case 'ack':
      return isSeq(v['upto']) ? { t: 'ack', upto: v['upto'] } : null
    case 'pres': {
      const ct = v['ct']
      return isPres(ct) ? { t: 'pres', ct } : null
    }
    case 'snapshot-ready':
      return isSeq(v['baseSeq']) && isSeq(v['bytes'])
        ? { t: 'snapshot-ready', baseSeq: v['baseSeq'], bytes: v['bytes'] }
        : null
    case 'bye':
      return { t: 'bye' }
    default:
      return null
  }
}

/** Разбор управляющего сообщения от сервера. Клиент не доверяет серверу. */
export function parseServerMsg(raw: string): ServerMsg | null {
  if (raw.length > C.WS_FRAME_MAX) return null
  const v = parseJson(raw)
  if (!isRec(v)) return null

  switch (v['t']) {
    case 'welcome': {
      const rawPeers = v['peers']
      if (!Array.isArray(rawPeers) || rawPeers.length > C.MAX_PEERS) return null
      const peers: PeerInfo[] = []
      for (const p of rawPeers as unknown[]) {
        if (!isPeerInfo(p)) return null
        peers.push(p)
      }
      if (
        !isSeq(v['head']) ||
        !isSeq(v['snapshotSeq']) ||
        !isSeq(v['snapshotGen']) ||
        typeof v['sessionId'] !== 'string' ||
        typeof v['compactionNeeded'] !== 'boolean' ||
        !isSeq(v['safeCompactSeq']) ||
        !isSeq(v['serverTime'])
      ) {
        return null
      }
      return {
        t: 'welcome',
        head: v['head'],
        snapshotSeq: v['snapshotSeq'],
        snapshotGen: v['snapshotGen'],
        sessionId: v['sessionId'],
        peers,
        compactionNeeded: v['compactionNeeded'],
        safeCompactSeq: v['safeCompactSeq'],
        serverTime: v['serverTime'],
      }
    }
    case 'ack': {
      const raw2 = v['assigned']
      if (!Array.isArray(raw2) || raw2.length > C.MAX_FRAMES) return null
      const assigned: Array<{ clientSeq: number; seq: number }> = []
      for (const a of raw2 as unknown[]) {
        if (!isRec(a) || !isSeq(a['clientSeq']) || !isSeq(a['seq'])) return null
        assigned.push({ clientSeq: a['clientSeq'], seq: a['seq'] })
      }
      if (
        !isSeq(v['head']) ||
        !isSeq(v['duplicates']) ||
        typeof v['compactionNeeded'] !== 'boolean' ||
        !isSeq(v['safeCompactSeq'])
      ) {
        return null
      }
      return {
        t: 'ack',
        assigned,
        head: v['head'],
        duplicates: v['duplicates'],
        compactionNeeded: v['compactionNeeded'],
        safeCompactSeq: v['safeCompactSeq'],
      }
    }
    case 'resync': {
      const reason = v['reason']
      if (!isSeq(v['snapshotSeq']) || (reason !== 'behind-snapshot' && reason !== 'log-pruned')) {
        return null
      }
      return { t: 'resync', snapshotSeq: v['snapshotSeq'], reason }
    }
    case 'snapshot':
      return isSeq(v['snapshotSeq']) && isSeq(v['snapshotGen'])
        ? { t: 'snapshot', snapshotSeq: v['snapshotSeq'], snapshotGen: v['snapshotGen'] }
        : null
    case 'peer': {
      const ev = v['ev']
      if ((ev !== 'join' && ev !== 'leave' && ev !== 'pres') || !isPeerInfo(v['peer'])) return null
      return { t: 'peer', ev, peer: v['peer'] }
    }
    case 'compact-request': {
      const urgency = v['urgency']
      if (
        !isSeq(v['upto']) ||
        !isSeq(v['logCount']) ||
        !isSeq(v['logBytes']) ||
        (urgency !== 'soft' && urgency !== 'hard')
      ) {
        return null
      }
      return {
        t: 'compact-request',
        upto: v['upto'],
        logCount: v['logCount'],
        logBytes: v['logBytes'],
        urgency,
      }
    }
    case 'error': {
      if (!isElmErrorCode(v['code']) || typeof v['message'] !== 'string') return null
      const msg: ServerMsg = { t: 'error', code: v['code'], message: v['message'] }
      return isSeq(v['retryAfter']) ? { ...msg, retryAfter: v['retryAfter'] } : msg
    }
    case 'bye': {
      if (!isElmErrorCode(v['code'])) return null
      const msg: ServerMsg = { t: 'bye', code: v['code'] }
      return isSeq(v['retryAfter']) ? { ...msg, retryAfter: v['retryAfter'] } : msg
    }
    default:
      return null
  }
}

export function encodeMsg(m: ClientMsg | ServerMsg): string {
  return JSON.stringify(m)
}

/** Подпись WS-хендшейка едет в субпротоколе (§8.7). */
export interface WsHandshake {
  since: number
  /** clientId в base32, 8 байт → 13 символов. */
  clientIdB32: string
  sig: { alg: SigAlg; tsMs: number; sigNonceB32: string; sigB32: string }
}

/**
 * Собирает список токенов для `Sec-WebSocket-Protocol`:
 * `elm.v1, since.<n>, cl.<clientId b32>, sig.<alg>.<ts>.<nonce b32>.<sig b32>`.
 */
export function formatWsSubprotocols(h: WsHandshake): string[] {
  return [
    WS_PROTOCOL,
    `since.${h.since}`,
    `cl.${h.clientIdB32}`,
    `sig.${h.sig.alg}.${h.sig.tsMs}.${h.sig.sigNonceB32}.${h.sig.sigB32}`,
  ]
}

const CLIENT_ID_CHARS = b32CharLen(8)

/** Разбор субпротокола. Любое отклонение → null: соединение не поднимается (404). */
export function parseWsSubprotocols(header: string | readonly string[] | null): WsHandshake | null {
  if (header === null) return null
  const tokens = (typeof header === 'string' ? header.split(',') : [...header])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (tokens.length < 4 || tokens.length > 8) return null
  if (!tokens.includes(WS_PROTOCOL)) return null

  let since: number | null = null
  let clientIdB32: string | null = null
  let sig: WsHandshake['sig'] | null = null

  for (const tok of tokens) {
    if (tok === WS_PROTOCOL) continue
    if (tok.startsWith('since.')) {
      const raw = tok.slice(6)
      if (!/^[0-9]{1,15}$/.test(raw)) return null
      const n = Number(raw)
      if (!Number.isSafeInteger(n)) return null
      since = n
    } else if (tok.startsWith('cl.')) {
      const raw = tok.slice(3)
      if (raw.length !== CLIENT_ID_CHARS || !isCrockford(raw)) return null
      clientIdB32 = raw
    } else if (tok.startsWith('sig.')) {
      const parts = tok.split('.')
      if (parts.length !== 5) return null
      const [, alg, ts, nonce, s] = parts
      if (alg === undefined || !isSigAlg(alg)) return null
      if (ts === undefined || !/^[0-9]{1,15}$/.test(ts)) return null
      const tsMs = Number(ts)
      if (!Number.isSafeInteger(tsMs)) return null
      if (
        nonce === undefined ||
        nonce.length !== b32CharLen(C.SIG_NONCE_BYTES) ||
        !isCrockford(nonce)
      ) {
        return null
      }
      if (s === undefined || s.length === 0 || !isCrockford(s)) return null
      sig = { alg, tsMs, sigNonceB32: nonce, sigB32: s }
    } else {
      return null
    }
  }

  if (since === null || clientIdB32 === null || sig === null) return null
  return { since, clientIdB32, sig }
}

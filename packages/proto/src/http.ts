/** Типы всех REST-эндпоинтов (§8.5). База: `${API_ORIGIN}/v1`. */
import type { ElmErrorCode } from './codes.js'
import type { B32, DocId, SigAlg } from './keys.js'

export type { ElmErrorCode } from './codes.js'
export type { B32, DocId, SigAlg } from './keys.js'

export interface ErrorBody {
  error: {
    code: ElmErrorCode
    message: string
    retryAfter?: number
    quota?: { used: number; limit: number; unit: 'bytes' | 'deltas' }
  }
}

/** 409 ELM_STALE_BASE на `GET /deltas`: клиент отстал от снапшота. */
export interface StaleBaseBody extends ErrorBody {
  resyncFrom: number
}

/** 409 ELM_UNSAFE_BASE на `PUT /snapshot`: компакция обогнала подтверждения пиров (§8.9). */
export interface UnsafeBaseBody extends ErrorBody {
  safeCompactSeq: number
}

export type KdfParams =
  | { alg: 'none' }
  | { alg: 'argon2id'; m: number; t: number; p: number; salt: B32 }
  | { alg: 'pbkdf2-sha256'; i: number; salt: B32 }

export interface WrapRecord {
  v: 1
  /** Монотонный. Увеличивается на 1 при каждой смене. Защита от отката сервером. */
  wrapVer: number
  kdf: KdfParams
  /** b32, 12 байт. */
  nonce: B32
  /** b32, 48 байт = K_doc(32) + tag(16). */
  ct: B32
}

export type DocState = 'active' | 'frozen' | 'tombstone'

export interface CreateDocRequest {
  /** 20 симв. Crockford base32, сгенерирован клиентом. */
  docId: DocId
  sigAlg: SigAlg
  /** raw 32 (ed25519) | raw 65 uncompressed (p256). */
  sigPub: B32
  /** 0..255. */
  app?: number
  /** §5.5, wrapVer = 1. */
  wrap: WrapRecord
  /** Начальный слепой блоб, ≤ 256 KiB. */
  snapshot?: B32
  /** Turnstile-токен, если сервер его требует. */
  challenge?: string
}

export interface DocMeta {
  docId: DocId
  seq: number
  snapshotSeq: number
  snapshotGen: number
  snapshotBytes: number
  logCount: number
  logBytes: number
  totalBytes: number
  wrap: WrapRecord
  wrapVer: number
  sigAlg: SigAlg
  createdAt: number
  updatedAt: number
  expiresAt: number
  state: DocState
  /** При tombstone: до deletedAt + 7d можно undelete. */
  deletedAt?: number
  limits: { maxDeltaBytes: number; maxSnapshotBytes: number; maxLogBytes: number; maxLogCount: number }
  compactionNeeded: boolean
  /** Граница, до которой компакция безопасна (§8.9). */
  safeCompactSeq: number
}

export interface PushResult {
  accepted: number
  duplicates: number
  /** Включая дубликаты — с их прежним seq. */
  assigned: Array<{ clientSeq: number; seq: number }>
  head: number
  compactionNeeded: boolean
  safeCompactSeq: number
  logCount: number
  logBytes: number
}

export interface SnapshotResult {
  snapshotSeq: number
  snapshotGen: number
  bytes: number
  location: 'do' | 'r2'
  prunedDeltas: number
  head: number
}

/** wrap.wrapVer должен быть строго больше текущего, иначе 409 ELM_WRAP_STALE. */
export interface PutWrapRequest {
  wrap: WrapRecord
}

export interface PutWrapResponse {
  wrapVer: number
}

/** iid — 20 симв. b32; blob — ≤ 128 байт. */
export interface CreateInviteRequest {
  iid: string
  blob: B32
}

export interface CreateInviteResponse {
  iid: string
  expiresAt: number
}

export interface HealthResponse {
  ok: true
}

export interface ChallengeResponse {
  sitekey: string
}

/** Query у `GET /deltas`: since эксклюзивно, limit 1..256, дефолт 128. */
export interface DeltasQuery {
  since: number
  limit: number
}

export const DELTAS_LIMIT_DEFAULT = 128
export const DELTAS_LIMIT_MIN = 1
export const DELTAS_LIMIT_MAX = 256

/** Имена заголовков — в нижнем регистре, сравнение всегда по нижнему. */
export const HDR = {
  SIG: 'x-elm-sig',
  CLIENT: 'x-elm-client',
  BASE_SEQ: 'x-elm-base-seq',
  CHALLENGE: 'x-elm-challenge',
  SEQ: 'x-elm-seq',
  GEN: 'x-elm-gen',
  HEAD: 'x-elm-head',
  MORE: 'x-elm-more',
  QUOTA: 'x-elm-quota',
  RETRY_AFTER: 'retry-after',
  ETAG: 'etag',
} as const

/** Значения CORS-заголовков из §8.5 (Allow-Origin — ASCII-литерал из env.ts). */
export const CORS = {
  allowHeaders: 'content-type, x-elm-sig, x-elm-client, x-elm-base-seq, x-elm-challenge',
  exposeHeaders: 'x-elm-seq, x-elm-gen, x-elm-head, x-elm-quota, retry-after, etag',
  maxAge: '86400',
} as const

export const API_PREFIX = '/v1'

/**
 * Пути эндпоинтов. Ровно эти строки уходят в канонизацию подписи (§4.5),
 * поэтому клиент и сервер обязаны строить их одним кодом.
 */
export const PATHS = {
  health: `${API_PREFIX}/health`,
  challenge: `${API_PREFIX}/challenge`,
  docs: `${API_PREFIX}/docs`,
  doc: (docId: string): string => `${API_PREFIX}/docs/${docId}`,
  snapshot: (docId: string): string => `${API_PREFIX}/docs/${docId}/snapshot`,
  deltas: (docId: string): string => `${API_PREFIX}/docs/${docId}/deltas`,
  wrap: (docId: string): string => `${API_PREFIX}/docs/${docId}/wrap`,
  undelete: (docId: string): string => `${API_PREFIX}/docs/${docId}/undelete`,
  ws: (docId: string): string => `${API_PREFIX}/docs/${docId}/ws`,
  invite: `${API_PREFIX}/invite`,
  inviteById: (iid: string): string => `${API_PREFIX}/invite/${iid}`,
  llm: (provider: string): string => `${API_PREFIX}/llm/${provider}`,
} as const

export interface QuotaHeader {
  logCount: number
  logLimit: number
  bytes: number
  bytesLimit: number
}

/** `X-Elm-Quota: log=412/2000;bytes=1048576/4194304` (§8.11). */
export function formatQuotaHeader(q: QuotaHeader): string {
  return `log=${q.logCount}/${q.logLimit};bytes=${q.bytes}/${q.bytesLimit}`
}

export function parseQuotaHeader(raw: string | null | undefined): QuotaHeader | null {
  if (typeof raw !== 'string') return null
  const m = /^log=(\d{1,15})\/(\d{1,15});bytes=(\d{1,15})\/(\d{1,15})$/.exec(raw)
  if (m === null) return null
  const [, a, b, c, d] = m
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null
  const nums = [Number(a), Number(b), Number(c), Number(d)] as const
  if (!nums.every((n) => Number.isSafeInteger(n))) return null
  return { logCount: nums[0], logLimit: nums[1], bytes: nums[2], bytesLimit: nums[3] }
}

/** Эндпоинты, которым подпись не нужна (§8.5). Всё остальное — только с подписью. */
export const UNSIGNED_PATHS: readonly string[] = [PATHS.health, PATHS.challenge]

/**
 * HTTP-путь синка (§8.5) и флаш outbox при уходе в фон (§7.5).
 *
 * Все эндпоинты, кроме /health и /challenge, подписаны (§4.5): подпись покрывает путь
 * БЕЗ query, метод и sha256 тела. Ответы читаются тотально: тело ошибки может быть любым.
 */
import {
  API_BASE,
  DELTAS_LIMIT_DEFAULT,
  HDR,
  PATHS,
  decodeFrames,
  isElmErrorCode,
} from '@elementar/proto'
import type {
  CreateDocRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  DeltasQuery,
  DocId,
  DocMeta,
  ElmErrorCode,
  Frame,
  PushResult,
  PutWrapRequest,
  SnapshotResult,
  WrapRecord,
} from '@elementar/proto'
import { b32encode } from '../crypto/b32.js'
import { signRequest } from '../crypto/sign.js'
import type { Signer } from '../crypto/sign.js'
import type { HlcString } from '../hlc.js'
import { utf8 } from '../util/bytes.js'
import type { OutboxItem, OutboxRow } from '../storage/schema.js'
import { BEACON_LIMITS, packBatch, packetOf } from './outbox.js'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpEnv {
  docId: string
  docIdBytes: Uint8Array
  signer: Signer
  /** 8 байт; уходит в X-Elm-Client. */
  clientId?: Uint8Array
  base?: string
  fetch?: FetchLike
  /** Turnstile-токен, если сервер его требует. */
  challenge?: string | null
}

export class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly code: ElmErrorCode | 'ELM_NETWORK'
  readonly status: number
  readonly retryAfter: number | null
  readonly body: unknown

  constructor(args: {
    code: ElmErrorCode | 'ELM_NETWORK'
    status: number
    message?: string
    retryAfter?: number | null
    body?: unknown
  }) {
    super(args.message ?? args.code)
    this.code = args.code
    this.status = args.status
    this.retryAfter = args.retryAfter ?? null
    this.body = args.body
  }
}

function fetchOf(env: HttpEnv): FetchLike {
  const f = env.fetch ?? (globalThis.fetch as FetchLike | undefined)
  if (f === undefined) throw new HttpError({ code: 'ELM_NETWORK', status: 0, message: 'no fetch' })
  return f
}

function baseOf(env: HttpEnv): string {
  const b = env.base ?? API_BASE
  return b.endsWith('/') ? b.slice(0, -1) : b
}

/** База уже содержит '/v1', а PATHS.* — абсолютные пути от корня. */
function urlOf(env: HttpEnv, path: string, query?: Record<string, string | number | undefined>): string {
  const origin = baseOf(env).replace(/\/v1$/, '')
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v))
  const tail = qs.toString()
  return `${origin}${path}${tail === '' ? '' : `?${tail}`}`
}

export interface SignedRequestInit {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | number | undefined>
  body?: Uint8Array | null
  contentType?: string
  headers?: Record<string, string>
}

/** Готовые заголовки подписанного запроса: используются и в beacon-заготовке. */
export async function signedHeaders(
  env: HttpEnv,
  init: SignedRequestInit,
): Promise<Record<string, string>> {
  const signed = await signRequest(env.signer, {
    method: init.method,
    path: init.path,
    docIdBytes: env.docIdBytes,
    body: init.body ?? null,
  })
  const headers: Record<string, string> = { [HDR.SIG]: signed.header, ...(init.headers ?? {}) }
  if (init.body !== null && init.body !== undefined) {
    headers['content-type'] = init.contentType ?? 'application/octet-stream'
  }
  if (env.clientId !== undefined) headers[HDR.CLIENT] = b32encode(env.clientId)
  if (env.challenge !== undefined && env.challenge !== null) headers[HDR.CHALLENGE] = env.challenge
  return headers
}

async function readError(res: Response): Promise<HttpError> {
  let body: unknown
  let code: ElmErrorCode | 'ELM_NETWORK' = 'ELM_INTERNAL'
  let message = `HTTP ${res.status}`
  let retryAfter: number | null = null
  try {
    body = await res.json()
    const err = (body as { error?: { code?: unknown; message?: unknown; retryAfter?: unknown } }).error
    if (err !== undefined) {
      if (isElmErrorCode(err.code)) code = err.code
      if (typeof err.message === 'string') message = err.message
      if (typeof err.retryAfter === 'number') retryAfter = err.retryAfter
    }
  } catch {
    /* тело не JSON — остаёмся с кодом по статусу */
  }
  if (retryAfter === null) {
    const raw = res.headers.get(HDR.RETRY_AFTER)
    const n = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(n)) retryAfter = n * 1000
  }
  return new HttpError({ code, status: res.status, message, retryAfter, body })
}

export async function signedFetch(env: HttpEnv, init: SignedRequestInit): Promise<Response> {
  const headers = await signedHeaders(env, init)
  const url = urlOf(env, init.path, init.query)
  const request: RequestInit = {
    method: init.method,
    headers,
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
  }
  if (init.body !== null && init.body !== undefined) request.body = init.body as BodyInit
  let res: Response
  try {
    res = await fetchOf(env)(url, request)
  } catch (cause) {
    throw new HttpError({ code: 'ELM_NETWORK', status: 0, message: String(cause) })
  }
  if (!res.ok) throw await readError(res)
  return res
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// ——— эндпоинты ———

export async function createDoc(env: HttpEnv, body: CreateDocRequest): Promise<DocMeta> {
  const res = await signedFetch(env, {
    method: 'POST',
    path: PATHS.docs,
    body: utf8(JSON.stringify(body)),
    contentType: 'application/json',
  })
  return json<DocMeta>(res)
}

export async function getDocMeta(env: HttpEnv): Promise<DocMeta> {
  const res = await signedFetch(env, { method: 'GET', path: PATHS.doc(env.docId) })
  return json<DocMeta>(res)
}

export interface DeltasPage {
  frames: Frame[]
  head: number
  more: boolean
}

export async function getDeltas(env: HttpEnv, q: DeltasQuery): Promise<DeltasPage> {
  const res = await signedFetch(env, {
    method: 'GET',
    path: PATHS.deltas(env.docId),
    query: { since: q.since, limit: q.limit || DELTAS_LIMIT_DEFAULT },
  })
  const bytes = new Uint8Array(await res.arrayBuffer())
  const decoded = decodeFrames(bytes, { direction: 's2c' })
  if (!decoded.ok) {
    throw new HttpError({ code: 'ELM_BAD_FRAME', status: 200, message: decoded.reason })
  }
  const head = Number(res.headers.get(HDR.HEAD) ?? '0')
  return {
    frames: decoded.frames,
    head: Number.isFinite(head) ? head : 0,
    more: res.headers.get(HDR.MORE) === '1',
  }
}

export async function pushDeltas(env: HttpEnv, packet: Uint8Array): Promise<PushResult> {
  const res = await signedFetch(env, {
    method: 'POST',
    path: PATHS.deltas(env.docId),
    body: packet,
  })
  return json<PushResult>(res)
}

export async function getSnapshot(env: HttpEnv, gen?: number): Promise<Uint8Array> {
  const res = await signedFetch(env, {
    method: 'GET',
    path: PATHS.snapshot(env.docId),
    query: gen === undefined ? undefined : { gen },
  })
  return new Uint8Array(await res.arrayBuffer())
}

export async function putSnapshot(
  env: HttpEnv,
  ct: Uint8Array,
  baseSeq: number,
): Promise<SnapshotResult> {
  const res = await signedFetch(env, {
    method: 'PUT',
    path: PATHS.snapshot(env.docId),
    body: ct,
    headers: { [HDR.BASE_SEQ]: String(baseSeq) },
  })
  return json<SnapshotResult>(res)
}

export async function putWrap(env: HttpEnv, wrap: WrapRecord): Promise<{ wrapVer: number }> {
  const body: PutWrapRequest = { wrap }
  const res = await signedFetch(env, {
    method: 'PUT',
    path: PATHS.wrap(env.docId),
    body: utf8(JSON.stringify(body)),
    contentType: 'application/json',
  })
  return json<{ wrapVer: number }>(res)
}

export async function deleteDoc(env: HttpEnv): Promise<void> {
  await signedFetch(env, { method: 'DELETE', path: PATHS.doc(env.docId) })
}

export async function undeleteDoc(env: HttpEnv): Promise<DocMeta> {
  const res = await signedFetch(env, { method: 'POST', path: PATHS.undelete(env.docId) })
  return json<DocMeta>(res)
}

export async function createInvite(
  env: HttpEnv,
  body: CreateInviteRequest,
): Promise<CreateInviteResponse> {
  const res = await signedFetch(env, {
    method: 'POST',
    path: PATHS.invite,
    body: utf8(JSON.stringify(body)),
    contentType: 'application/json',
  })
  return json<CreateInviteResponse>(res)
}

// ——— beacon: флаш очереди на выгрузке вкладки (§7.5) ———

export interface PreparedBeacon {
  docId: string
  url: string
  headers: Record<string, string>
  body: Uint8Array
  /** Что именно уедет: если этих элементов в очереди уже нет, заготовка протухла. */
  ids: HlcString[]
  preparedAt: number
}

const ARMED = new Map<string, PreparedBeacon>()

/**
 * Заготовка считается заранее и держится готовой: на выгрузке ждать асинхронную крипту
 * нельзя. Берётся самое старое, что влезает в 60 КБ, остальное догонит при следующем открытии.
 */
export async function prepareBeacon(
  env: HttpEnv,
  rows: readonly OutboxRow[],
  clientId: Uint8Array,
  at: number = Date.now(),
): Promise<PreparedBeacon | null> {
  const live = rows.filter((r) => r.dead !== true)
  const batch = packBatch(live, BEACON_LIMITS)
  if (batch.length === 0) return null
  const body = packetOf(batch, clientId)
  const path = PATHS.deltas(env.docId)
  const headers = await signedHeaders({ ...env, clientId }, { method: 'POST', path, body })
  return {
    docId: env.docId,
    url: urlOf(env, path),
    headers,
    body,
    ids: batch.map((r) => r.i),
    preparedAt: at,
  }
}

/** Держать заготовку наготове (или снять её, передав null). */
export function armBeacon(docId: string, beacon: PreparedBeacon | null): void {
  if (beacon === null) ARMED.delete(docId)
  else ARMED.set(docId, beacon)
}

export function armedBeacon(docId: string): PreparedBeacon | null {
  return ARMED.get(docId) ?? null
}

export function disarmBeacon(docId: string): void {
  ARMED.delete(docId)
}

/**
 * Отправляет хвост outbox через fetch(..., { keepalive: true }). Тело ≤ 60 КБ.
 * Синхронно по построению: заготовка уже подписана. Ничего не бросает — на выгрузке
 * бросать некуда, а элементы остаются в очереди и уедут при следующем открытии.
 */
export function flushOutboxBeacon(docId: DocId | string, items: readonly OutboxItem[]): void {
  const beacon = ARMED.get(docId)
  if (beacon === undefined || items.length === 0) return
  const alive = new Set(items.map((i) => i.i))
  if (!beacon.ids.some((i) => alive.has(i))) return
  const f = globalThis.fetch as FetchLike | undefined
  if (f === undefined) return
  try {
    void f(beacon.url, {
      method: 'POST',
      headers: beacon.headers,
      body: beacon.body as BodyInit,
      keepalive: true,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
    }).catch(() => undefined)
  } catch {
    /* выгрузка: жаловаться некому */
  }
}

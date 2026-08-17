/**
 * HTTP-часть DocDO: разбор запроса, проверка подписи, вызов DocCore, сборка ответа.
 * Вынесена из класса DO, чтобы её можно было гонять в обычном тесте без workerd —
 * рассылка по сокетам приходит хуками, всё остальное чистое.
 */
import {
  DELTAS_LIMIT_DEFAULT,
  DELTAS_LIMIT_MAX,
  DELTAS_LIMIT_MIN,
  HDR,
  PATHS,
  decodeFrames,
  parseSigHeader,
} from '@elementar/proto'
import type { DocId, ElmErrorCode, Frame, SnapshotResult } from '@elementar/proto'
import { binaryResponse, jsonResponse } from '../http/cors.js'
import { decodeB32Exact } from '../lib/b32.js'
import { errorResponse } from '../http/errors.js'
import { parseCreateDoc, parseUint, parseWrap } from '../lib/validate.js'
import { DocCore } from './doc.core.js'
import type { CoreFail } from './doc.core.js'

/** Внутренний заголовок Worker → DO: какой документ обслуживаем. Наружу не выходит. */
export const DOC_ID_HEADER = 'x-elm-doc'
/** Код ошибки для Worker'а: он решает, маскировать ли ответ единым 404 (§9.4). */
export const CODE_HEADER = 'x-elm-code'

const CLIENT_ID_BYTES = 8

export interface DocHooks {
  /** Разослать принятые кадры остальным пирам с проставленными seq/ts. */
  broadcastDeltas(
    frames: readonly Frame[],
    assigned: ReadonlyArray<{ clientSeq: number; seq: number }>,
  ): void
  broadcastSnapshot(res: SnapshotResult): void
  /** Пиры получают bye при удалении документа (§8.5). */
  closeAll(code: ElmErrorCode): void
  onPush(acceptedDeltas: number, bytes: number): void
}

export const NO_HOOKS: DocHooks = {
  broadcastDeltas: () => undefined,
  broadcastSnapshot: () => undefined,
  closeAll: () => undefined,
  onPush: () => undefined,
}

export async function handleDocHttp(
  core: DocCore,
  request: Request,
  docId: DocId,
  allowedOrigin: string,
  hooks: DocHooks = NO_HOOKS,
): Promise<Response> {
  const url = new URL(request.url)
  const body = new Uint8Array(await request.arrayBuffer())
  const isCreate = url.pathname === PATHS.docs

  const fail = (code: ElmErrorCode, message: string, extra?: Record<string, number>): Response =>
    withCode(
      errorResponse(code, message, extra === undefined ? {} : { body: extra }, allowedOrigin),
      code,
    )
  const failFrom = (f: CoreFail): Response => fail(f.code, f.message, f.body)
  const ok = (value: unknown, status: number): Response =>
    jsonResponse(value, status, { [HDR.QUOTA]: core.quotaHeader() }, allowedOrigin)

  // подпись обязательна на всех операциях, включая чтение (§4.5)
  const sig = parseSigHeader(request.headers.get(HDR.SIG))
  if (sig === null) return fail('ELM_SIG_MISSING', 'Signature required')

  const created = isCreate ? parseCreateDoc(safeJson(body)) : null
  if (isCreate && created === null) return fail('ELM_BAD_REQUEST', 'Malformed request')
  if (created !== null && created.docId !== docId) return fail('ELM_BAD_REQUEST', 'docId mismatch')

  const sigErr = await core.verifySig({
    method: request.method,
    path: url.pathname,
    body,
    sig,
    ...(created !== null ? { sigPub: created.sigPubBytes } : {}),
  })
  if (sigErr !== null) return fail(sigErr, 'Signature rejected')

  if (!isCreate && !core.exists()) return fail('ELM_NOT_FOUND', 'Not found')
  const isUndelete = url.pathname === PATHS.undelete(docId)
  if (!isCreate && !isUndelete && !core.visible()) return fail('ELM_NOT_FOUND', 'Not found')

  if (created !== null) {
    const res = await core.init(created)
    if (!res.ok) return failFrom(res)
    return ok(res.value.meta, res.value.created ? 201 : 200)
  }

  switch (url.pathname) {
    case PATHS.doc(docId): {
      if (request.method === 'DELETE') {
        const res = await core.remove()
        if (!res.ok) return failFrom(res)
        hooks.closeAll('ELM_NOT_FOUND')
        return new Response(null, { status: 204, headers: { [HDR.QUOTA]: core.quotaHeader() } })
      }
      core.touch()
      const meta = core.docMeta()
      if (meta === null) return fail('ELM_NOT_FOUND', 'Not found')
      return ok(meta, 200)
    }

    case PATHS.undelete(docId): {
      const res = await core.undelete()
      if (!res.ok) return failFrom(res)
      return ok(res.value, 200)
    }

    case PATHS.wrap(docId): {
      const wrap = parseWrap((safeJson(body) as { wrap?: unknown } | null)?.wrap)
      if (wrap === null) return fail('ELM_BAD_REQUEST', 'Malformed wrap')
      const res = core.putWrap(wrap)
      if (!res.ok) return failFrom(res)
      return ok(res.value, 200)
    }

    case PATHS.deltas(docId): {
      if (request.method === 'GET') {
        const since = parseUint(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER)
        const limit = parseUint(
          url.searchParams.get('limit'),
          DELTAS_LIMIT_DEFAULT,
          DELTAS_LIMIT_MIN,
          DELTAS_LIMIT_MAX,
        )
        if (since === null || limit === null) return fail('ELM_BAD_REQUEST', 'Bad query')
        const res = core.getDeltas({ since, limit })
        if (!res.ok) return failFrom(res)
        core.touch()
        // выдача дельт по HTTP — это и есть подтверждение приёма для safeCompactSeq (§8.9);
        // у HTTP-клиента другого канала для ack нет
        const clientId = decodeB32Exact(request.headers.get(HDR.CLIENT) ?? '', CLIENT_ID_BYTES)
        if (clientId !== null) core.ack(clientId, lastSeqOf(res.value.packet, since))
        return binaryResponse(
          res.value.packet,
          200,
          {
            [HDR.HEAD]: String(res.value.head),
            [HDR.MORE]: res.value.more ? '1' : '0',
            [HDR.QUOTA]: core.quotaHeader(),
          },
          allowedOrigin,
        )
      }
      const decoded = decodeFrames(body, { direction: 'c2s' })
      if (!decoded.ok) return fail('ELM_BAD_FRAME', `Bad frame: ${decoded.reason}`)
      const res = core.pushDeltas(decoded.frames)
      if (!res.ok) return failFrom(res)
      hooks.onPush(res.value.accepted, body.length)
      hooks.broadcastDeltas(decoded.frames, res.value.assigned)
      return ok(res.value, 200)
    }

    case PATHS.snapshot(docId): {
      if (request.method === 'GET') {
        const gen = parseUint(url.searchParams.get('gen'), 0, 0, Number.MAX_SAFE_INTEGER)
        if (gen === null) return fail('ELM_BAD_REQUEST', 'Bad query')
        const res = await core.getSnapshot(gen === 0 ? undefined : gen)
        if (!res.ok) return failFrom(res)
        core.touch()
        return binaryResponse(
          res.value.body,
          200,
          {
            [HDR.SEQ]: String(res.value.seq),
            [HDR.GEN]: String(res.value.gen),
            [HDR.ETAG]: `"${docId}-${res.value.gen}"`,
            [HDR.QUOTA]: core.quotaHeader(),
          },
          allowedOrigin,
        )
      }
      const baseSeq = parseUint(request.headers.get(HDR.BASE_SEQ), -1, 0, Number.MAX_SAFE_INTEGER)
      if (baseSeq === null || baseSeq < 0) return fail('ELM_BAD_REQUEST', 'Bad base seq')
      const res = await core.putSnapshot(body, baseSeq)
      if (!res.ok) return failFrom(res)
      hooks.broadcastSnapshot(res.value)
      return ok(res.value, 200)
    }

    default:
      return fail('ELM_NOT_FOUND', 'Not found')
  }
}

function withCode(res: Response, code: ElmErrorCode): Response {
  const headers = new Headers(res.headers)
  headers.set(CODE_HEADER, code)
  return new Response(res.body, { status: res.status, headers })
}

/** Последний seq в отданном пакете; если пакет пуст — клиент подтверждает свой since. */
function lastSeqOf(packet: Uint8Array, fallback: number): number {
  const decoded = decodeFrames(packet)
  if (!decoded.ok) return fallback
  const last = decoded.frames[decoded.frames.length - 1]
  return last?.seq ?? fallback
}

export function safeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    return null
  }
}

/**
 * Ошибки и единый 404 (§9.4). «Нет документа», «нет подписи», «подпись неверна», «удалён»,
 * «протух», «неверный формат» дают байт в байт одинаковый ответ: одинаковое тело,
 * одинаковый набор и порядок заголовков, никакого Retry-After и никаких X-Elm-*.
 */
import { C, NOT_FOUND_BODY, NOT_FOUND_BODY_BYTES, statusForCode } from '@elementar/proto'
import type { ElmErrorCode, ErrorBody } from '@elementar/proto'
import { baseHeaders } from './cors.js'

export interface ErrorExtra {
  retryAfter?: number
  quota?: { used: number; limit: number; unit: 'bytes' | 'deltas' }
  /** Дополнительные поля тела: resyncFrom / safeCompactSeq. */
  body?: Record<string, number>
  headers?: Record<string, string>
}

export function errorResponse(
  code: ElmErrorCode,
  message: string,
  extra: ErrorExtra = {},
  allowedOrigin?: string,
): Response {
  if (code === 'ELM_NOT_FOUND') return notFoundResponse(allowedOrigin)
  const err: ErrorBody['error'] = { code, message }
  if (extra.retryAfter !== undefined) err.retryAfter = extra.retryAfter
  if (extra.quota !== undefined) err.quota = extra.quota
  const body: Record<string, unknown> = { error: err, ...(extra.body ?? {}) }
  const headers: Record<string, string> = {
    ...baseHeaders(allowedOrigin),
    'content-type': 'application/json',
    ...(extra.headers ?? {}),
  }
  if (extra.retryAfter !== undefined) headers['retry-after'] = String(Math.ceil(extra.retryAfter))
  return new Response(JSON.stringify(body), { status: statusForCode(code), headers })
}

/**
 * Единый 404. Заголовки собираются в фиксированном порядке и не зависят ни от чего:
 * ни один бит ответа не должен отличать «документа нет» от «подпись неверна».
 */
export function notFoundResponse(allowedOrigin?: string): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: {
      ...baseHeaders(allowedOrigin),
      'content-type': 'application/json',
      'content-length': String(NOT_FOUND_BODY_BYTES),
    },
  })
}

/** Коды, которые снаружи обязаны выглядеть как 404 (§9.4). */
const MASKED: readonly ElmErrorCode[] = [
  'ELM_NOT_FOUND',
  'ELM_SIG_INVALID',
  'ELM_SIG_EXPIRED',
  'ELM_SIG_REPLAY',
  'ELM_SIG_MISSING',
]

export function isMaskedCode(code: ElmErrorCode): boolean {
  return MASKED.includes(code)
}

/** Нижняя граница времени ответа 404: ELM_404_MIN_MS = 25 мс (§9.3). */
export async function padTo404Floor(startedAt: number, now: () => number): Promise<void> {
  const left = C.MIN_404_MS - (now() - startedAt)
  if (left > 0) await new Promise<void>((resolve) => setTimeout(resolve, left))
}

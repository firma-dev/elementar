/**
 * Общие заголовки ответа (§8.5). Access-Control-Allow-Origin — ASCII-литерал из
 * @elementar/proto, НИКОГДА не эхо заголовка Origin (§4.8).
 */
import { ALLOWED_ORIGIN, CORS } from '@elementar/proto'

export function baseHeaders(allowedOrigin: string = ALLOWED_ORIGIN): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': CORS.allowHeaders,
    'access-control-expose-headers': CORS.exposeHeaders,
    'access-control-max-age': CORS.maxAge,
  }
}

export function preflight(allowedOrigin?: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...baseHeaders(allowedOrigin),
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
  })
}

export function jsonResponse(
  body: unknown,
  status: number,
  extra: Record<string, string> = {},
  allowedOrigin?: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(allowedOrigin), 'content-type': 'application/json', ...extra },
  })
}

export function binaryResponse(
  body: Uint8Array,
  status: number,
  extra: Record<string, string> = {},
  allowedOrigin?: string,
): Response {
  return new Response(body as unknown as ArrayBufferView, {
    status,
    headers: {
      ...baseHeaders(allowedOrigin),
      'content-type': 'application/octet-stream',
      ...extra,
    },
  })
}

/** Коды ошибок протокола (§8.5). Один список на клиент и сервер. */
export type ElmErrorCode =
  | 'ELM_BAD_REQUEST' // 400
  | 'ELM_BAD_FRAME' // 400
  | 'ELM_SIG_INVALID' // 401
  | 'ELM_SIG_EXPIRED' // 401
  | 'ELM_SIG_REPLAY' // 401
  | 'ELM_SIG_MISSING' // 401
  | 'ELM_CHALLENGE' // 403 — нужен Turnstile-токен
  | 'ELM_NOT_FOUND' // 404 — единый ответ для «нет», «удалён», «протух», «нет подписи»
  | 'ELM_EXISTS' // 409 — docId занят другим ключом
  | 'ELM_STALE_BASE' // 409 — снапшот от устаревшего base_seq
  | 'ELM_UNSAFE_BASE' // 409 — компакция обогнала подтверждения пиров (§8.9)
  | 'ELM_WRAP_STALE' // 409 — wrapVer не больше текущего
  | 'ELM_TOO_LARGE' // 413
  | 'ELM_FROZEN' // 423
  | 'ELM_RATE_LIMITED' // 429
  | 'ELM_QUOTA_LOG_FULL' // 507
  | 'ELM_QUOTA_DOC_FULL' // 507
  | 'ELM_SHUTDOWN' // 503
  | 'ELM_INTERNAL' // 500

export const ELM_ERROR_CODES = [
  'ELM_BAD_REQUEST',
  'ELM_BAD_FRAME',
  'ELM_SIG_INVALID',
  'ELM_SIG_EXPIRED',
  'ELM_SIG_REPLAY',
  'ELM_SIG_MISSING',
  'ELM_CHALLENGE',
  'ELM_NOT_FOUND',
  'ELM_EXISTS',
  'ELM_STALE_BASE',
  'ELM_UNSAFE_BASE',
  'ELM_WRAP_STALE',
  'ELM_TOO_LARGE',
  'ELM_FROZEN',
  'ELM_RATE_LIMITED',
  'ELM_QUOTA_LOG_FULL',
  'ELM_QUOTA_DOC_FULL',
  'ELM_SHUTDOWN',
  'ELM_INTERNAL',
] as const satisfies readonly ElmErrorCode[]

export const ERROR_STATUS: Readonly<Record<ElmErrorCode, number>> = {
  ELM_BAD_REQUEST: 400,
  ELM_BAD_FRAME: 400,
  ELM_SIG_INVALID: 401,
  ELM_SIG_EXPIRED: 401,
  ELM_SIG_REPLAY: 401,
  ELM_SIG_MISSING: 401,
  ELM_CHALLENGE: 403,
  ELM_NOT_FOUND: 404,
  ELM_EXISTS: 409,
  ELM_STALE_BASE: 409,
  ELM_UNSAFE_BASE: 409,
  ELM_WRAP_STALE: 409,
  ELM_TOO_LARGE: 413,
  ELM_FROZEN: 423,
  ELM_RATE_LIMITED: 429,
  ELM_QUOTA_LOG_FULL: 507,
  ELM_QUOTA_DOC_FULL: 507,
  ELM_SHUTDOWN: 503,
  ELM_INTERNAL: 500,
}

export function isElmErrorCode(v: unknown): v is ElmErrorCode {
  return typeof v === 'string' && (ELM_ERROR_CODES as readonly string[]).includes(v)
}

export function statusForCode(code: ElmErrorCode): number {
  return ERROR_STATUS[code]
}

/**
 * Единый 404 (§9.4) — байт в байт одинаковый для «нет документа», «нет подписи»,
 * «подпись неверна», «удалён», «протух», «неверный формат».
 * Ни Retry-After, ни X-Elm-*, ни различий в порядке заголовков.
 */
export const NOT_FOUND_BODY = '{"error":{"code":"ELM_NOT_FOUND","message":"Not found"}}'

/**
 * Длина NOT_FOUND_BODY в байтах — для Content-Length. Тело чисто ASCII, поэтому length = байты.
 * В §9.4 подписано «Content-Length: 62», но у показанного там же тела 56 байт;
 * важна не цифра, а байт-в-байт одинаковый ответ, поэтому длина считается, а не вбивается.
 */
export const NOT_FOUND_BODY_BYTES = NOT_FOUND_BODY.length

import type { LlmErrorCode, LlmEvent } from './types.js'

export class LlmError extends Error {
  override readonly name = 'LlmError'
  readonly code: LlmErrorCode
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined

  constructor(
    code: LlmErrorCode,
    message: string,
    opts?: { status?: number; retryAfterMs?: number },
  ) {
    super(message)
    this.code = code
    this.status = opts?.status
    this.retryAfterMs = opts?.retryAfterMs
  }
}

export function codeForStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate'
  if (status === 404) return 'model'
  if (status === 413) return 'context'
  if (status >= 500) return 'server'
  return 'server'
}

export function retryAfterMsOf(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number.parseInt(raw.trim(), 10)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return undefined
  const delta = date - Date.now()
  return delta > 0 ? delta : 0
}

function pick(o: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined
}

/** Сообщение об ошибке из тела ответа: у всех трёх семейств оно лежит по-разному. */
export function messageOfBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return trimmed.slice(0, 400)
  }
  if (typeof parsed !== 'object' || parsed === null) return trimmed.slice(0, 400)
  const root = parsed as Record<string, unknown>
  const err = pick(root, 'error')
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const msg = pick(err as Record<string, unknown>, 'message')
    if (typeof msg === 'string') return msg
  }
  const msg = pick(root, 'message')
  if (typeof msg === 'string') return msg
  return trimmed.slice(0, 400)
}

/** Ошибка контекста опознаётся по тексту: кода для неё нет ни у кого. */
export function refineCode(code: LlmErrorCode, message: string): LlmErrorCode {
  const m = message.toLowerCase()
  if (
    m.includes('context length') ||
    m.includes('context_length') ||
    m.includes('too many tokens') ||
    m.includes('maximum context') ||
    m.includes('prompt is too long')
  ) {
    return 'context'
  }
  // 400 «unknown model» — это не отказ сервера, а неверная настройка слота
  if (code === 'server' && m.includes('model')) return 'model'
  return code
}

export function isAbort(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const name = (e as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}

export function errorOf(e: unknown, fallback: LlmErrorCode = 'network'): LlmError {
  if (e instanceof LlmError) return e
  if (isAbort(e)) return new LlmError('aborted', 'запрос отменён')
  const message = e instanceof Error ? e.message : String(e)
  return new LlmError(fallback, message)
}

export function errorEvent(e: unknown, fallback: LlmErrorCode = 'network'): LlmEvent {
  const err = errorOf(e, fallback)
  return err.retryAfterMs === undefined
    ? { type: 'error', code: err.code, message: err.message }
    : { type: 'error', code: err.code, message: err.message, retryAfterMs: err.retryAfterMs }
}

/** Человеческий текст для слота модели. */
export function describeLlmError(code: LlmErrorCode): string {
  switch (code) {
    case 'auth':
      return 'Ключ не принят'
    case 'rate':
      return 'Слишком часто — провайдер попросил подождать'
    case 'context':
      return 'Слишком длинный запрос для этой модели'
    case 'network':
      return 'Нет связи с провайдером'
    case 'cors':
      return 'Провайдер не отвечает браузеру напрямую'
    case 'model':
      return 'Модель недоступна'
    case 'server':
      return 'Провайдер ответил ошибкой'
    case 'aborted':
      return 'Отменено'
  }
}

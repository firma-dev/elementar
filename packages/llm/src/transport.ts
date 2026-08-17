/**
 * Транспорт запроса к провайдеру (§10.1, §10.2).
 *
 * Три режима: direct → own-relay → elm-relay. Ключевое правило: авто-фолбэка нет.
 * Если direct упал на CORS, адаптер отдаёт код 'cors' и на этом останавливается;
 * решение «пустить ключ через сервер элементара» принимает человек в UI.
 */
import { API_ORIGIN, HDR, PATHS } from '@elementar/proto'
import { LlmError, codeForStatus, isAbort, messageOfBody, refineCode, retryAfterMsOf } from './errors.js'
import type { FetchLike, LlmTransportConfig } from './types.js'

/** Allowlist релея — ровно тот же, что зашит в Worker (§10.2). */
export const RELAY_ALLOW: Readonly<Record<string, { host: string; path: RegExp; keyHeader: string }>> =
  {
    anthropic: { host: 'api.anthropic.com', path: /^\/v1\/messages$/, keyHeader: 'x-api-key' },
    openai: { host: 'api.openai.com', path: /^\/v1\/chat\/completions$/, keyHeader: 'authorization' },
    deepseek: { host: 'api.deepseek.com', path: /^\/chat\/completions$/, keyHeader: 'authorization' },
    moonshot: { host: 'api.moonshot.cn', path: /^\/v1\/chat\/completions$/, keyHeader: 'authorization' },
  }

/** Тело запроса ≤ 256 KiB (§10.2 п.6) — проверяем до отправки, чтобы не жечь бакет. */
export const RELAY_MAX_BODY_BYTES = 256 * 1024
export const REQUEST_TIMEOUT_MS = 60_000

export function relayAllows(providerId: string, path: string): boolean {
  const rule = RELAY_ALLOW[providerId]
  return rule !== undefined && rule.path.test(path)
}

export interface EndpointArgs {
  providerId: string
  /** База провайдера без хвостового слэша, например 'https://api.deepseek.com'. */
  baseUrl: string
  /** Путь запроса, например '/v1/messages'. */
  path: string
  transport: LlmTransportConfig
}

export interface Endpoint {
  url: string
  mode: LlmTransportConfig['mode']
  viaRelay: boolean
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

/**
 * Куда реально уходит запрос. Никакой подстановки произвольного URL:
 * в режиме релея адрес собирается из allowlist по providerId, `?url=` не существует.
 */
export function resolveEndpoint(a: EndpointArgs): Endpoint {
  if (a.transport.mode === 'direct') {
    return { url: `${trimSlash(a.baseUrl)}${a.path}`, mode: 'direct', viaRelay: false }
  }
  if (a.transport.mode === 'own-relay') {
    const relay = a.transport.relayUrl
    if (relay === undefined || relay.trim() === '') {
      throw new LlmError('network', 'не задан адрес собственного релея')
    }
    return { url: `${trimSlash(relay)}${a.path}`, mode: 'own-relay', viaRelay: true }
  }
  if (!relayAllows(a.providerId, a.path)) {
    throw new LlmError('model', `релей элементара не проксирует ${a.providerId}${a.path}`)
  }
  return { url: `${API_ORIGIN}${PATHS.llm(a.providerId)}`, mode: 'elm-relay', viaRelay: true }
}

export interface LlmFetchArgs {
  endpoint: Endpoint
  headers: Record<string, string>
  body: string
  fetch?: FetchLike
  signal?: AbortSignal
  /** Одноразовый Turnstile-токен, TTL 60 с. Нужен только релею элементара. */
  challenge?: string | null
  timeoutMs?: number
}

/** TypeError от fetch в браузере — это либо обрыв сети, либо запрет CORS. */
function networkCode(endpoint: Endpoint): 'cors' | 'network' {
  return endpoint.mode === 'direct' ? 'cors' : 'network'
}

/**
 * Один сетевой вызов. Ошибку не «чинит» сменой транспорта — это сознательное
 * ограничение: провайдер (или атакующий на преflight) не должен уметь заставить
 * ключ пользователя пойти через наш сервер.
 */
export async function llmFetch(a: LlmFetchArgs): Promise<Response> {
  const bodyBytes = new TextEncoder().encode(a.body)
  if (a.endpoint.mode === 'elm-relay' && bodyBytes.byteLength > RELAY_MAX_BODY_BYTES) {
    throw new LlmError('context', 'запрос длиннее 256 КиБ — релей его не пропустит')
  }
  const headers: Record<string, string> = { ...a.headers }
  if (a.endpoint.mode === 'elm-relay') {
    if (a.challenge === undefined || a.challenge === null || a.challenge === '') {
      throw new LlmError('auth', 'релей элементара требует токен проверки')
    }
    headers[HDR.CHALLENGE] = a.challenge
  }
  const doFetch: FetchLike = a.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = a.timeoutMs ?? REQUEST_TIMEOUT_MS
  const ctl = new AbortController()
  const onAbort = (): void => ctl.abort()
  if (a.signal !== undefined) {
    if (a.signal.aborted) ctl.abort()
    else a.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res: Response
  try {
    res = await doFetch(a.endpoint.url, {
      method: 'POST',
      headers,
      body: a.body,
      signal: ctl.signal,
      redirect: 'error',
      cache: 'no-store',
      // Ключ пользователя не должен уехать вместе с нашими куками
      credentials: 'omit',
      mode: 'cors',
    })
  } catch (e) {
    if (isAbort(e)) {
      if (a.signal?.aborted === true) throw new LlmError('aborted', 'запрос отменён')
      throw new LlmError('network', 'провайдер не ответил за 60 секунд')
    }
    throw new LlmError(networkCode(a.endpoint), e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(timer)
    if (a.signal !== undefined) a.signal.removeEventListener('abort', onAbort)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const message = messageOfBody(text)
    const code = refineCode(codeForStatus(res.status), message)
    const retryAfterMs = retryAfterMsOf(res)
    throw new LlmError(code, message === '' ? `HTTP ${res.status}` : message, {
      status: res.status,
      retryAfterMs,
    })
  }
  return res
}

/**
 * Шаблон собственного релея — «в один клик» из §10.1. Тридцать строк, деплоится
 * на бесплатный тариф Workers; мы в этом режиме не на пути вообще.
 */
export const OWN_RELAY_TEMPLATE = `// Собственный релей к провайдеру модели. Деплой: wrangler deploy.
// ALLOW_ORIGIN — адрес, с которого вы открываете элементар.
const ALLOW_ORIGIN = 'https://elementar.example'
const UPSTREAM = 'https://api.deepseek.com' // адрес вашего провайдера
const PASS = ['content-type', 'accept', 'authorization', 'x-api-key', 'anthropic-version']

export default {
  async fetch(req) {
    const origin = req.headers.get('origin')
    const cors = {
      'access-control-allow-origin': ALLOW_ORIGIN,
      'access-control-allow-headers': PASS.join(','),
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-max-age': '86400',
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (origin !== ALLOW_ORIGIN) return new Response('forbidden', { status: 403 })
    if (req.method !== 'POST') return new Response('method', { status: 405 })
    const url = new URL(req.url)
    const headers = new Headers()
    for (const h of PASS) {
      const v = req.headers.get(h)
      if (v) headers.set(h, v)
    }
    const upstream = await fetch(UPSTREAM + url.pathname, {
      method: 'POST',
      headers,
      body: req.body,
      redirect: 'error',
    })
    const out = new Headers(cors)
    out.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
}
`

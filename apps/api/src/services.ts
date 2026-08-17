/**
 * Сборка зависимостей Worker'а. Всё, что ходит наружу (D1, DO, R2, KV, Cache API),
 * спрятано за интерфейсами: тест подставляет память и считает обращения к DocDO (§9.6 п.5).
 */
import { ALLOWED_ORIGIN } from '@elementar/proto'
import type { Env } from './env.js'
import { D1Catalog } from './lib/catalog.js'
import type { Catalog } from './lib/catalog.js'
import { KvFlags } from './lib/flags.js'
import type { FlagsReader } from './lib/flags.js'
import { DoLimiter } from './lib/limiter.client.js'
import type { LimiterClient } from './lib/limiter.client.js'
import { CacheApiExists, CacheApiPenalty, MemoryExists, MemoryPenalty } from './http/exists.js'
import type { ExistsCache, PenaltyCache } from './http/exists.js'
import { CloudflareTurnstile, DisabledTurnstile } from './http/turnstile.js'
import type { TurnstileVerifier } from './http/turnstile.js'
import { DOC_ID_HEADER } from './do/doc.http.js'

export interface Stub {
  fetch(request: Request): Promise<Response>
}

export interface StubHost {
  get(name: string): Stub
}

export interface Services {
  now(): number
  catalog: Catalog
  exists: ExistsCache
  penalty: PenaltyCache
  limiter: LimiterClient
  docs: StubHost
  invites: StubHost
  flags: FlagsReader
  turnstile: TurnstileVerifier
  /** ELM_IP_PEPPER; пустая строка — только в dev. */
  pepper: string
  allowedOrigin: string
  waitUntil(p: Promise<unknown>): void
}

class NamespaceHost implements StubHost {
  constructor(
    private readonly ns: DurableObjectNamespace,
    private readonly prefix: string,
  ) {}
  get(name: string): Stub {
    const stub = this.ns.get(this.ns.idFromName(this.prefix + name))
    return {
      fetch: (request: Request): Promise<Response> => stub.fetch(request),
    }
  }
}

export function buildServices(env: Env, ctx: ExecutionContext): Services {
  const hasCache = typeof caches !== 'undefined'
  const exists: ExistsCache = hasCache ? new CacheApiExists(caches.default) : new MemoryExists()
  const penalty: PenaltyCache = hasCache ? new CacheApiPenalty(caches.default) : new MemoryPenalty()
  const turnstile: TurnstileVerifier =
    env.ELM_TURNSTILE_SECRET !== undefined && env.ELM_TURNSTILE_SECRET !== ''
      ? new CloudflareTurnstile(env.ELM_TURNSTILE_SECRET, env.ELM_TURNSTILE_SITEKEY ?? '')
      : new DisabledTurnstile()

  return {
    now: () => Date.now(),
    catalog: new D1Catalog(env.DB),
    exists,
    penalty,
    limiter: new DoLimiter(env.LIMITER),
    docs: new NamespaceHost(env.DOC, ''),
    invites: new NamespaceHost(env.INVITE, 'inv:'),
    flags: new KvFlags(env.CONFIG),
    turnstile,
    pepper: env.ELM_IP_PEPPER ?? '',
    allowedOrigin: env.ELM_ALLOWED_ORIGIN !== '' ? env.ELM_ALLOWED_ORIGIN : ALLOWED_ORIGIN,
    waitUntil: (p) => ctx.waitUntil(p),
  }
}

/** Запрос к DocDO: docId едет служебным заголовком, путь и тело — как пришли от клиента. */
export function docRequest(request: Request, docId: string, body: BodyInit | null): Request {
  const headers = new Headers(request.headers)
  headers.set(DOC_ID_HEADER, docId)
  const init: RequestInit = { method: request.method, headers }
  if (body !== null) init.body = body
  return new Request(request.url, init)
}

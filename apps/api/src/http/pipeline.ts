/**
 * Порядок обработки входящего запроса (§9.3):
 *   формат docId → Cache API «существует ли» → наказания префикса → лимитер → DocDO.
 * Для неизвестного id DocDO не инстанцируется вообще: ни счёта, ни тайминга.
 *
 * Промах списывается в waitUntil, ПОСЛЕ отправки ответа (§9.2 п.6): атакующий не получает
 * тайминговой разницы, честный пользователь — задержки.
 */
import { C, HDR, OP_COST, asDocId } from '@elementar/proto'
import type { DocId, ElmErrorCode } from '@elementar/proto'
import { matchRoute } from './router.js'
import type { Route } from './router.js'
import { errorResponse, isMaskedCode, notFoundResponse, padTo404Floor } from './errors.js'
import { preflight } from './cors.js'
import type { Services } from '../services.js'
import {
  blockPrefix,
  challengePrefix,
  clientIp,
  dailyPepper,
  dayKey,
  prefixHash,
} from '../lib/ipHash.js'
import { bumpMetric } from '../lib/metrics.js'
import { isElmErrorCode } from '@elementar/proto'
import { CODE_HEADER } from '../do/doc.http.js'
import { handleChallenge, handleHealth } from '../routes/health.js'
import { handleCreateDoc } from '../routes/docs.create.js'
import { handleDocRoute } from '../routes/docs.proxy.js'
import { handleInviteCreate, handleInviteGet } from '../routes/invite.js'
import { handleLlm } from '../routes/llm.relay.js'
import type { Flags } from '../lib/flags.js'

export interface ReqCtx {
  req: Request
  url: URL
  route: Route
  svc: Services
  startedAt: number
  /** Хеш префикса челленджа: IPv4 /24, IPv6 /64. */
  prefix: string
  /** Хеш ключа блока: полный IPv4 или IPv6 /64. */
  blockKey: string
  flags: Flags
}

export async function handleRequest(req: Request, svc: Services): Promise<Response> {
  const startedAt = svc.now()
  if (req.method === 'OPTIONS') return preflight(svc.allowedOrigin)

  const url = new URL(req.url)
  const ip = clientIp(req)
  const pepper = await dailyPepper(svc.pepper, dayKey(startedAt))
  const prefix = await prefixHash(pepper, challengePrefix(ip))
  const blockKey = await prefixHash(pepper, blockPrefix(ip))

  const route = matchRoute(req.method, url.pathname)
  if (route === null) {
    return missResponse({ req, url, svc, startedAt, prefix, blockKey })
  }

  const flags = await svc.flags.read()
  const ctx: ReqCtx = { req, url, route, svc, startedAt, prefix, blockKey, flags }

  try {
    switch (route.name) {
      case 'health':
        return handleHealth(ctx)
      case 'challenge': {
        const gate = await anonGate(ctx, OP_COST.challenge)
        return gate ?? handleChallenge(ctx)
      }
      case 'docs.create':
        return await handleCreateDoc(ctx)
      case 'invite.create':
        return await handleInviteCreate(ctx)
      case 'invite.get':
        return await handleInviteGet(ctx)
      case 'llm':
        return await handleLlm(ctx)
      default:
        return await handleDocRoute(ctx)
    }
  } catch {
    return errorResponse('ELM_INTERNAL', 'Internal error', {}, svc.allowedOrigin)
  }
}

export interface MissCtx {
  req: Request
  url: URL
  svc: Services
  startedAt: number
  prefix: string
  blockKey: string
}

/**
 * Единый 404 (§9.4) плюс отложенное списание промаха. Все ветки — «нет документа»,
 * «нет подписи», «подпись неверна», «удалён», «протух», «неверный формат» — приходят сюда.
 */
export async function missResponse(ctx: MissCtx): Promise<Response> {
  // наказание префикса читается из Cache API: повторный мусор не стоит даже запроса
  // к LimiterDO и не наращивает missStreak дальше (§9.3)
  const p = await ctx.svc.penalty.get(ctx.prefix)
  const now = ctx.svc.now()
  if (p !== null && p.blockedUntil > now) {
    bumpMetric('http_429')
    return errorResponse(
      'ELM_RATE_LIMITED',
      'Too many requests',
      { retryAfter: Math.ceil((p.blockedUntil - now) / 1000) },
      ctx.svc.allowedOrigin,
    )
  }
  if (p !== null && p.challengeUntil > now) {
    bumpMetric('challenges')
    return errorResponse('ELM_CHALLENGE', 'Challenge required', {}, ctx.svc.allowedOrigin)
  }

  bumpMetric('http_404')
  ctx.svc.waitUntil(chargeMiss(ctx))
  await padTo404Floor(ctx.startedAt, ctx.svc.now)
  return notFoundResponse(ctx.svc.allowedOrigin)
}

async function chargeMiss(ctx: MissCtx): Promise<void> {
  const d = await ctx.svc.limiter.charge(ctx.prefix, { kind: 'miss', blockKey: ctx.blockKey })
  if (d.ok) return
  const now = ctx.svc.now()
  const state = {
    challengeUntil: d.reason === 'challenge' ? now + C.CHALLENGE_MS : 0,
    blockedUntil: d.reason === 'blocked' ? now + (d.retryAfter ?? 0) * 1000 : 0,
  }
  if (d.reason === 'blocked') bumpMetric('blocks_issued')
  await ctx.svc.penalty.set(ctx.prefix, state)
}

/** Наказание префикса: применимо только к неаутентифицированному трафику (§9.2). */
export async function penaltyGate(ctx: ReqCtx): Promise<Response | null> {
  const p = await ctx.svc.penalty.get(ctx.prefix)
  if (p === null) return null
  const now = ctx.svc.now()
  if (p.blockedUntil > now) {
    bumpMetric('http_429')
    return errorResponse(
      'ELM_RATE_LIMITED',
      'Too many requests',
      { retryAfter: Math.ceil((p.blockedUntil - now) / 1000) },
      ctx.svc.allowedOrigin,
    )
  }
  if (p.challengeUntil > now) {
    bumpMetric('challenges')
    return errorResponse('ELM_CHALLENGE', 'Challenge required', {}, ctx.svc.allowedOrigin)
  }
  return null
}

/** Плата за легальную, но неподписанную операцию: /challenge, GET /invite, LLM-релей. */
export async function anonGate(ctx: ReqCtx, cost: number): Promise<Response | null> {
  const blocked = await penaltyGate(ctx)
  if (blocked !== null) return blocked
  const d = await ctx.svc.limiter.charge(ctx.prefix, {
    kind: 'anon',
    cost,
    blockKey: ctx.blockKey,
  })
  if (d.ok) return null
  await ctx.svc.penalty.set(ctx.prefix, {
    challengeUntil: d.reason === 'challenge' ? ctx.svc.now() + C.CHALLENGE_MS : 0,
    blockedUntil: d.reason === 'blocked' ? ctx.svc.now() + (d.retryAfter ?? 0) * 1000 : 0,
  })
  if (d.reason === 'blocked' || d.reason === 'rate') {
    bumpMetric('http_429')
    const extra = d.retryAfter === undefined ? {} : { retryAfter: d.retryAfter }
    return errorResponse('ELM_RATE_LIMITED', 'Too many requests', extra, ctx.svc.allowedOrigin)
  }
  bumpMetric('challenges')
  return errorResponse('ELM_CHALLENGE', 'Challenge required', {}, ctx.svc.allowedOrigin)
}

/** Списание цены операции из auth-бакета. Промахи его не касаются никогда (§9.2). */
export async function authGate(ctx: ReqCtx, cost: number): Promise<Response | null> {
  const d = await ctx.svc.limiter.charge(ctx.prefix, { kind: 'auth', cost })
  if (d.ok) return null
  bumpMetric('http_429')
  const extra = d.retryAfter === undefined ? {} : { retryAfter: d.retryAfter }
  return errorResponse('ELM_RATE_LIMITED', 'Too many requests', extra, ctx.svc.allowedOrigin)
}

export function docIdOf(ctx: ReqCtx): DocId | null {
  const raw = ctx.route.docId
  return raw === undefined ? null : asDocId(raw)
}

/** Существование документа: Cache API → одно чтение D1 → запись в кэш (§9.3). */
export async function docExists(
  ctx: ReqCtx,
  docId: DocId,
  includeTombstone: boolean,
): Promise<boolean> {
  if (includeTombstone) return ctx.svc.catalog.existsAny(docId)
  const cached = await ctx.svc.exists.get(docId)
  if (cached !== null) return cached
  const real = await ctx.svc.catalog.existsActive(docId)
  ctx.svc.waitUntil(ctx.svc.exists.set(docId, real))
  return real
}

/**
 * Ответ DocDO наружу: коды подписи маскируются единым 404, служебный заголовок снимается,
 * успешный аутентифицированный ответ снижает missStreak (§9.2 п.4).
 */
export async function finishDoResponse(ctx: ReqCtx, res: Response): Promise<Response> {
  if (res.status === 101) return res
  const raw = res.headers.get(CODE_HEADER)
  const code: ElmErrorCode | null = raw !== null && isElmErrorCode(raw) ? raw : null

  if (code !== null && isMaskedCode(code)) {
    return missResponse(ctx)
  }
  if (res.ok) {
    ctx.svc.waitUntil(ctx.svc.limiter.success(ctx.prefix))
  }
  if (res.status === 429) bumpMetric('http_429')

  const headers = new Headers(res.headers)
  headers.delete(CODE_HEADER)
  const body = res.status === 204 || res.status === 304 ? null : res.body
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}

/** Заголовок квоты (§8.11) проставляет DocDO; здесь только его имя для проверок в тестах. */
export const QUOTA_HEADER = HDR.QUOTA

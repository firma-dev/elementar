/**
 * `POST /v1/docs` (§8.5). Порядок: kill-switch → лимитер → (Turnstile, если включён) →
 * валидация формата docId и sigPub → проверка подписи ключом sigPub из тела (доказательство
 * владения приватным ключом, проверяет DocDO) → init → прогрев exists-кэша и метрика.
 */
import { C, HDR, OP_COST } from '@elementar/proto'
import { errorResponse } from '../http/errors.js'
import { authGate, finishDoResponse, penaltyGate } from '../http/pipeline.js'
import type { ReqCtx } from '../http/pipeline.js'
import { docRequest } from '../services.js'
import { parseCreateDoc } from '../lib/validate.js'
import { bumpMetric } from '../lib/metrics.js'

/** JSON создания: снапшот в b32 (8 бит → 1.6 символа) плюс запас на wrap и ключ. */
const CREATE_BODY_LIMIT = Math.ceil((C.INLINE_SNAPSHOT_BYTES * 8) / 5) + 4096

export async function handleCreateDoc(ctx: ReqCtx): Promise<Response> {
  if (!ctx.flags.acceptCreates) {
    return errorResponse(
      'ELM_SHUTDOWN',
      'Creation is paused',
      { retryAfter: 60 },
      ctx.svc.allowedOrigin,
    )
  }
  if (ctx.req.headers.get(HDR.SIG) === null) {
    return errorResponse('ELM_SIG_MISSING', 'Signature required', {}, ctx.svc.allowedOrigin)
  }

  const blocked = await penaltyGate(ctx)
  if (blocked !== null && blocked.status !== 403) return blocked

  const declared = Number(ctx.req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > CREATE_BODY_LIMIT) {
    return errorResponse('ELM_TOO_LARGE', 'Body too large', {}, ctx.svc.allowedOrigin)
  }
  const body = await ctx.req.arrayBuffer()
  if (body.byteLength > CREATE_BODY_LIMIT) {
    return errorResponse('ELM_TOO_LARGE', 'Body too large', {}, ctx.svc.allowedOrigin)
  }

  const parsed = parseCreateDoc(safeJson(body))
  if (parsed === null)
    return errorResponse('ELM_BAD_REQUEST', 'Malformed request', {}, ctx.svc.allowedOrigin)

  // Turnstile обязателен, если префикс под челленджем или включён режим 1 (§9.2, §9.7)
  const needChallenge =
    ctx.flags.challengeMode === 1 || (blocked !== null && blocked.status === 403)
  if (needChallenge && ctx.flags.challengeMode !== 2) {
    const token = parsed.challenge ?? ctx.req.headers.get(HDR.CHALLENGE)
    if (!(await ctx.svc.turnstile.verify(token ?? null))) {
      bumpMetric('challenges')
      return errorResponse('ELM_CHALLENGE', 'Challenge required', {}, ctx.svc.allowedOrigin)
    }
  }

  const quota = await ctx.svc.limiter.createQuota(ctx.prefix)
  if (!quota.ok) {
    bumpMetric('http_429')
    const extra = quota.retryAfter === undefined ? {} : { retryAfter: quota.retryAfter }
    return errorResponse('ELM_RATE_LIMITED', 'Too many documents', extra, ctx.svc.allowedOrigin)
  }

  const gate = await authGate(ctx, OP_COST.createDoc)
  if (gate !== null) return gate

  const res = await ctx.svc.docs.get(parsed.docId).fetch(docRequest(ctx.req, parsed.docId, body))
  const out = await finishDoResponse(ctx, res)
  if (out.status === 201 || out.status === 200) {
    // кэш существования инвалидируется прямой записью положительного значения (§9.3)
    ctx.svc.waitUntil(ctx.svc.exists.set(parsed.docId, true))
    if (out.status === 201) bumpMetric('docs_created')
  }
  return out
}

function safeJson(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    return null
  }
}

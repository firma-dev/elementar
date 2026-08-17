/**
 * `POST /v1/llm/{provider}` — релей к модели (§8.5, режим 'elm-relay' §10.1).
 * Подписи нет (документ к запросу не привязан), поэтому: рубильник llm_relay,
 * обязательный Turnstile, цена 50 из miss-бакета и жёсткий белый список провайдеров.
 *
 * ЗАГЛУШКА: адреса провайдеров вынесены сюда как литералы; при выборе конкретных моделей
 * список меняется ровно здесь. Ключ пользователя не хранится — он приходит в заголовке
 * запроса и уходит вместе с ним, сервер его не логирует.
 */
import { OP_COST, HDR } from '@elementar/proto'
import { errorResponse } from '../http/errors.js'
import { anonGate } from '../http/pipeline.js'
import type { ReqCtx } from '../http/pipeline.js'
import { baseHeaders } from '../http/cors.js'
import { bumpMetric } from '../lib/metrics.js'

const PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
}

/** Заголовки, которым разрешено пройти к провайдеру. Всё остальное отбрасывается. */
const PASS_TO_PROVIDER = ['content-type', 'authorization', 'x-api-key', 'anthropic-version']
const MAX_LLM_BODY = 512 * 1024

export async function handleLlm(ctx: ReqCtx): Promise<Response> {
  if (!ctx.flags.llmRelay) {
    return errorResponse(
      'ELM_SHUTDOWN',
      'Relay is paused',
      { retryAfter: 60 },
      ctx.svc.allowedOrigin,
    )
  }
  const target = PROVIDERS[ctx.route.provider ?? '']
  if (target === undefined) {
    return errorResponse('ELM_BAD_REQUEST', 'Unknown provider', {}, ctx.svc.allowedOrigin)
  }
  if (ctx.flags.challengeMode !== 2) {
    const token = ctx.req.headers.get(HDR.CHALLENGE)
    if (!(await ctx.svc.turnstile.verify(token))) {
      bumpMetric('challenges')
      return errorResponse('ELM_CHALLENGE', 'Challenge required', {}, ctx.svc.allowedOrigin)
    }
  }

  const gate = await anonGate(ctx, OP_COST.llm)
  if (gate !== null) return gate

  const body = await ctx.req.arrayBuffer()
  if (body.byteLength > MAX_LLM_BODY) {
    return errorResponse('ELM_TOO_LARGE', 'Body too large', {}, ctx.svc.allowedOrigin)
  }

  const headers = new Headers()
  for (const name of PASS_TO_PROVIDER) {
    const v = ctx.req.headers.get(name)
    if (v !== null) headers.set(name, v)
  }

  const upstream = await fetch(target, { method: 'POST', headers, body })
  const out = new Headers(baseHeaders(ctx.svc.allowedOrigin))
  const ct = upstream.headers.get('content-type')
  if (ct !== null) out.set('content-type', ct)
  // стрим отдаётся как есть: ни одного байта ответа модели сервер не разбирает
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

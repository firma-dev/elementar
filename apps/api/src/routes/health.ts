/** `/v1/health` и `/v1/challenge` — единственные пути без подписи (§8.5). */
import type { HealthResponse, ChallengeResponse } from '@elementar/proto'
import { jsonResponse } from '../http/cors.js'
import type { ReqCtx } from '../http/pipeline.js'

export function handleHealth(ctx: ReqCtx): Response {
  const body: HealthResponse = { ok: true }
  return jsonResponse(body, 200, {}, ctx.svc.allowedOrigin)
}

export function handleChallenge(ctx: ReqCtx): Response {
  const body: ChallengeResponse = { sitekey: ctx.svc.turnstile.sitekey() }
  return jsonResponse(body, 200, {}, ctx.svc.allowedOrigin)
}

/**
 * Приглашения (§8.5). Блоб ≤ 128 байт шифротекста, TTL 15 минут, ровно одно использование.
 *
 * ОГРАНИЧЕНИЕ. В таблице §8.5 `POST /v1/invite` помечен как подписанный, но CreateInviteRequest
 * не несёт docId, а единственный ключ подписи живёт в DocDO соответствующего документа —
 * связать приглашение с документом на сервере нельзя по построению (в этом и смысл слепоты).
 * Поэтому здесь проверяется формат заголовка подписи, а цена берётся из miss-бакета,
 * как у неподписанных операций. Настоящий барьер — WAF-правило зоны и цена 5.
 */
import { C, OP_COST, isCrockford, parseSigHeader, HDR } from '@elementar/proto'
import { binaryResponse, jsonResponse } from '../http/cors.js'
import { errorResponse } from '../http/errors.js'
import { anonGate, missResponse } from '../http/pipeline.js'
import type { ReqCtx } from '../http/pipeline.js'
import { parseInvite } from '../lib/validate.js'
import { decodeB32 } from '../lib/b32.js'
import type { CreateInviteResponse } from '@elementar/proto'

const INVITE_BODY_LIMIT = 4096

export async function handleInviteCreate(ctx: ReqCtx): Promise<Response> {
  if (parseSigHeader(ctx.req.headers.get(HDR.SIG)) === null) return missResponse(ctx)

  const gate = await anonGate(ctx, OP_COST.createInvite)
  if (gate !== null) return gate

  const body = await ctx.req.arrayBuffer()
  if (body.byteLength > INVITE_BODY_LIMIT) {
    return errorResponse('ELM_TOO_LARGE', 'Body too large', {}, ctx.svc.allowedOrigin)
  }
  let parsedJson: unknown = null
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    parsedJson = null
  }
  const inv = parseInvite(parsedJson)
  if (inv === null)
    return errorResponse('ELM_BAD_REQUEST', 'Malformed invite', {}, ctx.svc.allowedOrigin)

  const res = await ctx.svc.invites.get(inv.iid).fetch(
    new Request('https://invite/put', {
      method: 'POST',
      body: JSON.stringify({ blob: inv.blob }),
    }),
  )
  if (res.status !== 201) return missResponse(ctx)
  const out = (await res.json()) as { expiresAt: number }
  const payload: CreateInviteResponse = { iid: inv.iid, expiresAt: out.expiresAt }
  return jsonResponse(payload, 201, {}, ctx.svc.allowedOrigin)
}

/** GET без подписи: получатель не имеет ключа до погашения. Второй GET → тот же 404. */
export async function handleInviteGet(ctx: ReqCtx): Promise<Response> {
  const iid = ctx.route.iid ?? ''
  // кривой iid не должен инстанцировать InviteDO — ровно как с docId (§9.3)
  if (iid.length !== C.DOC_ID_CHARS || !isCrockford(iid)) return missResponse(ctx)
  const gate = await anonGate(ctx, OP_COST.getInvite)
  if (gate !== null) return gate

  const res = await ctx.svc.invites.get(iid).fetch(new Request('https://invite/get'))
  if (res.status !== 200) return missResponse(ctx)
  const out = (await res.json()) as { blob?: unknown }
  const blob = typeof out.blob === 'string' ? decodeB32(out.blob) : null
  if (blob === null) return missResponse(ctx)
  return binaryResponse(blob, 200, {}, ctx.svc.allowedOrigin)
}

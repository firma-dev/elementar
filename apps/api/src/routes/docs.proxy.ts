/**
 * Все операции над существующим документом. Единственное, чем они отличаются друг от друга, —
 * цена в auth-бакете и флаг записи; сама работа целиком внутри DocDO, который один знает
 * sigPub и лог. Поэтому один прокси-модуль вместо тринадцати почти одинаковых.
 */
import {
  C,
  HDR,
  OP_COST,
  PACKET_HEADER_BYTES,
  FRAME_HEADER_BYTES,
  pushDeltasCost,
  putSnapshotCost,
} from '@elementar/proto'
import type { DocId } from '@elementar/proto'
import { WRITE_ROUTES } from '../http/router.js'
import type { RouteName } from '../http/router.js'
import { errorResponse } from '../http/errors.js'
import { authGate, docExists, docIdOf, finishDoResponse, missResponse } from '../http/pipeline.js'
import type { ReqCtx } from '../http/pipeline.js'
import { docRequest } from '../services.js'

const MAX_PACKET_WIRE_BYTES =
  PACKET_HEADER_BYTES + C.MAX_FRAMES * FRAME_HEADER_BYTES + C.MAX_PACKET_BYTES

export async function handleDocRoute(ctx: ReqCtx): Promise<Response> {
  const docId = docIdOf(ctx)
  // формат docId невалиден → 404 сразу, из изолята, без единого обращения куда-либо (§9.3)
  if (docId === null) return missResponse(ctx)

  const signed =
    ctx.route.name === 'docs.ws'
      ? ctx.req.headers.get('sec-websocket-protocol') !== null
      : ctx.req.headers.get(HDR.SIG) !== null
  if (!signed) return missResponse(ctx)

  const wantsTombstone = ctx.route.name === 'docs.undelete'
  if (!(await docExists(ctx, docId, wantsTombstone))) return missResponse(ctx)

  if (WRITE_ROUTES.includes(ctx.route.name) && !ctx.flags.acceptWrites) {
    return errorResponse(
      'ELM_SHUTDOWN',
      'Writes are paused',
      { retryAfter: 60 },
      ctx.svc.allowedOrigin,
    )
  }

  let body: ArrayBuffer | null = null
  if (ctx.req.method === 'POST' || ctx.req.method === 'PUT') {
    const limit = bodyLimit(ctx.route.name)
    const declared = Number(ctx.req.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > limit) {
      return errorResponse('ELM_TOO_LARGE', 'Body too large', {}, ctx.svc.allowedOrigin)
    }
    body = await ctx.req.arrayBuffer()
    if (body.byteLength > limit) {
      return errorResponse('ELM_TOO_LARGE', 'Body too large', {}, ctx.svc.allowedOrigin)
    }
  }

  const gate = await authGate(ctx, costOf(ctx.route.name, body?.byteLength ?? 0))
  if (gate !== null) return gate

  const res = await forward(ctx, docId, body)
  const out = await finishDoResponse(ctx, res)

  // кэш существования инвалидируется прямой записью значения (§9.3)
  if (ctx.route.name === 'docs.delete' && out.status === 204) {
    ctx.svc.waitUntil(ctx.svc.exists.set(docId, false))
  }
  if (ctx.route.name === 'docs.undelete' && out.status === 200) {
    ctx.svc.waitUntil(ctx.svc.exists.set(docId, true))
  }
  return out
}

export function forward(ctx: ReqCtx, docId: DocId, body: ArrayBuffer | null): Promise<Response> {
  return ctx.svc.docs.get(docId).fetch(docRequest(ctx.req, docId, body))
}

function bodyLimit(name: RouteName): number {
  switch (name) {
    case 'docs.deltas.post':
      return MAX_PACKET_WIRE_BYTES
    case 'docs.snapshot.put':
      return C.MAX_SNAPSHOT_BYTES
    default:
      return 64 * 1024
  }
}

/** Цены из §9.2; размерные — функции из @elementar/proto. */
export function costOf(name: RouteName, bytes: number): number {
  switch (name) {
    case 'docs.meta':
      return OP_COST.getDoc
    case 'docs.deltas.get':
      return OP_COST.getDeltas
    case 'docs.snapshot.get':
      return OP_COST.getSnapshot
    case 'docs.deltas.post':
      return pushDeltasCost(bytes)
    case 'docs.snapshot.put':
      return putSnapshotCost(bytes)
    case 'docs.wrap':
      return OP_COST.putWrap
    case 'docs.delete':
      return OP_COST.deleteDoc
    case 'docs.undelete':
      return OP_COST.undelete
    case 'docs.ws':
      return OP_COST.wsUpgrade
    case 'docs.create':
      return OP_COST.createDoc
    case 'invite.create':
      return OP_COST.createInvite
    case 'invite.get':
      return OP_COST.getInvite
    case 'llm':
      return OP_COST.llm
    default:
      return OP_COST.health
  }
}

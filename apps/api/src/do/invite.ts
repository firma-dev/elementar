/**
 * InviteDO (§8.5): один блоб приглашения, TTL 15 минут, ровно одно использование.
 * Отдача и удаление атомарны — второй GET получает тот же самый 404, что и несуществующий iid.
 */
import { C } from '@elementar/proto'
import type { Env } from '../env.js'
import { notFoundResponse } from '../http/errors.js'
import { jsonResponse } from '../http/cors.js'

interface InviteRecord {
  blob: string
  expiresAt: number
  uses: number
}

const KEY = 'invite'

export class InviteDO implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const now = Date.now()

    if (url.pathname === '/put' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { blob?: unknown } | null
      const blob = body?.blob
      if (typeof blob !== 'string' || blob.length === 0)
        return notFoundResponse(this.env.ELM_ALLOWED_ORIGIN)
      const existing = await this.ctx.storage.get<InviteRecord>(KEY)
      if (existing !== undefined && existing.expiresAt > now) {
        // iid занят: наружу это тот же 404, оракула «занято/свободно» не существует
        return notFoundResponse(this.env.ELM_ALLOWED_ORIGIN)
      }
      const rec: InviteRecord = { blob, expiresAt: now + C.INVITE_TTL_MS, uses: C.INVITE_USES }
      await this.ctx.storage.put(KEY, rec)
      await this.ctx.storage.setAlarm(rec.expiresAt)
      return jsonResponse({ expiresAt: rec.expiresAt }, 201, {}, this.env.ELM_ALLOWED_ORIGIN)
    }

    if (url.pathname === '/get' && request.method === 'GET') {
      const rec = await this.ctx.storage.get<InviteRecord>(KEY)
      if (rec === undefined || rec.expiresAt <= now || rec.uses <= 0) {
        await this.ctx.storage.deleteAll()
        return notFoundResponse(this.env.ELM_ALLOWED_ORIGIN)
      }
      await this.ctx.storage.deleteAll()
      return jsonResponse({ blob: rec.blob }, 200, {}, this.env.ELM_ALLOWED_ORIGIN)
    }

    return notFoundResponse(this.env.ELM_ALLOWED_ORIGIN)
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}

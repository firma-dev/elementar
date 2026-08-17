/**
 * Точка входа Worker'а: fetch + scheduled. Роутер свой, фреймворков нет.
 * Классы Durable Object экспортируются отсюда же — так их видит wrangler.
 */
import { handleRequest } from './http/pipeline.js'
import { buildServices } from './services.js'
import { runGc } from './cron/gc.js'
import { runTtl } from './cron/ttl.js'
import { runRollup } from './cron/rollup.js'
import type { Env } from './env.js'

export { DocDO } from './do/doc.js'
export { LimiterDO } from './do/limiter.js'
export { InviteDO } from './do/invite.js'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, buildServices(env, ctx))
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now()
    switch (controller.cron) {
      case '0 3 * * *':
        ctx.waitUntil(runTtl(env, now))
        return
      case '0 4 * * 0':
        ctx.waitUntil(runRollup(env, now))
        return
      default:
        ctx.waitUntil(runGc(env, now))
    }
  },
}

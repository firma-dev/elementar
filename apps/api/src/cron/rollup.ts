/**
 * Крон «0 4 * * 0» (§8.10): недельный ролл-ап metrics_daily и поиск аномалий по idx_docs_big.
 * Наружу не выходит ничего, кроме агрегатов: ни одного docId в логах не печатаем.
 */
import { C } from '@elementar/proto'
import type { Env } from '../env.js'
import { D1Catalog } from '../lib/catalog.js'

const ANOMALY_LIMIT = 20

export async function runRollup(env: Env, now: number): Promise<void> {
  const catalog = new D1Catalog(env.DB)
  const week = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10)

  const res = await env.DB.prepare(
    `SELECT count(*) AS days, sum(docs_created) AS created, sum(docs_deleted) AS deleted,
            sum(deltas_in) AS deltas, sum(bytes_in) AS bytes_in, sum(http_404) AS misses,
            sum(http_429) AS limited, sum(challenges) AS challenges
     FROM metrics_daily WHERE day >= ?`,
  )
    .bind(week)
    .first<Record<string, number | null>>()

  const big = await catalog.biggestDocs(ANOMALY_LIMIT)
  const overLimit = big.filter((d) => d.totalBytes > C.DOC_TOTAL_BYTES * 0.9).length

  console.log('weekly', { since: week, ...(res ?? {}), nearLimit: overLimit })
}

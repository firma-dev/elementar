/**
 * Крон раз в пять минут (§8.10): дренаж gc_queue (до 200 задач), синк flags → KV,
 * чистка abuse_blocks по expires_at, слив накопленных метрик.
 *
 * Зависимости приходят снаружи (GcDeps) — так дренаж можно прогнать в тесте без D1 и R2.
 */
import { MS } from '@elementar/proto'
import type { Env } from '../env.js'
import { D1Catalog } from '../lib/catalog.js'
import type { Catalog } from '../lib/catalog.js'
import { R2Blobs, docPrefix, snapKey } from '../lib/r2.js'
import type { BlobStore } from '../lib/r2.js'
import { DOC_ID_HEADER } from '../do/doc.http.js'
import { flushMetrics } from '../lib/metrics.js'
import { dayKey } from '../lib/ipHash.js'

const GC_BATCH = 200
const MAX_ATTEMPTS = 8

export interface GcDeps {
  catalog: Catalog
  blobs: BlobStore
  /** ctx.storage.deleteAll() внутри DocDO плюс bye всем пирам. */
  destroyDoc(docId: string): Promise<void>
  publishFlags(flags: Record<string, string>): Promise<void>
}

export function gcDepsFromEnv(env: Env): GcDeps {
  const blobs = new R2Blobs(env.SNAPSHOTS)
  return {
    catalog: new D1Catalog(env.DB),
    blobs,
    destroyDoc: async (docId: string): Promise<void> => {
      const stub = env.DOC.get(env.DOC.idFromName(docId))
      await stub.fetch('https://doc/_destroy', {
        method: 'POST',
        headers: { [DOC_ID_HEADER]: docId },
      })
    },
    publishFlags: async (flags: Record<string, string>): Promise<void> => {
      await env.CONFIG.put('flags', JSON.stringify(flags))
    },
  }
}

export function runGc(env: Env, now: number): Promise<void> {
  return runGcWith(gcDepsFromEnv(env), now)
}

export async function runGcWith(deps: GcDeps, now: number): Promise<void> {
  const flags = await deps.catalog.readFlags()
  if (Object.keys(flags).length > 0) await deps.publishFlags(flags)
  await deps.catalog.cleanupBlocks(now)
  await flushMetrics(deps.catalog, dayKey(now))

  for (const task of await deps.catalog.dueGc(now, GC_BATCH)) {
    try {
      await runTask(deps, task.id, task.stage, now)
    } catch (e) {
      const attempts = task.attempts + 1
      const dueAt = now + 2 ** Math.min(attempts, MAX_ATTEMPTS) * 60_000
      await deps.catalog.failGc(task.id, dueAt, e instanceof Error ? e.message : 'unknown')
      if (attempts >= MAX_ATTEMPTS) console.error('gc: giving up', { stage: task.stage, attempts })
    }
  }
}

async function runTask(deps: GcDeps, id: string, stage: number, now: number): Promise<void> {
  const hashIdx = id.indexOf('#')
  const docId = hashIdx === -1 ? id : id.slice(0, hashIdx)
  const kind = hashIdx === -1 ? '' : id.slice(hashIdx + 1)

  if (kind.startsWith('snap')) {
    const gen = Number(kind.slice(4))
    if (Number.isSafeInteger(gen) && gen > 0) await deps.blobs.delete([snapKey(docId, gen)])
    await deps.catalog.dropGc(id)
    return
  }

  if (kind === 'trash') {
    const objects = await deps.blobs.list(`${docPrefix(docId)}trash/`, 1000)
    await deps.blobs.delete(
      objects.filter((o) => now - o.uploaded > MS.TRASH_TTL).map((o) => o.key),
    )
    await deps.catalog.dropGc(id)
    return
  }

  // полное стирание документа: R2 → DO → строка каталога через 30 дней (§8.10)
  if (stage === 0) {
    await deps.blobs.deleteDoc(docId)
    await deps.catalog.advanceGc(id, 1, now)
    return
  }
  if (stage === 1) {
    await deps.destroyDoc(docId)
    await deps.catalog.advanceGc(id, 2, now + MS.SOFT_DELETE)
    return
  }
  await deps.catalog.deleteDocRow(docId)
  await deps.catalog.dropGc(id)
}

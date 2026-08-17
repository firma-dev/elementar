/**
 * Крон «0 3 * * *» (§8.10): скан TTL пачками по 500, физическое стирание тумбстонов
 * с purge_after < now, удаление снапшотов поколения < gen-2 и корзины trash старше 7 дней.
 */
import { C, MS } from '@elementar/proto'
import type { Env } from '../env.js'
import { D1Catalog } from '../lib/catalog.js'
import type { Catalog } from '../lib/catalog.js'
import { R2Blobs, docPrefix } from '../lib/r2.js'
import type { BlobStore } from '../lib/r2.js'
import { bumpMetric } from '../lib/metrics.js'

const TTL_BATCH = 500

export function runTtl(env: Env, now: number): Promise<void> {
  return runTtlWith(new D1Catalog(env.DB), new R2Blobs(env.SNAPSHOTS), now)
}

export async function runTtlWith(catalog: Catalog, blobs: BlobStore, now: number): Promise<void> {
  const expired = await catalog.expiredDocs(now, TTL_BATCH)
  for (const doc of expired) {
    // и протухший активный, и созревший тумбстон уходят в общую очередь стирания
    await catalog.enqueueGc(doc.docId, now)
    bumpMetric(doc.state === 1 ? 'docs_deleted' : 'docs_expired')
    await sweepDocBlobs(blobs, doc.docId, now)
  }
}

/** Оставляем три поколения снапшота, корзину — семь дней (§8.6). */
async function sweepDocBlobs(blobs: BlobStore, docId: string, now: number): Promise<void> {
  const snaps = await blobs.list(`${docPrefix(docId)}snap/`, 1000)
  const gens = snaps
    .map((o) => ({ key: o.key, gen: Number(/snap\/(\d+)\.bin$/.exec(o.key)?.[1] ?? '0') }))
    .filter((g) => Number.isSafeInteger(g.gen) && g.gen > 0)
    .sort((a, b) => b.gen - a.gen)
  await blobs.delete(gens.slice(C.SNAPSHOT_GENERATIONS).map((g) => g.key))

  const trash = await blobs.list(`${docPrefix(docId)}trash/`, 1000)
  await blobs.delete(trash.filter((o) => now - o.uploaded > MS.TRASH_TTL).map((o) => o.key))
}

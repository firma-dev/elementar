/**
 * §8.10: дренаж очереди уборки и суточный скан TTL. Стирание идёт строго по стадиям
 * R2 → DO → строка каталога через 30 дней; корзина живёт 7 дней, поколений остаётся три.
 */
import { describe, expect, it } from 'vitest'
import { MS } from '@elementar/proto'
import { runGcWith } from '../src/cron/gc.js'
import type { GcDeps } from '../src/cron/gc.js'
import { runTtlWith } from '../src/cron/ttl.js'
import { snapKey, trashKey } from '../src/lib/r2.js'
import { MemoryBlobs, MemoryCatalog, randomBytes, randomDocId } from './helpers/harness.js'

function deps(catalog: MemoryCatalog, blobs: MemoryBlobs, destroyed: string[]): GcDeps {
  return {
    catalog,
    blobs,
    destroyDoc: async (docId: string): Promise<void> => {
      destroyed.push(docId)
    },
    publishFlags: async (): Promise<void> => undefined,
  }
}

describe('кроны уборки', () => {
  it('стирание идёт по стадиям: R2 → DO → строка через 30 дней', async () => {
    const now = 1_800_000_000_000
    const catalog = new MemoryCatalog()
    const blobs = new MemoryBlobs(() => now)
    const destroyed: string[] = []
    const docId = randomDocId()

    await catalog.insertDoc({
      docId,
      sigAlg: 'ed25519',
      sigPub: randomBytes(32),
      app: 1,
      createdAt: now,
      expiresAt: now,
    })
    await blobs.putSnapshot(docId, 1, randomBytes(64), { seq: 1, gen: 1, bytes: 64, sha256: '' })
    await catalog.enqueueGc(docId, now)

    const d = deps(catalog, blobs, destroyed)
    await runGcWith(d, now)
    expect(blobs.objects.size).toBe(0)
    expect(catalog.gc.get(docId)?.stage).toBe(1)

    await runGcWith(d, now)
    expect(destroyed).toEqual([docId])
    expect(catalog.gc.get(docId)?.stage).toBe(2)
    expect(catalog.gc.get(docId)?.dueAt).toBe(now + MS.SOFT_DELETE)

    // раньше срока строка не трогается
    await runGcWith(d, now + MS.SOFT_DELETE - 1)
    expect(catalog.docs.has(docId)).toBe(true)

    await runGcWith(d, now + MS.SOFT_DELETE)
    expect(catalog.docs.has(docId)).toBe(false)
    expect(catalog.gc.size).toBe(0)
  })

  it('задача на поколение снапшота удаляет ровно один объект', async () => {
    const now = 1_800_000_000_000
    const catalog = new MemoryCatalog()
    const blobs = new MemoryBlobs(() => now)
    const docId = randomDocId()

    await blobs.putSnapshot(docId, 1, randomBytes(8), { seq: 1, gen: 1, bytes: 8, sha256: '' })
    await blobs.putSnapshot(docId, 2, randomBytes(8), { seq: 2, gen: 2, bytes: 8, sha256: '' })
    await catalog.enqueueGc(`${docId}#snap1`, now)

    await runGcWith(deps(catalog, blobs, []), now)
    expect(blobs.objects.has(snapKey(docId, 1))).toBe(false)
    expect(blobs.objects.has(snapKey(docId, 2))).toBe(true)
    expect(catalog.gc.size).toBe(0)
  })

  it('TTL-скан ставит протухшее в очередь и режет лишние поколения и корзину', async () => {
    const now = 1_800_000_000_000
    const catalog = new MemoryCatalog()
    const blobs = new MemoryBlobs(() => now)
    const docId = randomDocId()

    await catalog.insertDoc({
      docId,
      sigAlg: 'ed25519',
      sigPub: randomBytes(32),
      app: 1,
      createdAt: now - MS.TTL_ACTIVE,
      expiresAt: now - 1,
    })
    for (let gen = 1; gen <= 5; gen++) {
      await blobs.putSnapshot(docId, gen, randomBytes(8), { seq: gen, gen, bytes: 8, sha256: '' })
    }
    blobs.objects.set(trashKey(docId, 1, 10), {
      body: randomBytes(8),
      uploaded: now - MS.TRASH_TTL - 1,
    })
    blobs.objects.set(trashKey(docId, 11, 20), { body: randomBytes(8), uploaded: now })

    await runTtlWith(catalog, blobs, now)

    expect(catalog.gc.has(docId)).toBe(true)
    expect(blobs.objects.has(snapKey(docId, 5))).toBe(true)
    expect(blobs.objects.has(snapKey(docId, 3))).toBe(true)
    expect(blobs.objects.has(snapKey(docId, 2))).toBe(false)
    expect(blobs.objects.has(trashKey(docId, 1, 10))).toBe(false)
    expect(blobs.objects.has(trashKey(docId, 11, 20))).toBe(true)
  })
})

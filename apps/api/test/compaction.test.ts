/**
 * §8.9 + §8.13 п.6: срезанные дельты попадают в корзину R2, поколений остаётся три,
 * снапшот больше 256 KiB уезжает в R2, повтор на устаревшей базе — 409 ELM_STALE_BASE.
 */
import { describe, expect, it } from 'vitest'
import { C, HDR, PATHS, decodeFrames } from '@elementar/proto'
import type { DocId, SnapshotResult } from '@elementar/proto'
import { handleRequest } from '../src/http/pipeline.js'
import {
  createDoc,
  el1Payload,
  framePacket,
  makeHarness,
  makeSigner,
  randomBytes,
  randomDocId,
  signedRequest,
} from './helpers/harness.js'
import type { Harness, Signer } from './helpers/harness.js'

async function push(
  h: Harness,
  s: Signer,
  docId: DocId,
  clientId: Uint8Array,
  from: number,
  n: number,
): Promise<void> {
  const payloads = Array.from({ length: n }, () => el1Payload(randomBytes(20)))
  const req = await signedRequest(s, {
    method: 'POST',
    path: PATHS.deltas(docId),
    docId,
    body: framePacket(clientId, from, payloads),
    tsMs: h.svc.now(),
  })
  const res = await handleRequest(req, h.svc)
  await h.settle()
  expect(res.status).toBe(200)
}

async function snapshot(
  h: Harness,
  s: Signer,
  docId: DocId,
  baseSeq: number,
  bytes: number,
): Promise<Response> {
  const body = el1Payload(randomBytes(bytes))
  const sig = await signedRequest(s, {
    method: 'PUT',
    path: PATHS.snapshot(docId),
    docId,
    body,
    tsMs: h.svc.now(),
  })
  const res = await handleRequest(
    new Request(sig.url, {
      method: 'PUT',
      headers: new Headers([...sig.headers, [HDR.BASE_SEQ, String(baseSeq)]]),
      body: body as unknown as BodyInit,
    }),
    h.svc,
  )
  await h.settle()
  return res
}

describe('компакция', () => {
  it('срезанные дельты уходят в корзину R2 и только потом удаляются', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    const clientId = randomBytes(8)
    await push(h, signer, docId, clientId, 1, 5)

    const res = await snapshot(h, signer, docId, 5, 512)
    expect(res.status).toBe(200)
    const out = (await res.json()) as SnapshotResult
    expect(out).toMatchObject({
      snapshotSeq: 5,
      snapshotGen: 1,
      location: 'do',
      prunedDeltas: 5,
      head: 5,
    })

    const trash = h.blobs.objects.get(`doc/${docId}/trash/1-5.bin`)
    expect(trash).toBeDefined()
    const decoded = decodeFrames(trash?.body ?? new Uint8Array(0))
    expect(decoded.ok && decoded.frames.length).toBe(5)
    expect(h.docs.store(docId).logStats().count).toBe(0)
  })

  it('повтор на той же базе — ELM_STALE_BASE', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    await push(h, signer, docId, randomBytes(8), 1, 3)

    expect((await snapshot(h, signer, docId, 3, 256)).status).toBe(200)
    const again = await snapshot(h, signer, docId, 3, 256)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('ELM_STALE_BASE')
  })

  it('держим три поколения, старшее уходит в gc_queue', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    const clientId = randomBytes(8)

    for (let gen = 1; gen <= C.SNAPSHOT_GENERATIONS + 1; gen++) {
      await push(h, signer, docId, clientId, gen * 10, 2)
      const res = await snapshot(h, signer, docId, gen * 2, 128)
      expect(res.status).toBe(200)
    }

    const store = h.docs.store(docId)
    expect(store.readSnapshot(1)).toBeNull()
    expect(store.readSnapshot(2)).not.toBeNull()
    expect(store.readSnapshot(4)).not.toBeNull()
    expect(h.catalog.gc.has(`${docId}#snap1`)).toBe(true)
  })

  it('снапшот больше 256 KiB уезжает в R2', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    await push(h, signer, docId, randomBytes(8), 1, 1)

    const res = await snapshot(h, signer, docId, 1, C.INLINE_SNAPSHOT_BYTES + 1)
    expect(res.status).toBe(200)
    const out = (await res.json()) as SnapshotResult
    expect(out.location).toBe('r2')
    expect(h.blobs.objects.has(`doc/${docId}/snap/1.bin`)).toBe(true)

    const get = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.snapshot(docId),
      docId,
      tsMs: h.svc.now(),
    })
    const got = await handleRequest(get, h.svc)
    expect(got.status).toBe(200)
    expect((await got.arrayBuffer()).byteLength).toBe(out.bytes)
  })

  it('снапшот больше 2 MiB не принимается', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    await push(h, signer, docId, randomBytes(8), 1, 1)

    const res = await snapshot(h, signer, docId, 1, C.MAX_SNAPSHOT_BYTES + 1)
    expect(res.status).toBe(413)
  })
})

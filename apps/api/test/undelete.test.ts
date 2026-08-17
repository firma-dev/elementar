/**
 * §8.5 + §8.13 п.9: DELETE → 404 на всех GET → undelete в течение 7 дней восстанавливает
 * лог, снапшот и wrap; после purge_after — не восстанавливает.
 */
import { describe, expect, it } from 'vitest'
import { MS, PATHS } from '@elementar/proto'
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
import type { DocId } from '@elementar/proto'

async function push(
  h: Harness,
  signer: Signer,
  docId: DocId,
  clientId: Uint8Array,
  from: number,
  n: number,
): Promise<Response> {
  const payloads = Array.from({ length: n }, () => el1Payload(randomBytes(48)))
  const body = framePacket(clientId, from, payloads)
  const req = await signedRequest(signer, {
    method: 'POST',
    path: PATHS.deltas(docId),
    docId,
    body,
    tsMs: h.svc.now(),
  })
  const res = await handleRequest(req, h.svc)
  await h.settle()
  return res
}

async function get(h: Harness, signer: Signer, docId: DocId, path: string): Promise<Response> {
  const req = await signedRequest(signer, { method: 'GET', path, docId, tsMs: h.svc.now() })
  const res = await handleRequest(req, h.svc)
  await h.settle()
  return res
}

describe('удаление и восстановление', () => {
  it('DELETE прячет документ, undelete возвращает его целиком', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId, { snapshot: randomBytes(1024) })
    const clientId = randomBytes(8)
    expect((await push(h, signer, docId, clientId, 1, 5)).status).toBe(200)

    const before = (await (await get(h, signer, docId, PATHS.doc(docId))).json()) as {
      logCount: number
      wrapVer: number
      snapshotBytes: number
    }
    expect(before.logCount).toBe(5)

    const del = await signedRequest(signer, {
      method: 'DELETE',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(del, h.svc)).status).toBe(204)
    await h.settle()

    expect((await get(h, signer, docId, PATHS.doc(docId))).status).toBe(404)
    expect((await get(h, signer, docId, PATHS.deltas(docId))).status).toBe(404)
    expect((await get(h, signer, docId, PATHS.snapshot(docId))).status).toBe(404)
    expect(await h.catalog.existsActive(docId)).toBe(false)

    h.clock.now += MS.TOMBSTONE - 1000
    const undel = await signedRequest(signer, {
      method: 'POST',
      path: PATHS.undelete(docId),
      docId,
      body: new Uint8Array(0),
      tsMs: h.svc.now(),
    })
    const res = await handleRequest(undel, h.svc)
    await h.settle()
    expect(res.status).toBe(200)
    const after = (await res.json()) as {
      state: string
      logCount: number
      wrapVer: number
      snapshotBytes: number
    }
    expect(after.state).toBe('active')
    expect(after.logCount).toBe(before.logCount)
    expect(after.wrapVer).toBe(before.wrapVer)
    expect(after.snapshotBytes).toBe(before.snapshotBytes)

    expect((await get(h, signer, docId, PATHS.doc(docId))).status).toBe(200)
    expect(h.catalog.gc.size).toBe(0)
  })

  it('после purge_after восстановление невозможно', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const del = await signedRequest(signer, {
      method: 'DELETE',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(del, h.svc)).status).toBe(204)
    await h.settle()

    h.clock.now += MS.TOMBSTONE + 1000
    const undel = await signedRequest(signer, {
      method: 'POST',
      path: PATHS.undelete(docId),
      docId,
      body: new Uint8Array(0),
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(undel, h.svc)).status).toBe(404)
  })

  it('удаление ставит задачу физического стирания на purge_after', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    const at = h.svc.now()

    const del = await signedRequest(signer, {
      method: 'DELETE',
      path: PATHS.doc(docId),
      docId,
      tsMs: at,
    })
    await handleRequest(del, h.svc)
    await h.settle()

    const task = h.catalog.gc.get(docId)
    expect(task).toBeDefined()
    expect(task?.dueAt).toBe(at + MS.TOMBSTONE)
    // блобы и лог не тронуты до purge_after
    expect(h.docs.store(docId).logStats().count).toBe(0)
    expect(h.catalog.docs.get(docId)?.state).toBe('tombstone')
  })
})

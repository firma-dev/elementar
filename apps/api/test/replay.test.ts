/**
 * §4.5 + §8.13 п.3: антиреплей персистентен. После эвикции/хибернации DO (в моке —
 * пересборка DocCore поверх того же хранилища) повтор запроса с тем же sigNonce
 * всё ещё отбивается, а окно чистится по alarm через SIG_NONCE_TTL_MS.
 */
import { describe, expect, it } from 'vitest'
import { C, PATHS } from '@elementar/proto'
import { handleRequest } from '../src/http/pipeline.js'
import {
  createDoc,
  makeHarness,
  makeSigner,
  randomBytes,
  randomDocId,
  signedRequest,
} from './helpers/harness.js'

describe('антиреплей', () => {
  it('повтор того же nonce отбивается единым 404', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const nonce = randomBytes(C.SIG_NONCE_BYTES)
    const build = async (): Promise<Request> =>
      signedRequest(signer, {
        method: 'GET',
        path: PATHS.doc(docId),
        docId,
        tsMs: h.svc.now(),
        nonce,
      })

    expect((await handleRequest(await build(), h.svc)).status).toBe(200)
    const second = await handleRequest(await build(), h.svc)
    expect(second.status).toBe(404)
    expect(await second.text()).toContain('ELM_NOT_FOUND')
  })

  it('реплей отбивается и после пересоздания DO (хибернация)', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const nonce = randomBytes(C.SIG_NONCE_BYTES)
    const req = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
      nonce,
    })
    expect((await handleRequest(req, h.svc)).status).toBe(200)

    // каждый вызов TestDocs.get строит DocCore заново — ровно это делает проснувшийся DO
    const replay = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
      nonce,
    })
    expect((await handleRequest(replay, h.svc)).status).toBe(404)
    expect(h.docs.store(docId).hasNonces()).toBe(true)
  })

  it('окно антиреплея чистится через SIG_NONCE_TTL_MS, но не раньше', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const nonce = randomBytes(C.SIG_NONCE_BYTES)
    const first = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
      nonce,
    })
    await handleRequest(first, h.svc)

    h.clock.now += C.SIG_NONCE_TTL_MS - 1
    h.docs.core(docId).pruneNonces()
    expect(h.docs.store(docId).hasNonces()).toBe(true)

    h.clock.now += 2
    h.docs.core(docId).pruneNonces()
    expect(h.docs.store(docId).hasNonces()).toBe(false)
  })

  it('другой nonce с той же подписью-соседом проходит', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    for (let i = 0; i < 3; i++) {
      const req = await signedRequest(signer, {
        method: 'GET',
        path: PATHS.doc(docId),
        docId,
        tsMs: h.svc.now(),
      })
      expect((await handleRequest(req, h.svc)).status).toBe(200)
    }
  })
})

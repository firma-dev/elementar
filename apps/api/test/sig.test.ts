/**
 * §4.5 + §8.13 п.2: валидная подпись проходит; изменённые тело, путь, метод, просроченный ts
 * и отсутствие заголовка — не проходят. Обе схемы, ed25519 и p256. Подпись для `GET /ws`,
 * поданная на `DELETE /docs/{id}`, отвергается.
 */
import { describe, expect, it } from 'vitest'
import { C, PATHS } from '@elementar/proto'
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

describe('подпись', () => {
  it('ed25519: валидная подпись даёт 200 и DocMeta', async () => {
    const h = makeHarness()
    const signer = await makeSigner('ed25519')
    const docId = randomDocId()
    const created = await createDoc(h, signer, docId)
    expect(created.status).toBe(201)

    const req = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    const res = await handleRequest(req, h.svc)
    expect(res.status).toBe(200)
    const meta = (await res.json()) as { docId: string; seq: number; safeCompactSeq: number }
    expect(meta.docId).toBe(docId)
    expect(meta.seq).toBe(0)
  })

  it('p256: fallback-схема работает наравне', async () => {
    const h = makeHarness()
    const signer = await makeSigner('p256')
    const docId = randomDocId()
    expect((await createDoc(h, signer, docId)).status).toBe(201)

    const req = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(req, h.svc)).status).toBe(200)
  })

  it('подменённое тело не проходит', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const clientId = randomBytes(8)
    const signedBody = framePacket(clientId, 1, [el1Payload(randomBytes(32))])
    const otherBody = framePacket(clientId, 1, [el1Payload(randomBytes(32))])
    const sig = await signedRequest(signer, {
      method: 'POST',
      path: PATHS.deltas(docId),
      docId,
      body: signedBody,
      tsMs: h.svc.now(),
    })
    const tampered = new Request(sig.url, {
      method: 'POST',
      headers: sig.headers,
      body: otherBody as unknown as BodyInit,
    })
    const res = await handleRequest(tampered, h.svc)
    expect(res.status).toBe(404)
  })

  it('подпись другого пути не проходит', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const req = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.deltas(docId),
      signPath: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(req, h.svc)).status).toBe(404)
  })

  it('подпись GET /ws, поданная на DELETE /docs/{id}, отвергается', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const req = await signedRequest(signer, {
      method: 'DELETE',
      path: PATHS.doc(docId),
      signMethod: 'GET',
      signPath: PATHS.ws(docId),
      docId,
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(req, h.svc)).status).toBe(404)
    // документ жив: удаления не произошло
    expect(await h.catalog.existsActive(docId)).toBe(true)
  })

  it('просроченный ts не проходит', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)

    const req = await signedRequest(signer, {
      method: 'GET',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now() - C.SIG_SKEW_MS - 1,
    })
    expect((await handleRequest(req, h.svc)).status).toBe(404)
  })

  it('без заголовка подписи DocDO не трогается вообще', async () => {
    const h = makeHarness()
    const signer = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, signer, docId)
    const before = h.docs.instantiations

    const res = await handleRequest(
      new Request(`https://s.elementar.example${PATHS.doc(docId)}`),
      h.svc,
    )
    expect(res.status).toBe(404)
    expect(h.docs.instantiations).toBe(before)
  })

  it('чужой ключ не проходит', async () => {
    const h = makeHarness()
    const owner = await makeSigner()
    const stranger = await makeSigner()
    const docId = randomDocId()
    await createDoc(h, owner, docId)

    const req = await signedRequest(stranger, {
      method: 'DELETE',
      path: PATHS.doc(docId),
      docId,
      tsMs: h.svc.now(),
    })
    expect((await handleRequest(req, h.svc)).status).toBe(404)
    expect(await h.catalog.existsActive(docId)).toBe(true)
  })
})
